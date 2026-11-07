# Specification: Least-Privilege CI Roles & PR Isolation

## 1. Context & Problem
Currently, Grada scaffolds a single AWS IAM Role in `terraform/oidc.tf` granting `AdministratorAccess`. All CI workflows assume this exact role. 

Because GitHub Actions treats `pull_request_target` from forks as having the base repository's identity, an attacker submitting a fork PR could potentially modify the CI workflow to execute arbitrary Terraform against the production environment or spin up crypto-miners using the administrative role. We must split the IAM roles by branch context, strip `AdministratorAccess`, and implement explicit threat-modeled guardrails.

## 2. Scope of Work
Refactor `terraform/oidc.tf` to provision two distinct IAM roles unconditionally: a **Deploy Role** (bound to the default deploy branch with a hardened PowerUser baseline) and a **Preview Role** (bound to PRs with explicit denials protecting production data and compute). Update all workflow templates across all targets (`ecs`, `lambda`, `static`) to use the appropriate role.

## 3. Implementation Details

1. **OIDC Trust Policy Separation & Naming**:
   - Generate both roles unconditionally in `oidc.tf`.
   - **Deploy Role (`{{PROJECT_NAME}}{{RESOURCE_SUFFIX}}-github-actions-deploy-role`)**: 
     - Restrict the OIDC `Condition` to the project's configured deploy branch:
       `StringLike: { "token.actions.githubusercontent.com:sub": "repo:${repo}:ref:refs/heads/{{DEPLOY_BRANCH}}" }`
   - **Preview Role (`{{PROJECT_NAME}}{{RESOURCE_SUFFIX}}-github-actions-preview-role`)**: 
     - Restrict the OIDC `Condition` to pull requests:
       `StringLike: { "token.actions.githubusercontent.com:sub": "repo:${repo}:pull_request" }`
   - *Fallback:* If the repo cannot be determined at scaffold time, both roles fall back to the open `repo:*` trust with the standard warning.

2. **Permissions & Least-Privilege Guardrails**:
   - Remove `AdministratorAccess` completely.
   - **Deploy Role Permissions:**
     - Attach AWS managed policies: `PowerUserAccess` and `IAMFullAccess`.
     - Attach an explicit boundary `Deny` policy: Deny `cloudtrail:*`, `organizations:*`, `aws-portal:*`/`billing:*`, and deny `s3:DeleteBucket` specifically on the Terraform state bucket.
   - **Preview Role Explicit Deny List (Protecting Production & Compute):**
     - *Compute Abuse:* Deny `ec2:RunInstances`.
     - *IAM Backdoors:* Deny `iam:CreateUser`, `iam:CreateAccessKey`.
     - *State & Data Protection:* Deny destructive actions strictly on **Production ARNs only** (never wildcards, or `teardown.yml` will break).
       - S3: Deny `s3:DeleteBucket`, `s3:DeleteObjectVersion` (protects state bucket and app storage buckets).
       - ECS: Deny `ecs:UpdateService`, `ecs:DeleteService`, `ecs:DeleteCluster`.
       - ECR: Deny `ecr:BatchDeleteImage`.
       - Lambda: Deny `lambda:UpdateFunctionCode`, `lambda:DeleteFunction`.
       - SQS: Deny `sqs:PurgeQueue`, `sqs:DeleteQueue`.
       - RDS & Aurora: Deny `rds:DeleteDBInstance`, `rds:ModifyDBInstance`, `rds:ModifyDBSnapshotAttribute`, `rds:DeleteDBCluster`, `rds:ModifyDBCluster`.
       - DynamoDB: Deny `dynamodb:DeleteTable`.
       - ElastiCache: Deny `elasticache:DeleteReplicationGroup`, `elasticache:ModifyReplicationGroup`.
     - *Accepted Risk (Documented):* The secrets vault is per-project, meaning the Preview Role inherently requires `secretsmanager:GetSecretValue` on the production vault to boot PR previews. This risk is accepted for v1 and must be clearly documented.

3. **Workflow Assignments**:
   - **Deploy Role:** Assigned to `deploy.yml`, `deploy-lambda.yml`, `deploy-static.yml`, and `drift.yml`.
   - **Preview Role:** Assigned to `preview.yml`, `preview-lambda.yml`, `teardown.yml`, and `plan.yml`.

4. **Migration Path**:
   - The explicit migration path is `grada init` (re-init), which regenerates `oidc.tf` and the workflow ARNs.
   - The old admin role will be dropped from Terraform state and destroyed on the next `apply`.
   - Release notes must prominently urge users to re-init to drop the `AdministratorAccess` role.

5. **Refactoring**:
   - Centralize role-ARN construction in `init.js` to avoid string concatenations across all workflow templates.
   - Extend `renderOidcSubClaim` to emit both roles' claim sets, and teach the `re-init` trust classifier the new shapes so it doesn't misread the dual-role output as hand-edits.

## 4. Acceptance Criteria
- `npm test` passes.
- Extend the template-shape suite to assert:
  - Both `aws_iam_role` resources exist in `oidc.tf`.
  - Trust `sub` conditions are correctly parameterized.
  - The `ec2:RunInstances`, IAM backdoors, and full prod-ARN deny statements (including S3, RDS, Aurora, DynamoDB, ElastiCache replication groups) are present on the Preview Role.
  - Deploy Role contains `PowerUserAccess`, `IAMFullAccess`, and boundary denies.
  - Role ARNs are assigned correctly across all workflow templates.
- `init --headless` scaffolds the split roles and updates all CI pipelines to target their respective roles.