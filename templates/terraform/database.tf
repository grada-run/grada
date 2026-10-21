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

# 3. The PostgreSQL Instance
resource "aws_db_instance" "postgres" {
  identifier        = "${local.app_name}-db"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = "db.t4g.micro"
  allocated_storage = 20
  storage_encrypted = true

  # Clean up dashes for the database name (e.g. my-project -> my_project)
  db_name  = replace(local.app_name, "-", "_")
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
  name = "${local.app_name}-rds-secret-policy"
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
