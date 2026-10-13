---
title: Initializing Project (npx grada-run)
description: Scaffold production-ready AWS infrastructure and CI/CD pipelines.
---

Generate Terraform, Docker, and GitHub Actions files for your project.

## What it does

- Turns your codebase into a deployable AWS project: detects your framework, `Procfile`, `vercel.json`, and Compose files, warns about framework-specific gotchas, provisions the remote-state S3 bucket, and writes Terraform, Docker, and CI/CD files.
- Validates flags fail-fast: an unknown `--framework`, `--db-engine`, `--target`, or `--with` value errors with the supported list before anything is written.
- Pre-selects prompts from your manifests — database drivers pre-check the database prompt, detected capabilities (Redis, SQS, S3, …) come pre-checked in the addon picker — each showing the evidence that triggered it.
- Scaffolds addons in the same run, offers the pre-deploy migration gate and scheduled drift detection, and prints a stack topology preview when addons are included.
- Mints a short random suffix (e.g. `-a1b2c3`) baked into AWS-wide singleton names, so same-named projects never collide; clones and re-runs reuse it, older trees are unaffected.
- Never silently adopts existing remote state: a fresh project over occupied state asks adopt / rename / wipe (headless fails unless `--adopt-state`).
- Backs up existing generated files before overwriting, writes AI assistant rules, never overwrites your own `README.md`, and finishes with exact next steps (`apply`, then `git push`).

## Usage

```bash
npx grada-run
npx grada-run --headless --framework=nextjs --region=us-east-2
npx grada-run --headless --framework=nestjs --needsDatabase \
  --with db:redis,ai:bedrock,email:ses --domain example.com --setup-ci-migrate
npx grada-run --headless --framework=node --target=lambda
```

Running with no subcommand starts the interactive setup wizard (`init` is the default command).

## Compute targets

`--target` selects the AWS compute architecture (interactive runs prompt when the flag is absent):

- `ecs` (default, `fargate` accepted as a synonym) — always-on ECS Fargate tasks behind an ALB: zero cold starts, ~$31.28/mo compute+ALB baseline.
- `lambda` — scale-to-zero AWS Lambda container function (via the Lambda Web Adapter, zero app code changes) behind API Gateway HTTP API v2 and CloudFront: $0.00/mo fixed compute baseline, usage-based invocations.
- `static` — zero-compute hosting for static-site frameworks and detected static exports (Next.js `output: 'export'`, SvelteKit `adapter-static`): a private S3 bucket served through CloudFront with Origin Access Control. No containers, no Dockerfile, $0.00/mo idle baseline. Anything else is rejected with a validation error.

Lambda targets skip ECS-only scaffolding (no worker service, no ALB listener rules, no pre-deploy migration gate — run migrations from CI against your database endpoint instead). Day-0 `apply` seeds a placeholder image into ECR automatically, so the first provision succeeds before any code push. Secrets pushed with `secrets push` stay in the shared vault for runtime reads (`APP_SECRETS_ARN`); database credentials flow as `DB_*` environment variables so VPC-attached functions need no Secrets Manager endpoint.

Static targets skip even more: no VPC, no secrets vault, no Dockerfile, no PR preview workflows. Workers and databases are skipped with a warning (there is no compute to run or connect from). Deploys build the site (`npm run build`), sync the output folder to S3, and invalidate the CloudFront cache.

Not sure which to pick? Choose `ecs` for steady or latency-sensitive traffic, long responses, WebSockets, background workers, or persistent database connections — and `lambda` for sporadic or bursty traffic where $0 idle cost beats warm latency. The full side-by-side (cost crossover, request limits, connection safety, network egress) lives in [Fargate vs Lambda tradeoffs](/grada/guides/architecture/#fargate-vs-lambda-tradeoffs).

## Headless flags

| Flag | Description |
| ---- | ----------- |
| `--headless` | Bypass all interactive prompts (for CI/CD and automation). |
| `--force` | Re-run over modified files: back them up and regenerate. Headless re-runs refuse without it (`MODIFIED_TREE`); interactive re-runs list the modified files first. See [Re-running Init Safely](/grada/guides/rerun-init/). |
| `--framework=<name>` | `node`, `nestjs`, `nextjs`, `nuxt`, `svelte`, `python`, `django`, `rails`, `go`, `static`. |
| `--region=<region>` | AWS region (e.g. `us-east-1`). |
| `--port=<port>` | Container port your app listens on. |
| `--size=<size>` | Fargate task size preset. |
| `--healthCheckPath=<path>` | ALB health-check path. |
| `--desiredCount=<n>` | Number of tasks to run. |
| `--branch=<name>` | Branch the CI workflow deploys. |
| `--needsDatabase` | Provision a managed database. |
| `--db-engine <engine>` | Database engine: `postgres` (default), `mysql` (MySQL 8.0), or `aurora-postgresql` (Serverless v2 scale-to-zero). Skip the interactive engine prompt. |
| `--target <target>` | Compute target: `ecs` (default, `fargate` synonym), `lambda` (scale-to-zero serverless), or `static` (S3 + CloudFront; static-site frameworks and detected static exports only). Skips the interactive target prompt. |
| `--enablePrPreviews` | Enable ephemeral PR preview environments. |
| `--dir=<path>` | Target directory for generated files. |
| `--project-name <name>` | Override the project name (default: directory basename; re-runs reuse the existing tree's name). Renaming a deployed tree provisions a new stack on next apply — the old one is left untouched. |
| `--preconfigured` | Skip framework-specific warnings (for preconfigured setups). |
| `--with <capabilities>` | Comma-separated (or repeatable) addon capabilities to scaffold during init (`storage:s3`, `db:dynamodb`, `db:redis`, `queue:sqs`, `ai:bedrock`, `email:ses`, `cron`). Pre-checks the interactive picker, or scaffolds directly in headless mode. |
| `--model <id>` | Bedrock model override when `ai:bedrock` is included (defaults to the catalog's recommended model). |
| `--domain <domain>` | Domain for the SES identity when `email:ses` is included (required in headless mode). |
| `--zone-id <id>` | Route 53 hosted zone ID for automatic SES DNS records. |
| `--from-email <email>` | Default SES sender address (default `noreply@<domain>`). |
| `--setup-ci-migrate[=<cmd>]` | Wire the pre-deploy database migration gate into the generated workflow when a database and migration command are detected (on ECS trees with PR previews enabled, the preview gate in `preview.yml` is wired too). An explicit `=<cmd>` overrides detection — the escape hatch when detection yields `npm`/`npx` on a Node-family project, which refuses headless (`NPM_CMD_STRIPPED_RUNNER`); e.g. `--setup-ci-migrate="node ./dist/migrate.cjs"`. |
| `--setup-ci-drift` | Scaffold `.github/workflows/drift.yml`: a daily 06:00 UTC `terraform plan` check that opens (or updates) a GitHub Issue labeled `iac-drift` on drift and closes it when resolved. |
| `--offline` | Scaffold without any AWS calls (for template development and CI fixtures): no state bucket is created, `terraform/backend.tf` and workflow role ARNs get greppable `YOUR_AWS_ACCOUNT_ID` placeholders, and a reconciliation checklist is printed. Reconcile before applying. |
| `--adopt-state` | Take over existing remote state when the state bucket already holds a key for this project name. Without it, headless inits fail with `STATE_ALREADY_EXISTS`; interactive inits prompt adopt / rename / wipe. |
| `--github-repo=<owner/name>` | Scope the CI OIDC trust to this repo (`repo:<owner>/<name>:*`). Without it, init reads your git remote, then asks once (skippable) — headless falls back to the open `repo:*` trust with a warning. Re-runs keep the tree's rendered trust. |
| `--no-telemetry` | Disable telemetry for this run (or set `DO_NOT_TRACK=1` for all runs). |

## Automation & edge cases

- Headless runs never prompt — the full automation contract (flags, gates, error codes) lives in [Headless Mode](/grada/guides/headless/).
- `--offline` scaffolds without AWS calls for template development and CI fixtures: placeholder account IDs plus a printed reconciliation checklist. Reconcile before applying.
- Detection is read-only and skips secret values entirely; worker dependencies pre-fill the background-worker command.
- Compose files merge by fixed rules — `build:` service first, then framework-port match, then first non-datastore service; secret-like env vars are withheld with a warning, datastore-only files skip the merge. Full rules: [Docker Compose Support](/grada/guides/docker-compose/).
- Re-runs keep the tree's project name even if the directory was renamed (warns loudly; `--project-name` renames explicitly), and deployment docs land in `README.md` only when it is absent or was previously generated, otherwise `DEPLOYMENT.md` (or `GRADA.md`), with `secret_keys.json` untouched. Details: [Re-running Init Safely](/grada/guides/rerun-init/).
- A fixed-baseline cost estimate is written into the deployment doc and refreshed on every later [`add`](/grada/cli/add/).

New here? Start with the [Quickstart](/grada/guides/quickstart/).

See the [Supported Frameworks](/grada/guides/frameworks/) guide for detection rules and per-framework requirements, and the [Headless Mode guide](/grada/guides/headless/) for automation examples.

After scaffolding, continue with [CI/CD Pipeline & First Deploy](/grada/guides/cicd-pipeline/).
