# 0. Length-safe names: short names render byte-identically; over-cap
# names hash-suffix instead of failing validation (identifiers cap
# at 63, database names at 64, policies at 128). Mirrors
# safeSuffixedName in resolvers.js.
locals {
  identifier_safe_name    = length("${local.app_name}-db") > 63 ? "${trimsuffix(substr(local.app_name, 0, 63 - 1 - 5 - 3), "-")}-${substr(md5(local.app_name), 0, 5)}-db" : "${local.app_name}-db"
  db_name_base            = replace(local.app_name, "-", "")
  db_name_safe_name       = length(local.db_name_base) > 64 ? "${substr(local.db_name_base, 0, 59)}${substr(md5(local.db_name_base), 0, 5)}" : local.db_name_base
  secret_policy_safe_name = length("${local.app_name}-rds-secret-policy") > 128 ? "${trimsuffix(substr(local.app_name, 0, 128 - 1 - 5 - 18), "-")}-${substr(md5(local.app_name), 0, 5)}-rds-secret-policy" : "${local.app_name}-rds-secret-policy"
}

# 1. Database Subnet Group (isolated subnets live in network.tf, shared
# with ElastiCache so every data-plane group stays off public subnets)
resource "aws_db_subnet_group" "main" {
  name       = "${local.app_name}-db-subnet-group"
  subnet_ids = aws_subnet.db_isolated[*].id
}

# 2. Database Security Group
resource "aws_security_group" "rds" {
  name   = "${local.app_name}-rds-sg"
  vpc_id = aws_vpc.main.id

  # ONLY allow inbound traffic from the ECS Fargate tasks
  ingress {
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }
}

# 2b. TLS enforcement: clients connect with TLS (see the
# database-connections guide), so require it server-side. Pending
# reboot: existing trees enforce at the next reboot, never as a
# surprise mid-apply restart (see the SSL upgrade runbook).
resource "aws_db_parameter_group" "ssl" {
  name   = "${local.app_name}-mysql80"
  family = "mysql8.0"

  parameter {
    name         = "require_secure_transport"
    value        = "ON"
    apply_method = "pending-reboot"
  }
}

# 3. The MySQL Instance
resource "aws_db_instance" "postgres" {
  identifier        = local.identifier_safe_name
  engine            = "mysql"
  engine_version    = "8.0"
  instance_class    = "db.t4g.micro"
  allocated_storage = 20
  # Cap storage autoscaling: without a ceiling a runaway workload can
  # grow the volume (and the bill) without bound.
  max_allocated_storage   = 200
  backup_retention_period = 7
  # Explicit off-peak UTC windows: without them AWS assigns windows
  # that can land in peak hours (and drift between stacks).
  backup_window      = "03:00-04:00"
  maintenance_window = "sun:04:00-sun:05:00"
  storage_encrypted  = true

  # TLS enforcement (see the parameter group above).
  parameter_group_name = aws_db_parameter_group.ssl.name

  # Strip dashes for the database name: RDS MySQL db_name must begin with a
  # letter and contain only alphanumeric characters (e.g. my-project -> myproject)
  db_name  = local.db_name_safe_name
  username = "dbadmin"

  # AWS automatically creates and manages the secret in Secrets Manager!
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  skip_final_snapshot = true
  publicly_accessible = false

  # grada destroy lifts this only via --allow-data-loss (or a per-run
  # data-loss confirm); grada snapshots the database first unless the
  # flag says the data may go. grada destroy also pre-wakes stopped
  # databases automatically; a raw `terraform destroy` on a stopped DB
  # fails — start it first with `aws rds start-db-instance`.
  deletion_protection = !var.grada_allow_data_loss
}

variable "grada_allow_data_loss" {
  type        = bool
  default     = false
  description = "Set by grada destroy --allow-data-loss to lift deletion protection. Do not enable by hand."
}

# 4. IAM Permission for RDS Master Password Secret
resource "aws_iam_role_policy" "rds_secret_access" {
  name = local.secret_policy_safe_name
  role = aws_iam_role.execution_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_db_instance.postgres.master_user_secret[0].secret_arn
        ]
      }
    ]
  })
}
