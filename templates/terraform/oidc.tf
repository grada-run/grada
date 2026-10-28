# Fetch GitHub's OIDC certificate thumbprint
data "tls_certificate" "github" {
  url = "https://token.actions.githubusercontent.com"
}

variable "create_oidc_provider" {
  description = "Set to false if you already have OIDC provider in your AWS account"
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

# Dynamically pick the ARN of the provider based on the variable
locals {
  github_provider_arn = (var.create_oidc_provider && terraform.workspace == "default") ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github_existing[0].arn
}

# Create the IAM Role that GitHub Actions will assume
resource "aws_iam_role" "github_actions" {
  count = terraform.workspace == "default" ? 1 : 0
  name  = "{{PROJECT_NAME}}{{RESOURCE_SUFFIX}}-github-actions-role"

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
            # remote, or the setup prompt. "repo:*" means any GitHub repo's
            # Actions can assume this role — re-scope before going live.
            # Scoped trusts render both subject-claim formats: the classic
            # `repo:<owner>/<name>:*` plus the immutable-claim companion
            # `repo:<owner>@*/<name>@*:*` (repos created after 2026-07-15).
            "token.actions.githubusercontent.com:sub" : {{GITHUB_REPO_SUB}}
          }
          StringEquals = {
            "token.actions.githubusercontent.com:aud" : "sts.amazonaws.com"
          }
        }
      }
    ]
  })
}

# Grant the CI/CD pipeline permissions to provision infrastructure.
# Intentionally broad: this role runs full Terraform applies from CI.
# Narrow only with a reviewed least-privilege policy.
resource "aws_iam_role_policy_attachment" "github_actions_admin" {
  count      = terraform.workspace == "default" ? 1 : 0
  role       = aws_iam_role.github_actions[0].name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
