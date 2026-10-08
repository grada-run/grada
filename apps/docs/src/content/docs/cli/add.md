---
title: add
description: Provision modular cloud addons like private S3 storage, DynamoDB tables, Valkey caching, SQS queues, Bedrock AI access, SES email, scheduled cron jobs — or add a relational database to a project that started without one.
---

Provision modular Day-2 cloud primitives without writing Terraform, configuring IAM policies, or opening the AWS Management Console.

## What it does

- `storage:s3` creates a private S3 bucket (encrypted, CloudFront OAC, CORS ready for presigned browser uploads) and injects `S3_BUCKET_NAME` and `S3_CDN_URL` into your container.
- `db:dynamodb` creates a `PAY_PER_REQUEST` DynamoDB table (no fixed hourly instance cost) with Point-in-Time Recovery, a free VPC Gateway Endpoint, and injects `DYNAMODB_TABLE_NAME` into your container.
- `db:redis` provisions a cost-optimized ElastiCache for Valkey 8.0 node (Redis-protocol compatible) isolated in your VPC, reachable only from your ECS tasks or Lambda function, and injects `REDIS_URL` into your container.
- `queue:sqs` creates an SQS queue with long polling and a Dead-Letter Queue, and injects `SQS_QUEUE_URL` and `SQS_DLQ_URL` into your container. If your project has a background worker service, it also wires scale-to-zero auto-scaling driven by queue depth. On `--target lambda` projects the queue ships without a consumer (no worker service exists) — poll from function code or wire an event source mapping yourself. Adding it to a Lambda or static project prints a warning: long-running workers require ECS.
- `ai:bedrock` grants your container least-privilege permission to invoke Amazon Bedrock foundation models (no static AWS keys) and injects `BEDROCK_MODEL_ID` into your container. Run it interactively to pick a provider and model from the catalog, or pass `--model <id>` directly.
- `email:ses` provisions Amazon SES for transactional email: a domain identity, DKIM signing, a `mail.` subdomain for bounce handling with SPF, a DMARC baseline, least-privilege `ses:SendEmail` permissions locked to your sender domain, and `SES_FROM_EMAIL` / `SES_REGION` in your container. With `--zone-id` it creates the verification, DKIM, MX, SPF, and DMARC records in Route 53 automatically; otherwise it outputs the records to add at your DNS provider. If you already ran `domain add`, the domain (and zone) is picked up automatically. The identity, DKIM, MAIL FROM, and DNS records are scoped to the production workspace as account-wide singletons, so PR previews never duplicate or delete them — preview containers inherit sending permission through their own task role.
- `cron` creates an EventBridge Scheduler schedule that runs a one-off Fargate task from your app's task definition on a `cron(...)` or `rate(...)` expression, with least-privilege `ecs:RunTask` + `iam:PassRole` permissions. One schedule per project: `--name` customizes it, and re-running with `--force` replaces it in place. On `--target lambda` projects the schedule invokes the function directly with a JSON payload carrying the command — handle scheduled events in application code.
- `db:postgres`, `db:mysql`, and `db:aurora-postgresql` add a relational database to a project that was initialized without one: renders `terraform/database.tf` from the same templates `init --db-engine` uses and wires `DB_HOST`/`DB_PORT`/`DB_NAME` (plus `DB_ENGINE` for non-Postgres) into your container — as Secrets Manager references on ECS, as plain variables on Lambda (which also gets the VPC config and `random` provider). Refused on `--target static`; refuses when `main.tf` already references a database unless `--force` is passed.
- Every addon attaches least-privilege IAM policies to your task role, so your application code can use the AWS SDK with no extra configuration.
- Addon files live in `terraform/` (`s3.tf`, `dynamodb.tf`, `redis.tf`, `sqs.tf`, `bedrock.tf`, `ses.tf`, `cron.tf`, plus `database.tf` for post-init relational databases), so `destroy` tears them down and `eject` keeps them automatically. PR-preview workspaces get isolated per-workspace resources. If your project has a `worker.tf` background service, addon environment variables are injected there too.
- On [ejected](/grada/cli/eject/) projects, new addon files render without managed headers to match the vanilla tree (billing docs and resources are unchanged), with a warning and an `ejected: true` marker on the `add_run` telemetry event.
- On `--target static` projects addon infrastructure still scaffolds (queues, tables, buckets, identities), but container env injection is skipped — there is no task role to inject into. Read the resource names from the generated `.tf` files and wire them into your build manually.
- Emits an `add_run` telemetry event recording the capability and outcome.

> **Bedrock model access:** AWS requires you to enable model access in the Bedrock console before your first `InvokeModel` call — including in the regions behind your `us.*` cross-region inference profile. IAM permissions alone are not enough. Anthropic models additionally require a one-time First Time Use (FTU) form in the Bedrock console.

> **SES sandbox:** new AWS accounts start in the SES sandbox and can only send to verified addresses. Request production access in the SES console (a short use-case form, usually approved within a day) before sending to real users.

## Usage

```bash
npx grada-run add storage:s3
npx grada-run add db:dynamodb
npx grada-run add db:dynamodb --partition-key userId
npx grada-run add db:redis
npx grada-run add queue:sqs
npx grada-run add ai:bedrock
npx grada-run add ai:bedrock --model us.anthropic.claude-haiku-4-5-20251001-v1:0
npx grada-run add ai:bedrock --list-models
npx grada-run add ai:bedrock --refresh
npx grada-run add email:ses --domain example.com
npx grada-run add email:ses --domain example.com --zone-id Z1234567890ABC
npx grada-run add cron --schedule "cron(0 2 * * ? *)" --cmd "npm run cron"
npx grada-run add storage:s3 --force
npx grada-run add db:postgres
npx grada-run add db:mysql
npx grada-run add db:aurora-postgresql
```

After adding, run `grada apply` (or commit and push to trigger CI) to provision the resource.

To switch Bedrock models later, just run `grada add ai:bedrock` again (interactively) or with a new `--model <id>` — the model reference updates in place across `bedrock.tf`, `main.tf`, and `worker.tf` without needing `--force`. The same in-place update applies when you re-run `add email:ses` with a new `--domain` or `--from-email`; every other re-run needs `--force`.

## Flags

| Flag | Description |
| ---- | ----------- |
| `--region <region>` | Explicit AWS region override. |
| `--project-name <name>` | Explicit project name override (defaults to the name in `terraform/main.tf`, then the directory name). |
| `--partition-key <key>` | DynamoDB partition key name (default `id`). Letters, numbers, underscore, hyphen, and dot only. Only applies to `db:dynamodb`. |
| `--model <id>` | Bedrock model or inference profile ID (default `us.anthropic.claude-sonnet-4-6`). Only applies to `ai:bedrock`. |
| `--list-models` | Print the Bedrock model catalog (works offline, no project required). Only applies to `ai:bedrock`. |
| `--refresh` | Refresh the Bedrock model catalog from live AWS data before listing or provisioning. Only applies to `ai:bedrock`. |
| `--domain <domain>` | Domain for the SES identity (defaults to your `domain add` domain, or prompts interactively; required in `--headless` mode without a `domain.tf`). Only applies to `email:ses`. |
| `--from-email <email>` | Default sender address (default `noreply@<domain>`). Must belong to the SES domain. Only applies to `email:ses`. |
| `--zone-id <id>` | Route 53 hosted zone ID for automatic DKIM/SPF/DMARC records. Only applies to `email:ses`. |
| `--schedule <expr>` | EventBridge Scheduler expression, e.g. `cron(0 2 * * ? *)` or `rate(1 hour)` (default `cron(0 0 * * ? *)`). Only applies to `cron`. |
| `--cmd <command>` | Command to run inside the scheduled container (default `npm run cron`; also accepts `--cron-command`). Only applies to `cron`. |
| `--name <job>` | Job slug customizing the schedule name (default `daily-job`). Only applies to `cron`. |
| `--timezone <tz>` | IANA timezone for the schedule expression (default `UTC`). Only applies to `cron`. |
| `--force` | Overwrite the existing addon file (also accepts `--force=false`). Without it, re-adding refuses to clobber your edits. |
| `--headless` | Scaffold without interactive prompts, using flag values and built-in defaults (Bedrock default model, daily cron schedule). |

Requires a project initialized with `grada` (`terraform/main.tf` must exist).

## Cost & Billing Drivers

- `storage:s3`: $0/mo fixed baseline; billed per GB stored ($0.023/GB-mo), S3 PUT/GET requests, and CloudFront egress.
- `db:dynamodb`: $0/mo fixed instance baseline (the VPC Gateway Endpoint is free); billed per read/write request, table storage ($0.25/GB-mo), and PITR continuous backups ($0.20/GB-mo once data is written).
- `db:redis`: ~$9.49/mo fixed baseline ($0.013/hr Valkey 8.0 `cache.t4g.micro`); $0 intra-AZ VPC transfer. Each open PR preview runs its own node while the PR is open.
- `queue:sqs`: $0/mo fixed baseline; first 1M requests/mo free, then $0.40 per million requests.
- `ai:bedrock`: $0/mo fixed baseline; billed per 1K input/output tokens on `InvokeModel` calls.
- `email:ses`: $0/mo fixed baseline; $0.10 per 1,000 emails sent.
- `cron`: $0/mo fixed baseline (first 14M EventBridge Scheduler invocations/mo free); billed only for Fargate seconds while the cron task runs (per-invocation Lambda billing on `--target lambda`).
- `db:postgres` / `db:mysql`: same as an init-time database (~$11.68/mo `db.t4g.micro` compute + ~$2.30/mo 20 GB gp3 storage). `db:aurora-postgresql`: Serverless v2 idles at 0 ACU (~$0.12/hr per ACU when active).

`grada add` prints the cost impact, refreshes the estimate in your `README.md` (or `DEPLOYMENT.md`), and `grada apply` lists active addons in its pre-flight preview. Reference rates are us-east-2; actual charges vary by region and usage.

## See also

- [apply](/grada/cli/apply/)
- [destroy](/grada/cli/destroy/)
- [domain](/grada/cli/domain/) (serve your app from the same domain SES sends from)
