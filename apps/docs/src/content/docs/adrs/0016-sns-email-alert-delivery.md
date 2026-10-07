---
title: "SNS Email Alert Delivery with Manual Subscription"
description: "Scaffold an SNS topic plus 5xx alarm for ECS projects and let users subscribe an email address — no forwarding compute."
---

* **Status:** Accepted (amended 2026-10-07: universal multi-channel alerts)
* **Date:** 2026-10-04 (Retroactive)

## Context and Problem Statement

The generated stack has always included a 5xx CloudWatch alarm, but an alarm nobody receives is a dashboard decoration. Users asked for notifications that reach them — while the SNS subscription model requires a confirmation handshake that raw Slack/Discord webhook URLs cannot perform, so chat delivery needs a forwarding component and email does not.

We needed working notifications with no new always-on compute and no third-party service dependency.

## Decision Drivers

* **No new compute:** Alerting must not provision a Lambda, queue poller, or any other billable runtime for the v1 path.
* **Explicit consent:** Whoever receives alerts must confirm (SNS email handshake), not be silently subscribed by a scaffold command.
* **ECS-first:** The alarm dimensions (`aws_lb` 5xx counts) only exist on the ALB target; other targets come later.

## Considered Options

1. **Forwarding Lambda for chat webhooks.** (Rejected for v1: a new function plus IAM plus packaging for every project, to forward what email already delivers. Kept as documented future work.)
2. **Third-party paging service.** (Rejected: forces an external account, API token storage, and a vendor dependency onto the first-deploy path.)
3. **Scaffold SNS + alarm, subscribe email manually.** `grada alerts` writes `terraform/alerts.tf` (an `<project>-alerts` SNS topic plus a `<project>-5xx-notify` alarm mirroring the dashboard thresholds: more than 10 5xx in 2 minutes); the CLI then prints the follow-up — `apply`, subscribe an email address (console or `aws sns subscribe`), click the confirmation link.

## Decision Outcome

**Chosen Option:** Manual email subscription over scaffolded SNS infrastructure. `alerts` refuses non-ECS targets with a clear error (Lambda and static have no ALB to alarm on) and refuses to overwrite an existing `alerts.tf` without `--force`. Drift-detection Slack posts stay a separate mechanism — a workflow-level webhook in `drift.yml`, not SNS — so the two notification paths never share failure modes.

### Positive Consequences

* Working end-to-end notifications with zero new compute and ~$0 cost (SNS email delivery is free at this volume).
* The confirmation handshake guarantees the recipient opted in; no surprise subscriptions from automation.
* `alerts.tf` lives in `terraform/`, so `destroy` tears it down and `eject` keeps it like any other generated file.

### Negative Consequences

* Chat-native teams get no Slack/Discord path until the forwarding Lambda ships — the CLI must say so plainly (it does) rather than let users paste webhook URLs that can never confirm.
* The manual console step is a small papercut on an otherwise zero-click CLI; forgetting it means alarming into the void.
* Lambda and static targets have no alert scaffolding yet.

## Amendment (2026-10-07): Universal Multi-Channel Alerts

All three negative consequences above are now retired. `grada alerts` scaffolds per-target alarms on every compute target — ALB 5xx (ECS), Lambda Errors (lambda), CloudFront 5xxErrorRate (static) — with `--email` (baked SNS subscription, confirmation click still required) and `--webhook` (a scale-to-zero Node.js forwarding Lambda adapting notifications to Slack/Discord/generic payloads) destinations, alone or combined.

The v1 decision drivers survive the transition:

* **No new always-on compute:** the forwarder runs only on alarm delivery, inside the Lambda free tier at any plausible volume — the "no billable runtime" property holds in the scale-to-zero sense.
* **Explicit consent:** email keeps the SNS confirmation handshake; chat delivery needs no consent step because the operator pastes their own webhook URL explicitly.
* **ECS-first is now target-aware:** the ECS alarm resources are unchanged from v1 (same thresholds, same topic and alarm names); lambda/static alarms are new files, not retrofits.

Two implementation consequences worth recording:

* **Static alerts live in `us-east-1`.** CloudWatch serves CloudFront metrics only there, and an alarm's SNS actions must sit in the alarm's region — so the topic, alarm, and forwarder are pinned to the `aws.us_east_1` alias, which `alerts` adds to `terraform/main.tf` when missing (the same home `grada domain` uses, so the two never declare it twice).
* **The webhook URL stays out of git** via the sensitive `alerts_webhook_url` variable (`TF_VAR_alerts_webhook_url`), not a new Secrets Manager secret — a dedicated secret would cost $0.40/mo and break the $0.00 alerting baseline. Telemetry records destination kinds only, never the address or URL.
