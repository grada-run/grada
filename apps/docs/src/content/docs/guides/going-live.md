---
title: Going-Live Checklist
description: The console approvals, DNS steps, and safety nets to finish before real traffic arrives.
---

grada automates the infrastructure, but a few steps inherently need a human: AWS console approvals, DNS records at your provider, and confirming notifications reach someone. Work through this list before announcing the URL.

## Identity and deliverability

- [ ] **Custom domain attached.** `domain add` with `--zone-id` automates Route 53 end to end; external DNS needs the printed CNAMEs pasted at your provider, then `domain verify` + `apply`. Confirm the alias serves before sharing the URL.
- [ ] **SES out of the sandbox** (if sending email). New accounts only send to verified addresses — request production access in the SES console (a short use-case form, usually approved within a day) before real users depend on mail.
- [ ] **Bedrock model access enabled** (if using `ai:bedrock`). IAM permissions are not enough: enable each model in the Bedrock console, including the regions behind your `us.*` inference profile. Anthropic models additionally need the one-time First Time Use form.

## Data safety

- [ ] **Secrets pushed and mapped.** `secrets push`, commit `secret_keys.json`, push to deploy — then `secrets audit` to confirm the app sees every variable it needs.
- [ ] **First backup taken** (if running a database). `db backup --id pre-launch` before the first migration or import, so every later operation has a restore point.
- [ ] **Migration gate wired** (if schema changes ship with code). `db migrate --cmd "<command>" --setup-ci` (or `--setup-ci-migrate` at init) halts releases when migrations fail — ECS targets only; Lambda projects run migrations from CI against the database endpoint.

## Operations

- [ ] **Alerts subscribed.** `alerts` + `apply`, then confirm the SNS email subscription shows `Confirmed` — an unconfirmed topic pages nobody. See [Alert Notifications](/grada/guides/alert-notifications/).
- [ ] **Drift detection on.** `drift --setup` (or `--setup-ci-drift` at init) for the daily plan check with `iac-drift` issues, plus a `SLACK_WEBHOOK_URL` secret if the team lives in Slack.
- [ ] **Billing ceiling set.** The CLI estimates expected spend; pair it with an AWS Budgets billing alarm in the console so actuals page you too.
- [ ] **PR previews enabled** (if working as a team). `--enablePrPreviews` at init gives every PR an isolated environment with teardown on close — close stale PRs so ALB-hours stop billing.
- [ ] **Staging sleeps.** Non-production environments should `sleep` when idle (exact savings print at sleep time; databases auto-restart after 7 days — the CLI shows the timestamp).

## Final verification

- [ ] `status` reports healthy with quiet alarms, and you have seen one full `git push` deploy end to end.
- [ ] The pre-flight baseline in `apply --dry-run` matches what you expect to pay — no surprise worker, database, or Valkey node.
- [ ] Skim one pipeline run's Trivy summaries: scans are advisory-only and never block, so a human glance is the gate.

## See also

- [Understanding Your AWS Bill](/grada/guides/understanding-your-bill/) for what each piece costs.
- [Alert Notifications](/grada/guides/alert-notifications/) for the SNS subscription walkthrough.
- [Ephemeral PR Previews](/grada/guides/ephemeral-pr-previews/) for preview costs and lifecycle.
