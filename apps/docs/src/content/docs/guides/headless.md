---
title: "Headless Mode & Automation Guide"
description: "Run grada without prompts for CI/CD pipelines, scripts, and framework plugins."
sidebar:
  order: 11
---

The `grada` CLI is designed to be fully automatable for CI/CD pipelines, custom scripts, Cookiecutters, and framework plugins (like `vite-plugin-grada`). 

By passing the `--headless` flag, you bypass all interactive terminal prompts. This is a tested contract (`tests/headless.test.js`): with `--headless --preconfigured`, the CLI guarantees no interactive prompt ever fires, so external schematics and CI pipelines can invoke it without hanging.

## Required Flags
To use headless mode, simply include the `--headless` flag. 

If `grada` cannot auto-detect your framework, you should also provide the `--framework` flag to ensure the correct infrastructure is generated.

* **Valid `--framework` options:** `node`, `nestjs`, `nextjs`, `nuxt`, `svelte`, `python`, `django`, `rails`, `go`, `static` (anything else fails fast with a validation error — Express apps use `node`)

## Optional Configuration Flags

You can append any of these flags to customize the generated architecture. These map exactly to the options available in the interactive setup:

| Flag | Description | Default |
|---|---|---|
| `--region=<region>` | The AWS region to deploy to (e.g., `us-east-1`, `eu-west-1`). | `us-east-2` |
| `--size=<size>` | The Fargate compute size (`micro` or `small`). | `micro` |
| `--port=<number>` | The internal port your container exposes. | Framework dependent (`3000`, `8080`, `8000`) |
| `--healthCheckPath=<path>`| The ALB health check endpoint path. | `/` |
| `--desiredCount=<number>` | Number of container replicas to run (`1` or `2`). | `1` |
| `--branch=<name>` | The primary Git deployment branch for CI/CD. | `main` |
| `--dir=<path>` | The directory to generate files into (use `.` for current).| `.` |
| `--project-name=<name>` | Override the project name (default: directory basename; re-runs reuse the existing tree's name). | directory basename |
| `--target=<target>` | Compute architecture: `ecs` (default, `fargate` synonym), `lambda` (scale-to-zero serverless), or `static` (S3 + CloudFront; static-site frameworks and detected static exports only). | `ecs` |
| `--needsDatabase` | Provisions a managed AWS database alongside Fargate (engine via `--db-engine`). | `false` |
| `--db-engine=<engine>` | Database engine: `postgres` (default), `mysql` (MySQL 8.0), or `aurora-postgresql` (Serverless v2 scale-to-zero). | `postgres` |
| `--enablePrPreviews` | Generates workflows for Ephemeral PR Previews. | `false` |
| `--no-telemetry` | Disables anonymous usage analytics (or set `DO_NOT_TRACK=1` for all runs). | `false` |
| `--preconfigured` | Suppresses framework warnings for pre-validated configs from external schematics/integrations (e.g., `nest add`). | `false` |
| `--with=<capabilities>` | Comma-separated (or repeatable) addon capabilities to scaffold during init (`storage:s3`, `db:dynamodb`, `db:redis`, `queue:sqs`, `ai:bedrock`, `email:ses`, `cron`). | none |
| `--model=<id>` | Bedrock model override when `ai:bedrock` is included. | Catalog recommended model |
| `--domain=<domain>` | Domain for the SES identity when `email:ses` is included (required in headless mode). | none |
| `--zone-id=<id>` | Route 53 hosted zone ID for automatic SES DNS records. | none |
| `--from-email=<email>` | Default SES sender address. | `noreply@<domain>` |
| `--setup-ci-migrate[=<cmd>]` | Wire the pre-deploy database migration gate into the generated workflow when a database and migration command are detected. An explicit `=<cmd>` overrides detection. | `false` |
| `--setup-ci-drift` | Scaffold `.github/workflows/drift.yml`: a daily 06:00 UTC `terraform plan` check that opens (or updates) a GitHub Issue labeled `iac-drift` on drift and closes it when resolved. | `false` |
| `--force` | Re-run over modified files: back them up and regenerate. Without it, headless re-runs over hand edits fail with `MODIFIED_TREE`, and re-runs over ejected projects fail with `EJECTED_PROJECT`. | `false` |
| `--adopt-state` | Take over existing remote state when the state bucket already holds a key for this project name. Without it, headless inits fail with `STATE_ALREADY_EXISTS`. | `false` |
| `--github-repo=<owner/name>` | Scope the CI OIDC trust to this repo. Without it, headless init reads the git remote, else warns and renders the open `repo:*` trust. | git remote, else open |

*(Note: Boolean flags like `--needsDatabase` and `--enablePrPreviews` can be passed alone or as `--flag=true`).*

## Example Usage

**Standard Static Site Automation (e.g., Vite/React):**
```bash
npx grada-run --headless --framework=static --region=eu-west-1 --size=micro
```

**Next.js High-Availability CI/CD Generation:**
```bash
npx grada-run --headless --framework=nextjs --size=small --desiredCount=2
```

**Django Setup with Managed RDS Database:**
```bash
npx grada-run --headless --framework=django --needsDatabase
```

**Full-Stack Automation with Addons and Migration Gate:**
```bash
npx grada-run --headless --framework=nestjs --needsDatabase \
  --with db:redis,ai:bedrock,email:ses --domain example.com --setup-ci-migrate
```

## Automating lifecycle commands

`--headless` also suppresses confirmations in the Day-2 lifecycle commands, so scripted pipelines can provision, tear down, and decouple without hanging on a prompt:

```bash
npx grada-run apply --auto-approve              # provision without the preview confirmation
npx grada-run destroy --yes --allow-data-loss   # tear down compute (incl. database) and delete the state bucket
npx grada-run eject --yes                       # strip CLI metadata without confirming
npx grada-run sleep --strict                    # exit 2 (not 0) when there is nothing to pause
npx grada-run gc --yes                          # delete orphaned images, log groups, and EIPs without confirming
```

Each command also accepts `--headless` directly (implying the approval flag). Without an approval flag, a non-interactive invocation cancels with no changes rather than destroying anything.

Several gates commonly bite scripted pipelines — every one fails loud with a named error instead of prompting:

- `apply` fails with `SLEEPING_ENVIRONMENT` on an asleep environment (wake first, or pass `--force`), with `TARGET_SWITCH_DESTROY_REVIEW` when the tree's compute target changed (re-run with `--destroy-previous-target`), and stops at an import runbook on post-recovery resource collisions (`--force-resume` proceeds anyway).
- `destroy` fails with `DATA_LOSS_UNCONFIRMED` when a live database exists (pass `--allow-data-loss` to destroy without the snapshot checkpoint and lift deletion protection — snapshot by hand first if the data matters).
- A stuck Terraform state lock fails `apply`/`destroy` until released (`--force-unlock <lock-id>`, only when no other run holds it).
- `eject` fails with `EJECT_WHILE_ASLEEP` on a slept stack (wake first, or pass `--force` to migrate the ledger to `SLEEPING.md`).
- `db migrate`, `add cron`, and `init --setup-ci-migrate` fail with `NPM_CMD_STRIPPED_RUNNER` when the command needs `npm`/`npx` but the `Dockerfile` strips those binaries — pass an explicit `node ...` command instead (`--setup-ci-migrate="node ..."`, `--cmd "node ..."` elsewhere).
- Re-running setup over modified files fails with `MODIFIED_TREE` (pass `--force` to back up and regenerate).
- Fresh `init` over a state bucket that already holds this project's key fails with `STATE_ALREADY_EXISTS` (pass `--adopt-state` to take over that state, or rename the project).
- `wake` fails with `ECS_WAKE_CRASH_LOOP` when restored tasks keep crashing, or `ECS_WAKE_PULL_FAILURE` when a task is stuck `PENDING` on an unpullable image (the message names the most recent failure in both cases), or `ECS_WAKE_TIMEOUT` when tasks never reach the desired count — every path applies the restore first, so inspect with `status` and fix the task before retrying.
- `apply` fails with `PARTIAL_STATE` when the outputs map comes back empty (pass `--allow-partial-outputs` for trees that legitimately declare no outputs).
- Re-running setup over a multi-entry or non-literal OIDC trust fails with `OIDC_TRUST_WIDENING_REFUSED` when no repo can be determined (pass `--github-repo owner/name` to scope it explicitly, or narrow `terraform/oidc.tf` by hand) — headless never widens such a trust to `repo:*` silently.

## Exit codes

Conventions hold across commands: `0` means success (including no-op skips), `1` means failure or a declined/cancelled run. Two commands define their own non-zero codes so scripts can branch on them:

- [`sleep`](/grada/cli/sleep/) with `--strict` exits `2` (instead of `0`) when there is nothing to do, with the `skipped` reason preserved.
- [`rollback`](/grada/cli/rollback/) exits `3` on wrong-target refusals (distinct from failure's `1`); [`db enable-vector`](/grada/cli/db/) exits `3` when the container has no usable Postgres client.

Each command page documents its own codes in an Automation & edge cases section — e.g. [apply](/grada/cli/apply/), [destroy](/grada/cli/destroy/), [sleep](/grada/cli/sleep/).

## See also

- [`npx grada-run`](/grada/cli/init/) for the full flag table.
- [Supported Frameworks](/grada/guides/frameworks/) for valid `--framework` ids.
- [CI/CD Pipeline & First Deploy](/grada/guides/cicd-pipeline/) for what runs after generation.