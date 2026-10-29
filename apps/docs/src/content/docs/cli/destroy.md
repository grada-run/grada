---
title: destroy
description: Tear down all AWS resources provisioned for this project.
---

Permanently delete the AWS infrastructure created by `apply` when a project is retired or needs a clean rebuild, protecting you from ongoing AWS charges.

## What it does

- Finds your database first: with a live database, destruction needs the data-loss hatch — confirm the prompt naming the cluster, or pass `--allow-data-loss` in automation.
- Takes a pre-destroy snapshot checkpoint before tearing anything down (skipped only with `--allow-data-loss`); the destroy waits for the snapshot to complete, and a failed or timed-out snapshot aborts the run with the database untouched.
- Wakes a stopped database back to `available` first, so retiring an asleep environment succeeds instead of failing mid-destroy.
- Empties every Terraform-managed S3 bucket before handing off to Terraform, so destroys never trip `BucketNotEmpty`.
- Asks whether to also delete the S3 state bucket — answering "No" keeps it so `apply` can restore the infrastructure later. `--yes` deletes without asking.

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
| `--progress <lines\|spinner>` | Force Terraform progress as deduped plain lines (`lines`, for viewers that split animation frames into lines such as harness PTYs) or as the animated spinner (`spinner`). Default sniffs the terminal (TTY outside CI with a capable `TERM`). |

## Automation & edge cases

- Headless runs refuse with `DATA_LOSS_UNCONFIRMED` when a live database exists (pass `--allow-data-loss`); `--force` skips discovery entirely for wedged states. Non-interactive runs without approval fail with `DESTROY_NON_INTERACTIVE` (teardown/bucket delete: `--yes`; stuck lock: `--force-unlock <lock-id>`). Full catalog: [Headless Mode](/grada/guides/headless/).
- `--allow-data-loss` (or the confirmed prompt) also switches deletion protection off via the RDS API before Terraform runs, so protected clusters destroy instead of failing with `DELETION_PROTECTION_ACTIVE`. If the lift fails, destroy warns and proceeds.
- Transitional databases (`creating`, `backing-up`, `modifying`, …) are waited out on their own settle budget; the run aborts with a retry message if one never becomes ready.
- The S3 drain covers versions, delete markers, and in-flight uploads past the 1,000-key pagination cap; the state bucket is excluded, and drain failures abort with `BUCKET_DRAIN_FAILED` naming every residual key.
- Recognized Terraform failures print a runbook instead of raw stderr: state locks offer `force-unlock` + retry, Aurora protection points at `--allow-data-loss`, dependency violations name the blocking resources.

## See also

- [apply](/grada/cli/apply/)
- [doctor](/grada/cli/doctor/)
- [sleep & wake](/grada/cli/sleep/) (pause billing temporarily instead of tearing down)
