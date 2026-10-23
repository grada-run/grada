# Apply-Time Offline Reconciliation (Zero-Terraform Day-0)

This sprint retires the manual `--offline` reconciliation flow (hand-edit
`YOUR_AWS_ACCOUNT_ID` across five files, hand-create the state bucket in
the console, hand-run `terraform init`). `grada apply` detects
unreconciled placeholders itself, resolves the AWS account, rewrites the
files, ensures the state bucket, and continues into the existing
init → apply flow — the user never touches Terraform or the console.

> **Open decision (resolve before implementing):** account-ID source
> order. Recommended: `--account-id` flag → STS `GetCallerIdentity` (+
> one-keypress confirm interactively) → fail loud without credentials.
> Rationale: infra lands in the credentials' account by construction
> (including cross-account roles, where a human-typed ID could be wrong),
> so STS is ground truth, not a guess. Alternative: prompt for manual
> entry first. The spec below implements the recommendation; if the
> alternative wins, swap Part 2's precedence and drop the STS call.

---

## Part 1: Placeholder Detection (`src/utils/reconcile.js`, new)

* Create `src/utils/reconcile.js` with a pure, unit-testable core:
  * `export const PLACEHOLDER_ACCOUNT_ID = 'YOUR_AWS_ACCOUNT_ID';`
  * `export function findUnreconciledFiles(targetDir)`: scan
    `terraform/backend.tf` and every `.github/workflows/*.yml` for the
    literal token; return the sorted list of repo-relative paths still
    containing it (`[]` when the tree is reconciled). Missing files are
    skipped, never an error. **Do not** hardcode the four workflow
    filenames — glob the directory so future workflows are covered.
  * `export function isValidAccountId(value)`: strict `/^\d{12}$/`.
* No AWS calls, no prompts, no writes in this module — detection only.

## Part 2: Account Resolution (`src/commands/apply.js` + `src/utils/aws.js`)

* In `parseApplyArgs`, add `--account-id` to the string flags (both
  `--flag value` and `--flag=value` forms, via the existing `parseFlags`
  machinery). It flows through `stripGlobalOnlyFlags` untouched (it is
  apply-specific, not global).
* Resolution precedence inside `runApplyMain`, before anything else runs:
  1. Explicit `--account-id` (validate with `isValidAccountId`; reject
     anything else with `INVALID_ACCOUNT_ID` naming the bad value's
     shape, never echoing secrets-adjacent content — the ID itself may
     be echoed since the user just typed it).
  2. STS `GetCallerIdentityCommand` (region from `resolveRegion`),
     reusing the `CI_MOCK_AWS === 'true'` short-circuit convention from
     `provisionStateBucket` so tests never touch the network.
  3. No credentials / STS failure → `failCommand` telling the user to
     configure AWS credentials first (apply could not proceed anyway).
* The resolved ID is logged (it is an identifier, not a secret) but is
  **never** sent to telemetry — telemetry carries `account_source`
  (`flag`|`sts`) only.

## Part 3: Reconcile Flow (`src/commands/apply.js`, step 0)

* At the top of `runApplyMain`, call `findUnreconciledFiles(targetDir)`.
  When empty, proceed exactly as today (zero behavior change for
  reconciled trees — assert this in tests).
* When placeholders exist:
  * Resolve the account per Part 2.
  * Interactive confirm (single keypress) showing the account ID, its
    source, and the file list. Gate with the standard
    `refuseIfNonInteractive` helper (`--yes` bypasses;
    errorCode `RECONCILE_NON_INTERACTIVE`). Headless logs the resolved
    ID loudly and proceeds — the operation is deterministic, printed,
    and re-runnable.
  * Rewrite: replace every `PLACEHOLDER_ACCOUNT_ID` occurrence in the
    listed files with the resolved ID (idempotent — re-running finds
    nothing). Print the rewritten paths. **No `.bak` files** — the
    change is deterministic and re-runnable; the printed list is the
    audit trail.
  * Emit `trackEvent('apply_reconciled', { projectName, account_source,
    file_count, bucket_created })` — counts and enums only, per the
    no-values telemetry discipline.
* This step runs **before** the preflight visualizer so all downstream
  reads see final files. The existing provision prompt is unchanged (two
  distinct consents: "rewrite + bucket" then "provision"); `--yes`
  covers both.

## Part 4: Bucket Ensure (`src/utils/aws.js` + `src/commands/apply.js`)

* Extract bucket creation from `provisionStateBucket` into
  `export async function ensureStateBucketExists(bucketName, region,
  { s3Client } = {})`: `HeadBucket` → return `{ created: false }` when
  present; else `CreateBucket` (region-aware — no `LocationConstraint`
  in `us-east-1`, mirroring the existing exception) + `ManagedBy=grada`
  tagging + versioning, returning `{ created: true }`. Both `init`'s
  online path and apply's reconcile call it — **do not** fork the
  logic.
* In the reconcile flow, parse the bucket name from the rewritten
  `backend.tf` with the existing `parseStateBucketBackend` helper (do
  not re-derive the name), then call the extractor. A bucket name that
  still fails S3 validity after reconciliation is a fail-loud internal
  error (unreachable — placeholders are the only invalid-name source).
* The existing state-bucket-missing recovery prompt later in `apply`
  stays as the out-of-band-deletion path; reconcile-first means it no
  longer fires for merely-unreconciled trees.

## Part 5: Test Suite (`tests/apply-reconcile.test.js`)

* Pure-function matrix: `findUnreconciledFiles` over
  {clean, backend-only, workflows-only, missing-dir} fixtures (partial
  reconciliation must list exactly the remaining files);
  `isValidAccountId` over {12-digit, short, long, alpha, empty}.
* Flag precedence: `--account-id` beats STS (assert the STS client is
  never constructed); invalid `--account-id` fails `INVALID_ACCOUNT_ID`.
* Consent: non-interactive without `--yes` refuses
  `RECONCILE_NON_INTERACTIVE` and writes nothing; `--yes` proceeds.
* Rewrite idempotency: run twice, second run finds `[]` and byte-identical
  files.
* Migration: a 0.40.17-era offline fixture reconciles to the exact
  backend.tf + ARN contents (assert full-file equality, not substrings).
* Integration leg (mocked STS/S3 via `CI_MOCK_AWS`): offline scaffold →
  `apply` reconciles → proceeds to (mocked) init. **No live network in
  any test.**
* Full suite green, no snapshot changes outside this feature's files.

## Part 6: Documentation

* `apply` CLI reference: document `--account-id` (precedence, validation,
  headless behavior) and the reconcile pre-step (trigger, consent,
  idempotency).
* Quickstart + Going-Live guides: replace the manual placeholder/bucket/
  `terraform init` sequence with "run `apply` and confirm" (keep one
  sentence noting the manual equivalent for users who want it).
* Release notes entry. No telemetry registry updates needed (no registry
  exists); the new event has test coverage per Part 5.
