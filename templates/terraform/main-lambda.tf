# grada generated infrastructure (Lambda target)
# Scale-to-zero web service: container image + Lambda Web Adapter, fronted by
# API Gateway HTTP API v2 and CloudFront. See templates/terraform/main.tf for
# the ECS Fargate equivalent.
provider "aws" {
  region = "{{REGION}}"

  default_tags {
    tags = {
      ManagedBy    = "grada"
      GradaProject = "{{PROJECT_NAME}}"
    }
  }
}

# Alias for us-east-1-only services (CloudFront ACM certificates). Lives here
# — not in domain.tf — so removing a custom domain never orphans the provider
# configuration Terraform needs to destroy the certificate.
# tflint-ignore: terraform_unused_declarations
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      ManagedBy    = "grada"
      GradaProject = "{{PROJECT_NAME}}"
    }
  }
}

locals {
  # Workspace suffix for PR preview environments (e.g., "-pr-123"). Empty for production.
  env_suffix = terraform.workspace == "default" ? "" : "-${terraform.workspace}"

  # Per-project collision suffix minted once at init ("-a1b2c3"). Empty for
  # trees scaffolded before suffixes existed — never change it by hand:
  # renaming replaces every singleton resource below.
  grada_resource_suffix = "{{RESOURCE_SUFFIX}}"

  # Full application name: project + workspace + collision suffix.
  app_name = "{{PROJECT_NAME}}${local.env_suffix}${local.grada_resource_suffix}"
}

# --- CloudWatch Logs ---
resource "aws_cloudwatch_log_group" "app" {
  name              = "/aws/lambda/${local.app_name}-fn"
  retention_in_days = 30
}

# --- ECR Repository (Shared across workspaces) ---
resource "aws_ecr_repository" "app" {
  count = terraform.workspace == "default" ? 1 : 0
  name  = "{{PROJECT_NAME}}{{RESOURCE_SUFFIX}}-repo"
  # trivy:ignore:AVD-AWS-0031 - Mutable tags allow the CI/CD pipeline to reuse the 'latest' tag for simplified deployments
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

# In PR workspaces, fetch the existing production repository
data "aws_ecr_repository" "existing_app" {
  count = terraform.workspace != "default" ? 1 : 0
  name  = "{{PROJECT_NAME}}{{RESOURCE_SUFFIX}}-repo"
}

locals {
  ecr_url = terraform.workspace == "default" ? aws_ecr_repository.app[0].repository_url : data.aws_ecr_repository.existing_app[0].repository_url
}

# --- IAM: Execution Role ---
# Kept for addon compatibility (same name as the ECS target). The Lambda
# function itself assumes the task role below.
data "aws_iam_policy_document" "ecs_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution_role" {
  name               = "${local.app_name}-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_trust.json
}

resource "aws_iam_role_policy_attachment" "execution_role_policy" {
  role       = aws_iam_role.execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# --- IAM: Task Role (Lambda function role) ---
# Allows your application code running INSIDE the container to access AWS services.
# Trusted by both Lambda and ECS task principals so every addon
# `aws_iam_role_policy` attachment targeting this role works on both targets.
data "aws_iam_policy_document" "lambda_task_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com", "ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_role" {
  name               = "${local.app_name}-task-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_task_trust.json
}

# VPC ENI management plus CloudWatch Logs delivery (this single managed
# policy includes the AWSLambdaBasicExecutionRole log permissions).
resource "aws_iam_role_policy_attachment" "lambda_vpc_access" {
  role       = aws_iam_role.task_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Allows application code to read the shared Secrets Manager vault at
# runtime via the APP_SECRETS_ARN environment variable (non-VPC functions
# reach Secrets Manager directly; VPC-attached functions should prefer
# plain environment variables injected with `grada add`).
resource "aws_iam_role_policy" "app_secrets_access" {
  name = "${local.app_name}-app-secrets-policy"
  role = aws_iam_role.task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [local.secret_arn]
      }
    ]
  })
}

# --- Lambda Function (container image + Web Adapter) ---
resource "aws_lambda_function" "app" {
  function_name = "${local.app_name}-fn"
  role          = aws_iam_role.task_role.arn
  package_type  = "Image"
  # Lambda requires an image in a private same-account ECR repository.
  # On Day 0 `grada apply` seeds a minimal placeholder under :latest
  # (see src/utils/lambda-ecr.js); every CI push then deploys the real image
  # via `aws lambda update-function-code`, which Terraform intentionally
  # ignores here so code deploys and `terraform apply` never fight.
  image_uri     = "${local.ecr_url}:latest"
  architectures = ["x86_64"]
  memory_size   = 512
  timeout       = 30

{{LAMBDA_IMAGE_CONFIG}}
{{LAMBDA_VPC_CONFIG}}
  environment {
    variables = {
      PORT            = "{{PORT}}"
      AWS_LWA_PORT    = "{{PORT}}"
      APP_SECRETS_ARN = local.secret_arn
{{DB_ENV_VARS}}{{COMPOSE_WEB_ENV_VARS}}
    }
  }

  lifecycle {
    ignore_changes = [image_uri]
  }

  depends_on = [aws_cloudwatch_log_group.app]
}

# --- API Gateway HTTP API v2 ---
resource "aws_apigatewayv2_api" "main" {
  name          = "${local.app_name}-http-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.app.invoke_arn
  payload_format_version = "2.0"
}

# The $default open route is intentional: authentication (if any) lives in the
# application, matching the public-ALB posture of the ECS target.
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.app.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# --- Outputs ---
output "api_gateway_url" {
  description = "Direct API Gateway HTTP API URL (Bypasses CloudFront/CDN)"
  value       = aws_apigatewayv2_api.main.api_endpoint
}

output "ecr_repository_url" {
  description = "The URL of the ECR repository"
  value       = local.ecr_url
}

# --- CloudWatch Alarms ---
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${local.app_name}-high-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = "60"
  statistic           = "Sum"
  threshold           = "10"
  alarm_description   = "Triggers if the Lambda function reports more than 10 errors in 2 minutes."

  dimensions = {
    FunctionName = aws_lambda_function.app.function_name
  }
}
