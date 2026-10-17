---
title: sleep & wake
description: Pause idle environments to save costs by scaling ECS services to zero and stopping RDS, then restore them with one command.
---

Pause a non-production or idle environment with a single command, and wake it back up when you need it — without opening the AWS Management Console.

## What it does

- `sleep [env]` scales your ECS services to `0` and stops the database, printing the estimated compute savings; `wake [env]` starts the database first, then restores your exact replica counts.
- Sleeping also pauses the cron schedule and SQS auto-scaling, so nothing wakes the environment back up; `wake` resumes both.
- Sleeping production needs confirmation (`--yes` in automation); named environments sleep without prompting.
- AWS restarts stopped databases after 7 days — `sleep` prints the exact restart timestamp.
- `wake` gives up fast on crashing tasks and tells you why, instead of waiting the full timeout.
- On Lambda projects only the database sleeps (compute is already scale-to-zero); on static projects there is nothing to pause, so both commands exit successfully with nothing to do.

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
| `--force` | On `sleep`, also bypass the add-in-progress gate when your automation sequences commands itself. |
| `--strict` | Exit 2 (instead of 0) when the command has nothing to do, with the `skipped` reason preserved. |

Both commands are idempotent: re-sleeping an asleep environment (or waking an awake one) reports the current state instead of failing.

## Automation & edge cases

- `wake` short-circuits doomed waits: two fresh task stops fail with `ECS_WAKE_CRASH_LOOP`, a `PENDING` task with a fatal pull reason (`CannotPullContainerError`, …) with `ECS_WAKE_PULL_FAILURE` — both name the failure, and timeouts do too when one exists. Non-interactive `sleep` without `--yes` fails with `SLEEP_NON_INTERACTIVE`. Full catalog: [Headless Mode](/grada/guides/headless/).
- Every no-op reports a machine-readable `skipped` reason (`static-target`, `lambda-skip-db`, `lambda-no-database`, `already-awake`) and exits 0; with `--strict`, skips exit 2 instead (distinct from failure's 1) so scripts can tell "nothing to do" apart from success and error.
- Terraform stays consistent via a managed `terraform/sleep.auto.tfvars` marker (`asleep = true`) that `wake` deletes before restoring — never edit it by hand. Replica counts live in gitignored `.grada/sleep-state.json`; if that file is ever corrupt, the CLI quarantines it aside (`sleep-state.json.corrupt.<timestamp>`) and prints a one-line notice naming the backup instead of silently starting fresh.
- `sleep` refuses while an `add` scaffold is in progress (`--force` bypasses when your automation sequences commands itself).
- While asleep, `apply` refuses (wake-first offer / `--force`), while `add` and `rollback` proceed with a loud warning.

## Cost & billing drivers

While asleep you stop paying for Fargate task hours (`~$9.01/mo` per 256/512 replica) and RDS instance compute (`~$11.68/mo` for `db.t4g.micro`). 20 GB gp3 storage (`~$2.30/mo`), the ALB (`~$22.27/mo`), ElastiCache Valkey (`~$9.49/mo` — it has no pause API), and Secrets Manager secrets keep billing until you run `destroy`. Aurora Serverless v2 already idles at 0 ACU, so stopping it only prevents active wake-ups. Lambda projects skip the ALB line entirely — asleep, only storage, secrets, and (if present) Valkey keep billing.

## See also

- [status](/grada/cli/status/)
- [destroy](/grada/cli/destroy/)
