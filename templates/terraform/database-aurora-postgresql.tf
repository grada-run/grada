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

# 3. The Aurora PostgreSQL Serverless v2 Cluster (scale-to-zero)
resource "aws_rds_cluster" "postgres" {
  cluster_identifier = "${local.app_name}-db-cluster"
  engine             = "aurora-postgresql"

  # engine_version is intentionally omitted: AWS retires Aurora minor versions
  # (e.g. 16.4 in us-east-2), so new clusters take the regional default.
  # Strip dashes for the database name: Aurora database_name must begin with a
  # letter and contain only alphanumeric characters (e.g. my-project -> myproject)
  database_name   = replace(local.app_name, "-", "")
  master_username = "dbadmin"

  # AWS automatically creates and manages the secret in Secrets Manager!
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  skip_final_snapshot = true
  storage_encrypted   = true

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
  identifier         = "${local.app_name}-db-instance-1"
  cluster_identifier = aws_rds_cluster.postgres.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.postgres.engine
  engine_version     = aws_rds_cluster.postgres.engine_version

  publicly_accessible = false
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
          aws_rds_cluster.postgres.master_user_secret[0].secret_arn
        ]
      }
    ]
  })
}
