---
title: logs
description: Stream CloudWatch logs for your ECS service.
---

Stream recent and live CloudWatch logs for the current project, without opening the AWS console.

## What it does

- Prints recent lines with dimmed timestamps and task IDs; errors in red, warnings in yellow.
- With `-f`, streams live until Ctrl+C, which exits cleanly.
- On Lambda projects tails the function's log group instead (the service filter is ignored — Lambda stream names are request-based).

## Usage

```bash
npx grada-run logs
npx grada-run logs api --tail 100 --error
npx grada-run logs -f --since 5m
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `[service]` | Service/container filter. Defaults to the project service. |
| `--tail <n>` | Recent lines to show (default `50`). |
| `-f, --follow` | Stream live until interrupted. |
| `--error` | Show only error lines (`ERROR`, `FATAL`, `Exception`, `fail`, `5XX`). |
| `--since <duration>` | Look-back window, e.g. `5m`, `1h`, `1d` (default `1h` for one-shot reads). |
| `--region <region>` | Explicit AWS region override. |
| `--workspace <name>` | Target a PR-preview environment (e.g. `--workspace pr-123`). Falls back to the workspace in `.terraform/environment`. |

## Automation & edge cases

- Inputs resolve automatically: log group from the project name (overridable via `ECS_LOG_GROUP`), region (`--region` → `AWS_REGION` → `terraform/main.tf` → `us-east-2`); `--workspace` targets a PR-preview environment's namespaced log group.
- Follow mode polls every 2 seconds. On expired credentials you get the `aws sso login` / `aws configure` hint and exit 1; on a missing log group, the matching `aws logs describe-log-groups` lookup instead of an error dump. Any other AWS failure prints a one-line message with the credentials hint and exits 1 (headless callers get a structured `{ ok: false }` result instead) — never a raw SDK dump.

## See also

- [exec](/grada/cli/exec/)
- [status](/grada/cli/status/)
