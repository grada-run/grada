---
title: "SNS Email Alert Delivery with Manual Subscription"
description: "Scaffold an SNS topic plus 5xx alarm for ECS projects and let users subscribe an email address — no forwarding compute."
---

* **Status:** Accepted
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
