# Specification: State-Transition Audit Fixes (Cross-Command Flows)

## 1. Overview

This spec turns the cross-command state-transition audit into fixes. The
audit traced multi-command user flows (`init → add → apply → sleep →
wake → rollback → eject → destroy`, re-runs, out-of-order runs) and found
9 confirmed issues (1 retracted during review — see F6). Each fix below
is specified **tests-first**: the failing sequence test lands before the
implementation, following the existing suite conventions (vitest,
`tests/helpers/*`, injected mock clients, `noExit` programmatic
results).

Finding numbers (F1–F10) match the audit report so review discussion can
reference them. F6 is kept as a placeholder marked retracted to preserve
numbering. The four items originally parked as follow-ups are promoted
into the work: the F1 interactive path and F7 `--strict` are folded into
their sections, and Phase 4 adds F11 (true post-init `add db:*`) and
F12 (concurrency investigation with a conditional build).

## 2. Boundaries & Constraints

- **No implementation in this step.** This spec is review-only; code and
  tests land after approval.
- **Preserve existing contracts:** `failCommand` result shapes
  (`{ ok: false, reason, ... }`), `noExit` exit-code stamping restored
  by `bin/cli.js`, telemetry event names, and all timing seams
  (`pollIntervalMs` / `timeoutMs` / `sleepFn` / `nowFn`).
- **Preserve the stability-guardrails contract:** `sleep`/`wake` on
  `static` (and `lambda` without a DB) exit gracefully with code 0. F7
  sharpens signaling only; it must not turn skips into failures.
- **CLI exit codes for new gates:** hard gates fail with exit 1 and a
  structured `error_code`; skipped no-ops keep exit 0 with a `skipped`
  reason.
- **Roadmap correction:** the roadmap example sequence uses
  `add db:postgres`, which does not exist until Phase 4 implements it
  (see F8/F11). The canonical regression sequence for this spec is
  `init → add queue:sqs → apply → sleep → wake → rollback → eject →
  destroy`, plus the re-run/out-of-order variants in §3.
- **F12 is investigative with a conditional build:** the concurrency
  protocol (§F12) runs first; the CLI-level lockfile is implemented
  only if the protocol reproduces damage beyond Terraform's native
  lock error. Either outcome is recorded before Phase 4 closes.

## 3. Test Strategy (Phase 0 — lands first)

### 3.1 New flow-matrix suite: `tests/state-transitions.test.js`

A single suite owning the cross-command sequences, built on existing
helpers (`tests/helpers/tmpdir.js`, `clack.js`, `telemetry.js`,
`console.js`) and the mock patterns in `tests/apply.test.js`
(mock `child_process`, `@clack/prompts`, `provisionStateBucket`) and
`tests/sleep-wake.test.js` (injected `ecsClient`/`rdsClient`,
`spawnSyncImpl`, tmpdir `cwd` fixtures):

| # | Sequence | Expected after fix |
|---|----------|--------------------|
| S1a | `init → apply → sleep → apply` (headless) | second apply fails fast `SLEEPING_ENVIRONMENT`; zero terraform calls (F1) |
| S1b | same + `--force` | proceeds; override recorded in telemetry (F1) |
| S1c | same (interactive) | offers wake-and-continue; wake runs, then apply proceeds (F1) |
| S2 | `init → eject → add queue:sqs` | warns; renders headerless `sqs.tf`; tree stays vanilla (F2) |
| S3a | `init → hand-edit main.tf → init` (interactive) | prompt lists modified files; backup/cancel (F3) |
| S3b | same, headless | fails `MODIFIED_TREE`; `--force` regenerates (F3) |
| S3c | `init → init` (unmodified), headless | regenerates silently (idempotent, current behavior) (F3) |
| S4 | `sleep → wake → wake` | second wake is `already-awake` no-op; no `UpdateService` (F4) |
| S5a | `init → apply (1 rev) → rollback` | `NO_PRIOR_REVISIONS` names revision count + next action (F5) |
| S5b | `init → rollback` (never applied) | `SERVICE_NOT_FOUND` directs to `apply` (F5) |
| S7a | `init(static) → sleep/wake` | exit 0, `skipped` reason, shared message shape (F7) |
| S7b | same + `--strict` | exits 2 with `skipped` reason preserved (F7) |
| S8 | `init → add db:oracle` | guided error listing valid `db:*` engines (F8) |
| S9a | `add queue:sqs × 2` | still requires `--force` (F9) |
| S9b | `add ai:bedrock --model A → --model B` | upserts in place without `--force` (F9) |
| S9c | `add email:ses --from-email A → B` | upserts in place without `--force` (F9) |
| S10 | `deploy` | aliases `apply` (bin dispatch + help) (F10) |
| S11a | `init(no db, ecs) → add db:postgres` | `database.tf` + `DB_*` env/secrets in `main.tf` (+`worker.tf`); `hasDb` true (F11) |
| S11b | `init(no db) → add db:mysql` | mysql template + `DB_ENGINE` env (F11) |
| S11c | `init(no db, lambda) → add db:postgres` | converted `database.tf`, random provider, VPC config, plain `DB_PASSWORD` (F11) |
| S11d | `init(static) → add db:postgres` | refused by target guard (F11) |
| S11e | `add db:postgres × 2` / `init(db) → add db:postgres` | already-exists / already-provisioned errors unless `--force` (F11) |

F12 (concurrency) has no automated matrix row: its work item is the
live protocol in §F12, whose recorded decision gates the conditional
lockfile build (which, if triggered, lands with its own unit tests
per §R10).

Each row is written to fail against current code (red) before its fix
(green). Unit tests for extracted helpers live next to existing files
(`tests/sleep-wake.test.js`, `tests/add.test.js`, `tests/eject.test.js`,
`tests/rollback.test.js`, `tests/apply.test.js`, `tests/cli.test.js`).

### 3.2 Phase ordering

1. **Phase 0:** land `tests/state-transitions.test.js` with all rows
   asserting the *desired* behavior (red where unfixed), plus any
   shared fixtures/factories needed by later phases.
2. **Phases 1–4:** implement fixes in dependency order (§4), turning
   rows green without touching the test expectations. Phase 4 (F11,
   F12) runs last: F11 builds on the F9 gate and §R3 helpers, and
   F12's protocol runs against the finished tree.
3. No test expectation may be weakened to fit an implementation; if a
   row proves wrong, the spec is amended first.

## 4. Implementation Targets

### Phase 1 — Safety gates (F1, F4, F3)

#### F1. Block `apply` while asleep (`init → apply → sleep → apply`)

- **Tests first (S1a–c):** asleep-ledger fixture + `applyStack`:
  headless expects failure with `error_code:
  'SLEEPING_ENVIRONMENT'`, hint naming `grada wake`, and zero
  terraform invocations; with `force: true`, expects apply to
  proceed with the override in telemetry; interactive (mocked
  confirm → yes, injected `wakeImpl`) expects wake to run for the
  same env and apply to proceed; mocked confirm → no expects a
  clean cancel with zero terraform calls.
- **Implementation (`src/commands/apply.js:34-41`):**
  - Replace the advisory warning with a hard gate via a new shared
    helper `requireAwakeEnvironment(targetDir, envKey)` in
    `src/utils/sleep-state.js` returning the ledger entry or null
    (pure over the ledger; the command owns prompting/exit).
  - Headless/CI fails the gate via `failCommand`
    (`SLEEPING_ENVIRONMENT`, reason `sleeping-environment`, hint
    `Run npx grada-run wake first…`) — no silent proceed.
  - `--dry-run` is exempt: previews change nothing, so they keep the
    historical advisory warning and complete normally.
  - Interactive offers wake-and-continue: `confirm("Environment
    \"<env>\" is asleep. Wake it now and continue with apply?")`.
    On yes, apply invokes wake through an injectable seam
    (`options.wakeImpl || runWake`, mirroring the existing
    `runTerraformImpl` / `spawnSyncImpl` seams) with
    `{ cwd: targetDir, env }` and default wait semantics (the DB
    must be `available` before tasks start); a failed wake aborts
    the apply with the wake result's reason. On no/cancel, abort
    cleanly with zero terraform calls. (`apply.js` importing
    `runWake` from `wake.js` introduces no cycle: `wake.js`
    imports only utils.)
  - Escape hatch: `--force` proceeds without waking (existing
    `force` option vocabulary, as in `add`/`alerts`); telemetry
    records `forced_apply_while_asleep`. Requires a new
    `parseApplyArgs` in `apply.js` following the `parseSleepArgs`
    pattern, wired in `bin/cli.js` (the apply branch currently
    passes only `isDryRun`/`autoApprove`/`isHeadless`).

#### F4. `wake` is idempotent (`sleep → wake → wake`)

- **Tests first (S4):** after a wake that clears the ledger (current
  `removeSleepStateEntry` behavior, `wake.js:372`), a second `runWake`
  with a mock `ecsClient` must issue zero `UpdateService` calls and
  return `{ ok: true, skipped: 'already-awake', … }`. Also cover
  `wake` on a never-slept env (no ledger entry, services at
  desired > 0) → same no-op; and deleted-ledger-while-asleep
  (no entry, services at 0 / DB stopped) → proceeds with 1/1
  defaults (preserves recovery).
- **Implementation (`src/commands/wake.js:178,252-255`):**
  - After reading the ledger entry, when there is **no entry** for
    the env, probe live state before restoring: `fetchActiveService`
    for app/worker (already imported) plus the existing DB probe.
  - No-op rule: no ledger entry AND no service at desired 0 AND no
    stopped DB → print `already awake`, `trackSuccess` with
    `skipped: 'already-awake'`, return the standard skip result
    (same shape as the static intercept, §R1).
  - Otherwise proceed exactly as today (1/1 defaults cover the
    missing-ledger case). Keep `Math.max(1, …)` only on this
    fallback path and comment why.

#### F3. `init` re-run must not silently supersede hand edits

- **Tests first (S3a–c):** fixture project with `terraform/`,
  `Dockerfile`, `deploy.yml` + manifest (below): unmodified re-run →
  regenerates; one file hand-edited → interactive prompt names the
  file; headless + modified → `MODIFIED_TREE` failure unless
  `force: true`.
- **Implementation (`src/utils/backup.js`, `src/commands/init.js:428`):**
  - `init` writes `.grada/manifest.json` after generation:
    `{ file: sha256 }` over `terraform/**`, `Dockerfile`,
    `.github/workflows/deploy.yml` (new `writeInitManifest` /
    `detectModifiedTree` in `backup.js`; dependency-free hashing
    via `node:crypto`).
  - `handleExistingFiles(targetDir, isHeadless, { force })`:
    - No manifest (legacy project) → current behavior (prompt /
      auto-backup). Never fail on projects we cannot judge.
    - Manifest matches → regenerate silently (idempotent fast
      path, both modes).
    - Modified files → interactive: the `select` message lists
      them (`main.tf, Dockerfile differ from generated output`)
      with the existing Backup/Cancel options; headless:
      `failCommand` (`MODIFIED_TREE`, hint: re-run with `--force`
      to backup & regenerate, or back up by hand).
  - Wire `--force` into init: add `force: getBoolFlag('force')` in
    `src/core/parser.js` and pass through `initOptions`
    (`bin/cli.js` else-branch) to `handleExistingFiles`.

### Phase 2 — Provenance & diagnostics (F2, F5, F8, F6-residual)

#### F2. `eject → add` must not mix vanilla and managed files

- **Tests first (S2):** `ejectStack` on a fixture, then `runAdd`
  `queue:sqs`: expect a warning naming the ejected state, a
  headerless `sqs.tf` (no `# grada addon:` line, billing docs
  kept), and `ejected: true` in `add_run` telemetry.
- **Implementation:**
  - `ejectStack` writes `.grada/ejected.json`
    (`{ ejectedAt, cliVersion }`). `.grada/` is already the
    gitignored local-state dir, so the ejected tree stays
    "100% vanilla" where it matters (terraform + git).
  - `scaffoldAddon` (`src/commands/add.js:1072`) checks the
    marker: when present, strip managed header lines from the
    rendered template via the shared helper (§R3) and set
    `ejected: true` on the result; `runAdd` prints one warning
    line (`project was ejected … rendering unmanaged-compatible
    file`). Env injection into `main.tf`/`worker.tf` is unchanged
    (functional, not provenance).
  - Considered and rejected: refusing `add` after eject — additive
    scaffolding is still useful; consistency of the tree is the
    requirement, not refusal.
  - Same marker check in `init` re-run: warn that init will
    re-apply managed metadata, require confirm / `--force`
    (shares the F3 gate messaging).

#### F5. `rollback` diagnostics per failure cause

- **Tests first (S5a–b):** single-revision service → failure message
  contains current revision number and "deploy again to create
  rollback history"; missing/inactive service → message directs to
  `grada apply` (already does — pin it). Keep exit codes and
  `NO_PRIOR_REVISIONS` / `SERVICE_NOT_FOUND` telemetry unchanged.
- **Implementation (`src/commands/rollback.js:105-117,163-173`):**
  - `NO_PRIOR_REVISIONS` message gains the family and current
    revision (`Family X is on revision 3 with no previous ACTIVE
    revisions — nothing to roll back to. Deploy again to create
    rollback history.`). No exit-code change (still a failure:
    masking it as success would hide scripting errors).
  - Extract revision discovery into
    `discoverEligibleRevisions(ecsClient, family, currentRevNum)`
    (§R6) so the messaging and filtering are unit-testable without
    the prompt flow.
  - Lambda/static guard keeps current behavior (already hints at
    redeploy/manual steps); no change.

#### F8. Unknown `db:*` names → guided error (valid engines ship in F11)

- **Tests first (S8):** `runAdd({ capability: 'db:oracle' })`
  expects `UNSUPPORTED_CAPABILITY` with a hint listing the valid
  relational capabilities.
- **Implementation (`src/commands/add.js:924-936`):**
  - When the unknown capability matches `/^db:/`, append a hint:
    `Valid relational capabilities: db:postgres, db:mysql,
    db:aurora-postgresql (see also db:dynamodb, db:redis).`
  - The three valid engines are implemented in Phase 4 (F11); this
    item keeps the error helpful for every other `db:*` spelling
    before and after that lands.

#### F6 (retracted) — residual only

The audit's "destroy → apply bucket trap" was refuted: apply
self-heals a missing bucket (`apply.js:140-191`) and destroy only
offers bucket deletion after a successful destroy (`destroy.js:174`).
One residual item survives:

- **Tests first:** missing-bucket recovery prompt text asserts the
  state-loss warning (below).
- **Implementation:** the recovery confirm message gains one line:
  `Previous state is unrecoverable — if infrastructure still exists
  (bucket deleted out-of-band), apply will try to recreate it.` No
  behavior change. The recovery block itself is extracted per §R5.

### Phase 3 — Consistency & naming (F9, F7, F10)

#### F9. Generalize the `add` re-run gate (remove the bedrock special case)

- **Tests first (S9a–b):** `queue:sqs × 2` still fails
  `ADDON_ALREADY_EXISTS` without `--force`; `ai:bedrock --model A`
  then `--model B` upserts `BEDROCK_MODEL_ID` in place; same-class
  coverage for `db:redis` and `email:ses` upsert keys where explicit
  new values are provided.
- **Implementation (`src/commands/add.js:1019-1034`):**
  - Replace `canSwitchBedrock` with a general `canUpsert` rule:
    re-run without `--force` is allowed when the capability has
    `ADDON_UPSERT_KEYS` entries (`src/utils/addons.js:108`) **and**
    the user explicitly supplied new values for them
    (`resolved.meta` explicit flags — extend `resolveAddonOptions`
    meta for redis/ses to record explicitness, mirroring bedrock's
    `explicitModel`).
  - The general upsert machinery (`injectContainerEnvVars` /
    `injectLambdaEnvVars` with `upsertKeys`) already handles the
    in-place update; only the gate is special-cased today.
  - Success message distinguishes `Created` (first run) from
    `Updated` (upsert re-run).

#### F7. Unify skip signaling for `sleep`/`wake` (+ `--strict`)

- **Tests first (S7a–b):** static-target `sleep`/`wake` pin exit 0,
  `skipped` reason, and the shared message shape from §R1; same for
  `lambda-skip-db` / `lambda-no-database` / `already-awake` rows.
  With `strict: true`, the same intercepts return
  `{ ok: false, skipped: '<reason>', … }` and exit 2, with the
  human message unchanged.
- **Implementation:**
  - One `skipped`-reason vocabulary (`static-target`,
    `lambda-skip-db`, `lambda-no-database`, `already-awake`), one
    message shape (`… Nothing to do (<reason>).`), one
    result/telemetry builder — via §R1's shared intercept helper.
  - New `--strict` flag (wired through `parseSleepArgs` /
    `parseWakeArgs`, help text, and README): under `--strict` a
    skip exits **2** (distinct from failure's 1) so shell scripts
    can distinguish "nothing to do" from both success and error.
    Telemetry keeps `success: true` with the `skipped` reason —
    strictness is a caller contract, not a command failure.
  - Document the reasons, the exit-2 contract, and the default
    exit-0 behavior in `README.md` (sleep/wake section) so scripts
    can rely on them.

#### F10. `deploy` aliases `apply`

- **Tests first (S10):** `bin/cli.js` dispatch test (or
  `tests/cli.test.js` addition): `deploy` routes to `applyStack`
  with the same options as `apply`, including `--dry-run` /
  `--auto-approve`.
- **Implementation (`bin/cli.js:116`):** accept
  `positionalArgs[0] === 'deploy'` in the apply branch; add
  `deploy                Alias of apply` to `HELP_TEXT`. Note:
  `process.env.CLI_COMMAND` will record `deploy`; keep it (it
  truthfully records what the user typed).

### Phase 4 — Post-init database & concurrency (F11, F12)

#### F11. True post-init `add db:postgres|mysql|aurora-postgresql`

Feasibility was verified against the templates: `database.tf` ships
with zero `{{PLACEHOLDERS}}` (verbatim copy works — everything is
parameterized via `local.app_name` and references to `aws_vpc.main`
/ `aws_security_group.ecs_tasks`), `parseTerraformConfig` detects
`hasDb` by `database.tf` presence (`visualizer.js:68`) so cost,
preview, and sleep/wake pick it up for free, and the env-injection
machinery (`injectContainerEnvVars` / `injectLambdaEnvVars`) already
supports add-time wiring. Only the ECS secrets array needs a new
injection helper.

- **Tests first (S11a–e):** tmpdir fixtures from `init(no db)` per
  target; assert file + injection outcomes below, the static
  refusal, and the re-run guards. Add `terraform validate`-shape
  assertions where cheap (balanced braces via existing HCL
  helpers), not a real terraform binary.
- **Implementation (`src/commands/add.js`, new `scaffoldDatabase`):**
  - Dispatch: capabilities `db:postgres`, `db:mysql`,
    `db:aurora-postgresql` bypass the `ADDON_REGISTRY` lookup and
    route to a dedicated `scaffoldDatabase(engine, { cwd })`
    pipeline after the terraform guard. The registry stays
    addon-only so cost/display logic (which treats RDS via `hasDb`,
    not as an addon) is untouched; valid engine names are surfaced
    by the F8 hint, not the registry list.
  - Guards: `static` target → `guardComputeTarget` refusal (same
    helper as `db.js`); `terraform/database.tf` exists →
    `ADDON_ALREADY_EXISTS` (force to overwrite, per the F9 gate);
    `main.tf` already references `aws_db_instance.postgres` /
    `aws_rds_cluster.postgres` without `database.tf` (hand-added
    DB) → `DB_ALREADY_REFERENCED` unless `--force`.
  - Render: copy `templates/terraform/database[-<engine>].tf` to
    `terraform/database.tf`. Lambda targets apply the existing
    exported `convertDatabaseTfForLambda` +
    `addRandomProvider` (`generator.js`) and reuse
    `ensureLambdaVpcConfig` as is (its block already carries both
    subnet ids and the task security group, matching the DB
    variant).
  - Wire ECS (`main.tf` + `worker.tf` when present): inject
    `DB_HOST` / `DB_PORT` / `DB_NAME` (+ `DB_ENGINE` for non-
    postgres) via `injectContainerEnvVars`, and `DB_USER` /
    `DB_PASSWORD` `valueFrom` entries via a new
    `injectContainerSecrets` helper targeting the second array
    literal of the `secrets = concat(…, [ … ])` block
    (`main.tf:146`) — the `concat` shape is why env injection
    cannot be reused directly. Entry values come from the
    extracted builders (§R9) so init and add can never diverge.
  - Wire Lambda: `DB_HOST` / `DB_PORT` / `DB_NAME` /
    `DB_USER = "dbadmin"` / `DB_PASSWORD =
    random_password.db_password.result` via `injectLambdaEnvVars`.
  - Finish: `syncDocCostEstimate` (already picks up `hasDb`),
    success message naming the engine + `grada apply`, telemetry
    `add_run` with `capability: 'db:<engine>'`. Sleep/wake need no
    changes (`findDbTarget` probes RDS live).
  - Out of this item: migration-gate CI setup for the new DB
    (stays an init-time concern; `db migrate --setup-ci` remains
    the manual path).

#### F12. Concurrency: protocol first, lockfile only on reproduction

The audit found no evidence of CLI-level interleaving damage, and
Terraform natively serializes concurrent runs via its own state
lock — so this item starts as a time-boxed investigation, not a
build.

- **Protocol (run against a live test project, recorded in the
  implementation PR):**
  1. `apply --auto-approve` × 2 concurrently → expect one to fail
     with Terraform's lock error and the other to succeed, with
     `terraform plan` clean afterwards.
  2. `apply` + `destroy --yes` concurrently → expect the same
     clean serialization.
  3. `sleep` during `apply` (ECS+DB project) → document the end
     state (tasks vs DB) and whether recovery is just `wake`.
- **Decision rule:** if all three serialize or fail cleanly with no
  manual state surgery, record the outcome (matrix + logs) and
  close F12 with no code change. If any run leaves partial/corrupt
  state or requires `terraform force-unlock` / manual repair,
  implement the CLI-level lockfile per §R10 with unit tests, then
  re-run the protocol.
- **Status (implementation):** steps 1–2 verified LOCALLY
  (Terraform v1.15.8, local backend, `/tmp/f12-lock` fixture):
  two concurrent `apply -auto-approve` runs serialized — one
  exited 0, the other failed with `Error acquiring the state
  lock`, and a follow-up `plan` confirmed valid state with no
  repair. The S3 backend uses the same native lock semantics, so
  a CLI-level lockfile is not indicated for apply/destroy races.
  Step 3 (sleep during apply end state) and the live-AWS rerun of
  steps 1–2 remain PENDING: they provision real infrastructure on
  the operator's account and need an explicit live run (suggested:
  `grada init --headless` a throwaway project, run the three
  steps, `grada destroy --yes`, then record the matrix here).
  §R10 stays unbuilt unless that run reproduces damage.

## 5. Refactoring Opportunities (aligned with §4)

Each refactor is required by, or directly adjacent to, a fix above —
no speculative rewrites.

- **R1. Shared sleep/wake intercept helper (serves F4, F7).**
  `sleep.js` (~lines 85-178) and `wake.js` (~lines 78-176) duplicate
  the static / lambda-skip-db / lambda-no-database intercepts
  (~90 lines each, drift-prone). Extract to `src/utils/sleep-state.js`
  (or extend `src/utils/sleep-targets.js`):
  `resolveTargetIntercept({ computeTarget, skipDb, dbProbe }) →
  { intercepted, reason, message }` plus `skipResult/trackSkip`
  builders emitting the §F7 standard shape. Both commands call it
  before any AWS write. Pure and unit-tested; commands keep their
  distinct main flows.
- **R2. `requireAwakeEnvironment` gate (serves F1).** New pure helper
  in `src/utils/sleep-state.js` over `readSleepState`, used by
  apply's hard gate. Documents the counterpart: destroy's
  wake-before-destroy preflight (`destroy.js:80-167`) stays as is.
- **R3. Shared terraform-metadata utils (serves F2).**
  `stripTerraformMetadata` / `stripGitignoreMetadata` move from
  `src/commands/eject.js:29-40` to `src/utils/terraform-metadata.js`,
  re-exported from `eject.js` (existing imports in
  `tests/eject.test.js` keep working). `scaffoldAddon` reuses the
  strip helper for headerless rendering — no second regex set.
- **R4. Upsert-gate generalization (serves F9).** As specified in F9:
  gate driven by `ADDON_UPSERT_KEYS` + explicit-option meta; delete
  the bedrock-only branch.
- **R5. Extract bucket recovery (serves F6-residual).** Move the
  `NoSuchBucket` recovery block (`apply.js:140-191`) into
  `recoverMissingStateBucket({ tfDir, region, projectName, options })`
  in `src/utils/aws.js` (next to `provisionStateBucket`) or a new
  `src/utils/recovery.js`. `applyStack` keeps the recursive resume
  call; the helper owns cache-wipe + re-provision + prompt, making
  it unit-testable without a terraform binary.
- **R6. Extract revision discovery (serves F5).**
  `discoverEligibleRevisions(ecsClient, family, currentRevNum)` in
  `rollback.js` (exported, pure over the client) covering the
  list/filter logic (`rollback.js:152-173`).
- **R7. Init manifest + dirty detection (serves F3).**
  `writeInitManifest` / `detectModifiedTree` in `src/utils/backup.js`
  (`node:crypto` sha256). `handleExistingFiles` gains the
  `{ force }` third parameter; legacy no-manifest projects keep
  current behavior.
- **R8. CLI alias table (serves F10).** Replace the single-command
  equality checks in `bin/cli.js` dispatch with a minimal alias map
  (`{ deploy: 'apply' }`) resolved before dispatch, so future
  aliases are one line. Help text lists the alias.
- **R9. Shared DB wiring builders + secrets injection (serves F11).**
  Extract the engine→entries mapping (`generator.js:272-296`: dbRef,
  host/name attrs, port, ECS env + `valueFrom` secrets, Lambda
  variables) into exported `buildDbEnvEntries(engine, target)` in
  `src/utils/generator.js` (or a new `src/utils/database.js`);
  `generateTemplates` keeps behavior by calling it, `scaffoldDatabase`
  reuses it so init-time and add-time wiring can never diverge. Add
  `injectContainerSecrets(tfContent, secretEntries,
  taskDefinitionName)` in `src/commands/add.js` mirroring
  `injectContainerEnvVars` but targeting the second array literal
  of the `secrets = concat(…)` block; unit-tested (empty array,
  existing entries, idempotent re-run, missing block → unchanged).
- **R10. CLI-level run lockfile (conditional on F12).** Only if the
  F12 protocol reproduces damage: `src/utils/run-lock.js` with
  `acquireRunLock(cwd)` / `releaseRunLock()` using atomic `mkdir`
  on `.grada/run.lock/` (payload: pid + started-at; stale after 30
  min or dead pid → steal with warning), held by `apply` and
  `destroy` (the terraform-mutating commands), `--no-lock` escape
  hatch, unit tests with tmpdir + injected pid/clock. Not built
  unless F12 triggers it.

## 6. Acceptance Criteria

1. `tests/state-transitions.test.js` covers all S1–S11 rows; the full
   suite (`npm test`) passes with no weakened pre-existing test.
2. Headless `apply` on an asleep env fails with `SLEEPING_ENVIRONMENT`
   and runs zero terraform commands; `--force` proceeds with override
   telemetry; interactive offers wake-and-continue and aborts cleanly
   on decline.
3. Second `wake` issues zero AWS writes and returns
   `skipped: 'already-awake'`; deleted-ledger-while-asleep still
   recovers via 1/1 defaults.
4. Headless `init` re-run over hand-edited files fails with
   `MODIFIED_TREE`; unmodified re-run regenerates silently;
   interactive re-run names modified files.
5. `eject → add` renders a headerless addon file with an ejected
   warning; no mixed provenance.
6. Fresh-stack `rollback` names the current revision and the next
   action; exit codes and telemetry codes unchanged.
7. Static `sleep`/`wake` keep exit 0 with documented `skipped`
   reasons (exit 2 under `--strict`); `add queue:sqs × 2` still
   needs `--force` while explicit-value upserts (bedrock/redis/ses)
   do not.
8. `deploy` behaves identically to `apply` and appears in help.
9. All §5 refactors land with unit tests; no behavior change beyond
   what §4 specifies.
10. `add db:postgres|mysql|aurora-postgresql` on ECS and Lambda
    projects produces an apply-ready tree (`database.tf` + wiring);
    static is refused; re-runs are guarded. The roadmap sequence can
    use `add db:postgres` again.
11. F12's protocol is executed and its decision + evidence recorded;
    the §R10 lockfile exists if and only if the protocol reproduced
    damage.
