---
title: diagnose
description: Diagnose failing ECS deployments from logs and task state.
---

Inspect recent ECS task failures and CloudWatch logs for the current project.

## What it does

- Saves you from digging through the AWS console by finding the most recently stopped ECS task for this project and showing why it stopped plus the failing container's recent log events (up to 50 lines).
- Resolves its inputs automatically: the AWS region from `AWS_REGION`, falling back to `region` in `terraform/main.tf` (default `us-east-2`); the cluster (`<project-name>-cluster`, overridable via `ECS_CLUSTER`); and the log group (`/ecs/<project-name>`, overridable via `ECS_LOG_GROUP`). The project name itself comes from `app_name` in `terraform/main.tf`, falling back to the current directory name.
- Lists up to 100 recent stopped tasks, describes them in a single batch, and diagnoses the most recently stopped one (by container exit time, falling back to stop/start/creation time): stopped reason, failing container name, exit code, container reason, and how long ago it stopped.
- Reports recovery instead of a stale crash: when the crash belongs to a superseded task-definition revision, or a running task started after the stop, prints the previous crash as one-line context (no log dump) and exits healthy.
- Fetches logs from the crashed task's own CloudWatch stream first, falling back to the last hour of group-wide events; reports a missing log group distinctly instead of showing an empty result.
- Makes no changes to your infrastructure; it is read-only. Prints a healthy message and exits when no stopped tasks exist.
- On `--target lambda` projects, checks function state and configuration via the AWS CLI and tails the function's recent log events instead of inspecting ECS tasks.
- On `--target static` projects there is no ECS cluster, so the stopped-task lookup has no history to inspect and fails — use `status` (distribution state and site URL) instead.
- On expired AWS credentials, points you to `aws sso login` / `aws configure` and the [AWS credentials guide](/grada/guides/aws-credentials/), then exits with code 1 instead of throwing.
- Emits a `diagnose_run` telemetry event recording success and whether the service was healthy.

## Usage

```bash
npx grada-run diagnose
npx grada-run wtf
```

`wtf` is an alias for `diagnose`.

## Flags

This command accepts no CLI flags. Region, cluster, and log group are resolved as described above, not from flags.

## See also

- [exec](/grada/cli/exec/)
- [status](/grada/cli/status/)
- [ADR-0004: IaC-Driven Diagnostic Context](/grada/adrs/0004-iac-driven-diagnostic-context/)
