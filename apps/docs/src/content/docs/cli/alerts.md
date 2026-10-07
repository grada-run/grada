---
title: alerts
description: Scaffold SNS + alarm notifications with email and chat webhook delivery for every compute target.
---

Scaffolds notification infrastructure for your deployment: an SNS topic plus a target-aware alarm wired to it, with email and Slack/Discord webhook delivery.

## What it does

- Detects the compute target from `terraform/main.tf` and scaffolds the matching alarm into `terraform/alerts.tf`:
  - **ECS:** `HTTPCode_Target_5XX_Count` on the ALB (default: more than 10 5xx in 2 minutes, mirroring the dashboard alarm).
  - **Lambda:** `Errors` on the app function (default: more than 5 errors in 5 minutes).
  - **Static:** `5xxErrorRate` on the CloudFront distribution (default: more than 5% over 5 minutes). CloudWatch only serves CloudFront metrics from `us-east-1`, so the topic, alarm, and forwarder are pinned to the `aws.us_east_1` provider alias — `alerts` adds the alias to `terraform/main.tf` when it is missing.
- `--email` bakes an SNS email subscription into the file (the recipient still clicks a confirmation link — no surprise subscriptions).
- `--webhook` adds a scale-to-zero Node.js forwarding Lambda that adapts alarm notifications to Slack, Discord, or generic JSON payloads. The webhook URL is a bearer secret: it stays out of git in the sensitive `alerts_webhook_url` variable (`export TF_VAR_alerts_webhook_url=...` before `apply`), and the `archive` provider it needs is pinned in `terraform/backend.tf`.
- Run with no flags in a terminal, `alerts` prompts for a destination (Email, Webhook, or Both) and validates it before writing. In CI / non-TTY shells it scaffolds the topic + alarm and prints the manual subscribe steps instead of prompting.
- Refuses to overwrite an existing `alerts.tf` without `--force`.
- Emits an `alerts_run` telemetry event recording the target and destination kinds only — never the address or URL.

## Usage

```bash
npx grada-run alerts
npx grada-run alerts --email you@example.com
npx grada-run alerts --webhook https://hooks.slack.com/services/XXX
npx grada-run alerts --email you@example.com --webhook https://discord.com/api/webhooks/XXX --threshold 3
npx grada-run alerts --force
```

After scaffolding with `--webhook`:

```bash
export TF_VAR_alerts_webhook_url='https://hooks.slack.com/services/XXX'
npx grada-run apply
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `--email <address>` | Bake an SNS email subscription into `alerts.tf` (confirmation click still required). |
| `--webhook <url>` | Add a forwarding Lambda posting to this `https://` Slack/Discord/generic webhook. |
| `--threshold <number>` | Alarm threshold override. Counts for ECS/Lambda, percent (0–100) for static. |
| `--force` | Overwrite an existing `terraform/alerts.tf`. |
| `--region <region>` | Explicit AWS region override. |

## See also

- [Alert Notifications](/grada/guides/alert-notifications/) for the email vs chat vs drift-alert setup guide.
- [status](/grada/cli/status/)
- [diagnose](/grada/cli/diagnose/)
