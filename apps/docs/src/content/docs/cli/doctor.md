---
title: doctor
description: Check that required tools are installed before provisioning.
---

Verify your machine is ready to provision and deploy, telling you exactly which dependency to install when something is missing.

## What it does

- Checks for the four required binaries — `terraform`, `aws` (AWS CLI), `docker`, and `git` — and prints a pass/fail line for each with an install hint for anything missing (Homebrew on macOS, distro-appropriate guidance on Linux, `winget` on native Windows). When `CI` is set, failed Terraform and AWS CLI checks append a CI-specific hint (e.g., `hashicorp/setup-terraform`).
- Verifies your AWS credentials are active and valid (the SDK equivalent of `aws sts get-caller-identity`). Expired SSO tokens or missing profiles fail the `AWS Credentials` line with recovery guidance (`aws sso login` or `aws configure`) instead of a false-positive green light. The probe has a 15-second ceiling: hung enterprise SSO wrappers resolve to a clean failure rather than wedging the run, and no check can crash `doctor` before results print.
- Downgrades a missing AWS CLI to a warning when live SDK credentials resolve (common with enterprise SSO wrappers that don't put `aws` on `PATH`): the run stays green, but SSM tunnels (`grada db connect`, `grada exec`) stay unavailable until the CLI is installed.
- Makes no changes to your project or cloud resources; it is a read-only check.
- Prints a success message when everything is present, a credentials reminder when only auth fails, or a reminder to install the missing dependencies first.
- Emits a `doctor_run` telemetry event recording whether all checks passed, per-check booleans (`check_terraform`, `check_aws_cli`, `check_aws_auth`, `check_docker`, `check_git`), the stable-ID outcomes (`passed_checks`, `failed_checks`, `total_failed` — never paths or error text), and on failure a specific `error_code` (`MISSING_TERRAFORM`, `AWS_CLI_UNCONFIGURED`, …) with its kebab-case `reason`.

## Usage

```bash
npx grada-run doctor
```

## Flags

This command accepts no CLI flags.

## See also

- [npx grada-run](/grada/cli/init/)
- [apply](/grada/cli/apply/)
- [Troubleshooting AWS Credentials & Authentication](/grada/guides/aws-credentials/) for expired SSO tokens and missing profiles.
