---
title: sleep & wake
description: Pause idle environments to save costs by scaling ECS services to zero and stopping RDS, then restore them with one command.
---

Pause a non-production or idle environment with a single command, and wake it back up when you need it — without opening the AWS Management Console.

## What it does

- `sleep [env]` scales your ECS services (`app` and `worker`, when present) to `0` and stops the RDS instance or Aurora cluster, printing the estimated hourly/monthly compute savings.
- `wake [env]` starts the database first (waiting until it is `available`), then restores the exact ECS desired counts recorded at sleep time.
- `sleep` also pauses the `add cron` schedule (when configured) and suspends SQS worker auto-scaling, so no scheduled task or queued message wakes the environment back up; `wake` resumes both. Schedules that were never deployed and unregistered scaling targets are skipped gracefully.
- Sleeping the default (production) environment requires confirmation (`--yes` in automation); named environments sleep without prompting.
- AWS automatically restarts stopped RDS databases after 7 consecutive days — `sleep` prints the exact restart timestamp, and `wake` warns if the window already elapsed.
- Sleep state lives in `.grada/sleep-state.json` (one entry per environment, gitignored), so `wake` restores your original replica counts even for scaled-out services.
- On `--target lambda` projects, compute is already scale-to-zero, so `sleep`/`wake` manage only the database (and pause/resume the cron schedule) — no services are scaled or restored.
- On `--target static` projects there is nothing to pause — no compute or database exists — so `sleep` reports nothing-to-sleep without suggesting `apply`.
- Emits `sleep_run` / `wake_run` telemetry events recording the outcome.

## Usage

```bash
npx grada-run sleep staging
npx grada-run wake staging
npx grada-run sleep --yes
npx grada-run wake --no-wait
npx grada-run sleep staging --skip-db
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `[env]` | Positional environment name (e.g. `staging`, `pr-42`). Aliases `--workspace`. Defaults to the default environment. |
| `--workspace <name>` | Explicit environment name. Wins over the positional `[env]`. |
| `--project-name <name>` | Explicit project name override (defaults to the name in `terraform/main.tf`, then the directory name). |
| `--cluster <name>` | Explicit ECS cluster override. |
| `--service <name>` | Explicit ECS app service override. |
| `--db-identifier <id>` | Explicit database identifier override. |
| `--region <region>` | Explicit AWS region override. |
| `--skip-db` | Scale ECS services only; leave the database running. |
| `--no-wait` | On `wake`, return immediately instead of waiting for RDS `available` and ECS tasks to reach their desired counts. |
| `--yes` | Skip the production confirmation prompt on `sleep` (also accepts `--force`; required in `--headless`/CI runs, which fail instead of prompting). |

Both commands are idempotent: re-sleeping an asleep environment (or waking an awake one) reports the current state instead of failing.

## Cost & billing drivers

While asleep you stop paying for Fargate task hours (`~$9.01/mo` per 256/512 replica) and RDS instance compute (`~$11.68/mo` for `db.t4g.micro`). 20 GB gp3 storage (`~$2.30/mo`), the ALB (`~$22.27/mo`), ElastiCache Valkey (`~$9.49/mo` — it has no pause API), and Secrets Manager secrets keep billing until you run `destroy`. Aurora Serverless v2 already idles at 0 ACU, so stopping it only prevents active wake-ups. Lambda projects skip the ALB line entirely — asleep, only storage, secrets, and (if present) Valkey keep billing.

## See also

- [status](/grada/cli/status/)
- [destroy](/grada/cli/destroy/)
