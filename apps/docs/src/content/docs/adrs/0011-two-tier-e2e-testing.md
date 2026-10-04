---
title: "Two-Tier End-to-End Testing"
description: "Mock-AWS Tier 0 on every PR plus a live-AWS Tier 1 lifecycle on a nightly schedule."
---

* **Status:** Accepted
* **Date:** 2026-10-01 (Retroactive)

## Context and Problem Statement

Unit tests prove the CLI generates the *correct files*, but only real executions prove the generated stack works: the CLI must run end to end, Terraform must validate, and the full `init → apply → status → destroy` lifecycle must succeed against AWS. Running the live lifecycle on every PR would be slow (6+ minute status polls), expensive (real Fargate/RDS time), and flaky (eventual consistency), while running *no* E2E would let scaffold regressions reach users.

We needed fast per-PR signal plus real-AWS proof, without coupling the two.

## Decision Drivers

* **PR velocity:** Every-pull-request checks must finish in minutes with zero AWS spend.
* **Lifecycle proof:** Some suite must exercise the true Day-0-to-Day-2 path against real infrastructure.
* **Determinism:** Suites must skip gracefully — never fail — when their prerequisites (credentials, binaries) are absent.

## Considered Options

1. **Live-only E2E on every PR.** (Rejected: too slow, too costly, too flaky for a merge gate.)
2. **Mock-only E2E.** (Rejected: Terraform `validate` and CLI exit codes never prove a container boots behind the ALB.)
3. **Two tiers.** Tier 0 (`npm run test:e2e:tier0`, every PR) runs the real `bin/cli.js` with `CI_MOCK_AWS=true`: ECS/Lambda/static scaffolds (plus the static framework-mismatch rejection), the 7-capability `add` matrix, `terraform validate`, `doctor`/`eject`, and failure-path contracts. Tier 1 (nightly/manual) runs the live lifecycle against real AWS via `AWS_ACCESS_KEY_ID` credentials, seeding a minimal Express fixture so the deployed container boots, and dumping `logs` + `diagnose` on status timeouts for CI visibility.

## Decision Outcome

**Chosen Option:** Two-tier testing. Tier 0 gates merges; Tier 1 guards releases.

### Positive Consequences
* PRs get black-box CLI coverage in minutes with no cloud bill.
* The nightly live run catches drift between generated IaC and real AWS behavior (e.g. container boot contracts, ECR seeding gaps).
* Both tiers skip loudly-but-cleanly without their prerequisites, so forks and local runs stay green.

### Negative Consequences
* Two harnesses to maintain (`tests/e2e/tier0.e2e.test.js`, `tests/e2e/tier1.live.e2e.test.js`) plus dedicated Vitest configs.
* Tier 1 failures arrive the morning after merge, not at review time — a nightly red run must still block the release train by policy, not by tooling.
