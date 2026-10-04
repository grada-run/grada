---
title: Alert Notifications
description: Get paged when your ALB serves errors — SNS email alerting via grada alerts, and drift alerts to Slack.
---

grada has two notification paths that solve different problems. They are independent mechanisms — set up one, the other, or both:

- **`grada alerts`** — pages a human when the live service errors (ECS-only, email delivery).
- **Drift Slack posts** — tells a channel when out-of-band console changes drift Terraform (any target, via the `drift.yml` workflow).

## Service alarms with `grada alerts`

Your stack already includes a dashboard 5xx alarm, but an alarm with no subscriber notifies nobody. `grada alerts` scaffolds the missing half:

```bash
npx grada-run alerts        # writes terraform/alerts.tf (refuses to overwrite without --force)
npx grada-run apply         # provisions the topic and alarm
```

This creates an `<project>-alerts` SNS topic plus a `<project>-5xx-notify` alarm (more than 10 5xx responses in 2 minutes, mirroring the dashboard thresholds), wired to publish into the topic. Re-running with `--force` replaces `alerts.tf` in place.

SNS requires every subscriber to confirm, so the last step is manual — subscribe an email address, then click the confirmation link:

```bash
aws sns subscribe --topic-arn <topic-arn> --protocol email \
  --notification-endpoint you@example.com
```

Find `<topic-arn>` in the SNS console (or in the `apply` output); confirm the subscription shows `Confirmed` before relying on it. Until someone confirms, alarms publish into a topic with no listeners.

**Email is the only delivery today.** Raw Slack/Discord webhook URLs cannot complete the SNS confirmation handshake, so they need a forwarding Lambda that grada does not generate yet — email works end to end, chat webhooks are documented future work. On `--target lambda` and `--target static` projects `alerts` exits with a clear error: there is no ALB to alarm on.

## Drift alerts to Slack

Separately, the opt-in drift workflow can post to a Slack channel when `terraform plan` detects drift. Set a `SLACK_WEBHOOK_URL` repository secret and the daily 06:00 UTC run posts a warning with the plan summary alongside opening (or updating) the `iac-drift` GitHub Issue. This is a plain workflow webhook, not SNS — it works on every compute target and needs no subscription step. See [`drift`](/grada/cli/drift/).

## See also

- [alerts](/grada/cli/alerts/) for flags and the ECS-only guard.
- [status](/grada/cli/status/) for the health dashboard and Golden Signals the alarms watch.
- [Going-Live Checklist](/grada/guides/going-live/) for the full pre-launch notification setup.
- [ADR-0016](/grada/adrs/0016-sns-email-alert-delivery/) for why alerting is email-first with no forwarding compute.
