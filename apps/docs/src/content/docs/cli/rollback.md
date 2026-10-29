---
title: rollback
description: Roll back your ECS service to a previous task definition revision.
---

Two layers of deployment safety: your infrastructure rolls back bad deployments automatically, and you can manually return to any previous revision with one command.

## What it does

- Your ECS service ships with a deployment circuit breaker — failed deploys roll back automatically, with no action from you.
- `rollback` returns to a previous task definition revision on demand: pass a revision number, or pick from an interactive list of images and dates.
- On trees with a worker service, the worker rolls back alongside web to its own previous revision — the two never skew. Pass an explicit `--service` to roll back a single service.
- Watches the rollback until it stabilizes (up to 5 minutes), pointing you to `status` and `logs` if it fails or times out.
- On a fresh stack it says so precisely instead of failing opaquely — deploy again to create rollback history.
- ECS only: on Lambda projects it prints the Lambda-native alternative (redeploy a previous image); static sites have no revisions, so push to redeploy.

## Usage

```bash
npx grada-run rollback
npx grada-run rollback 12
npx grada-run rollback --skip-wait
npx grada-run rollback 12 --cluster myapp-cluster --service myapp-service
```

Without a revision number, you'll see an interactive revision selector:

```text
? Select a task definition revision to roll back to:
  Revision 13 — myapp:sha-9f2c1ab (2026-09-20)
  Revision 12 — myapp:sha-77d0e4f (2026-09-18)
  Revision 11 — myapp:sha-51b8c2d (2026-09-15)
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `[revision]` | Task revision to roll back to: a number (`12`), `family:revision` (`myapp-task:12`), or a full task definition ARN. Defaults to the most recent older revision (interactive prompt on a TTY). Explicit `family:revision`/ARN input must belong to the service's own family — foreign families are refused (`REVISION_FAMILY_MISMATCH`) rather than re-pointing the service. |
| `--cluster <name>` | Explicit cluster name override. |
| `--service <name>` | Explicit service name override. |
| `--region <region>` | Explicit AWS region override. |
| `--workspace <name>` | Roll back the PR-preview environment's service instead of production. |
| `--skip-wait` | Trigger the rollback and exit immediately without waiting for stabilization. |

## Automation & edge cases

- Headless runs default to the most recent older revision with no prompt. Wrong-target refusals exit 3 (distinct from failure's 1 and strict-skip's 2) so automation can tell them apart. Non-interactive runs with no revision and no TTY fail with `ROLLBACK_NON_INTERACTIVE` (pass a revision). Full catalog: [Headless Mode](/grada/guides/headless/).
- Inputs resolve automatically: cluster/service from the project name (overridable via `ECS_CLUSTER` / `ECS_SERVICE`), region (`--region` → `AWS_REGION` → `terraform/main.tf` → `us-east-2`); `--workspace` targets a PR-preview environment's namespaced service.
- On an asleep environment, proceeds with a warning (the restore targets stopped services) — `apply` stays gated until you [`wake`](/grada/cli/sleep/).

## See also

- [status](/grada/cli/status/)
- [logs](/grada/cli/logs/)
- [diagnose](/grada/cli/diagnose/)
