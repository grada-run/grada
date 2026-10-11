# --- Worker ECS Task Definition ---
resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.app_name}-worker-task"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "{{CPU}}"
  memory                   = "{{MEMORY}}"
  execution_role_arn       = aws_iam_role.execution_role.arn
  task_role_arn            = aws_iam_role.task_role.arn

  container_definitions = jsonencode([
    {
      name      = "${local.app_name}-worker-container"
      image     = "${local.ecr_url}:${terraform.workspace == "default" ? "latest" : terraform.workspace}"
      essential = true

      environment = [
        { "name" : "NODE_ENV", "value" : "production" },
        {{DB_ENV_VARS}}
      ]

      secrets = concat(
        [
          for key in local.secret_keys : {
            name      = key
            valueFrom = "${local.secret_arn}:${key}::"
          }
        ],
        [
          {{TASK_SECRETS}}
        ]
      )

      {{WORKER_COMMAND}}

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app_logs.name
          "awslogs-region"        = "{{REGION}}"
          "awslogs-stream-prefix" = "worker" # Isolates worker logs from web logs
        }
      }
    }
  ])
}

# --- Worker ECS Service ---
# Notice there is NO load_balancer block. This service is strictly private.
resource "aws_ecs_service" "worker" {
  name                   = "${local.app_name}-worker-service"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.worker.arn
  launch_type            = "FARGATE"
  desired_count          = 1
  enable_execute_command = true

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true
  }

  # Queue-depth auto-scaling (see `grada add queue:sqs`) manages
  # desired_count outside Terraform; ignore it to avoid apply-time drift.
  lifecycle {
    ignore_changes = [desired_count]
  }
}