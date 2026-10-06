---
title: Background Workers
description: Run background jobs on a private ECS worker service — how it is created, SQS scale-to-zero, and day-2 operations.
---

Long-running jobs (Celery, Sidekiq, BullMQ workers, queue pollers) run on a second ECS Fargate service that shares your web container's image, secrets, and database wiring but takes no HTTP traffic. (ECS targets only — `--target lambda` projects run a single function with no worker service; Procfile workers are skipped at scaffold time.)

## What the worker service is

`terraform/worker.tf` defines an internal `aws_ecs_service.worker`: same ECR image and cluster as the web service, same Secrets Manager payload and database variables, and its own task definition whose container runs your worker command instead of the web server. There is deliberately **no load balancer block**, so nothing routes internet traffic to it — though like the web service it still runs in the public subnets. Logs go to the shared `/ecs/<project>` group with the `worker` stream prefix, keeping them separable from web logs.

New services start with `desired_count = 1`, but the service ignores `desired_count` changes in Terraform so queue-depth auto-scaling can manage the count without apply-time drift.

## How you get one

The worker service is created at init time, from either source:

- A `worker:` entry in your `Procfile` — see [Heroku (Procfile)](/grada/migrations/heroku-procfile-to-aws/).
- The scaffold worker prompt, pre-filled from what detection finds (Procfile entry, worker dependencies, or Compose commands) — see [`npx grada-run`](/grada/cli/init/).

Either path writes the command into `worker.tf` (`WORKER_COMMAND`) and manages the file like any other generated file.

## SQS scale-to-zero

`add queue:sqs` extends the worker with Application Auto Scaling driven by `ApproximateNumberOfMessagesVisible`:

- **Scale out:** one task per minute while the queue is non-empty, up to 5 tasks.
- **Scale in:** back to 0 after the queue stays empty for five minutes — a parked worker costs nothing in compute.

The scaling target, both step-scaling policies, and both CloudWatch alarms live in `sqs.tf`, and AWS creates the required service-linked role automatically on first registration. Addon environment variables are injected into the worker container as well as the web container. On `--target lambda` or `--target static` projects the command warns that long-running workers require ECS and provisions the queue without a consumer.

## Adding a worker later

There is no `add worker` command: if you scaffolded without a worker, `add queue:sqs` still creates the queue and injects its URLs, but renders the auto-scaling block **commented out**. To activate it later, add `terraform/worker.tf` — re-run init (backup and regenerate, then restore hand-edited and addon files from the `.bak` copy; see [Re-running Init Safely](/grada/guides/rerun-init/)) or copy `worker.tf` from an equivalent fresh scaffold and set the command — uncomment the block in `sqs.tf`, and `apply`.

## Day-2 operations and cost

- Stream worker output with [`logs`](/grada/cli/logs/) — worker entries carry the `worker` stream prefix in the shared group — and open a shell with [`exec`](/grada/cli/exec/) using its service and container overrides.
- A running worker roughly doubles the Fargate baseline (~$18.02/mo at micro size), falling to $0 compute while its queue is empty; each open PR preview runs its own copy while the PR is open. See [Understanding Your AWS Bill](/grada/guides/understanding-your-bill/).

## See also

- [Heroku (Procfile)](/grada/migrations/heroku-procfile-to-aws/) for Procfile process mapping.
- [add](/grada/cli/add/) for `queue:sqs` flags and cost drivers — or `add cron` for scheduled one-off tasks that need no always-on worker.
- [Re-running Init Safely](/grada/guides/rerun-init/) for regeneration behavior.
