---
title: run
description: Run a one-off command inside your VPC in a disposable container.
---

Run any command inside your production environment — data backfills, database seeders, admin scripts, cache clears — in a clean, short-lived container built from your deployed image and environment. No bastion hosts, no touching the live service.

## What it does

- Spins up an ephemeral Fargate task from your deployed image and environment variables, runs `--cmd`, streams `stdout`/`stderr` live to your terminal, then tears the task down.
- Exits with the task's own exit code, so CI pipelines fail correctly when the command fails.
- Database-aware: when your container carries discrete `DB_*` credentials, the task gets a synthesized `DATABASE_URL` automatically, so seeders and backfills connect with no extra flags.
- Applies the same stripped-runner guard as `db migrate`: `npm`/`npx` commands are refused headless when your Dockerfile strips those binaries — use a compiled `node ...` path instead.
- ECS only: Lambda and static projects get a clean unsupported-target message instead of a cryptic AWS error.

## Usage

```bash
npx grada-run run --cmd "node ./dist/backfill.cjs"
npx grada-run run --cmd "python manage.py createsuperuser" --timeout 300
npx grada-run run --cmd "node ./dist/seed.cjs" --workspace pr-123 --headless
```

Omit `--cmd` interactively and you will be prompted for the command. Press `Ctrl+C` to abort — the remote task is stopped for you.

## run vs exec

- `run` (`--cmd`) launches a fresh, disposable container for one job and streams its logs. Nothing to install beyond the CLI, and the live service is never touched — the immutable-friendly default.
- `exec` (`--command`) opens a session inside an already-running container via Session Manager (needs the AWS CLI and plugin). Better for inspecting live state.

## Flags

| Flag | Description |
| ---- | ----------- |
| `--cmd <command>` | Command to run. Prompted interactively when omitted; required with `--headless`. |
| `--timeout <seconds>` | Task timeout (default `600`). The task is stopped best-effort on expiry. |
| `--task-def <task-def>` | Pin a task definition revision (default: the service's current revision). |
| `--workspace <name>` | Target a PR-preview environment (e.g. `--workspace pr-123`). Falls back to the workspace in `.terraform/environment`. |
| `--project-name <name>` | Explicit project name override. |
| `--region <region>` | Explicit AWS region override. |
| `--cluster <name>` | Explicit cluster name override. |
| `--service <name>` | Explicit service name override. |
| `--container <name>` | Explicit container name override. |

## Automation & edge cases

- Inputs resolve automatically: cluster, service, and container from the project name, region (`--region` → `AWS_REGION` → `terraform/main.tf` → `us-east-2`); `--workspace` targets a PR-preview environment's namespaced service, so preview runs never land in production.
- Headless runs fail loud with named errors instead of prompting: `MISSING_RUN_CMD` without `--cmd`, `NPM_CMD_STRIPPED_RUNNER` for `npm`/`npx` commands against a stripped runner image.
- On expired credentials you get the `aws sso login` / `aws configure` pointer and exit 1 instead of an error dump.

## Prerequisites

- Run `npx grada-run apply` first: there must be a deployed ECS service to borrow the image, environment, and network from.

## See also

- [exec](/grada/cli/exec/)
- [db](/grada/cli/db/)
- [status](/grada/cli/status/)
- [logs](/grada/cli/logs/)
