---
title: alerts
description: Scaffold SNS + 5xx alarm notifications for ECS projects.
---

Scaffolds notification infrastructure for your deployment: an SNS topic plus a 5xx alarm wired to it. ECS-only for now.

## What it does

- Writes `terraform/alerts.tf` with an `aws_sns_topic` (`<project>-alerts`) and an `aws_cloudwatch_metric_alarm` (`<project>-5xx-notify`, mirroring the dashboard alarm's thresholds: >10 5xx in 2 minutes).
- Refuses to overwrite an existing `alerts.tf` without `--force`.
- Prints the manual follow-up: `apply`, then subscribe an email address to the topic and click the confirmation link.
- Emits an `alerts_run` telemetry event recording the outcome.

Raw Slack/Discord webhook URLs cannot confirm SNS subscriptions (SNS requires a confirmation handshake webhooks don't perform), so email is the supported delivery today — a forwarding Lambda for chat webhooks is future work.

## Usage

```bash
npx grada-run alerts
npx grada-run alerts --force
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `--force` | Overwrite an existing `terraform/alerts.tf`. |
| `--region <region>` | Explicit AWS region override. |

## See also

- [status](/grada/cli/status/)
- [diagnose](/grada/cli/diagnose/)
