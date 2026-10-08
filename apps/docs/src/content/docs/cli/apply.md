---
title: apply
description: Provision or update your AWS infrastructure with Terraform.
---

Run the Terraform plan/apply flow against the generated configuration.

## What it does

- Verifies you are in a grada project (`terraform/main.tf` must exist), exiting otherwise, so `apply` never runs against the wrong directory.
- Renders an infrastructure preview from your Terraform config and framework detection: a `Fixed Baseline` monthly figure with per-service breakdown, one topology entry per provisioned [`add`](/grada/cli/add/) addon (collapsing to a single `Addons (N)` line when three or more are active), and a one-line `Usage-based (N addons)` summary of metered billing drivers (shown only when usage-billed addons are present). With `--dry-run` it stops there and provisions nothing.
- Otherwise runs `terraform init -upgrade` followed by `terraform apply -auto-approve` in `terraform/`, streaming progress, then prints the live URLs from the Terraform outputs (`cloudfront_url` and `alb_direct_url`, `api_gateway_url` on `--target lambda`, or `site_url` on `--target static`) plus the `git push` command that deploys your app and clears the initial 503.
- On `--target lambda` projects, ensures the ECR repository exists first and seeds a minimal placeholder image under `:latest` when nothing has been pushed yet (Lambda rejects empty repositories), so Day-0 provisioning succeeds before the first code push.
- Asks for confirmation after the preview; declining aborts without provisioning anything. With `--auto-approve` (or the global `--headless` flag), the preview still renders but provisioning proceeds without prompting.
- If the S3 state bucket is missing (e.g. deleted manually), offers to recreate it and resume automatically instead of failing; `--auto-approve` and `--headless` accept the recovery without prompting. The prompt warns that previous state is unrecoverable — if infrastructure still exists (bucket deleted out-of-band), the resumed apply will try to recreate it.
- If the environment is asleep (a `.grada/sleep-state.json` entry exists), refuses to apply: applying would start tasks against a stopped database. Interactively it offers to [`wake`](/grada/cli/sleep/) first and continue; in automation it fails with `SLEEPING_ENVIRONMENT` (run `wake`, or re-run with `--force` to proceed anyway — the override is recorded in telemetry). `--dry-run` previews are exempt and only warn.
- `deploy` is an alias of `apply` (same flags, same behavior).
- On the known GitHub OIDC provider conflict (`EntityAlreadyExists` for `token.actions.githubusercontent.com`), tells you to set `create_oidc_provider = false` in `terraform/oidc.tf` and re-run; other failures print the Terraform error and the manual `cd terraform && terraform apply` fallback.

## Usage

```bash
npx grada-run apply
npx grada-run apply --dry-run
npx grada-run apply --auto-approve
npx grada-run deploy            # alias of apply
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `--dry-run` | Render a preview of the planned changes without applying them. |
| `--auto-approve` | Skip the post-preview confirmation (and the state-bucket recovery prompt) for non-interactive runs. |
| `--force` | Apply even when the environment is asleep (records a `forced_apply_while_asleep` telemetry event). |
| `--headless` | Global automation flag; implies `--auto-approve` for this command. |

`apply` shells out to the `terraform` binary in your generated `terraform/` directory and streams progress while it runs.
