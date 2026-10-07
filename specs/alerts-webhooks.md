# Specification: Cross-Target Alerts & Chat Webhooks

## 1. Overview
Expand `grada alerts` from an ECS-only email alert to a universal observability command supporting all three compute targets (`ecs`, `lambda`, `static`) and multi-channel destinations: Email (direct SNS) and Chat Webhooks (Slack, Discord, generic incoming webhook via an inline forwarding Lambda).

## 2. Boundaries & Constraints
- **Universal Target Support:** Remove the `target !== 'ecs'` guard in `src/commands/alerts.js`. Support `ecs`, `lambda`, and `static` projects.
- **FinOps & Zero-Baseline:** 
  - Standard CloudWatch alarms stay within the AWS Free Tier (first 10 metric alarms free; $0.10/mo thereafter).
  - The forwarding Lambda runs purely on alarm triggers (scale-to-zero, $0.00 fixed cost within the 1M monthly free requests).
- **Webhook Compatibility:** Auto-detect payload format based on URL or provide universal payloads:
  - Slack (`hooks.slack.com`): `{"text": "..."}` or block kit.
  - Discord (`discord.com/api/webhooks`): `{"content": "..."}` or embeds.
  - Generic: fallback payload with alarm name, state, reason, and timestamp.
- **Secret Handling:** Webhook URLs contain sensitive tokens; store the webhook URL in AWS Secrets Manager (`alerts_webhook_url`) or pass via a sensitive Terraform variable to prevent git leakage.

## 3. Implementation Targets

### A. CLI Command & Flags (`src/commands/alerts.js`)
- Support flags:
  - `--email <address>`: Traditional SNS email subscriber.
  - `--webhook <url>`: Incoming webhook URL (Slack/Discord/generic).
  - `--threshold <number>`: Error count / percentage threshold (defaults: ECS: 10 5xxs/5min, Lambda: 5 errors/5min, Static: 5% 5xx error rate/5min).
- Interactive mode (when run without flags):
  - Prompt user to select destination type: `Email`, `Slack/Discord Webhook`, or `Both`.
  - Validate email and/or HTTPS webhook URL before touching disk.

### B. Terraform Generator & Addon Template (`templates/terraform/addons/alerts.tf`)
- **Notification Topic:** Single `aws_sns_topic` (`alerts`).
- **Target-Aware Alarms:**
  - `ecs`: Alarm on `aws_lb_target_group` / ALB `HTTPCode_Target_5XX_Count >= threshold`.
  - `lambda`: Alarm on `aws_lambda_function.app` `Errors >= threshold` (or API Gateway HTTP API `5XXError`).
  - `static`: Alarm on `aws_cloudfront_distribution.site` `5xxErrorRate >= threshold` (evaluated in `us-east-1` provider alias).
- **Webhook Forwarder (when `--webhook` is configured):**
  - Minimal inline Node.js runtime Lambda (`alerts_forwarder`) packaged using Terraform `archive_file`.
  - Subscribes to the SNS topic via `aws_sns_topic_subscription` (`protocol = "lambda"`).
  - Handles CloudWatch SNS alarm JSON, formats markdown for Slack/Discord, and issues an HTTPS POST.

### C. ADR & Documentation Updates
- Update `apps/docs/src/content/docs/cli/alerts.md` to document `--webhook`, `--email`, and the target-specific failure metrics.
- Amend ADR-0016 to record the transition from ECS-only email alerts to universal multi-channel alerts.

## 4. Acceptance Criteria
1. `grada alerts --webhook <url>` scaffolds valid `terraform/alerts.tf` across `ecs`, `lambda`, and `static` projects.
2. `terraform validate` and `tflint` pass cleanly on rendered `alerts.tf` for all three targets.
3. Unit tests cover command flag parsing, target dispatch, webhook URL validation, and alert template rendering.