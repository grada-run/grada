# Fetch GitHub's OIDC certificate thumbprint
data "tls_certificate" "github" {
  url = "https://token.actions.githubusercontent.com"
}

variable "create_oidc_provider" {
  description = "Set to false if you already have an OIDC provider in your AWS account"
  type        = bool
  default     = true
}

# Register GitHub as an Identity Provider in AWS (Production Only)
resource "aws_iam_openid_connect_provider" "github" {
  count           = (var.create_oidc_provider && terraform.workspace == "default") ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github.certificates[0].sha1_fingerprint]
}

# Reference the Provider (whether newly created or already existing)
data "aws_iam_openid_connect_provider" "github_existing" {
  count = (var.create_oidc_provider && terraform.workspace == "default") ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

# Canonical home for the account/region data sources: every generated tree
# includes this file, so conditional templates must reference (never
# redeclare) these blocks.
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Dynamically pick the ARN of the provider based on the variable
locals {
  github_provider_arn = (var.create_oidc_provider && terraform.workspace == "default") ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github_existing[0].arn
  # Production resource prefix for the guardrail policies below. Rendered
  # (not local.app_name): app_name carries the workspace suffix in preview
  # workspaces, while these denies must always name production.
  prod_prefix = "{{PROJECT_NAME}}{{RESOURCE_SUFFIX}}"
}

# Deploy role FIRST: readTerraformOidcTrust anchors on this block so re-init
# resolves trust from the deploy claim even if the file is reordered.
resource "aws_iam_role" "github_actions_deploy" {
  count = terraform.workspace == "default" ? 1 : 0
  name  = "{{DEPLOY_ROLE_NAME}}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRoleWithWebIdentity"
        Effect = "Allow"
        Principal = {
          Federated = local.github_provider_arn
        }
        Condition = {
          StringLike = {
            # CI trust, scoped at scaffold time from --github-repo, the git
            # remote, or the setup prompt, then bound to the deploy branch.
            # "repo:*" means any GitHub repo's Actions can assume this role —
            # re-scope before going live. Scoped trusts render both
            # subject-claim formats: the classic `repo:<owner>/<name>:...`
            # plus the immutable-claim companion
            # `repo:<owner>@*/<name>@*:...` (repos created after 2026-07-15).
            "token.actions.githubusercontent.com:sub" : {{GITHUB_DEPLOY_SUB}}
          }
          StringEquals = {
            "token.actions.githubusercontent.com:aud" : "sts.amazonaws.com"
          }
        }
      },
    ]
  })
}

resource "aws_iam_role" "github_actions_preview" {
  count = terraform.workspace == "default" ? 1 : 0
  name  = "{{PREVIEW_ROLE_NAME}}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRoleWithWebIdentity"
        Effect = "Allow"
        Principal = {
          Federated = local.github_provider_arn
        }
        Condition = {
          StringLike = {
            # Same scoping as the deploy role, bound to pull request events
            # instead of the deploy branch.
            "token.actions.githubusercontent.com:sub" : {{GITHUB_PREVIEW_SUB}}
          }
          StringEquals = {
            "token.actions.githubusercontent.com:aud" : "sts.amazonaws.com"
          }
        }
      },
    ]
  })
}

# Least-privilege baselines for the CI/CD pipeline: full service power
# without standing AdministratorAccess. Guardrail policies below carve out
# the audit planes (deploy) and production data + compute (preview).
resource "aws_iam_role_policy_attachment" "deploy_poweruser" {
  count      = terraform.workspace == "default" ? 1 : 0
  role       = aws_iam_role.github_actions_deploy[0].name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

resource "aws_iam_role_policy_attachment" "deploy_iam_full" {
  count      = terraform.workspace == "default" ? 1 : 0
  role       = aws_iam_role.github_actions_deploy[0].name
  policy_arn = "arn:aws:iam::aws:policy/IAMFullAccess"
}

resource "aws_iam_role_policy_attachment" "preview_poweruser" {
  count      = terraform.workspace == "default" ? 1 : 0
  role       = aws_iam_role.github_actions_preview[0].name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

resource "aws_iam_role_policy_attachment" "preview_iam_full" {
  count      = terraform.workspace == "default" ? 1 : 0
  role       = aws_iam_role.github_actions_preview[0].name
  policy_arn = "arn:aws:iam::aws:policy/IAMFullAccess"
}

# Deploy boundary: even the deploy role cannot touch the audit and billing
# planes or delete the state bucket backing every workspace.
resource "aws_iam_role_policy" "deploy_boundary" {
  count = terraform.workspace == "default" ? 1 : 0
  name  = "${local.prod_prefix}-deploy-boundary"
  role  = aws_iam_role.github_actions_deploy[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DenyAuditBillingPlanes"
        Effect   = "Deny"
        Action   = ["cloudtrail:*", "organizations:*", "aws-portal:*", "billing:*"]
        Resource = "*"
      },
      {
        Sid      = "DenyStateBucketDeletion"
        Effect   = "Deny"
        Action   = ["s3:DeleteBucket"]
        Resource = ["arn:aws:s3:::{{STATE_BUCKET}}"]
      },
    ]
  })
}

# Preview guardrails: PR-triggered runs (preview/teardown/plan) keep full
# build power but cannot destroy production data, mint compute, or open
# IAM backdoors. Every Resource below names an exact production ARN —
# never a wildcard — so pr-suffixed preview resources keep working.
resource "aws_iam_role_policy" "preview_guardrails" {
  count = terraform.workspace == "default" ? 1 : 0
  name  = "${local.prod_prefix}-preview-guardrails"
  role  = aws_iam_role.github_actions_preview[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DenyComputeAbuse"
        Effect   = "Deny"
        Action   = ["ec2:RunInstances"]
        Resource = "*"
      },
      {
        Sid      = "DenyIAMBackdoors"
        Effect   = "Deny"
        Action   = ["iam:CreateUser", "iam:CreateAccessKey"]
        Resource = "*"
      },
      {
        Sid      = "DenySnapshotSharing"
        Effect   = "Deny"
        Action   = ["rds:ModifyDBSnapshotAttribute"]
        Resource = "*"
      },
      {
        Sid    = "DenyProdStateDestruction"
        Effect = "Deny"
        Action = ["s3:DeleteBucket", "s3:DeleteObjectVersion"]
        Resource = [
          "arn:aws:s3:::{{STATE_BUCKET}}",
          "arn:aws:s3:::{{STATE_BUCKET}}/*",
        ]
      },
      {
        Sid    = "DenyProdECSShutdown"
        Effect = "Deny"
        Action = ["ecs:UpdateService", "ecs:DeleteService", "ecs:DeleteCluster"]
        Resource = [
          "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:cluster/${local.prod_prefix}-cluster",
          "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:service/${local.prod_prefix}-cluster/${local.prod_prefix}-service",
          "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:service/${local.prod_prefix}-service",
        ]
      },
      {
        Sid    = "DenyProdImageDeletion"
        Effect = "Deny"
        Action = ["ecr:BatchDeleteImage"]
        Resource = [
          "arn:aws:ecr:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:repository/${local.prod_prefix}-repo",
        ]
      },
      {
        Sid    = "DenyProdLambdaRewrite"
        Effect = "Deny"
        Action = ["lambda:UpdateFunctionCode", "lambda:DeleteFunction"]
        Resource = [
          "arn:aws:lambda:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:function:${local.prod_prefix}-fn",
        ]
      },
      {
        Sid    = "DenyProdQueueDestruction"
        Effect = "Deny"
        Action = ["sqs:PurgeQueue", "sqs:DeleteQueue"]
        Resource = [
          "arn:aws:sqs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:${local.prod_prefix}-queue",
          "arn:aws:sqs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:${local.prod_prefix}-dlq",
        ]
      },
      {
        Sid    = "DenyProdDatabaseDestruction"
        Effect = "Deny"
        Action = ["rds:DeleteDBInstance", "rds:ModifyDBInstance"]
        Resource = [
          "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:db:${local.prod_prefix}-db",
          "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:db:${local.prod_prefix}-db-instance-1",
        ]
      },
      {
        Sid    = "DenyProdAuroraDestruction"
        Effect = "Deny"
        Action = ["rds:DeleteDBCluster", "rds:ModifyDBCluster"]
        Resource = [
          "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:cluster:${local.prod_prefix}-db-cluster",
        ]
      },
      {
        Sid    = "DenyProdTableDeletion"
        Effect = "Deny"
        Action = ["dynamodb:DeleteTable"]
        Resource = [
          "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/${local.prod_prefix}-table",
        ]
      },
    ]
  })
}
