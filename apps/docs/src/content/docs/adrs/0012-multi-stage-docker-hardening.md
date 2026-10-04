---
title: "Multi-Stage Dockerfile Hardening"
description: "All generated images build in an isolated stage and ship a minimal Alpine runner with no package managers."
---

* **Status:** Accepted
* **Date:** 2026-10-02 (Retroactive)

## Context and Problem Statement

Generated Dockerfiles are user-shipped production images. Single-stage builds carried compilers, `pip`/`npm`, and stale base-image packages into the running container — a wide CVE surface (including a pcre2 finding in the static Nginx image) that Trivy flagged on every deploy. Shrinking that surface had to preserve debuggability: teams rely on shell access via ECS Exec, and every framework's boot contract (entrypoint, port binding, health checks) had to keep working.

## Decision Drivers

* **Minimal attack surface:** The final image should contain the app and its runtime — nothing that installs software.
* **Operability:** Keep a shell for ECS Exec; keep every framework booting identically.
* **Enforceability:** Hardening properties must be pinned by tests, not just by code review of template text.

## Considered Options

1. **Distroless runners.** (Rejected: no shell breaks the ECS Exec debugging story the CLI promises.)
2. **Single-stage with cleanup (`apk del`, `pip uninstall`).** (Rejected: cleanup layers still ship deleted-file bloat, and ordering is fragile — the Node/Python/Django templates proved single-stage could not stay minimal.)
3. **Multi-stage Alpine builds.** Dependencies compile in a `builder` stage; a `runner` stage copies only production artifacts (Python/Django via a `pip`-less venv, Node via production `node_modules`), then removes every package manager. All ten presets — including the previously single-stage Node, Python, and Django images — follow this shape, and `tests/dockerfile-hardening.test.js` pins the properties (≥2 stages, named `runner`, non-root final user, no installs past the last `FROM`).

## Decision Outcome

**Chosen Option:** Multi-stage Alpine builds across all presets, with one deliberate behavior change: generic Node.js images now run `node index.js` directly instead of `npm start` (there is no `npm` left in the runner) — any other start command goes in a `Procfile` `web:` line.

### Positive Consequences
* Near-zero Critical/High CVE footprint by construction; OS patches (`apk upgrade`) apply at build time, though coverage varies by preset (the Go images carry no upgrade layer).
* Structural tests fail the build if any template edit reintroduces installs or root into the runner.

### Negative Consequences
* The Node entrypoint change is mildly breaking for projects without `index.js` at the root (mitigated by the `Procfile` escape hatch and a rewritten setup warning).
* Two-stage builds are marginally slower in CI than single-stage (offset by smaller push/pull layers).
