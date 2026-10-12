---
title: diagnose
description: Diagnose failing ECS deployments from logs and task state.
---

Inspect recent ECS task failures and CloudWatch logs for the current project.

## What it does

- Finds the most recently stopped task for this project and shows why it stopped, plus the failing container's recent log events — no console digging.
- Reports recovery instead of a stale crash: if a newer revision or a running task already superseded it, you get one line of context and a healthy exit.
- Read-only, and prints a healthy message when nothing stopped. On Lambda projects it checks function state and tails recent log events instead.
- On static projects there is nothing to inspect — use `status` (distribution state and site URL) instead.

## Usage

```bash
npx grada-run diagnose
npx grada-run wtf
```

`wtf` is an alias for `diagnose`.

## Flags

This command accepts no CLI flags. Region, cluster, and log group resolve automatically, not from flags.

## Automation & edge cases

- Inputs resolve automatically: region from `AWS_REGION`, falling back to `region` in `terraform/main.tf` (default `us-east-2`); cluster and log group from the project name (overridable via `ECS_CLUSTER` / `ECS_LOG_GROUP`); the project name from `app_name` in `terraform/main.tf`, falling back to the directory name.
- Diagnoses the most recently stopped of up to 100 recent tasks (by container exit time, with fallbacks): stopped reason, failing container, exit code, and how long ago — with up to 50 log lines from the crashed task's own stream first, then the last hour of group-wide events.
- On expired credentials, points to `aws sso login` / `aws configure` and the [AWS credentials guide](/grada/guides/aws-credentials/), then exits 1 instead of throwing.

## See also

- [exec](/grada/cli/exec/)
- [status](/grada/cli/status/)
- [ADR-0004: IaC-Driven Diagnostic Context](/grada/adrs/0004-iac-driven-diagnostic-context/)
