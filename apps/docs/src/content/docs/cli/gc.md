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

- `--yes` is the CI hatch for standard-target deletion; deep findings stay report-only with or without it.
- Discovery paginates fully, so large accounts are completely scanned.

## Safety

Deletion requires explicit interactive confirmation (`Are you sure you want to permanently delete these orphaned resources? (y/N)`, defaulting to no), unless `--yes` is passed. Declining or cancelling deletes nothing; finding nothing skips the prompt entirely.

Deep discovery (`--deep`) is strictly read-only: VPCs, secrets, and the state bucket are reported but never deleted, because live infrastructure matches the same name heuristics. Standard-target deletion is scoped to resources tagged `GradaProject = <project-name>` (an exact tag match, not a name-prefix match), so projects sharing one AWS account can never delete each other's resources. The `GradaProject` tag is stamped on every managed resource via `default_tags` at `init` time.

## See also

- [status](/grada/cli/status/)
- [Ephemeral PR Previews](/grada/guides/ephemeral-pr-previews/)
