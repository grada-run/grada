---
title: destroy
description: Tear down all AWS resources provisioned for this project.
---

Permanently delete the AWS infrastructure created by `apply` when a project is retired or needs a clean rebuild, protecting you from ongoing AWS charges.

## What it does

- Verifies you are in a grada project (`terraform/backend.tf` must exist) and that the `terraform` binary is installed, exiting otherwise.
- Discovers the provisioned database first (read-only RDS lookup, before any prompt). When a live database exists, destruction requires the data-loss hatch: interactively you confirm a prompt naming the cluster; headless runs must pass `--allow-data-loss` or the command refuses with a `DATA_LOSS_UNCONFIRMED` error instead of prompting. `--force` skips discovery (and the gate) as the escape hatch for wedged states.
- Takes a pre-destroy snapshot checkpoint of the database (`📸 Pre-destroy snapshot: <id>`) before tearing anything down, unless `--allow-data-loss` was passed (explicit acceptance of data loss) or the database is already `deleting`. A failed snapshot aborts the run — re-run with `--allow-data-loss` to destroy without one.
- Before destroying, wakes a stopped or transitional-state database back to `available` (RDS refuses to delete databases that aren't available), so tearing down an asleep environment succeeds instead of failing mid-destroy. Transitional states (`creating`, `backing-up`, `modifying`, …) are waited out on their own settle budget; aborts with a retry message if the database never becomes ready.
- When `--allow-data-loss` is passed (or the interactive data-loss prompt is confirmed), switches deletion protection off on the database via the RDS API (`ModifyDBInstance` / `ModifyDBCluster` with `DeletionProtection: false`, applied immediately) before Terraform runs, so protected clusters destroy instead of failing with `DELETION_PROTECTION_ACTIVE`. If the lift fails, destroy warns and proceeds — Terraform remains authoritative.
- Before `terraform destroy` runs, drains every Terraform-managed S3 bucket (addon storage, static sites) — all object versions, delete markers, and in-flight multipart uploads, paginated past the 1,000-key cap — so destroys never trip `BucketNotEmpty`. The state bucket is excluded (Terraform reads state from it throughout); drain failures abort with `BUCKET_DRAIN_FAILED` before Terraform runs, naming every residual key.
- Runs `terraform destroy -auto-approve` in `terraform/`, streaming progress, so all compute resources (ECS or Lambda, ALB or API Gateway, database, and related resources) are removed. On trees whose templates declare it, the `grada_allow_data_loss` variable lifts deletion protection for the destroy only.
- When `terraform destroy` fails with a recognized error, prints a runbook instead of raw stderr: state locks offer `force-unlock` + retry (`--force-unlock <lock-id>` headless), Aurora deletion protection points at `--allow-data-loss`, dependency violations name the blocking resources.
- Parses the state bucket name and region out of `terraform/backend.tf` (region defaults to `us-east-2` when not found), then optionally asks whether to also empty and delete the S3 state bucket via `teardownStateBucket`. Answering "No" keeps the bucket so `apply` can restore the infrastructure later. With `--yes` (or `--headless`), the bucket is deleted without asking. Buckets with thousands of versions are emptied with paginated deletes.
- Emits an `infrastructure_destroyed` telemetry event recording success and whether the state bucket was retained, plus `rds_preflight_waited` / `rds_preflight_skipped` / `db_destroy_checkpoint` events for the database gate, `deletion_protection_lifted` / `deletion_protection_lift_failed` for the protection lift, and `bucket_drain_completed` for the S3 drain.

## Usage

```bash
npx grada-run destroy
npx grada-run destroy --yes
npx grada-run destroy --yes --allow-data-loss
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `--yes` | Answer "Yes" to both the destruction and state-bucket confirmations for non-interactive runs. |
| `--allow-data-loss` | Accept database data loss: skips the pre-destroy snapshot checkpoint and lifts deletion protection. Required headless whenever a live database exists. |
| `--force-unlock <lock-id>` | Force-unlock a stuck Terraform state lock and retry (only when no other run holds it). |
| `--force` | Skip database discovery and the data-loss gate; escape hatch for wedged states. |
| `--headless` | Global automation flag; implies `--yes` for this command. |

## See also

- [apply](/grada/cli/apply/)
- [doctor](/grada/cli/doctor/)
- [sleep & wake](/grada/cli/sleep/) (pause billing temporarily instead of tearing down)
