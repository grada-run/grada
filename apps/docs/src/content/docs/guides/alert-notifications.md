---
title: Alert Notifications
description: Get paged when your service errors — SNS email and Slack/Discord webhook alerting via grada alerts, and drift alerts to Slack.
---

grada has two notification paths that solve different problems. They are independent mechanisms — set up one, the other, or both:

- **`grada alerts`** — pages a human when the live service errors (every compute target; email and chat-webhook delivery).
- **Drift Slack posts** — tells a channel when out-of-band console changes drift Terraform (any target, via the `drift.yml` workflow).

## Service alarms with `grada alerts`

Your stack already includes a dashboard alarm, but an alarm with no subscriber notifies nobody. `grada alerts` scaffolds the missing half — an SNS topic plus a target-aware notifying alarm:

| Target | Alarm metric | Default threshold |
| ------ | ------------ | ----------------- |
| ECS | ALB `HTTPCode_Target_5XX_Count` | > 10 5xx in 2 minutes |
| Lambda | Function `Errors` | > 5 errors in 5 minutes |
| Static | CloudFront `5xxErrorRate` | > 5% over 5 minutes |

```bash
npx grada-run alerts --email you@example.com --webhook https://hooks.slack.com/services/XXX
npx grada-run apply         # provisions the topic, alarm, and chat forwarder
```

This writes `terraform/alerts.tf` (refusing to overwrite without `--force`) and prints the follow-up steps. Static alarms live in `us-east-1` — the only region CloudWatch serves CloudFront metrics from — so `alerts` pins the topic, alarm, and forwarder there and adds the provider alias to `terraform/main.tf` when it is missing.

### Email delivery

`--email` bakes an SNS subscription into the file. SNS requires every subscriber to confirm, so the last step is manual — click the confirmation link in the inbox, then check the subscription shows `Confirmed` in the SNS console before relying on it. Until someone confirms, alarms publish into a topic with no listeners.

Run with no flags, `alerts` prompts for a destination in a terminal (Email, Webhook, or Both); in CI it scaffolds the topic + alarm and prints the manual subscribe command instead:

```bash
aws sns subscribe --topic-arn <topic-arn> --protocol email \
  --notification-endpoint you@example.com
```

### Chat webhook delivery

`--webhook` adds a scale-to-zero Node.js Lambda subscribed to the topic. Raw webhook URLs cannot complete the SNS confirmation handshake, so the Lambda adapts each alarm notification to the payload dialect its URL sniffs at runtime — `{"text"}` for Slack, `{"content"}` for Discord, alarm/state/reason/timestamp JSON for anything else.

The webhook URL is a bearer secret and never lands in git: it flows through the sensitive `alerts_webhook_url` Terraform variable. Export it before applying:

```bash
export TF_VAR_alerts_webhook_url='https://hooks.slack.com/services/XXX'
npx grada-run apply
```

The forwarder only runs when an alarm fires — no requests, no bill — and stays inside the Lambda free tier at any plausible alarm volume.

## Drift alerts to Slack

Separately, the opt-in drift workflow can post to a Slack channel when `terraform plan` detects drift. Set a `SLACK_WEBHOOK_URL` repository secret and the daily 06:00 UTC run posts a warning with the plan summary alongside opening (or updating) the `iac-drift` GitHub Issue. This is a plain workflow webhook, not SNS — it works on every compute target and needs no subscription step. See [`drift`](/grada/cli/drift/).

## See also

- [alerts](/grada/cli/alerts/) for flags and per-target thresholds.
- [status](/grada/cli/status/) for the health dashboard and Golden Signals the alarms watch.
- [Going-Live Checklist](/grada/guides/going-live/) for the full pre-launch notification setup.
- [ADR-0016](/grada/adrs/0016-sns-email-alert-delivery/) for why alerting started email-first and how chat delivery joined without breaking the cost or consent properties.
