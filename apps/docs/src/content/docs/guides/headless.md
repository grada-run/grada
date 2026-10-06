---
title: "Headless Mode & Automation Guide"
description: "Run grada without prompts for CI/CD pipelines, scripts, and framework plugins."
sidebar:
  order: 11
---

The `grada` CLI is designed to be fully automatable for CI/CD pipelines, custom scripts, Cookiecutters, and framework plugins (like `vite-plugin-grada`). 

By passing the `--headless` flag, you bypass all interactive terminal prompts. This is a tested contract (`tests/headless.test.js`): with `--headless --preconfigured`, the CLI guarantees no interactive prompt ever fires, so external schematics and CI pipelines can invoke it without hanging.

## Required Flags
To use headless mode, simply include the `--headless` flag. 

If `grada` cannot auto-detect your framework, you should also provide the `--framework` flag to ensure the correct infrastructure is generated.

* **Valid `--framework` options:** `node`, `nestjs`, `nextjs`, `nuxt`, `svelte`, `python`, `django`, `rails`, `go`, `static`

## Optional Configuration Flags

You can append any of these flags to customize the generated architecture. These map exactly to the options available in the interactive setup:

| Flag | Description | Default |
|---|---|---|
| `--region=<region>` | The AWS region to deploy to (e.g., `us-east-1`, `eu-west-1`). | `us-east-2` |
| `--size=<size>` | The Fargate compute size (`micro` or `small`). | `micro` |
| `--port=<number>` | The internal port your container exposes. | Framework dependent (`3000`, `8080`, `8000`) |
| `--healthCheckPath=<path>`| The ALB health check endpoint path. | `/` |
| `--desiredCount=<number>` | Number of container replicas to run (`1` or `2`). | `1` |
| `--branch=<name>` | The primary Git deployment branch for CI/CD. | `main` |
| `--dir=<path>` | The directory to generate files into (use `.` for current).| `.` |
| `--target=<target>` | Compute architecture: `ecs` (default, `fargate` synonym), `lambda` (scale-to-zero serverless), or `static` (S3 + CloudFront; static-site frameworks and detected static exports only). | `ecs` |
| `--needsDatabase` | Provisions a managed AWS database alongside Fargate (engine via `--db-engine`). | `false` |
| `--db-engine=<engine>` | Database engine: `postgres` (default), `mysql` (MySQL 8.0), or `aurora-postgresql` (Serverless v2 scale-to-zero). | `postgres` |
| `--enablePrPreviews` | Generates workflows for Ephemeral PR Previews. | `false` |
| `--no-telemetry` | Disables anonymous usage analytics (or set `DO_NOT_TRACK=1` for all runs). | `false` |
| `--preconfigured` | Suppresses framework warnings for pre-validated configs from external schematics/integrations (e.g., `nest add`). | `false` |
| `--with=<capabilities>` | Comma-separated (or repeatable) addon capabilities to scaffold during init (`storage:s3`, `db:dynamodb`, `db:redis`, `queue:sqs`, `ai:bedrock`, `email:ses`, `cron`). | none |
| `--model=<id>` | Bedrock model override when `ai:bedrock` is included. | Catalog recommended model |
| `--domain=<domain>` | Domain for the SES identity when `email:ses` is included (required in headless mode). | none |
| `--zone-id=<id>` | Route 53 hosted zone ID for automatic SES DNS records. | none |
| `--from-email=<email>` | Default SES sender address. | `noreply@<domain>` |
| `--setup-ci-migrate` | Wire the pre-deploy database migration gate into the generated workflow when a database and migration command are detected. | `false` |
| `--setup-ci-drift` | Scaffold `.github/workflows/drift.yml`: a daily 06:00 UTC `terraform plan` check that opens (or updates) a GitHub Issue labeled `iac-drift` on drift and closes it when resolved. | `false` |

*(Note: Boolean flags like `--needsDatabase` and `--enablePrPreviews` can be passed alone or as `--flag=true`).*

## Example Usage

**Standard Static Site Automation (e.g., Vite/React):**
```bash
npx grada-run --headless --framework=static --region=eu-west-1 --size=micro
```

**Next.js High-Availability CI/CD Generation:**
```bash
npx grada-run --headless --framework=nextjs --size=small --desiredCount=2
```

**Django Setup with Managed RDS Database:**
```bash
npx grada-run --headless --framework=django --needsDatabase
```

**Full-Stack Automation with Addons and Migration Gate:**
```bash
npx grada-run --headless --framework=nestjs --needsDatabase \
  --with db:redis,ai:bedrock,email:ses --domain example.com --setup-ci-migrate
```

## Automating lifecycle commands

`--headless` also suppresses confirmations in the Day-2 lifecycle commands, so scripted pipelines can provision, tear down, and decouple without hanging on a prompt:

```bash
npx grada-run apply --auto-approve   # provision without the preview confirmation
npx grada-run destroy --yes          # tear down compute and delete the state bucket
npx grada-run eject --yes            # strip CLI metadata without confirming
```

Each command also accepts `--headless` directly (implying the approval flag). Without an approval flag, a non-interactive invocation cancels with no changes rather than destroying anything.

## See also

- [`npx grada-run`](/grada/cli/init/) for the full flag table.
- [Supported Frameworks](/grada/guides/frameworks/) for valid `--framework` ids.
- [CI/CD Pipeline & First Deploy](/grada/guides/cicd-pipeline/) for what runs after generation.