---
title: apply
description: Provision or update your AWS infrastructure with Terraform.
---

Run the Terraform plan/apply flow against the generated configuration.

## What it does

- Renders an infrastructure preview — monthly cost baseline, topology, usage-billed addons — asks for confirmation, then provisions everything with Terraform and prints your live URLs plus the `git push` that deploys your app. `--dry-run` stops after the preview.
- If the S3 state bucket is missing, offers to recreate it and resume instead of failing.
- Refuses to apply while the environment is asleep (it would start tasks against a stopped database) — wake first, or pass `--force`.
- When the compute target changed since the last apply, shows the plan and requires explicit approval first, since the switch destroys the old stack's resources.
- `deploy` is an alias of `apply` (same flags, same behavior).

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
| `--force` | Apply even when the environment is asleep. |
| `--force-resume` | Proceed past resource collisions (post-recreate or same-run) instead of stopping at the import runbook. |
| `--destroy-previous-target` | Approve a compute-target switch, destroying the previous target's resources. |
| `--allow-partial-outputs` | Accept an empty/missing outputs map as success (for trees that legitimately declare no outputs). |
| `--force-unlock <lock-id>` | Force-unlock a stuck Terraform state lock and retry once (only when no other run holds it). |
| `--headless` | Global automation flag; implies `--auto-approve` for this command. |

## Automation & edge cases

- Automation refuses instead of prompting: asleep environments fail with `SLEEPING_ENVIRONMENT` (wake first, or `--force`), target switches need `--destroy-previous-target`, stuck locks need `--force-unlock <lock-id>`. `--dry-run` previews only warn. Full catalog: [Headless Mode](/grada/guides/headless/).
- Bucket recovery recreates the exact bucket (and region) from `terraform/backend.tf`; if live infrastructure collides with the resumed apply, you get an import runbook (`terraform import` per address) instead of a blind recreate — `--force-resume` proceeds anyway. The same runbook covers same-run AlreadyExists failures (e.g. a create retried across a network drop).
- After a successful apply, an empty outputs map fails loud (`PARTIAL_STATE`); missing keys warn. `--allow-partial-outputs` accepts legitimately output-less trees.
- Interrupted previous runs (Ctrl+C, crash) are surfaced up front; on Lambda projects Day-0 seeds a placeholder ECR image so the first provision succeeds; on the known GitHub OIDC provider conflict, set `create_oidc_provider = false` in `terraform/oidc.tf` and re-run.

`apply` shells out to the `terraform` binary in your generated `terraform/` directory and streams progress while it runs.
