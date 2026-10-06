---
title: "Blocking IaC Config Scans in Grada's Own CI"
description: "Fail our repo pipeline on HIGH/CRITICAL Terraform misconfigurations while container image scans stay advisory."
---

* **Status:** Accepted
* **Date:** 2026-10-05

## Context and Problem Statement

ADR-0010 made security scans advisory-only in the *generated* deploy pipeline: a user's build must never fail because an upstream base image published a CVE overnight. That decision says nothing about grada's own repository CI — where the scanned artifact is not a user's app but our first-party IaC templates — and until now our own scans inherited the same advisory posture almost by accident: `exit-code: 0` everywhere, with findings visible only to whoever opened the step summary.

Meanwhile the template surface grew teeth: three compute targets, a dozen add-ons, and a suppression scheme (`trivy:ignore`) whose whole point is that every remaining HIGH/CRITICAL finding is either a bug or an undocumented trade-off. Advisory scanning cannot enforce that invariant — only a gate can.

We needed our CI to fail fast on template regressions without reintroducing the upstream-CVE lottery ADR-0010 rejected for users.

## Decision Drivers

* **Determinism:** A gate must fail only on findings the repo controls. Template misconfigurations are deterministic; base-image CVEs are not.
* **Scope separation:** Grada's CI policy and generated user pipelines must evolve independently — tightening ours must never tighten a user's deploy.
* **Shift-left parity:** Whatever blocks CI must be runnable locally before push (`npm run test:iac`).

## Considered Options

1. **All scans blocking (config + image).** (Rejected: image findings inherit upstream disclosure timing — the exact lottery ADR-0010 describes — and would red-noise our CI for third-party CVEs.)
2. **All scans advisory (status quo).** (Rejected: leaves the template/suppression invariant unenforced; a dropped `USER` directive or a new un-ignored misconfiguration merges silently.)
3. **Split: blocking config scans, advisory image scans.** `trivy config --exit-code 1 --severity HIGH,CRITICAL` gates every PR; image scans keep reporting without gating.

## Decision Outcome

**Chosen Option:** The split. Our repo CI renders all three targets headless (bare `npx grada-run --target ecs --headless`, `--target lambda --headless`, and `--target static --headless`) and runs blocking `trivy config` scans against the *rendered* output — never the raw `templates/` tree, whose `{{TEMPLATE_VARS}}` are not valid HCL. The same commands run locally via `scripts/test-iac.js` (Docker-backed; it warns and exits 0 where Docker is absent). Container image scans stay `exit-code: 0`, and generated user pipelines are untouched — ADR-0010 still governs them.

### Positive Consequences

* Template regressions (new misconfigurations, lost suppressions, root containers) fail the PR deterministically instead of rotting in a summary nobody opens.
* The `trivy:ignore` comments become load-bearing documentation: each accepted trade-off is named at the finding site, and anything un-ignored blocks.
* Local/CI parity: authors reproduce the gate with one npm script before pushing.

### Negative Consequences

* Two scan policies to explain (blocking config vs advisory image); contributors must learn which failure mode they are looking at.
* The docker-run steps float on `aquasec/trivy:latest`, so a new upstream check can turn CI red with no repo change — pin the tag if that ever bites.
* ADR-0010's scope note now carries real weight: any future change to generated-pipeline scanning must re-read both ADRs together.
