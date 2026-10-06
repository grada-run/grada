---
title: Stack Architecture
description: How the generated VPC, load balancer, cluster, CDN, data stores, and CI pipeline fit together.
---

Every grada project generates the same shape: a public-subnet VPC, an ALB-fronted Fargate cluster (or a scale-to-zero Lambda function with `--target lambda`), CloudFront at the edge, and a keyless CI pipeline that ships images while Terraform owns the infrastructure. This page is the map; each piece links to its reference.

## Request path

Internet → **CloudFront** → **ALB** → **ECS tasks**. The distribution's origin is the load balancer (`cloudfront.tf`), so web traffic enters through the CDN with SSL terminated at the edge; the `Direct URL` printed by `apply` bypasses it for debugging.

Tasks run with `awsvpc` networking in **public subnets** spread across availability zones (`10.0.0.0/16` VPC, one subnet per AZ, internet gateway attached). There is intentionally **no NAT gateway** — tasks get public IPs and talk out directly, which saves ~$33/mo versus a conventional private-subnet layout. Isolation comes from security groups: the ALB accepts public internet traffic, tasks accept traffic only from the ALB, and outbound access stays open for image pulls and external APIs.

## Compute and images

One ECS cluster holds the `app` service, plus an optional internal `worker` service with no load balancer — though like the web service it still runs in the public subnets (see [Background Workers](/grada/guides/background-workers/)). Both run the same ECR image: the pipeline builds once per push and tags it with the commit SHA (the immutable deploy artifact) and `latest`. Scheduled jobs ([`add cron`](/grada/cli/add/)) reuse that same image — an EventBridge Scheduler rule launches a one-off Fargate task inside the VPC on your `cron(...)` or `rate(...)` expression, so there is no always-on worker to pay for.

Two IAM roles split concerns: the **execution role** pulls images and reads secrets at boot, while the **task role** carries workload permissions — every [`add`](/grada/cli/add/) addon attaches its least-privilege policy here, so application code uses the AWS SDK with no keys.

Deploys never rebuild infrastructure: the pipeline registers a new task-definition revision per push and updates the service to it, while Terraform ignores the service's `task_definition` so the next `apply` never reverts a code deploy. An ECS deployment circuit breaker rolls back failed rollouts automatically, and every revision stays registered so [`rollback`](/grada/cli/rollback/) always has history. See [CI/CD Pipeline & First Deploy](/grada/guides/cicd-pipeline/).

## Serverless target (`--target lambda`)

Passing `--target lambda` to [`init`](/grada/cli/init/) generates an alternate scale-to-zero topology with the same VPC, ECR repository, IAM roles, secrets vault, and CloudFront distribution — only the compute layer changes:

Internet → **CloudFront** → **API Gateway HTTP API v2** → **Lambda function**. The generated `Dockerfile` embeds the AWS Lambda Web Adapter extension, so standard HTTP servers (`app.listen(process.env.PORT)`) serve API Gateway events with zero application code changes. The fixed compute and load-balancer baseline is **$0.00/mo** (Lambda and HTTP APIs bill per request); a no-database project totals ~$0.80/mo in Secrets Manager.

Deploys push the SHA-tagged image to ECR and call `update-function-code`, which Terraform ignores (mirroring the ECS `task_definition` rule) so code deploys and `apply` never fight. On day 0, `apply` seeds a minimal placeholder image into ECR automatically — Lambda's API rejects empty repositories — so the first provision succeeds before any code push.

Projects with a database attach the function to the VPC subnets (still no NAT gateway) and receive credentials as `DB_*` environment variables, since VPC-attached functions cannot reach Secrets Manager without a paid VPC endpoint. Non-database functions stay outside the VPC with direct internet access; `add db:redis` attaches the VPC config on demand. Cron schedules invoke the function directly with a JSON payload carrying the configured command — handle scheduled events in application code.

Day-2 commands adapt: `status` and `diagnose` read function configuration via the AWS CLI, `logs` tails `/aws/lambda/<project>-fn`, and `sleep`/`wake` manage only the database (compute needs no scaling) — exiting successfully when no database exists. `exec` and `rollback` are ECS-only and exit with the Lambda-native alternative. On static targets `sleep`/`wake` exit successfully (nothing to pause) while `exec`/`rollback` fail fast with an unsupported-target error.

## Static target (`--target static`)

Passing `--target static` to [`init`](/grada/cli/init/) generates a zero-compute topology for static-site frameworks (Vite, Astro, SPA exports — anything the `static` framework preset detects) plus detected static exports (Next.js `output: 'export'`, SvelteKit `adapter-static`). Anything else is rejected with a validation error.

Internet → **CloudFront** → **private S3 bucket**. There is no VPC, no ALB, no ECS, and no Dockerfile: the bucket blocks all public access and CloudFront reads through an Origin Access Control (OAC), unknown paths fall back to `/index.html` for client-side routers, and the fixed baseline is **$0.00/mo**. Deploys build the site, `aws s3 sync` the output folder, and invalidate the CloudFront cache.

Day-2 commands adapt: `status` reports distribution status (`Deployed` vs propagating) instead of ECS, and `alerts` is ECS-only with a clear error. Container-oriented commands (`exec`, `rollback`, `logs`) behave as on an unprovisioned ECS project (service-not-found guidance). Workers, databases, and PR preview workflows are skipped (with a warning) — there is no compute to run them on.

### Fargate vs Lambda tradeoffs

Both targets share the VPC, ECR, IAM, secrets, and CloudFront layers — pick by traffic shape, not by feature set:

- **Cost crossover.** Lambda idles at $0 and bills per request (API Gateway HTTP API at $1.00 per million requests, plus Lambda request and GB-second compute charges), so sporadic or bursty workloads cost pennies. Under sustained high-concurrency traffic those per-request charges catch up to and pass Fargate's flat ~$31/mo compute+ALB baseline, and always-on containers become the more cost-effective steady state. See [Understanding Your AWS Bill](/grada/guides/understanding-your-bill/).
- **Database connections.** Fargate runs a fixed handful of tasks with persistent, pooled connections. Lambda can burst toward 1,000 concurrent executions, and the generated stack connects each execution straight to RDS with no proxy in between — enough simultaneous cold starts will exhaust a `db.t4g.micro` connection limit and fail queries until executions drain. For high-concurrency Lambda workloads against a relational database, keep client pools tiny with aggressive idle timeouts, or place RDS Proxy in front of the database yourself.
- **Cold starts.** Fargate tasks are always warm behind the ALB. VPC-attached Lambda container images (any project with a database or Redis) pay multi-second cold starts on scale-out — fine for background-tolerant traffic, noticeable on latency-sensitive paths.
- **Request limits.** API Gateway caps every Lambda invocation behind it at 30 seconds and 10 MB of payload, and a single function execution can never exceed 15 minutes — long responses, in-request file processing, SSE streams, and WebSockets don't fit. The ALB imposes no such ceilings, so ECS carries long-lived and streaming traffic.
- **Background workers and queues.** ECS keeps a first-class worker story: Procfile workers become a dedicated service, and `queue:sqs` drives a scale-to-zero worker with queue-depth autoscaling. Lambda runs one function — Procfile workers are skipped at scaffold time, SQS queues ship without a consumer (poll from function code or wire an event source mapping yourself), and cron schedules arrive as JSON-payload invokes your code must handle.
- **Outbound network.** ECS tasks carry public IPs and reach the open internet directly. Lambda functions attached to the VPC (any project with a database or Redis) get private-only network interfaces, and the generated VPC has no NAT gateway — so they cannot call third-party APIs unless you add NAT or VPC endpoints yourself. Non-VPC functions keep direct internet access.

| | ECS Fargate + ALB | Lambda + API Gateway v2 |
| --- | --- | --- |
| Idle cost | ~$31/mo flat | $0 |
| Cost at sustained scale | flat per task (cheaper steady state) | per request + compute (grows with traffic) |
| Cold starts | none (always warm) | multi-second on VPC scale-out |
| Max request duration | no hard cap (ALB) | 30s API Gateway cap, 15-min function max |
| DB connections | fixed pooled tasks | per-execution, no proxy |
| Background workers | dedicated service + SQS autoscaling | none (queues ship unconsumed) |
| Outbound internet | yes (public IPs) | only when outside the VPC |
| WebSockets / streaming | yes, via ALB | no |
| Day-2 ops | `exec`, `rollback`, migration gate | adapted `status`/`logs`/`diagnose`; no `exec`/`rollback` |
| Web scaling | fixed desired count | automatic to 1,000 concurrent |

Choose **ECS Fargate** when traffic is steady or latency-sensitive (product APIs, SaaS backends), responses can exceed 30 seconds or stream, background workers or queue consumers are part of the design, or handlers need persistent database connections and outbound internet side by side.

Choose **Lambda** when traffic is sporadic, bursty, or unpredictable (side projects, internal tools, webhooks), $0 idle cost matters more than warm latency, and the workload is request-scoped with no workers or long-lived connections — ideally with Aurora Serverless (which scales with the function) or no database at all.

## Data and secrets

- **Database** (when enabled) runs on RDS in **isolated subnets** with its own subnet group — no route to the internet. Pick the engine at scaffold time (`postgres`, `mysql`, or scale-to-zero `aurora-postgresql` via `--db-engine`). Reach it from your laptop via [`db connect`](/grada/cli/db/), and run migrations inside the VPC with [`db migrate`](/grada/cli/db/).
- **Secrets** live in Secrets Manager as one app secret, injected as environment variables at container boot from the key map in `terraform/secret_keys.json`. See [Secrets Management](/grada/guides/secrets-management/).
- **State** lives in an encrypted S3 bucket using native S3 locking (`use_lockfile`), so concurrent applies are safe without a lock table.

## CDN, domain, and email

CloudFront serves the app globally — from the ALB origin on ECS, the API Gateway origin on Lambda, or the S3 origin on static. [`domain add`](/grada/cli/domain/) attaches your own hostname with an automated `us-east-1` ACM certificate; [`add email:ses`](/grada/cli/add/) provisions SES sending on the same domain with DKIM/SPF/DMARC. Both are optional day-2 steps over the base stack.

## Observability

One CloudWatch log group per project (`/ecs/<project>`, 14-day retention) collects web and worker streams; an alarm fires when the ALB serves more than ten 5XX errors in two minutes. [`status`](/grada/cli/status/) renders the health dashboard, [`diagnose`](/grada/cli/diagnose/) explains crashed tasks, and [`logs`](/grada/cli/logs/) streams without the console.

## Operations

Idle environments cost nothing in compute: [`sleep` / `wake`](/grada/cli/sleep/) scales ECS services to zero and stops RDS — printing the exact hourly/monthly savings and the 7-day AWS auto-restart timestamp — then restores the exact replica counts on wake. Console click-ops never go unnoticed: the opt-in `drift.yml` workflow runs `terraform plan` daily and opens a GitHub Issue on drift, and [`drift`](/grada/cli/drift/) runs the same check locally.

## Preview workspaces

Each open pull request gets a Terraform workspace (`preview.yml`) running the same files renamed by `app_name` plus an environment suffix — a full copy of the stack that `teardown.yml` destroys on close. A few resources are deliberately shared instead of copied (the ECR repository, Secrets Manager lookups), and account-wide singletons — the custom-domain ACM certificate and aliases, the SES domain identity/DKIM/DNS — are scoped to the production (`default`) workspace via `count` guards, so previews neither duplicate them nor delete them on teardown; previews serve over their own `*.cloudfront.net` URL and inherit SES sending permission. See [Ephemeral PR Previews](/grada/guides/ephemeral-pr-previews/).

## See also

- [Quickstart (5 minutes)](/grada/guides/quickstart/) for the fastest path through this stack.
- [Understanding Your AWS Bill](/grada/guides/understanding-your-bill/) for what each piece costs.
