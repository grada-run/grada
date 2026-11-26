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
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }
}

# 2b. TLS enforcement: the cluster floats its engine version by
# design, so resolve the regional default at creation time and
# derive the matching family. (default_only spans every major's
# default, so latest pins the lookup down to one.) The group name
# carries no major and later family rollovers are ignored — when
# AWS rolls the default major, applies stay clean instead of
# failing on the mismatch; the enforced family stays correct
# until a manual major upgrade, which re-taints the group (see
# the database runbook). Pending reboot like the instance groups.
data "aws_rds_engine_version" "default" {
  engine       = "aurora-postgresql"
  default_only = true
  latest       = true
}

locals {
  aurora_major = split(".", data.aws_rds_engine_version.default.version_actual)[0]

  # Length-safe names: short names render byte-identically; over-cap
  # names hash-suffix instead of failing validation (identifiers and
  # database names cap at 63, policies at 128). Mirrors
  # safeSuffixedName in resolvers.js.
  cluster_safe_name       = length("${local.app_name}-db-cluster") > 63 ? "${replace(substr(local.app_name, 0, 63 - 1 - 5 - 11), "/-+$/", "")}-${substr(md5(local.app_name), 0, 5)}-db-cluster" : "${local.app_name}-db-cluster"
  instance_safe_name      = length("${local.app_name}-db-instance-1") > 63 ? "${replace(substr(local.app_name, 0, 63 - 1 - 5 - 14), "/-+$/", "")}-${substr(md5(local.app_name), 0, 5)}-db-instance-1" : "${local.app_name}-db-instance-1"
  database_name_base      = replace(local.app_name, "-", "")
  database_name_safe_name = length(local.database_name_base) > 63 ? "${substr(local.database_name_base, 0, 58)}${substr(md5(local.database_name_base), 0, 5)}" : local.database_name_base
  secret_policy_safe_name = length("${local.app_name}-rds-secret-policy") > 128 ? "${replace(substr(local.app_name, 0, 128 - 1 - 5 - 18), "/-+$/", "")}-${substr(md5(local.app_name), 0, 5)}-rds-secret-policy" : "${local.app_name}-rds-secret-policy"
}

resource "aws_rds_cluster_parameter_group" "ssl" {
  name   = "${local.app_name}-aurorapg"
  family = "aurora-postgresql${local.aurora_major}"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  lifecycle {
    # Rollover-stable: the lookup above feeds creation only. Later
    # default-major rollovers change nothing (same name, family
    # ignored), so applies stay clean; re-taint after a manual
    # major upgrade so the family follows the new engine.
    ignore_changes = [family]
  }
}

# 3. The Aurora PostgreSQL Serverless v2 Cluster (scale-to-zero)
resource "aws_rds_cluster" "postgres" {
  cluster_identifier = local.cluster_safe_name
  engine             = "aurora-postgresql"

  # engine_version is intentionally omitted: AWS retires Aurora minor versions
  # (e.g. 16.4 in us-east-2), so new clusters take the regional default.
  # Strip dashes for the database name: Aurora database_name must begin with a
  # letter and contain only alphanumeric characters (e.g. my-project -> myproject)
  database_name   = local.database_name_safe_name
  master_username = "dbadmin"

  # AWS automatically creates and manages the secret in Secrets Manager!
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  # TLS enforcement (see the parameter group above). In-place update,
  # never a replacement.
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.ssl.name

  skip_final_snapshot = true
  storage_encrypted   = true

  # Match the instance engines: 7-day retention with explicit off-peak
  # UTC windows instead of AWS-assigned ones.
  backup_retention_period      = 7
  preferred_backup_window      = "03:00-04:00"
  preferred_maintenance_window = "sun:04:00-sun:05:00"

  # grada destroy lifts this only via --allow-data-loss (or a per-run
  # data-loss confirm); grada snapshots the database first unless the
  # flag says the data may go. grada destroy also pre-wakes stopped
  # databases automatically; a raw `terraform destroy` on a stopped DB
  # fails — start it first with `aws rds start-db-cluster`.
  deletion_protection = !var.grada_allow_data_loss

  serverlessv2_scaling_configuration {
    min_capacity             = 0
    max_capacity             = 2
    seconds_until_auto_pause = 300
  }

  lifecycle {
    # RDS auto-assigns AZ ordering beyond our 2-subnet group; never treat
    # that drift as a change on subsequent applies.
    ignore_changes = [availability_zones]
  }
}

variable "grada_allow_data_loss" {
  type        = bool
  default     = false
  description = "Set by grada destroy --allow-data-loss to lift deletion protection. Do not enable by hand."
}

resource "aws_rds_cluster_instance" "postgres" {
  identifier         = local.instance_safe_name
  cluster_identifier = aws_rds_cluster.postgres.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.postgres.engine
  engine_version     = aws_rds_cluster.postgres.engine_version

  publicly_accessible = false
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
          aws_rds_cluster.postgres.master_user_secret[0].secret_arn
        ]
      }
    ]
  })
}
