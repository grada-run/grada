---
title: gc
description: Discover and delete orphaned ECR images, CloudWatch log groups, and Elastic IPs.
---

Dry-run discovery and interactive deletion of orphaned AWS resources left behind by failed deployments, deleted PR previews, or manual console changes — protecting your AWS bill without leaving the terminal.

## What it does

- Finds orphaned ECR images, preview-leftover log groups, and unassociated Elastic IPs — then prints a categorized dry-run summary before asking anything.
- Never touches live resources: the live log group is always excluded (Lambda scans `/aws/lambda/<project-name>-*` minus the live function group).
- Deep mode (`--deep`) additionally audits VPCs, secrets, and the state bucket — strictly report-only, never deleted.

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

## Automation & edge cases

- `--yes` is the CI hatch for standard-target deletion; deep findings stay report-only with or without it. Non-interactive runs without `--yes` fail with `GC_NON_INTERACTIVE` instead of prompting.
- Discovery paginates fully, so large accounts are completely scanned.
- AWS failures print a one-line message with the credentials hint and exit 1 (headless callers get a structured `{ ok: false }` result instead) — never a raw SDK dump.

## Safety

Deletion requires explicit interactive confirmation (`Are you sure you want to permanently delete these orphaned resources? (y/N)`, defaulting to no), unless `--yes` is passed. Declining or cancelling deletes nothing; finding nothing skips the prompt entirely.

Deep discovery (`--deep`) is strictly read-only: VPCs, secrets, and the state bucket are reported but never deleted, because live infrastructure matches the same name heuristics. Standard-target deletion is ownership-scoped, never prefix-scoped: untagged images come only from your exact `<project>-repo` ECR repository, and log-group candidates must match your anchored `-pr-<n>` preview shape — foreign lookalikes (`myapp-evil-…`) in a shared account are never proposed. The live log group is always excluded, as are preview groups whose service (ECS) or function (Lambda) still exists; when that liveness check itself fails, no preview groups are proposed at all and `gc` says so. VPC candidates additionally pass ECS liveness across the default and every workspace cluster — Grada-minted `pr-N` and hand-made (`staging`) alike — so VPCs behind desired or running services are `live — excluded`, plus the stack-VPC name check (your own network is excluded even when asleep); when liveness itself is unverifiable, no VPCs are proposed and `gc` says so.

## See also

- [status](/grada/cli/status/)
- [Ephemeral PR Previews](/grada/guides/ephemeral-pr-previews/)
