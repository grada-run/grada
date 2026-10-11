---
title: gc
description: Discover and delete orphaned ECR images, CloudWatch log groups, and Elastic IPs.
---

Dry-run discovery and interactive deletion of orphaned AWS resources left behind by failed deployments, deleted PR previews, or manual console changes — protecting your AWS bill without leaving the terminal.

## What it does

- Scans ECR repositories matching `<project-name>-*` for untagged images and batch-deletes them.
- Scans CloudWatch log groups under `/ecs/<project-name>-*` (preview leftovers; the live `/ecs/<project-name>` group is never matched) and deletes them. On `--target lambda` projects it scans `/aws/lambda/<project-name>-*` instead, always excluding the live `/aws/lambda/<project-name>-fn` group.
- Scans Elastic IPs and releases any without an association (stops the hourly unused-EIP charge).
- Paginates all discovery APIs, so large accounts are fully scanned.
- Prints a categorized dry-run summary with per-target counts before asking anything.
- Deep mode (`--deep`) additionally audits VPCs, Secrets Manager secrets, and the Terraform state bucket for leftovers.

## Usage

```bash
npx grada-run gc
npx grada-run gc --region eu-west-1
npx grada-run gc --deep
npx grada-run gc --yes
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `--region <region>` | Explicit AWS region override. |
| `--project-name <name>` | Explicit project name override (defaults to `app_name` in `terraform/main.tf`, then the current directory name). |
| `--deep` | Audit VPCs, secrets, and the state bucket in addition to the standard targets. Deep findings are report-only: nothing in this tier is ever deleted. |
| `--yes` | Auto-confirm deletion of the standard targets (ECR images, log groups, EIPs) without prompting. Intended for CI; deep findings stay report-only. |

## Safety

Deletion requires explicit interactive confirmation (`Are you sure you want to permanently delete these orphaned resources? (y/N)`, defaulting to no), unless `--yes` is passed. Declining or cancelling deletes nothing; finding nothing skips the prompt entirely.

Deep discovery (`--deep`) is strictly read-only: VPCs, secrets, and the state bucket are reported but never deleted, because live infrastructure matches the same name heuristics. Standard-target deletion is scoped to resources tagged `GradaProject = <project-name>` (an exact tag match, not a name-prefix match), so projects sharing one AWS account can never delete each other's resources. The `GradaProject` tag is stamped on every managed resource via `default_tags` at `init` time.

## See also

- [status](/grada/cli/status/)
- [Ephemeral PR Previews](/grada/guides/ephemeral-pr-previews/)
