# Grada Copilot Instructions

This repository's AWS infrastructure is managed strictly by the `grada` CLI.
**DO NOT** generate custom Terraform, AWS CloudFormation, or raw AWS CLI commands to deploy the application or modify the architecture. Use the Grada MCP tools (or the equivalent CLI commands) instead.

## Mental model

- **Three compute targets.** `--target ecs` (default) runs always-on Fargate containers behind an ALB — best for steady traffic. `--target lambda` runs scale-to-zero containers behind API Gateway — best for sporadic traffic. `--target static` serves pre-built assets from S3 + CloudFront with zero compute. Check `terraform/main.tf` (or the `analyze_stack` MCP tool) before assuming which one a project uses.
- **Lifecycle: `init` → `add` → `apply`.** `grada init` scaffolds the base stack (VPC, compute, CI/CD). `grada add <capability>` provisions one add-on primitive at a time (e.g. `queue:sqs`, `db:redis`, `storage:s3`, `ai:bedrock`). `grada apply` deploys. Never skip to `apply` before the stack is scaffolded.
- **Primitives, not raw blocks.** To add storage, queues, caches, cron jobs, email, or Bedrock access, always use the `add_primitive` MCP tool — never hand-write the Terraform resource blocks yourself.

## Available MCP tools

- `analyze_stack` — detect the framework, compute target, and installed primitives.
- `add_primitive` — scaffold one add-on capability (headless `grada add`).
- `stack_status` — live ECS/Lambda health, alarms, and replica counts.
- `fetch_logs` — recent CloudWatch logs (`hours` lookback, optional error filter).
- `audit_secrets` — diff local `.env` keys against AWS Secrets Manager (key names only, never values).

## Operating procedures

1. **Deploying or updating infrastructure:** scaffold with `add_primitive` as needed, then tell the user to run `npx grada-run apply`.
2. **New environment variables:** after adding keys to `.env`, prompt the user to run `grada secrets audit` (or call `audit_secrets`) and then `npx grada-run secrets push <env-file>` to sync them to AWS.
3. **After editing any `.tf` file:** run `terraform validate` in the background to catch syntax errors early.
4. **Teardown:** tell the user to run `npx grada-run destroy` (destructive — confirm first).
5. **After changing build output:** if you modify a `package.json` build script or framework output directory, remind the user to run `npx grada-run apply` if the infrastructure needs to be updated.
