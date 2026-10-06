---
title: secrets
description: Push, pull, and audit environment secrets synced with AWS Secrets Manager.
---

Sync your local `.env` file with the Secrets Manager vault provisioned for this project, so your deployed app reads the values at runtime without plaintext secrets ever touching the repo or CI/CD pipelines.

Compute-target notes: on `--target static` projects no vault exists, so `push`, `pull`, and `audit` exit immediately with an unsupported-target error instead of calling Secrets Manager. On `--target lambda` projects values apply to fresh invocations with no restart step.

## secrets push

Uploads a local env file to the `<project-name>-secrets` vault via `UpdateSecretCommand`, then writes the pushed key names to `terraform/secret_keys.json` so Terraform and CI redeploy know which variables exist.

```bash
npx grada-run secrets push
npx grada-run secrets push .env.production
```

The optional positional argument is the path of the env file to push (resolved relative to the project root). It defaults to `.env` when omitted or blank.

**Smart follow-up based on what changed:**

- **Key names changed** (added/removed variables) — commit `terraform/secret_keys.json` and push to GitHub to trigger a deployment with the new variables. The ECS task definition is rebuilt from the updated key map.
- **Only values changed** (same key set) — the CLI offers a rolling ECS restart (`forceNewDeployment`) so running tasks pick up the new values immediately, no redeploy required.
- **Lambda target** — new values apply to fresh invocations automatically; no restart is offered or needed.

Region resolution is shared across all three commands (see Prerequisites), so they work even when no region is configured. Emits a `secrets_pushed` telemetry event. Exits non-zero on failure.

**Missing env file:** if the file does not exist, `push` does not throw. Interactively it asks `Would you like to create an empty <file> file now to get started?` — confirming creates the file (with parent directories) so you can fill it in and re-run; declining leaves everything untouched. With `--headless` or `CI=true` it prints a pointer to generate the file first and exits 1.

## secrets pull

Fetches the remote JSON payload from the `<project-name>-secrets` vault and merges it into your local env file — useful for onboarding a new machine or recovering after losing `.env`.

```bash
npx grada-run secrets pull
npx grada-run secrets pull .env
```

**Merge behavior:**

- Remote keys are appended after your existing local keys; existing local order is preserved.
- Local-only variables are kept — pull never deletes them.
- If a key exists locally and remotely with different values, the CLI asks `Conflicting variables found. Overwrite local values with remote?` In `--headless` mode it overwrites automatically.

Values are written in standard `KEY="value"` format. Emits a `secrets_pull` telemetry event. Exits non-zero on failure (e.g. no remote vault yet — run `secrets push` first).

## secrets audit

Compares your local env file against the remote vault and prints a colored drift report — no files are modified.

```bash
npx grada-run secrets audit
```

- `+ KEY (Missing locally)` in green — exists in AWS but not in your `.env`.
- `~ KEY (Mismatched value)` in yellow — exists in both with different values.
- `- KEY (Not tracked in AWS)` in dim — exists locally but was never pushed.

Ends with `Audit complete. N drifted variable(s) found.` Emits a `secrets_audit` telemetry event.

## Prerequisites

- Run `npx grada-run apply` first: the `<project-name>-secrets` vault is created during provisioning. If it does not exist yet, each command points you back to `apply`.
- Valid AWS credentials. On expired credentials, refresh with `aws sso login` or `aws configure`. See the [AWS credentials guide](/grada/guides/aws-credentials/).
- Region (all three commands): pass `--region <region>` explicitly, or rely on the automatic chain — `AWS_REGION` → `AWS_DEFAULT_REGION` → the `region` in `terraform/backend.tf` → default `us-east-2`.

## A note on `terraform/secret_keys.json`

This file contains **key names only** (e.g. `["API_KEY"]`), never values — it is safe to commit, and it **must** be committed: Terraform reads it during deployment to map each key into your ECS task definition.

## See also

- [Secrets management guide](/grada/guides/secrets-management/)
- [apply](/grada/cli/apply/)
