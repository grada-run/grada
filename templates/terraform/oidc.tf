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
  # Boundary ARN resolving in every workspace: created in default, read
  # everywhere else (mirrors the secrets-vault pattern). Consumed by the
  # task/execution/cron roles, which static trees lack.
  # tflint-ignore: terraform_unused_declarations
  preview_boundary_arn = terraform.workspace == "default" ? aws_iam_policy.preview_boundary[0].arn : data.aws_iam_policy.preview_boundary[0].arn
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
        # BUG-207: the preview role carries IAMFullAccess, so without this
        # statement it can delete its own guardrails, delete the deploy
        # role, or widen trust in one call. Scoped to the CI role ARNs
        # (not *): preview stacks legitimately manage their own
        # pr-suffixed IAM roles. The deploy role keeps full IAM power on
        # purpose — it runs on the trusted branch and needs it for the
        # re-init trust migration.
        Sid    = "DenyCIRoleMutation"
        Effect = "Deny"
        Action = ["iam:DeleteRole", "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy"]
        Resource = [
          aws_iam_role.github_actions_deploy[0].arn,
          aws_iam_role.github_actions_preview[0].arn,
        ]
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
          "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:service/${local.prod_prefix}-cluster/${local.prod_prefix}-worker-service",
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
      {
        # BUG-208: manual snapshots (grada names them
        # <db-identifier>-manual-<stamp>) are directly deletable;
        # automated snapshots can only go away via retention changes or
        # instance deletion, both already denied above.
        Sid    = "DenyProdSnapshotDeletion"
        Effect = "Deny"
        Action = ["rds:DeleteDBSnapshot", "rds:DeleteDBClusterSnapshot"]
        Resource = [
          "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:snapshot:${local.prod_prefix}-db-*",
          "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:cluster-snapshot:${local.prod_prefix}-db-cluster-*",
        ]
      },
      {
        # The vault ARN carries a random suffix and static trees have no
        # vault at all (no secrets.tf), so match the tight name prefix —
        # on static it simply matches nothing.
        Sid    = "DenyProdSecretsDeletion"
        Effect = "Deny"
        Action = ["secretsmanager:DeleteSecret"]
        Resource = [
          "arn:aws:secretsmanager:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:secret:${local.prod_prefix}-secrets-*",
        ]
      },
      {
        # Web and worker containers share one log group; deleting it
        # wipes the audit trail for both.
        Sid    = "DenyProdLogDeletion"
        Effect = "Deny"
        Action = ["logs:DeleteLogGroup"]
        Resource = [
          "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/${local.prod_prefix}",
        ]
      },
      {
        # BUG-212: every role preview credentials create must carry the
        # boundary — a missing key fails StringNotEquals, so unbounded
        # creation is denied and born-capped roles cannot escalate.
        Sid      = "DenyRoleWithoutBoundary"
        Effect   = "Deny"
        Action   = ["iam:CreateRole"]
        Resource = "*"
        Condition = {
          StringNotEquals = {
            "iam:PermissionsBoundary" = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/${local.prod_prefix}-preview-boundary"
          }
        }
      },
      {
        # The boundary cannot be swapped or removed after creation:
        # legitimate Terraform never touches it (stable ARN, and
        # deleting a role needs no boundary call).
        Sid      = "DenyBoundarySwap"
        Effect   = "Deny"
        Action   = ["iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"]
        Resource = "*"
      },
      {
        # The boundary policy itself cannot be neutered (preview
        # Terraform never manages it: this file is
        # default-workspace-only).
        Sid    = "DenyBoundaryMutation"
        Effect = "Deny"
        Action = ["iam:*"]
        Resource = [
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/${local.prod_prefix}-preview-boundary",
        ]
      },
    ]
  })
}

# BUG-212: permissions boundary capping every role preview credentials
# can create. The guardrail above denies CreateRole unless the request
# carries this boundary, so a backdoor role is born capped: its
# effective permissions are its own policies intersected with this one.
# Deny-list shape (default-allow) on purpose: a missing entry weakens
# security instead of breaking prod tasks. Keep the data denies in sync
# with preview_guardrails above.
resource "aws_iam_policy" "preview_boundary" {
  count       = terraform.workspace == "default" ? 1 : 0
  name        = "${local.prod_prefix}-preview-boundary"
  description = "Permissions boundary capping roles created by preview CI runs"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "BoundaryBaseAllow"
        Effect   = "Allow"
        Action   = "*"
        Resource = "*"
      },
      {
        Sid      = "BoundaryDenyIAM"
        Effect   = "Deny"
        Action   = ["iam:*"]
        Resource = "*"
      },
      {
        Sid      = "BoundaryDenyAuditBilling"
        Effect   = "Deny"
        Action   = ["cloudtrail:*", "organizations:*", "aws-portal:*", "billing:*"]
        Resource = "*"
      },
      {
        Sid      = "BoundaryDenyComputeAbuse"
        Effect   = "Deny"
        Action   = ["ec2:RunInstances"]
        Resource = "*"
      },
      {
        Sid      = "BoundaryDenySnapshotSharing"
        Effect   = "Deny"
        Action   = ["rds:ModifyDBSnapshotAttribute"]
        Resource = "*"
      },
      {
        Sid    = "BoundaryDenyStateDestruction"
        Effect = "Deny"
        Action = ["s3:DeleteBucket", "s3:DeleteObjectVersion"]
        Resource = [
          "arn:aws:s3:::{{STATE_BUCKET}}",
          "arn:aws:s3:::{{STATE_BUCKET}}/*",
        ]
      },
      {
        Sid    = "BoundaryDenyECSShutdown"
        Effect = "Deny"
        Action = ["ecs:UpdateService", "ecs:DeleteService", "ecs:DeleteCluster"]
        Resource = [
          "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:cluster/${local.prod_prefix}-cluster",
          "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:service/${local.prod_prefix}-cluster/${local.prod_prefix}-service",
          "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:service/${local.prod_prefix}-cluster/${local.prod_prefix}-worker-service",
        ]
      },
      {
        Sid    = "BoundaryDenyImageDeletion"
        Effect = "Deny"
        Action = ["ecr:BatchDeleteImage"]
        Resource = [
          "arn:aws:ecr:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:repository/${local.prod_prefix}-repo",
        ]
      },
      {
        Sid    = "BoundaryDenyLambdaRewrite"
        Effect = "Deny"
        Action = ["lambda:UpdateFunctionCode", "lambda:DeleteFunction"]
        Resource = [
          "arn:aws:lambda:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:function:${local.prod_prefix}-fn",
        ]
      },
      {
        Sid    = "BoundaryDenyQueueDestruction"
        Effect = "Deny"
        Action = ["sqs:PurgeQueue", "sqs:DeleteQueue"]
        Resource = [
          "arn:aws:sqs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:${local.prod_prefix}-queue",
          "arn:aws:sqs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:${local.prod_prefix}-dlq",
        ]
      },
      {
        Sid    = "BoundaryDenyDatabaseDestruction"
        Effect = "Deny"
        Action = ["rds:DeleteDBInstance", "rds:ModifyDBInstance"]
        Resource = [
          "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:db:${local.prod_prefix}-db",
          "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:db:${local.prod_prefix}-db-instance-1",
        ]
      },
      {
        Sid    = "BoundaryDenyAuroraDestruction"
        Effect = "Deny"
        Action = ["rds:DeleteDBCluster", "rds:ModifyDBCluster"]
        Resource = [
          "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:cluster:${local.prod_prefix}-db-cluster",
        ]
      },
      {
        Sid    = "BoundaryDenyTableDeletion"
        Effect = "Deny"
        Action = ["dynamodb:DeleteTable"]
        Resource = [
          "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/${local.prod_prefix}-table",
        ]
      },
      {
        Sid    = "BoundaryDenySnapshotDeletion"
        Effect = "Deny"
        Action = ["rds:DeleteDBSnapshot", "rds:DeleteDBClusterSnapshot"]
        Resource = [
          "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:snapshot:${local.prod_prefix}-db-*",
          "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:cluster-snapshot:${local.prod_prefix}-db-cluster-*",
        ]
      },
      {
        Sid    = "BoundaryDenySecretsDeletion"
        Effect = "Deny"
        Action = ["secretsmanager:DeleteSecret"]
        Resource = [
          "arn:aws:secretsmanager:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:secret:${local.prod_prefix}-secrets-*",
        ]
      },
      {
        Sid    = "BoundaryDenyLogDeletion"
        Effect = "Deny"
        Action = ["logs:DeleteLogGroup"]
        Resource = [
          "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/${local.prod_prefix}",
        ]
      },
    ]
  })
}

# Preview workspaces create pr-suffixed roles through the same templates,
# so they read the default workspace's boundary instead of creating one
# (IAM names are account-global).
data "aws_iam_policy" "preview_boundary" {
  count = terraform.workspace == "default" ? 0 : 1
  name  = "${local.prod_prefix}-preview-boundary"
}
