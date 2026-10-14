---
title: status
description: Check service health, Golden Signals, and CloudWatch alarms.
---

Instant health dashboard for your deployment. Exits cleanly when healthy; hands off to `diagnose` automatically when degraded.

## What it does

- Prints a color-coded dashboard: service status, replica counts, alarm states, and live Golden Signals (traffic, errors, latency, CPU/memory, database load).
- When degraded, hands off to `diagnose` automatically and exits 1; exits cleanly when healthy.
- On Lambda projects reports function state and deployed image instead; on static projects, CloudFront distribution status and the site URL.

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

## Automation & edge cases

- Degraded means `runningCount < desiredCount` or any alarm firing. Signals read standard AWS metrics only (no custom metrics); a metrics failure degrades to `null` sections without failing the check, and signals are `null` on Lambda.
- Inputs resolve automatically: region (`--region` → `AWS_REGION` → `terraform/main.tf` → `us-east-2`), cluster/service/log group from the project name (overridable via `ECS_CLUSTER` / `ECS_SERVICE` / `ECS_LOG_GROUP`).
- On [ejected](/grada/cli/eject/) projects, warns that the tree is user-owned but still reports — read-only commands never refuse.
- `--json` always emits exactly one JSON document: failures print an `{ok: false, ...}` envelope and exit 1, missing infrastructure prints the `{healthy: false, missing: true}` state and exits 0 — pipes never see prose.

## See also

- [exec](/grada/cli/exec/)
- [diagnose](/grada/cli/diagnose/)
- [alerts](/grada/cli/alerts/)
