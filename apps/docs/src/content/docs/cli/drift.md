---
title: drift
description: Detect out-of-band AWS changes with terraform plan, locally or on a daily GitHub Actions schedule.
---

Catch console click-ops before they surprise you: compare live AWS state against Terraform, locally on demand or daily in CI with automatic GitHub Issues.

## What it does

- `drift` runs `terraform init` + `terraform plan -detailed-exitcode` in `terraform/` and reports `✅ No infrastructure drift detected` (exit `0`), `⚠ Infrastructure drift detected!` with a resource summary (exit `2`), or a plan failure (exit `1`).
- `drift --setup` (alias: `drift init`) scaffolds `.github/workflows/drift.yml` into an existing project, reusing your deploy workflow's OIDC role — no extra secrets needed.
- `--setup-ci-drift` scaffolds the same workflow during `grada` scaffolding.
- The scheduled workflow runs daily at 06:00 UTC (plus a manual `workflow_dispatch` trigger): on drift it opens (or updates, without spamming) a GitHub Issue labeled `iac-drift` with the plan diff; when drift resolves it comments `✅ Drift resolved` and closes the issue.
- Set a `SLACK_WEBHOOK_URL` repository secret to also post drift alerts to Slack.

## Before the first apply

A plan on never-applied infrastructure also exits `2` (everything "to add") — that is not drift. Both paths check `terraform state list` first: when the state tracks no resources yet, the CLI reports `✅ Nothing provisioned yet` (exit `0`) and the scheduled workflow skips the issue/Slack alarm, noting the skip in the run summary. Run `apply` once, and drift checks start meaning drift.

## Usage

```bash
npx grada-run drift
npx grada-run drift --setup
npx grada-run drift --setup --force
npx grada-run --setup-ci-drift
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `--setup` | Scaffold `.github/workflows/drift.yml` instead of running a local check. |
| `--force` | Overwrite an existing `drift.yml` on `--setup`. |
| `--region <region>` | Explicit AWS region override. |
| `--project-name <name>` | Explicit project name override (defaults to the name in `terraform/main.tf`, then the directory name). |

Requires a project initialized with `grada` (`terraform/main.tf` must exist) and the Terraform CLI installed for local checks.

## See also

- [apply](/grada/cli/apply/) (reconcile drifted state)
- [init](/grada/cli/init/)
