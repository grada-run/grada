---
title: rollback
description: Roll back your ECS service to a previous task definition revision.
---

Two layers of deployment safety: your infrastructure rolls back bad deployments automatically, and you can manually return to any previous revision with one command.

## What it does

- Your ECS service ships with a deployment circuit breaker — if a new deployment fails its health checks, AWS automatically rolls it back without you lifting a finger.
- `rollback` takes you back to a previous task definition revision on demand: pass a revision number, or pick from an interactive list showing each revision's container image and registration date.
- In automation and CI (or with `--headless`), it defaults to the most recent older revision with no prompt.
- On a fresh stack it says so precisely instead of failing opaquely: a service on its only revision reports the revision number and suggests deploying again to create rollback history; a never-deployed service points you to `grada apply`.
- Resolves its inputs automatically: cluster (`<project-name>-cluster`, overridable via `ECS_CLUSTER`), service (`<project-name>-service`, overridable via `ECS_SERVICE`), and region (`--region` → `AWS_REGION` → `terraform/main.tf` → `us-east-2`). `--workspace` targets a PR-preview environment's namespaced service.
- Watches the rollback deployment until it stabilizes (up to 5 minutes), and points you to `status` and `logs` if it fails or times out.
- ECS only: on `--target lambda` projects the command exits with the Lambda-native alternative — redeploy a previous image with `aws lambda update-function-code` (list SHA tags via `aws ecr describe-images`). On `--target static` projects it exits with the same guard — static sites have no revisions, so push to redeploy.
- Emits a `rollback_run` telemetry event recording success and outcome.

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
| `[revision]` | Task revision to roll back to: a number (`12`), `family:revision` (`myapp-task:12`), or a full task definition ARN. Defaults to the most recent older revision (interactive prompt on a TTY). |
| `--cluster <name>` | Explicit cluster name override. |
| `--service <name>` | Explicit service name override. |
| `--region <region>` | Explicit AWS region override. |
| `--workspace <name>` | Roll back the PR-preview environment's service instead of production. |
| `--skip-wait` | Trigger the rollback and exit immediately without waiting for stabilization. |

## See also

- [status](/grada/cli/status/)
- [logs](/grada/cli/logs/)
- [diagnose](/grada/cli/diagnose/)
