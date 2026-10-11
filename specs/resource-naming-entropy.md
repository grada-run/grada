# Resource Naming Hardening: Entropy Suffix (Item 3) + Bucket Adoption Warnings (Item 4)

Status: **draft for review** — no implementation. Follow-up to the items 1/2/5
fixes (broadened collision classifier, `--framework` fail-fast, unified
bucket-name sanitization).

## Problem

- All Grada resource names derive deterministically from the sanitized project
  name (`${app}-db`, `${app}-repo`, `${app}-secrets`, IAM roles, …). Two
  *different* projects sharing a tutorial-style name (`myapp`) in one AWS
  account collide on every singleton and — worse — silently share one state
  bucket + key (`<name>-tfstate-<account>` / `state/terraform.tfstate`),
  fighting over each other's infrastructure with no warning.
- `init` never checks whether the state bucket already holds a state key, so
  adopting (or hijacking) a previous life is silent in both directions.

## Goals / non-goals

- Goals: same-account same-name projects stop colliding; adopting existing
  state becomes an explicit user choice.
- Non-goals: same-*tree* retries (a retried apply shares the tree's suffix by
  design — the VPN-partition class stays served by the Item-1 import runbook);
  renaming anything in already-provisioned projects (RDS identifier changes
  force destroy/recreate).

## Item 3 — Init-time entropy suffix

- At `init`, mint one short random suffix per project (proposal: 6 lowercase
  hex, e.g. `-a1b2c3`) and bake it into the names of account/region-global
  singletons: RDS instance identifier + Aurora cluster/instance identifiers,
  state bucket, ECR repo, Secrets Manager secret, IAM roles/policies, log
  groups, Lambda function/API names, EventBridge schedule names. Tags,
  descriptions, and workspace-suffixed display names stay human-readable.
- Persist the suffix in **committed** Terraform (proposal: a
  `grada_resource_suffix` local rendered into `terraform/locals.tf` or the
  existing locals block) — never only in gitignored `.grada/`, or fresh
  clones re-mint and diverge.
- Stickiness (hard requirement): re-`init` over an existing tree (target
  pivots, flag changes — the rerun-init flow regenerates from scratch) must
  parse and **reuse** the rendered suffix, minting only when absent. Minting
  twice for one project renames the RDS identifier and destroys the database.
- Backward compatibility: trees without a suffix render byte-identical names
  (suffix defaults to empty when the local is absent), so existing projects
  see zero drift on re-`init` or `apply`. Suffix applies to new projects only;
  no migration path renames live resources.
- Deterministic suffixes (hash of name/account/region) are explicitly rejected:
  they fix cross-account collisions but not same-account same-name recreation,
  which is the reported case. Random + persisted is the only shape that works.
- Required refactors alongside:
  - `recreateStateBucket` must read the bucket from `backend.tf` instead of
    re-deriving it via `provisionStateBucket` — a suffixed bucket breaks any
    site that recomputes `<name>-tfstate-<account>` (Item 5 unified the
    *formula*; this removes the last *recomputation*). Already verified
    read-based (no change needed): destroy, gc, and doctor all resolve the
    bucket through `parseStateBucketBackend`.
  - ALB names are `substr(..., 0, 32)`-truncated: the suffix eats 7 of 32
    chars; confirm truncation still leaves uniqueness (it does — suffix is
    the tail... unless truncation cuts it off; order the suffix before the
    cut or exempt ALB names and document why).
  - `terraform fmt`/snapshot churn: template edits re-render every golden
    file; follow the established pairing-check-before-`-u` discipline.
- Telemetry: stamp `resource_suffix_present: true|false` (never the suffix
  value) on `project_provisioned` so adoption is measurable.
- Tests-first: unit (mint-once format, reuse-when-present, empty-default),
  rerun-init stickiness (pivot target twice, suffix stable, names unchanged),
  golden-file regeneration for one suffixed tree, backend-read (not recompute)
  pins for recovery/destroy/gc/doctor.

## Item 4 — Bucket adoption warnings

- During `init`, after provisioning/opening the state bucket: `HeadObject`
  (or equivalent) on `state/terraform.tfstate`. If a key exists and the local
  tree is fresh (no `terraform/` or no prior manifest):
  - Interactive: warn that state already exists for this project name
    (previous life? another project?) with choices: adopt (continue),
    rename (abort with guidance), wipe (explicit, fenced like
    `--allow-data-loss` — never default).
  - Headless: fail closed with a named code (proposal:
    `STATE_ALREADY_EXISTS` / `state-already-exists`) plus an explicit-flag
    hatch (proposal: `--adopt-state`); never silently share.
- Telemetry: `state_adoption_prompted` / `state_adoption_accepted` with
  stable IDs only (no key contents, no bucket listing).
- Edge cases to pin: versioned bucket with only delete-markers (treat as
  empty?); same-name different-region (bucket has no region component — the
  warning must fire, since the key is shared); `BucketAlreadyOwnedByYou`
  racing two inits (second sees empty key, proceeds — acceptable, Terraform
  locking serializes applies afterward).
- Tests-first: mocked-S3 matrix (key present/absent, fresh/existing tree,
  interactive/headless, adopt/rename/wipe paths), headless exit-code pins.

## Open questions for review

- Suffix length/charset: 6 hex keeps names readable; 8+ buys collision
  margin nobody needs at this scale. Confirm 6.
- Should the suffix also cover the S3 *storage* addon bucket and
  ElastiCache group (already `md5`-suffixed)? Proposal: yes for S3 (same
  global-namespace class), leave ElastiCache (deterministic hash already
  disambiguates truncation; random suffix adds churn, not safety).
- `gc --deep` and `doctor` match resources by `GradaProject` tag, not name —
  confirm no name-prefix discovery breaks under suffixed names (audit pass).
- Ejected trees: suffix lives in user-owned HCL after eject — document as
  immutable-by-convention (changing it replaces singletons).

## Post-implementation resolutions

- 6-char hex confirmed; S3 storage addon suffixed, ElastiCache untouched.
- ALB/target-group 32-char truncation: the suffix rides inside `app_name`,
  so it survives intact for project names up to 25 characters. Two
  same-account projects sharing a longer prefix can still collide on the
  ALB name — Terraform then fails loud with the Item-1 import runbook,
  never silent sharing. Reordering the suffix before the cut was
  rejected: any formula change drifts existing long-name projects, and
  the drift-safe conditional form doubles the CLI-mirror complexity
  (`resolveAlbName`, target group, every future truncated name) for no
  realistic gain. Same boundary covers the S3 storage addon (42 chars).
- `gc`/`doctor` audit: doctor does no name matching (backend-read bucket,
  locks, freshness, manifest); gc deletions are exact-tag (EIPs, VPCs) or
  exact-name (lambda log-group exclusion reads the rendered suffix);
  remaining prefix matches (ECR repos, report-only secrets) are
  discovery-broad and match suffixed names by construction.
- Ejected trees: suffix is a committed local, immutable by convention
  (re-run guide); changing it replaces singletons.
