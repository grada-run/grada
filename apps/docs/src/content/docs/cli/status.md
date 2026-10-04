---
title: status
description: Check service health, Golden Signals, and CloudWatch alarms.
---

Instant health dashboard for your deployment. Exits cleanly when healthy; hands off to `diagnose` automatically when degraded.

## What it does

- Queries ECS (`desiredCount` vs `runningCount`/`pendingCount`) and project-prefixed CloudWatch alarms.
- Prints a color-coded dashboard: service status, replicas (green/yellow/red), alarm states, and live Golden Signals (ALB requests/5xx/p95, ECS CPU/memory, DB ACU or CPU plus connections over the last 15 minutes).
- Signals read standard AWS metrics only — no custom metrics are created, and any telemetry failure degrades to `null` sections without failing the health check.
- If degraded (`runningCount < desiredCount` or any alarm firing), prints the degraded notice, invokes `diagnose`, and exits 1.
- Resolves region like `logs` (`--region` → `AWS_REGION` → `terraform/main.tf` → `us-east-2`); cluster, service, and log group default to `<project-name>-cluster`, `<project-name>-service`, `/ecs/<project-name>` (overridable via `ECS_CLUSTER` / `ECS_SERVICE` / `ECS_LOG_GROUP`).
- On `--target lambda` projects, reads function state via the AWS CLI (which must be installed) instead of ECS, printing function state, last update status, memory/timeout, and deployed image. Signals are `null` on Lambda for now.
- On `--target static` projects, reports CloudFront distribution status (`Deployed` vs propagating) and the site URL instead of ECS.
- Emits a `status_run` telemetry event recording health and outcome.

## Usage

```bash
npx grada-run status
npx grada-run status --json
npx grada-run status --watch
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `--json` | Output the raw status payload as JSON; disables auto-diagnose. |
| `--watch` | Repaint the dashboard every 10 seconds until interrupted; skips auto-diagnose (diagnosis stays manual). Ignored when combined with `--json`. |
| `--region <region>` | Explicit AWS region override. |

## See also

- [exec](/grada/cli/exec/)
- [diagnose](/grada/cli/diagnose/)
- [alerts](/grada/cli/alerts/)
