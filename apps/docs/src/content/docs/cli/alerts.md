---
title: alerts
description: Scaffold SNS + alarm notifications with email and chat webhook delivery for every compute target.
---

Scaffolds notification infrastructure for your deployment: an SNS topic plus a target-aware alarm wired to it, with email and Slack/Discord webhook delivery.

## What it does

- Detects the compute target and scaffolds the matching alarm into `terraform/alerts.tf`: ALB 5xx rate on ECS, function errors on Lambda, CloudFront 5xx rate on static.
- `--email` bakes an SNS email subscription into the file (the recipient still clicks a confirmation link — no surprise subscriptions).
- `--webhook` adds a scale-to-zero forwarding Lambda posting to Slack, Discord, or generic JSON endpoints. The webhook URL is a bearer secret: it stays out of git in the sensitive `alerts_webhook_url` variable (`export TF_VAR_alerts_webhook_url=...` before `apply`).
- Run with no flags, `alerts` prompts for a destination (Email, Webhook, or Both) and validates it before writing.
- Refuses to overwrite an existing `alerts.tf` without `--force`.

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

## Automation & edge cases

- Alarm defaults: more than 10 ALB 5xx in 2 minutes (ECS), more than 5 function errors in 5 minutes (Lambda), more than 5% 5xx over 5 minutes (static).
- CloudWatch only serves CloudFront metrics from `us-east-1`, so static projects pin the topic, alarm, and forwarder to the `aws.us_east_1` provider alias — added to `terraform/main.tf` automatically when missing.
- Without `--email`/`--webhook`, non-interactive runs fail with `ALERTS_NON_INTERACTIVE`; explicit `--headless` scaffolds the topic + alarm with manual subscribe steps instead of prompting.

## See also

- [Alert Notifications](/grada/guides/alert-notifications/) for the email vs chat vs drift-alert setup guide.
- [status](/grada/cli/status/)
- [diagnose](/grada/cli/diagnose/)
