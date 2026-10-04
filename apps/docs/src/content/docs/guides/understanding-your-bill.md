---
title: Understanding Your AWS Bill
description: What each part of your grada infrastructure costs, what the CLI estimates cover, and how to keep spend low.
---

Every grada command that touches infrastructure tells you what it costs *before* you pay it: `apply` shows a pre-flight estimate, `add` prints the cost impact of each addon, and your `README.md` keeps a refreshed monthly baseline. This guide explains what those numbers include, what they leave out, and where the cost levers are.

All reference rates below are for `us-east-2` (the stack default) and assume a 730-hour month. Other regions typically land within ~5–15% of these figures.

## The Fixed Monthly Baseline

These resources bill by the hour (or month) whether your app serves one request or one million. A minimal stack (256 CPU / 512 MB Fargate micro, no database) runs **~$31.68/mo**:

| Resource | Math | Monthly |
| -------- | ---- | ------- |
| Fargate task (0.25 vCPU + 0.5 GB) | (0.25 × $0.04048 + 0.5 × $0.004445) × 730 hrs | ~$9.01 |
| Application Load Balancer (base + ~1 LCU) | ($0.0225 + $0.008) × 730 hrs | ~$22.27 |
| Secrets Manager (1 app secret) | 1 × $0.40 | $0.40 |

Optional fixed add-ons to the baseline:

| Addition | Monthly |
| -------- | ------- |
| Background worker service (second identical Fargate task) | doubles Fargate to ~$18.02 — but scales to $0 when its SQS queue is empty |
| RDS Postgres (`db.t4g.micro` + 20 GB gp3 + managed secret) | ~$13.98 + $0.40 secret |
| Valkey caching (`add db:redis`, `cache.t4g.micro`) | ~$9.49 |

So a typical full stack (web + database + Valkey) lands around **~$55.55/mo**, and the CLI's estimate always reflects your actual `terraform/` directory — container size, worker, database, secrets, and fixed-cost addons included.

On the Lambda target (`--target lambda`) there is no Fargate or ALB baseline at all: compute and the API Gateway HTTP API bill purely on use, so a no-database project idles at **~$0.40/mo** (one Secrets Manager secret) and an Aurora-backed one at **~$0.80/mo**. The pre-flight estimate shows this as `Fixed Baseline: ~$0.80/mo (RDS: $0.00, Secrets: $0.80 + API GW & Lambda usage)` — the trailing caveat is the reminder that requests, not hours, are the real bill.

On the static target (`--target static`) the fixed baseline is **$0.00/mo**: no Fargate, no ALB, no secrets vault. The pre-flight preview shows `Fixed Baseline: $0.00/mo (Usage-based only via S3/CloudFront)` — S3 storage and requests plus CloudFront requests and egress are the entire bill, all usage-metered.

## What the Estimate Leaves Out (Usage Billing)

Anything that scales with traffic is billed on use and intentionally excluded from the fixed number:

- **Addons:** `storage:s3` (storage, requests, CloudFront egress), `db:dynamodb` (requests, storage, backups), `queue:sqs` (requests past the 1M free tier), `ai:bedrock` (per-token inference), `email:ses` ($0.10 per 1,000 emails sent), `cron` (Fargate seconds per scheduled run). Each `add` run prints its own billing drivers.
- **Data transfer:** outbound traffic and CloudFront egress beyond free tiers.
- **Logs & images:** CloudWatch Logs ingestion (14-day retention is configured) and ECR image storage (~$0.10/GB-mo) — usually cents, plus `gc` cleans up orphans.
- **Traffic spikes:** ALB capacity units above the ~1 LCU baseline, and RDS backup storage past the free allowance.
- **Serverless compute (Lambda target):** API Gateway HTTP API requests ($1.00 per million) plus Lambda request charges and GB-second compute time. Sporadic traffic costs pennies; sustained high-concurrency traffic can overtake the ~$31/mo Fargate baseline — see the [Fargate vs Lambda tradeoffs](/grada/guides/architecture/#fargate-vs-lambda-tradeoffs).

Rule of thumb: the fixed baseline is your floor; side projects with modest traffic typically land within a few dollars above it.

### Which target costs less for my workload?

- **Side project / internal tool** (dozens to hundreds of requests a day): Lambda, by a mile — pennies a month against ~$31+ of idle ECS baseline.
- **Steady product API** (sustained traffic around the clock): Fargate — the flat baseline undercuts per-request billing once concurrency stops dropping to zero.
- **Spiky or unpredictable traffic** (launches, webhooks, batch-driven): Lambda absorbs bursts with no capacity planning; just mind the database-connection note in [Fargate vs Lambda tradeoffs](/grada/guides/architecture/#fargate-vs-lambda-tradeoffs).
- **Static site** (docs, marketing pages, SPA exports): the static target — $0.00/mo baseline with pennies of S3/CloudFront usage.

## Cost Savers Built Into the Stack

- **No NAT gateway.** Tasks run in public subnets behind the ALB security group instead of behind a ~$33/mo NAT — the single biggest saving versus a conventional VPC layout.
- **Micro defaults, scale up deliberately.** Fargate micro, single-AZ `db.t4g.micro`, and single-node Valkey keep the floor low; grow container size or add read replicas only when metrics say so.
- **Workers scale to zero.** The SQS-driven worker parks at 0 tasks (and $0 compute) when the queue drains — you pay for background capacity only while jobs exist.
- **Sleep idle environments.** `sleep [env]` scales ECS services to 0 and stops RDS, printing the exact hourly/monthly compute savings (e.g. ~$20.69/mo for a micro web service plus Postgres: ~$9.01 Fargate + ~$11.68 RDS compute paused); `wake [env]` restores everything. Storage (~$2.30/mo), the ALB (~$22.27/mo), Valkey (~$9.49/mo, no pause API), and secrets keep billing while asleep, and AWS auto-restarts stopped databases after 7 days — the CLI shows the exact restart timestamp.
- **PR previews self-destruct.** Each open pull request runs a full copy of the stack (~$31+/mo each while open, mostly the extra ALB), so previews are destroyed automatically when the PR closes. Close stale PRs and run `gc` to catch leftovers.
- **Serverless-first addons.** DynamoDB on-demand, SQS, SES, Bedrock, and scheduled cron jobs cost nothing at rest — prefer them over always-on resources when the workload fits.

## Keeping Estimates Accurate

- The `README.md` estimate refreshes automatically on every `add` and `apply` — if you hand-edit `terraform/`, re-run `apply` (or `--dry-run`) to re-sync it.
- Estimates follow your real config: bigger `--size` at `init`, extra secrets, and new addons all flow into the number on the next run.
- For hard budget enforcement, pair the CLI estimates with an AWS Budgets billing alarm in the console — the CLI tells you the expected spend, AWS tells you the actuals.
