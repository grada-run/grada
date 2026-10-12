---
title: doctor
description: Check that required tools are installed before provisioning.
---

Verify your machine is ready to provision and deploy, telling you exactly which dependency to install when something is missing.

## What it does

- Checks for `terraform`, `aws`, `docker`, and `git`, printing a pass/fail line for each with an install hint for anything missing.
- Verifies your AWS credentials are actually valid — expired SSO tokens fail the line with recovery guidance instead of a false green.
- Inside a grada project, additionally checks for a held Terraform state lock and an interrupted previous run; outside a project these report as skipped.
- Results group into `System Environment` (your machine) and `Project State` (your project), so host health never reads as project health. Read-only — it changes nothing.

## Usage

```bash
npx grada-run doctor
npx grada-run doctor --deep
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `--deep` | Show the state-lock holder details (who/what holds the lock) when the state-lock check fails. Costs one extra S3 read. |

## Automation & edge cases

- In CI, failed Terraform/AWS CLI checks append CI-specific hints (e.g. `hashicorp/setup-terraform`).
- A missing AWS CLI downgrades to a warning when live SDK credentials resolve (common with enterprise SSO wrappers) — the run stays green, but SSM tunnels stay unavailable until the CLI is installed.
- The credential probe has a 15-second ceiling, and no check can crash `doctor` before results print.

## See also

- [npx grada-run](/grada/cli/init/)
- [apply](/grada/cli/apply/)
- [Troubleshooting AWS Credentials & Authentication](/grada/guides/aws-credentials/) for expired SSO tokens and missing profiles.
