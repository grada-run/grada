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
  # Shared twin resource lists: every Deny*/BoundaryDeny* pair consumes
  # one list, so a one-sided resource edit is impossible. New pairs add
  # their list here and reference it from both sides. Wildcards below
  # anchor on prod_prefix (never on the bare project): preview names
  # carry -pr-<n>- where prod carries the hex suffix, so a
  # ${prod_prefix}-* pattern matches prod only. Anchoring also keeps
  # the boundary under the 6144-char managed-policy quota that broke
  # tier1 E2E at a 24-char prefix — prefer one anchored wildcard over
  # several exact ARNs when adding entries.
  guardrail_compute_abuse_resources    = ["*"]
  guardrail_snapshot_sharing_resources = ["*"]
  guardrail_state_destruction_resources = [
    "arn:aws:s3:::{{STATE_BUCKET}}*",
  ]
  guardrail_ecs_shutdown_resources = [
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:cluster/${local.prod_prefix}-cluster",
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:service/${local.prod_prefix}-cluster/*",
  ]
  guardrail_image_deletion_resources = [
    "arn:aws:ecr:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:repository/${local.prod_prefix}-repo",
  ]
  guardrail_lambda_rewrite_resources = [
    "arn:aws:lambda:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:function:${local.prod_prefix}-fn",
  ]
  guardrail_queue_destruction_resources = [
    "arn:aws:sqs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:${local.prod_prefix}-*",
  ]
  guardrail_database_destruction_resources = [
    "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:db:${local.prod_prefix}-db*",
  ]
  guardrail_aurora_destruction_resources = [
    "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:cluster:${local.prod_prefix}-db-cluster",
  ]
  guardrail_table_deletion_resources = [
    "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/${local.prod_prefix}-table",
  ]
  guardrail_snapshot_deletion_resources = [
    "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:snapshot:${local.prod_prefix}-db-*",
    "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:cluster-snapshot:${local.prod_prefix}-db-cluster-*",
    # BUG-205: legacy bare pre-deploy-<sha> ids carry no db prefix, so
    # they match no prod pattern above — deny them outright. gc never
    # runs under preview credentials, so nothing legitimate needs them.
    "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:snapshot:pre-deploy-*",
    "arn:aws:rds:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:cluster-snapshot:pre-deploy-*",
  ]
  guardrail_secrets_deletion_resources = [
    "arn:aws:secretsmanager:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:secret:${local.prod_prefix}-secrets-*",
  ]
  guardrail_log_deletion_resources = [
    "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/${local.prod_prefix}",
  ]
  guardrail_task_execution_resources = [
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:cluster/${local.prod_prefix}-cluster",
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:service/${local.prod_prefix}-cluster/*",
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:task/${local.prod_prefix}-cluster/*",
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:task-definition/${local.prod_prefix}-*:*",
  ]
  guardrail_task_definition_resources = [
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:task-definition/${local.prod_prefix}-*:*",
  ]
  # String-built (not HCL refs): static trees define no IAM roles, so
  # refs would dangle and fail validate. ECS and Lambda use identical
  # physical role names, so one pattern covers both and matches
  # nothing on static. The wildcard also covers the CI roles (same
  # prefix, -github-actions-*-role): capped callers never legitimately
  # pass or mutate those, so the overlap only tightens the boundary.
  guardrail_app_role_resources = [
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.prod_prefix}-*-role",
  ]
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
# IAM backdoors. Every Resource below names production only — exact ARNs
# or prod_prefix-anchored wildcards (preview names carry -pr-<n>- where
# prod carries the hex suffix, so anchored patterns never match preview
# resources and pr-suffixed workflows keep working).
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
        Resource = local.guardrail_compute_abuse_resources
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
        Resource = local.guardrail_snapshot_sharing_resources
      },
      {
        Sid      = "DenyProdStateDestruction"
        Effect   = "Deny"
        Action   = ["s3:DeleteBucket", "s3:DeleteObjectVersion"]
        Resource = local.guardrail_state_destruction_resources
      },
      {
        Sid      = "DenyProdECSShutdown"
        Effect   = "Deny"
        Action   = ["ecs:UpdateService", "ecs:DeleteService", "ecs:DeleteCluster"]
        Resource = local.guardrail_ecs_shutdown_resources
      },
      {
        Sid      = "DenyProdImageDeletion"
        Effect   = "Deny"
        Action   = ["ecr:BatchDeleteImage"]
        Resource = local.guardrail_image_deletion_resources
      },
      {
        Sid      = "DenyProdLambdaRewrite"
        Effect   = "Deny"
        Action   = ["lambda:UpdateFunctionCode", "lambda:DeleteFunction"]
        Resource = local.guardrail_lambda_rewrite_resources
      },
      {
        Sid      = "DenyProdQueueDestruction"
        Effect   = "Deny"
        Action   = ["sqs:PurgeQueue", "sqs:DeleteQueue"]
        Resource = local.guardrail_queue_destruction_resources
      },
      {
        Sid      = "DenyProdDatabaseDestruction"
        Effect   = "Deny"
        Action   = ["rds:DeleteDBInstance", "rds:ModifyDBInstance"]
        Resource = local.guardrail_database_destruction_resources
      },
      {
        Sid      = "DenyProdAuroraDestruction"
        Effect   = "Deny"
        Action   = ["rds:DeleteDBCluster", "rds:ModifyDBCluster"]
        Resource = local.guardrail_aurora_destruction_resources
      },
      {
        Sid      = "DenyProdTableDeletion"
        Effect   = "Deny"
        Action   = ["dynamodb:DeleteTable"]
        Resource = local.guardrail_table_deletion_resources
      },
      {
        # BUG-208: manual snapshots (grada names them
        # <db-identifier>-manual-<stamp> and
        # <db-identifier>-pre-deploy-<sha>) are directly deletable;
        # automated snapshots can only go away via retention changes or
        # instance deletion, both already denied above.
        Sid      = "DenyProdSnapshotDeletion"
        Effect   = "Deny"
        Action   = ["rds:DeleteDBSnapshot", "rds:DeleteDBClusterSnapshot"]
        Resource = local.guardrail_snapshot_deletion_resources
      },
      {
        # The vault ARN carries a random suffix and static trees have no
        # vault at all (no secrets.tf), so match the tight name prefix —
        # on static it simply matches nothing.
        Sid      = "DenyProdSecretsDeletion"
        Effect   = "Deny"
        Action   = ["secretsmanager:DeleteSecret"]
        Resource = local.guardrail_secrets_deletion_resources
      },
      {
        # Web and worker containers share one log group; deleting it
        # wipes the audit trail for both.
        Sid      = "DenyProdLogDeletion"
        Effect   = "Deny"
        Action   = ["logs:DeleteLogGroup"]
        Resource = local.guardrail_log_deletion_resources
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
      {
        # BUG-215: close by target — deny the execution APIs on prod
        # ARNs while pr-* stays allowed. No describes: plan.yml
        # refreshes prod state with preview credentials, so describing
        # prod is legitimate traffic.
        Sid      = "DenyProdTaskExecution"
        Effect   = "Deny"
        Action   = ["ecs:RunTask", "ecs:StopTask", "ecs:ExecuteCommand", "ecs:CreateService"]
        Resource = local.guardrail_task_execution_resources
      },
      {
        # RegisterTaskDefinition is likely resource-*-only (void half);
        # the cluster-scoped RunTask deny above is the real choke.
        Sid      = "DenyProdTaskDefinitionRegistration"
        Effect   = "Deny"
        Action   = ["ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition"]
        Resource = local.guardrail_task_definition_resources
      },
      {
        Sid      = "DenyProdPassRole"
        Effect   = "Deny"
        Action   = ["iam:PassRole"]
        Resource = local.guardrail_app_role_resources
      },
      {
        # Trust writes close the assume-it-directly bypass (re-trusting
        # the prod task role would defeat every execution deny);
        # DeleteRole guards the roles themselves. UpdateRole and
        # tagging stay allowed (cosmetic — description, session
        # duration within AWS bounds, tags).
        Sid      = "DenyProdAppRoleMutation"
        Effect   = "Deny"
        Action   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:DeleteRole"]
        Resource = local.guardrail_app_role_resources
      },
    ]
  })
}

# BUG-212: permissions boundary capping every role preview credentials
# can create. The guardrail above denies CreateRole unless the request
# carries this boundary, so a backdoor role is born capped: its
# effective permissions are its own policies intersected with this one.
# Deny-list shape (default-allow) on purpose: a missing entry weakens
# security instead of breaking prod tasks. Twin pairs share their
# resource lists via the locals above, so one-sided edits fail loudly.
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
        # BUG-214: capped roles must pass their task roles to ECS (the
        # scheduler role passes at invocation time), so PassRole is
        # carved out here and re-gated on service + target below.
        # Explicit Action list on purpose: a Deny with NotAction would
        # veto every AWS service, not just IAM (tier2 E2E proved it on
        # secretsmanager:GetSecretValue, SES, and Bedrock). IAM reads
        # and cosmetic writes (UpdateRole, tagging) stay allowed: they
        # cannot escalate a backdoor role, and a missing entry must
        # weaken security instead of breaking prod tasks.
        Sid      = "BoundaryDenyIAM"
        Effect   = "Deny"
        Action   = ["iam:CreateRole", "iam:DeleteRole", "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary", "iam:CreatePolicy", "iam:DeletePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:CreateUser", "iam:DeleteUser", "iam:CreateAccessKey", "iam:DeleteAccessKey"]
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
        Resource = local.guardrail_compute_abuse_resources
      },
      {
        Sid      = "BoundaryDenySnapshotSharing"
        Effect   = "Deny"
        Action   = ["rds:ModifyDBSnapshotAttribute"]
        Resource = local.guardrail_snapshot_sharing_resources
      },
      {
        Sid      = "BoundaryDenyStateDestruction"
        Effect   = "Deny"
        Action   = ["s3:DeleteBucket", "s3:DeleteObjectVersion"]
        Resource = local.guardrail_state_destruction_resources
      },
      {
        Sid      = "BoundaryDenyECSShutdown"
        Effect   = "Deny"
        Action   = ["ecs:UpdateService", "ecs:DeleteService", "ecs:DeleteCluster"]
        Resource = local.guardrail_ecs_shutdown_resources
      },
      {
        Sid      = "BoundaryDenyImageDeletion"
        Effect   = "Deny"
        Action   = ["ecr:BatchDeleteImage"]
        Resource = local.guardrail_image_deletion_resources
      },
      {
        Sid      = "BoundaryDenyLambdaRewrite"
        Effect   = "Deny"
        Action   = ["lambda:UpdateFunctionCode", "lambda:DeleteFunction"]
        Resource = local.guardrail_lambda_rewrite_resources
      },
      {
        Sid      = "BoundaryDenyQueueDestruction"
        Effect   = "Deny"
        Action   = ["sqs:PurgeQueue", "sqs:DeleteQueue"]
        Resource = local.guardrail_queue_destruction_resources
      },
      {
        Sid      = "BoundaryDenyDatabaseDestruction"
        Effect   = "Deny"
        Action   = ["rds:DeleteDBInstance", "rds:ModifyDBInstance"]
        Resource = local.guardrail_database_destruction_resources
      },
      {
        Sid      = "BoundaryDenyAuroraDestruction"
        Effect   = "Deny"
        Action   = ["rds:DeleteDBCluster", "rds:ModifyDBCluster"]
        Resource = local.guardrail_aurora_destruction_resources
      },
      {
        Sid      = "BoundaryDenyTableDeletion"
        Effect   = "Deny"
        Action   = ["dynamodb:DeleteTable"]
        Resource = local.guardrail_table_deletion_resources
      },
      {
        Sid      = "BoundaryDenySnapshotDeletion"
        Effect   = "Deny"
        Action   = ["rds:DeleteDBSnapshot", "rds:DeleteDBClusterSnapshot"]
        Resource = local.guardrail_snapshot_deletion_resources
      },
      {
        Sid      = "BoundaryDenySecretsDeletion"
        Effect   = "Deny"
        Action   = ["secretsmanager:DeleteSecret"]
        Resource = local.guardrail_secrets_deletion_resources
      },
      {
        Sid      = "BoundaryDenyLogDeletion"
        Effect   = "Deny"
        Action   = ["logs:DeleteLogGroup"]
        Resource = local.guardrail_log_deletion_resources
      },
      {
        Sid      = "BoundaryDenyTaskExecution"
        Effect   = "Deny"
        Action   = ["ecs:RunTask", "ecs:StopTask", "ecs:ExecuteCommand", "ecs:CreateService"]
        Resource = local.guardrail_task_execution_resources
      },
      {
        Sid      = "BoundaryDenyTaskDefinitionRegistration"
        Effect   = "Deny"
        Action   = ["ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition"]
        Resource = local.guardrail_task_definition_resources
      },
      {
        Sid      = "BoundaryDenyPassRole"
        Effect   = "Deny"
        Action   = ["iam:PassRole"]
        Resource = local.guardrail_app_role_resources
      },
      {
        Sid      = "BoundaryDenyAppRoleMutation"
        Effect   = "Deny"
        Action   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:DeleteRole"]
        Resource = local.guardrail_app_role_resources
      },
      {
        # BUG-214: carved PassRole may only pass to the ECS tasks
        # service (mirrors the scheduler policy's own condition).
        Sid      = "BoundaryDenyPassRoleOffService"
        Effect   = "Deny"
        Action   = ["iam:PassRole"]
        Resource = "*"
        Condition = {
          StringNotEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
      {
        # ... and only task roles: preview patterns plus the prod pair
        # (shared local, so renames flow). Preview app names put the
        # workspace between the project and the collision suffix
        # (<project>-pr-<n>-<suffix>), so the preview patterns key off
        # {{PROJECT_NAME}}, not prod_prefix. Prod roles stay
        # scheduler-only via the statement below.
        Sid    = "BoundaryDenyPassRoleOffTarget"
        Effect = "Deny"
        Action = ["iam:PassRole"]
        NotResource = concat([
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/{{PROJECT_NAME}}-pr-*-task-role",
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/{{PROJECT_NAME}}-pr-*-execution-role",
        ], local.guardrail_app_role_resources)
      },
      {
        # Prod task roles pass only by the prod scheduler role, which
        # passes them at invocation time (its own policy allows only
        # those two roles, so the boundary stays a backstop). Every
        # other capped caller stays denied, and the scheduler itself
        # cannot pass anything outside the four roles above.
        Sid      = "BoundaryDenyProdPassRoleOffScheduler"
        Effect   = "Deny"
        Action   = ["iam:PassRole"]
        Resource = local.guardrail_app_role_resources
        Condition = {
          StringNotEquals = {
            "aws:PrincipalArn" = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.prod_prefix}-cron-scheduler-role"
          }
        }
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
