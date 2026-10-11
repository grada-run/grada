# Specification: State-Transition Audit Fixes, Round 2 (Lifecycle & State Hardening)

## 1. Overview

This spec turns the second cross-command state-transition audit into
fixes. The audit traced four multi-command flows (S1 framework pivot
static→ECS, S2 Ctrl+C mid-apply over Aurora → destroy → gc → doctor,
S3 parallel adds → sleep → rollback on lambda, S4 sleep → eject →
raw Terraform) and found 26 issues: CRITICAL C1–C2, HIGH H1–H10,
MODERATE M1–M10, LOW L1–L4.

Every finding was then adversarially re-verified statement-by-statement
against the whole tree (sources: `/tmp/grada-state-transition-audit.md`,
`/tmp/audit-verification.md`, `/tmp/refactor-opportunities.md`). Result:
**20 CONFIRMED, 6 CORRECTED (H2, H10, M3, M5, M8, L3), 0 WRONG**, no
severity changes. The six corrections are folded into the sections
below; the original audit wording must not be re-implemented where a
correction applies.

Each fix is specified **tests-first**: failing sequence rows land in
`tests/state-transitions.test.js` (red) before the implementation
(green), following existing suite conventions (vitest,
`tests/helpers/*`, injected mocks, `noExit` programmatic results).
Finding IDs (C/H/M/L) match the audit report. Refactor IDs (R1–R23)
match the merged refactor list; each fix names the refactors that are
its prerequisite shape (foundations land before the fixes that need
them — see §7). Live-AWS verification items are protocol phases with
record-decision gates (§8), not separate follow-ups: nothing in this
spec is parked.

## 2. Boundaries & Constraints

- **No implementation in this step.** This spec is review-only; code and
  tests land after approval.
- **Preserve existing contracts:** `failCommand` result shapes
  (`{ ok: false, reason, ... }`), `noExit` exit-code stamping restored
  by `bin/cli.js`, existing telemetry event names, all timing seams
  (`pollIntervalMs` / `timeoutMs` / `sleepFn` / `nowFn` / injected
  `spawnImpl`), and the `exitCode: null` soft-fail contract in
  `add`/`domain` guards.
- **Preserve the stability-guardrails contract:** `sleep`/`wake` on
  `static` (and `lambda` without a DB) exit gracefully with code 0;
  `--strict` keeps exit 2 for skips. Nothing here turns skips into
  failures.
- **CLI exit codes for new gates:** hard gates fail with exit 1 and a
  structured `error_code`; skipped no-ops keep exit 0 with a `skipped`
  reason. Rollback target-unsupported gets a dedicated exit code
  distinct from 1 (L3/M6, §R21).
- **Headless never prompts:** every interactive confirm (force-unlock,
  destroy-previous-target, wake-first, data-loss) refuses headless
  with the explicit flag named, per the `shouldAutoApprove`
  explicit-flags-only contract.
- **Finding corrections are normative.** Where §4 notes a correction
  (H2 file list, H10 sleep-conditional, M3 citation, M5 unreachable
  `dbId: null`, M8 ledger shape + wake-clear miss, L3 any-N
  auto-select), the corrected statement governs.

## 3. Test Strategy (Phase 0 — lands first)

### 3.1 New flow-matrix rows in `tests/state-transitions.test.js`

Rows S12–S37 extend the existing S1–S11 matrix. Each row fails against
current code (red) before its fix (green). Mock patterns: `child_process`
spawn mocks (`tests/apply.test.js`), injected AWS clients
(`tests/sleep-wake.test.js`), tmpdir `cwd` fixtures, `@clack/prompts`
mocks for interactive branches.

| # | Sequence | Expected after fix |
|---|----------|--------------------|
| S12a | static applied (mocked state) → re-init ecs → `apply` headless | refuses `TARGET_SWITCH_DESTROY_REVIEW`; zero terraform calls (C1) |
| S12b | same + `--destroy-previous-target` | proceeds; override in telemetry (C1) |
| S12c | re-init same target → `apply` | no gate; normal path (C1 negative) |
| S13 | SIGINT during `apply` (mocked spawn) | relayed to child; last-run marker persisted; next `apply`/`doctor` reports interrupted (C2) |
| S14a | stale-lock stderr on `apply` | named `STATE_LOCK_HELD` + runbook, exit 1 (H1) |
| S14b | same, interactive confirm | runs `force-unlock <ID>`, retries (H1) |
| S14c | same, headless | refuses unless `--force-unlock` (H1) |
| S15 | parallel `add queue:sqs` + `add cron` (interleaved promises) | serialized; both env injections present; both `.tf` files land (H2) |
| S16a | `init(static) → init(ecs)` re-init | `secret_keys.json` carried forward, not reset to `[]` (H3) |
| S16b | same | custom `.tf` moved to `.bak` with a pointer printed (H3) |
| S17 | `init(ecs) → apply` | manifest v2 records intended + applied target (H4) |
| S18a | bucket deleted → `apply` → recreate → collisions | refuses with `terraform import` runbook, no blind resume (H5) |
| S18b | same + `--force-resume` | proceeds preserving caller approval mode (H5) |
| S19 | `destroy` on fresh checkout (no `.terraform/`) | inits first, then destroys (H6) |
| S20 | `sleep → eject` (asleep stack) | preflight warns ASLEEP; wake-first/abort offered (L4/H7) |
| S21 | `eject` | emits `STATE_BUCKET_CLEANUP.md` with bucket + region (M7) |
| S22 | re-init with failing bucket provision | pre-backup tree intact; only `.bak` never the end state (H9) |
| S23 | `eject` → clone simulation (no `.grada/`) → `init` | sentinel detected; eject warning, no silent re-manage (H10) |
| S24 | `destroy` with DB, no flag | snapshot checkpoint xor `--allow-data-loss` required (M1) |
| S25a | `gc` with foreign-team EIP in account | EIP scoped out, never proposed (M2) |
| S25b | `gc --deep --dry-run` | lists tag-keyed orphans; state/secrets report-only (M2) |
| S26 | `destroy` incl. bucket with 2500 mocked versions | paginated list + chunked deletes; empty residual (M3) |
| S27a | `doctor` with `.tflock` present | reports lock held (M4) |
| S27b | `doctor` with no `terraform/` | success message downgraded; project checks listed as skipped (M4) |
| S28a | asleep env → `add queue:sqs` | warns apply will block until wake; proceeds (M6) |
| S28b | `rollback` on lambda | dedicated exit code + machine-readable `actual: lambda` (M6) |
| S29a | `destroy` success on slept env | env ledger entry removed (M8) |
| S29b | `wake` on destroyed stack (`NOTHING_TO_WAKE`) | stale entry cleared (M8 strengthener) |
| S30 | post-eject `grada apply` | managed-tree warning; `--force` to proceed (M9) |
| S31 | `apply` with empty outputs map | partial-state advisory + non-zero exit (L1) |
| S32a | `init(static) → add queue:sqs` | policy-table warn, `.tf` lands unwired (L2) |
| S32b | `init(static) → add cron` | policy-table refuse (L2) |
| S33 | `rollback` requesting the deployed revision | warns; does not silent-redeploy (L3) |
| S34 | corrupt `sleep-state.json` bytes → `sleep`/`wake` | quarantined to `.corrupt.<ts>`; no `{}` discard (M5/M8) |
| S35 | `sleep → wake` on R18 tree | wake deletes `sleep.auto.tfvars` before its restore apply; plan shows no asleep values (H7) |
| S36 | `gc --deep` with same-prefix foreign project + untagged legacy | foreign excluded from deletion set; legacy listed unscoped-only, never deleted (M2) |
| S37 | `destroy` blocked by deletion protection | error names `--allow-data-loss` as the recommended remedy (M1) |

### 3.2 New unit suites (land with Phase 0 scaffolding, fill per phase)

- `tests/terraform-lifecycle.test.js` — signal forwarding, timeout,
  last-run marker, structured reject (R6).
- `tests/terraform-errors.test.js` — fixture-table matcher tests for
  every named code + runbook variants (R1).
- `tests/file-lock.test.js`, `tests/atomic-write.test.js` — lock
  serialize/fail-fast/stale-expiry, tmp+fsync+rename, `wx` EEXIST
  mapping (R13/R7/R11).
- `tests/backup-manifest.test.js` (extend) — manifest v2, preserved
  files, plan/execute split (R5/R15/R20).
- Extend in place: `tests/destroy.test.js` (R4/R9/R14/R19),
  `tests/doctor.test.js` (R2), `tests/gc.test.js` (R23),
  `tests/rollback.test.js` (R21), `tests/sleep-wake.test.js`
  (R16/R17/R18), `tests/eject.test.js` (R3/R8),
  `tests/add.test.js` (R12/R13), `tests/apply.test.js`
  (R1/R4/R5/R10/R19/R22).

## 4. Fixes — CRITICAL

### C1 — Target-switch apply destroys the old stack unpreviewed [S1]

- **Problem:** preview is disk-only (`apply.js:98-123`); `apply
  -auto-approve` (`:161`) runs against remote state holding the old
  target; static→ECS destroys the `force_destroy` site bucket +
  CloudFront with no destroy review.
- **Contract:** when the tree's intended target (manifest v2, R5)
  differs from the recorded applied target, `apply` must render the
  `terraform plan` destroy side and require `--destroy-previous-target`
  (interactive: explicit destroy review; headless: refuse with
  `TARGET_SWITCH_DESTROY_REVIEW`, exit 1, zero terraform calls).
  Legacy v1 manifests (applied unknown) take the refuse path with a
  runbook, never the silent path.
- **Tests:** S12a/b/c. Telemetry: `target_switch_refused`,
  `target_switch_override` (with old/new target).
- **Implements via:** R5 (schema), R1 (named code + runbook).

### C2 — No SIGINT/SIGTERM handling on the Terraform lifecycle [S2]

- **Problem:** `terraform.js:7-41` bare spawn; no handlers in
  `apply`/`destroy`/`bin/cli.js`; Ctrl+C kills the spinner, skips
  `trackFailure`, leaves partial state + stale lock.
- **Contract:** `runTerraformCommand` owns signals: forward SIGINT /
  SIGTERM to the child, await graceful exit with timeout, escalate to
  SIGKILL (second Ctrl+C = immediate SIGKILL, Terraform convention);
  persist a `.grada/` last-run marker (pid, args, started-at) so the
  next `apply`/`doctor` reports "previous run interrupted".
  `removeListener` in `finally`. (Correction adopted: `mcp.js`
  pairs are `583-584`/`658-659`; immaterial.)
- **Tests:** S13 (mocked spawn + `process.emit('SIGINT')`); live
  protocol P1 (§8) proves real Terraform semantics.
- **Implements via:** R6 (wrapper), R2 (doctor surfaces the marker).

## 5. Fixes — HIGH

### H1 — Stale S3 state lock never detected/reported/released [S2]

- **Contract:** `apply`/`destroy` preflight classifies `Error acquiring
  the state lock` (+ lock ID) into `STATE_LOCK_HELD` with a runbook
  (R1). Interactive: confirmation-gated `terraform force-unlock <ID>`
  then retry. Headless/CI: refuse unless `--force-unlock <ID>`.
  `doctor` gains a lock-presence check (R2).
- **Tests:** S14a/b/c, S27a. Telemetry: `state_lock_detected`,
  `state_lock_force_unlocked` (with confirm mode).
- **Implements via:** R1, R6 (structured `{code, stderr, lockId?}`
  reject), R2.

### H2 — Parallel adds corrupt shared files [S3]

- **Problem (corrected):** no lock, in-place RMW clobber, TOCTOU
  guards, torn writes — but the file list is `main.tf`, `worker.tf`,
  `backend.tf`, cost docs (the ledger and `.gitignore` amend are NOT
  touched by `add` and move to M5/R16 and the sleep×eject race
  respectively). Strengthened: `domain.js:56-62` and `eject.js:54-60`
  are writers in the same race class — the race is add×add AND
  add×domain×eject. Torn-`main.tf` ecs fallback is
  `resolvers.js:27-37`.
- **Contract:** one `withProjectLock(cwd, fn)` (R13) held across every
  whole read→modify→write; atomic tmp+fsync+rename writes (R7);
  exclusive-create `wx` for new addon files mapping `EEXIST` to the
  existing soft failure (R11, `exitCode: null` contract kept).
  Headless fail-fast, interactive wait.
- **Tests:** S15; lock/atomic unit suites. Telemetry: `file_lock_waited`
  (mode, wait ms) for contention visibility.
- **Implements via:** R13, R7, R11.

### H3 — Re-init backup resets `secret_keys.json`, sweeps custom `.tf` [S1]

- **Contract:** `PRESERVED_FILES` (starting with
  `terraform/secret_keys.json`) copied aside before the whole-dir
  rename, restored after `generateTemplates` succeeds (before
  `writeInitManifest`); absent files tolerated (fresh init).
  `generator.js:527-531` ensure reworked to never restart carried
  state. Custom `.tf` still moves to `.bak`, but the CLI prints a
  pointer to what moved. All-workflows backup-or-document rule.
- **Tests:** S16a/b. Telemetry: `preserved_files_restored` (count).
- **Implements via:** R15.

### H4 — `.grada/` tracks no target or applied revision [S1]

- **Contract:** manifest v2 `{version: 2, target, appliedTarget,
  appliedRevision, files}` — init records intended target, apply
  records actual via `recordAppliedTarget()` after success (under the
  R13 lock). Drives C1's gate, sleep-gate accuracy, `drift`/`status`
  coherence. Legacy v1 reads as "unknown applied".
- **Tests:** S17. Telemetry: include intended/applied target pair on
  `infrastructure_applied`.
- **Implements via:** R5.

### H5 — Bucket recovery auto-resumes into recreate-conflicts [S2]

- **Problem:** recreate → blind resume with forced `autoApprove: true`
  (`apply.js:224`), which takes the `:115-116` branch and SKIPS the
  interactive confirm — blinder than a normal apply. Only OIDC
  collisions handled.
- **Contract:** split into recreate (keep) → `probeRecreatedBucket()`
  (`plan -refresh-only` / drift reuse) → refuse-with-`terraform
  import` runbook for the known generated set (VPC/IAM/ECR/log
  groups/RDS) or guided auto-import. `--force-resume` escape hatch
  preserving the caller's approval mode. R1 names the collision codes.
- **Tests:** S18a/b. Telemetry: `bucket_recovery_probed`
  (collision count), `bucket_recovery_resume_refused/forced`.
- **Implements via:** R19, R1, R4.

### H6 — `destroy` never runs `terraform init` [S2]

- **Contract:** one `ensureTerraformInit(tfDir, {upgrade, ...})`
  (init + ENOENT/dependency handling, folding `destroy.js:33-36` and
  `drift.js:178-190`) called as step 0 of `destroyStack`
  (non-upgrade); `apply` keeps it as step 1. Guarantee: no terraform
  verb except init runs first.
- **Tests:** S19. Telemetry: `terraform_init_preflight` (command, ms).
- **Implements via:** R4, surfaced in R9's pipeline.

### H7 — Raw `terraform apply` after eject-while-asleep: silent partial wake [S4]

- **Problem:** sleep is zero-Terraform (SDK `desired_count=0`,
  CLI-only autosuspend); raw apply resets ECS to 1+ vs a stopped DB
  (asleep-gate span corrected to `apply.js:44-95`), worker stays 0,
  cron re-enables (no `state` arg in `cron.tf` AND `cron-lambda.tf`).
- **Contract (two layers):** (1) `eject` preflights the sleep ledger:
  non-empty → ASLEEP warning with wake-first/abort (R3, mirrors
  `apply.js:72-94`, injectable `wakeImpl`). (2) Sleep gains a
  Terraform-visible representation: committed
  `terraform/sleep.auto.tfvars` consumed by `desired_count` guards,
  scheduler `state` args, lifecycle blocks; un-slept plans
  byte-identical (proven by live protocol P3 before landing). `wake`
  explicitly deletes `sleep.auto.tfvars` BEFORE running its restore
  apply, so wake never fights its own auto-vars (absent file =
  proceed, idempotent). RDS stop/start stays SDK-driven. R3 lands
  before R18.
- **Tests:** S20, S35; R18 template unit tests (plan-identity
  fixtures). Telemetry: `eject_asleep_preflight` (decision).
- **Implements via:** R3, R18.

### H8 — RDS destroy lifecycle gap, both directions [S4+S2]

- **Problem:** raw post-eject destroy has no pre-wake preflight
  (half-destroy); grada `destroy` refuses transitional
  (`creating`/`backing-up`/`modifying`) clusters. Correction: timeout
  is PER WAIT (~20 min worst case, not 10); code waits for stable
  state before Start — the finding is the timeout/refusal.
- **Contract:** treat `creating`/`backing-up` as waitable (not
  startable) with a longer budget + live status; add `--force` /
  skip-preflight escape hatch reporting RDS's own error; `eject`
  prints exact `aws rds start-db-*` recovery commands for the
  recorded `dbId`/`dbKind`; pre-destroy note in `database*.tf`
  template comments. Live protocol P2 proves the matrix.
- **Tests:** destroy RDS unit rows (waitable states, hatch, comment
  presence); S20/S21 eject halves. Telemetry: `rds_preflight_waited`
  (state, seconds), `rds_preflight_skipped`.
- **Implements via:** R3 (eject commands), R9 (preflight kept
  byte-for-byte, then extended).

### H9 — Re-init backup runs before AWS provisioning [S1]

- **Contract:** split `handleExistingFiles` into pure
  `planExistingFiles` (ejected/dirty/prompt gates) + `executeBackup`
  (renames); init runs plan → provision → execute (or
  execute-then-restore-on-failure). Headless fail paths still fire
  pre-provision. An AWS failure leaves the pre-backup tree intact.
- **Tests:** S22. Telemetry: `init_backup_deferred` (plan ok,
  provision failed).
- **Implements via:** R20.

### H10 — Ejected marker gitignored-local: clones silently re-manage [S4]

- **Problem (corrected):** `.grada/` reaches `.gitignore` ONLY via
  `ensureSleepGitignore` from `sleep.js:326` — the "gitignored by
  design" comments assert what only a prior successful sleep delivers.
  On the S4 path (sleep→eject) the finding holds fully; eject-without-
  sleep leaves `ejected.json` committable (gate inherited — no bug).
  Same conditional applies to `.grada/manifest.json`.
- **Contract:** eject emits a COMMITTED sentinel (`.grada-ejected` or
  preserved footer surviving `stripTerraformMetadata` round-trips,
  never false-positiving); init's gate checks local marker AND
  sentinel. Unify the three `.gitignore` RMW writers into one
  `ensureGitignoreRules(cwd, rules)` (also fixes sleep×eject).
- **Tests:** S23; strip round-trip unit tests. Telemetry:
  `ejected_sentinel_detected` (marker/sentinel/both).
- **Implements via:** R8, R10 (shared consult).

## 6. Fixes — MODERATE

### M1 — Aurora destroy path is silent data loss [S2]

- **Problem:** `skip_final_snapshot = true` on all three DB templates,
  zero `deletion_protection` tree-wide, generic confirm only.
- **Contract:** generated DB resources default to
  `deletion_protection = true` wired to a `grada_allow_data_loss`
  Terraform variable (default false) that `destroy --allow-data-loss`
  flips via `-var` at destroy time; lifted only by that flag or a
  per-run confirm naming the cluster. The safety snapshot is the
  CLI-created pre-destroy checkpoint — a Terraform-managed
  `final_snapshot_identifier` cannot be unique-per-destroy without
  perpetual diffs, so `skip_final_snapshot` stays `true`. When destroy
  is blocked by deletion protection, the
  CLI must classify it (R1 `DELETION_PROTECTION_ACTIVE`) and print
  `--allow-data-loss` explicitly as the recommended escape hatch
  (interactive alternative: per-run confirm naming the cluster).
  `destroy` auto-creates a `db backup`-style checkpoint
  (cf. `generateSnapshotId`, `rds.js:95-99`) before destroy unless the
  flag is given. Refactor `destroyStack` into the `DESTROY_PREFLIGHTS`
  pipeline (R9), keeping RDS wait/refusal semantics byte-for-byte.
- **Tests:** S24, S37; template-attribute unit tests; preflight-order tests.
  Telemetry: `db_destroy_checkpoint` (`db_kind` only — snapshot IDs never
  enter payloads per §11), `db_data_loss_accepted`.
- **Implements via:** R9, R1 (codes).

### M2 — Orphaned resources invisible to `destroy`; `gc` covers ~none [S2+S3]

- **Contract:** (1) Scope EIP discovery by tag/attachment history —
  never bare account-wide. (2) Convert targets to a `GC_TARGETS`
  registry `{id, label, discover, remove, scope}` with generic
  print/delete/report. (3) Add `gc --deep` orphan entries for
  VPC/IAM/ECR/log groups/RDS/secrets/CloudFront/ALB with a STRICT
  deletion predicate: a resource is deletable only if it carries the
  exact project tag (`GradaProject = <app_name>`, introduced into
  every generated provider `default_tags` block alongside
  `ManagedBy`). `Name`/prefix matching may feed report-only listing,
  never deletion; legacy resources lacking the tag are listed as
  unscoped/manual-review and never deleted. State bucket, lockfiles,
  and secrets-bearing state are report-only, never silent-deleted.
  (4) Add `--yes` honoring
  `shouldAutoApprove` for delete-confirm only (dry-run first; `--deep`
  opt-in only — the deliberate no-`--yes` design is preserved for the
  default path). Lambda workerless-queue case (L2/R12 policy row)
  stops new workerless queues at `add` time.
- **Tests:** S25a/b, S36; `default_tags` unit tests (project tag
  present in all provider blocks). Telemetry: `gc_deep_report`
  (counts by target).
- **Implements via:** R23, R9 (post-destroy sweep reuse), R12.

### M3 — `teardownStateBucket` silently under-deletes versioned buckets [S2]

- **Problem (citation corrected):** the console pointer is
  `destroy.js:200-203` alone (`aws.js:174-177` is return/throw only).
  Mechanics confirmed: single unpaginated list, single unbounded
  delete, versioned buckets.
- **Contract:** paginate `ListObjectVersions` to exhaustion (gc-style
  `nextToken` loop), chunk deletes at 1000 keys (shared
  `src/utils/batch.js` `chunkArray`, shared with R23), retry
  `DeleteBucket`; return precise residual inventory `{deleted,
  remaining, bucket}` rendered by R1. Keep `NoSuchBucket → true`.
- **Tests:** S26 (2500 mocked versions). Telemetry:
  `bucket_teardown_residual` (remaining count).
- **Implements via:** R14, R1.

### M4 — `doctor` is green on a broken project [S2]

- **Contract:** generalize checks to `{id, label, run, hint, scope}`
  with `runCheckSafe` dispatch; existing 5 checks byte-identical in
  ids/telemetry. Add project-scoped checks gated on `terraform/`
  existing (bucket reachable, no `.tflock`, init freshness via R4,
  R6 last-run marker clean, manifest intended-vs-applied per R5) plus
  `--deep` chaining plan-based `drift` and live-health `status`.
  Downgrade the success message when project checks are skipped.
- **Tests:** S27a/b; per-check unit rows. Telemetry: new check ids.
- **Implements via:** R2, R4, R5.

### M5 — Sleep racing unfinished adds; ledger RMW [S3]

- **Problem (corrected):** intercepts/exit-2/cron-note/worker.tf
  gating/no-already-asleep-guard/ledger-RMW confirmed — but "lambda
  records `dbId: null`" is unreachable: lambda always reuses the live
  probe result, so `dbId` is always the real DB id with services
  `{0,0}`. What sleep masks is only IaC half-written-ness (no
  add-completeness check; file probes gate pause/suspend notes only).
- **Contract:** probes treat files newer than ~N seconds or failing
  parse as "scaffolding in progress" (wait/retry or report
  `add-in-progress`, never `unreadable, skipped` + success); sleep
  refuses (or waits) while the R13 add-lock is held; ledger moves to
  per-env files `.grada/sleep/<envKey>.json` (preferred) or locked +
  versioned single file — either way corrupt bytes quarantine to
  `.corrupt.<ts>` instead of read-as-`{}` + discard; add an idempotent
  already-asleep fast path.
- **Tests:** S34; add-in-progress rows; fast-path row (no duplicate
  AWS calls). Telemetry: `sleep_add_in_progress` (file age),
  `sleep_ledger_quarantined`.
- **Implements via:** R13, R7, R16.

### M6 — `rollback` on lambda always refuses; ledger consulted only by `apply` [S3]

- **Problem:** ECS-only guard pre-AWS with manual hint only; `add` /
  `rollback` never read the ledger while `apply` refuses asleep envs
  (precision: interactive `apply` offers wake-first-and-continue,
  `apply.js:72-94`; only headless/auto-approve hard-refuses).
- **Contract:** (1) `guardSleepingEnv({cwd, envKey, options, command,
  mode})` extracted from `apply.js:44-95` (keeping the `wakeImpl`
  seam): `refuse` (apply, today's behavior), `warn` (add/rollback —
  "env asleep, apply will block until wake"), `clear-on-success`
  (destroy). Ownership: sleep=writer, wake=clearer, apply=refuser,
  add/rollback=warners, destroy=clearer-on-success, eject=preflighter.
  (2) Rollback: guard moves above client construction + intro,
  machine-readable `actual` in `resultExtra`, dedicated exit code
  (3, distinct from failure's 1 and strict-skip's 2), `--help`
  ECS-only disclosure; Case-B flow extracted to target-agnostic
  `src/utils/revision-discovery.js` as the reuse seam. A native
  lambda ECR-tag adapter remains a possible enhancement on that seam
  but is out of scope here: the refusal shape is the complete M6
  fix (the audit's either/or, second option).
- **Tests:** S28a/b; headless-newest characterization rows. Telemetry:
  `asleep_add_warned`, `rollback_target_unsupported` (actual).
- **Implements via:** R17, R21.

### M7 — Raw destroy orphans the state bucket; secrets linger in state [S4]

- **Contract:** at eject time, parse bucket/region from `backend.tf`
  (shared helper extracted from `destroy.js:51-56`) and emit exact
  manual deletion commands (`STATE_BUCKET_CLEANUP.md`) plus rotation
  notes (`ignore_changes = [secret_string]` stale-version caveat,
  `pgp_key` considerations) for the inherited state history.
- **Tests:** S21. Telemetry: `eject_cleanup_emitted` (bucket parsed?).
- **Implements via:** R3.

### M8 — Sleep artifacts local-only and orphaned [S4]

- **Problem (corrected):** ledger shape is `{env, sleptAt,
  autoRestartAt, services, dbId, dbKind}` — no "wake counts"
  (reword to stored-replica-counts); `ejected.json` inherits H10's
  sleep-conditional; STRENGTHENER: `NOTHING_TO_WAKE`
  (`wake.js:286-302`) does NOT clear the entry (`removeSleepStateEntry`
  only at `:386`, after the early return) — the stale ledger survives
  even after wake.
- **Contract:** grada `destroy` removes the env's ledger entry on
  success (R17 `clear-on-success`, exactly the destroyed `envKey`);
  `wake`'s `NOTHING_TO_WAKE` path clears the stale entry (S29b);
  `eject` migrates ledger essentials into committed human-readable
  `SLEEPING.md` or refuses while asleep (shared with H7's guard).
- **Tests:** S29a/b. Telemetry: `sleep_entry_cleared` (by: destroy /
  wake-nothing / eject).
- **Implements via:** R16, R17, R8, R18, R5.

### M9 — Post-eject split brain [S4]

- **Contract:** central `requireManagedTree()` beside
  `readEjectedMarker` (`terraform-metadata.js:61-69`): refuse-with-
  `--force` for mutating commands (apply/destroy/sleep/wake/rollback/
  secrets), warn-only for read-only `status`; wired into each
  command's existing preflight block; checks local marker AND the R8
  committed sentinel. Headless fail / warn-never-prompt pattern;
  `shouldAutoApprove` contract preserved. This picks "divorce with
  override" over "headers-only interop" — the spec decision; the
  alternative (document-and-bless) is rejected because H7 shows silent
  partial-wake harm.
- **Tests:** S30 (+ destroy/sleep/wake/rollback rows). Telemetry:
  `managed_tree_refused` (command).
- **Implements via:** R10, R8.

### M10 — All errors past two handled cases are raw text, no timeout [S1]

- **Contract:** R1 classifies the known post-transition modes (lock
  held, backend `-reconfigure` after region change, destroy-time
  dependency violations, CloudFront in-progress) into named Grada
  errors with headless-safe runbook variants; R6 streams plan/apply
  summary lines into the spinner and adds a generous phase timeout
  with "still running, state locked by X" progress. No in-process
  crash/hang changes needed (`bin/cli.js:99-109` + never-throw
  outputs already hold).
- **Tests:** fixture rows in `tests/terraform-errors.test.js`;
  spinner-stream + timeout rows. Telemetry: `terraform_error_named`
  (code) for coverage measurement.
- **Implements via:** R1, R6.

## 7. Fixes — LOW

### L1 — Missing/partial outputs degrade silently [S2]

- **Contract:** new `checkOutputsContract(outputs, computeTarget)`
  against a per-target expected-keys table (ECS: `alb_direct_url`,
  `ecr_repository_url`). Empty map or missing keys → loud
  partial-state advisory (expected vs got + next steps) and non-zero
  exit unless `--allow-partial-outputs` (start: warn + non-zero only
  on fully-empty map, to avoid false positives). Keep the never-throw
  `getTerraformOutputs` contract; add "resumed/completed partial
  apply" messaging when the R6 marker shows a prior interrupt.
- **Tests:** S31; per-target key rows. Telemetry:
  `outputs_contract_violated` (missing keys).
- **Implements via:** R22, R6.

### L2 — Inconsistent static gating [S1]

- **Contract:** one table near `ADDON_REGISTRY` —
  `{capability: {supported, level}}` with explicit rows for every
  entry — consulted once at the top of `runAdd`/`runAddDatabase`,
  before the TOCTOU guards. Refuse-level reuses the
  `guardComputeTarget` descriptor + `STATIC_TARGET_UNSUPPORTED`;
  warn-level reuses the sqs message shape. Exact error codes/reasons
  preserved (asserted in `tests/target-matrix.test.js`). The no-op
  backstop in `injectContainerEnvVars` stays.
- **Tests:** S32a/b; full-table rows. Telemetry: `addon_target_refused`
  / `addon_target_warned` (capability, target).
- **Implements via:** R12.

### L3 — Rollback discovery footguns [S3]

- **Problem (corrected):** `if (headless)` auto-selects
  `eligibleArns[0]` for ANY nonzero count (zero returns earlier);
  interactive mode with exactly one eligible still prompts;
  interactive candidates cap at 5 (`rollback.js:187`).
- **Contract:** keep "headless → newest of N; interactive → prompt
  over newest ≤5"; annotate each `failCommand` call site with an
  explicit `exitCode`; warn (not silent-accept) when the requested
  revision equals the deployed one.
- **Tests:** S33; headless-N + interactive-cap rows. Telemetry:
  `rollback_current_revision_warned`.
- **Implements via:** R21.

### L4 — Eject message urges immediate `apply` with no asleep caveat [S4]

- **Contract:** folded into R3/H7: pre-confirm sleep-ledger read;
  non-empty → "stack is ASLEEP (ECS=0, RDS stopped…)" warning with
  wake-first/abort, mirroring `apply.js:72-94`.
- **Tests:** S20. Telemetry: covered by `eject_asleep_preflight`.
- **Implements via:** R3.

## 8. Refactors (prerequisite shapes)

Condensed from `/tmp/refactor-opportunities.md`; full file:line
grounding lives there. Risk in brackets.

| ID | Shape | Serves | Risk |
|----|-------|--------|------|
| R1 | `src/utils/terraform-errors.js`: `classifyTerraformError` + `ERROR_RUNBOOKS` (headless-safe variants); replace 3 ad-hoc sites | H1 H5 M10 M1 M3 | LOW |
| R2 | Doctor `{id,label,run,hint,scope}` checks + project-scoped checks + `--deep`; downgrade bare success | M4 H1 C2 H6 | LOW |
| R3 | Eject pre-confirm asleep preflight + `STATE_BUCKET_CLEANUP.md` + rds start commands emission | L4 M7 H7 H8 | LOW |
| R4 | Shared `ensureTerraformInit`; step 0 of destroy, step 1 of apply | H6 H5 M4 | LOW |
| R5 | Manifest v2 `{target, appliedTarget, appliedRevision}`; `recordAppliedTarget()` post-apply | C1 H4 M4 M8 | MED |
| R6 | `runTerraformCommand` lifecycle owner: signals, timeout, spinner streaming, last-run marker, structured reject | C2 M10 H1 L1 | MED |
| R7 | `src/utils/atomic-write.js` (sync+async) at every truncating site; preserve modes | H2 M5 | LOW |
| R8 | Committed eject sentinel + unified `ensureGitignoreRules` | H10 M8 M9 | LOW-MED |
| R9 | `DESTROY_PREFLIGHTS` pipeline incl. snapshot checkpoint + post-destroy sweep | M1 H6 M2 | MED |
| R10 | Central `requireManagedTree()` (refuse mutating, warn `status`) | M9 H10 | LOW-MED |
| R11 | `createFileExclusive` (`wx`→soft-fail) replacing 3 TOCTOU pairs | H2 | LOW |
| R12 | Capability-vs-target policy table at top of `runAdd` | L2 M2 | LOW |
| R13 | `withProjectLock` (mkdir-lockdir + stale expiry or proper-lockfile) at every RMW site | H2 M5 | MED |
| R14 | Paginated/chunked S3 teardown + residual inventory; shared `batch.js` | M3 | LOW |
| R15 | `PRESERVED_FILES` carry-forward across regenerate | H3 | LOW-MED |
| R16 | Per-env ledger files (preferred) or locked+versioned file; quarantine corrupt bytes | M5 M8 | MED |
| R17 | `guardSleepingEnv` refuse/warn/clear-on-success + ownership table | M6 M8 | MED |
| R18 | Committed `sleep.auto.tfvars` + template guards; wake deletes file before restore-apply; un-slept plans byte-identical | H7 M8 | HIGH |
| R19 | `probeRecreatedBucket` + import runbook + `--force-resume`; no forced auto-approve | H5 | MED |
| R20 | `planExistingFiles` / `executeBackup` split; plan → provision → execute | H9 | MED |
| R21 | Rollback guard reorder + `revision-discovery.js` seam + dedicated exit code + explicit exitCodes | M6 L3 | MED |
| R22 | `checkOutputsContract` per-target key tables | L1 | LOW |
| R23 | `GC_TARGETS` registry + exact project-tag deletion predicate + new `GradaProject` default tag + `--deep` + `--yes` (delete-confirm only) | M2 | HIGH |

Dependency order (foundations first): R13 → R7 → R11 →
R6 → R1 → R4 → R5 → R9/R14/R19 → R16/R17 → R2/R22 → R3 →
R18 → R8/R10 → R12 → R15/R20 → R21 → R23.

## 9. Phases

| Phase | Content | Gates |
|-------|---------|-------|
| 0 | S12–S37 red rows + unit-suite scaffolding (§3) | all rows fail for the right reason |
| 1 | Foundations: R13/R7/R11 (H2), R6 (C2), R1 (H1/M10) | S13 S14a S15 green; P1 records signal semantics |
| 2 | State truth: R5 (H4), C1 gate, R4 (H6), R19 (H5), R14 (M3), R9+M1, H8 waits/hatch | S12 S17–S19 S24 S26 S37 green; P2 records RDS matrix |
| 3 | Sleep/eject coherence: R16/R17 (M5/M6/M8), R3 (L4/M7), R18 (H7, after P3), R8/R10 (H10/M9) | S20 S21 S23 S28–S30 S34 S35 green; P3 proves plan identity |
| 4 | Policy & UX: R12 (L2), R15 (H3), R20 (H9), R21 (M6/L3), R2 (M4), R22 (L1) | S16 S22 S25a S27 S31–S33 green |
| 5 | GC deep (R23/M2) + P4/P5 + docs (§12) + full suite green | S25b S36 green; all protocols recorded |

## 10. Live protocols (in-scope, with record-decision gates)

Run against a throwaway AWS project; destroy afterwards. Each records
its outcome in the implementation PR/notes before its phase closes.

- **P1 — Interrupt semantics (C2/H1):** Ctrl+C a real `apply`
  mid-provision; confirm child relay, marker write, stale `.tflock`
  shape, and that `force-unlock` + retry recovers. Resolves
  verification items 1–2.
- **P2 — RDS destroy matrix (H8/M1):** destroy from `stopped`,
  `creating`, `backing-up`, `modifying`; confirm waitable-vs-refused
  behavior, hatch output, snapshot checkpoint, and whether the
  RDS-managed master secret lingers (item 3).
- **P3 — Sleep plan identity (R18 gate):** `terraform plan` before vs
  after adding un-slept `sleep.auto.tfvars` must be byte-identical;
  slept plan must show exactly the intended guards. R18 does not land
  without this.
- **P4 — Provider defaults (H7):** confirm scheduler `state` default
  (cron re-enable half) and raw-apply half-wake shape on a slept
  ejected tree (item 7).
- **P5 — Bucket scale (M3/R14):** bucket with >1000 versions;
  confirm paginated teardown reaches zero residual (item 6).

Already resolved by code reading (not re-proven live): `drift.yml`
exit-1 → no issue action; init re-run never partially overwrites
(any-trigger whole-dir rename; manifest-compare otherwise); no
`templates/rds.js` (DB secrets are template
`manage_master_user_password` + read-only `rds.js` refs).

## 11. Telemetry additions

New events (all with `project_id`, `cli_command`, target where
relevant): `target_switch_refused/override`, `state_lock_detected/
force_unlocked`, `file_lock_waited`, `preserved_files_restored`,
`bucket_recovery_probed/resume_refused/forced`,
`terraform_init_preflight`, `eject_asleep_preflight`,
`eject_cleanup_emitted`, `rds_preflight_waited/skipped`,
`init_backup_deferred`, `ejected_sentinel_detected`,
`db_destroy_checkpoint/data_loss_accepted`, `gc_deep_report`,
`bucket_teardown_residual`, `sleep_add_in_progress`,
`sleep_ledger_quarantined`, `asleep_add_warned`,
`rollback_target_unsupported`, `sleep_entry_cleared`,
`managed_tree_refused`, `terraform_error_named`,
`outputs_contract_violated`, `addon_target_refused/warned`,
`rollback_current_revision_warned`. Extend `infrastructure_applied`
with the intended/applied target pair. No new PII: bucket names,
lock IDs, and snapshot IDs stay in runbook stdout, never in payloads.

## 12. Docs (after implementation, before release notes)

- CLI pages: `apply` (C1 gate, H1 unlock, H5 resume), `destroy`
  (R9 pipeline, M1 flag, H6 init), `doctor` (`--deep`, project
  checks), `gc` (`--deep`, `--yes`, scoping), `rollback`
  (lambda support, exit codes), `eject` (asleep preflight, sentinel,
  cleanup file), `sleep` (add-in-progress, fast path).
- Guides: rerun-init (preserved files, provision-before-backup),
  headless (new refuse-with-flag codes), troubleshooting (lock
  recovery, import runbook, interrupted-run marker).
- Templates: `database*.tf` pre-destroy comments (H8); `SLEEPING.md`
  / `STATE_BUCKET_CLEANUP.md` formats documented.
- Roadmap + release notes per the repo's typical approach once the
  release version is assigned.
