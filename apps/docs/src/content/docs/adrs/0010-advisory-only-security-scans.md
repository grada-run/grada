---
title: "Advisory-Only Security Scans in the Pipeline"
description: "Trivy scans report vulnerabilities without blocking builds or deploys."
---

* **Status:** Accepted — complemented by [ADR-0017](/grada/adrs/0017-blocking-iac-config-scans-own-ci/), which gates grada's own repo CI on config findings while this ADR keeps generated user pipelines advisory-only.
* **Date:** 2026-09-24 (Retroactive)

## Context and Problem Statement

The generated pipeline scans both Terraform (`CRITICAL,HIGH`) and the built container image on every deploy. Failing the build on findings would enforce security posture — but base-image and transitive-dependency findings routinely arrive faster than fixes, which would turn the deployment pipeline into a lottery where routine pushes fail for reasons outside the user's code.

We needed scans to inform without holding deploys hostage.

## Decision Drivers

* **Deploy velocity:** A routine push must not fail because an upstream base image published a CVE overnight.
* **Visibility:** Findings must still land where the team looks, on every run, not rot in a dashboard nobody opens.
* **Reversibility:** The day the signal is clean enough to gate on, flipping the default must be a one-line change.

## Considered Options

1. **Blocking scans (`exit-code: 1`).** (Rejected: couples deploy success to upstream vulnerability disclosure timing; guarantees false-positive outages.)
2. **No scans.** (Rejected: surrenders the IaC and image visibility the pipeline is well placed to provide.)
3. **Advisory scans (`exit-code: 0`).** Trivy runs on every deploy for both IaC and image; results land in the GitHub step summary; the build proceeds regardless.

## Decision Outcome

**Chosen Option:** Advisory-only scans. Every finding is reported in the step summary; none blocks the rollout.

### Positive Consequences
* Deploys never fail for third-party CVEs; security signal accumulates without operational pain.
* Teams adopt the pipeline without fearing day-one red builds from pre-existing findings.

### Negative Consequences
* Genuinely critical misconfigurations ship unless a human reads the summary — the signal only works if someone looks.
* Without a ratchet (e.g. fail only on *new* findings), vulnerability debt can grow silently.
