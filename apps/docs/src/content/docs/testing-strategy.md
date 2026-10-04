---
title: Testing Strategy
description: How grada prevents regressions — unit tests, snapshot harness, API mocking, and CI validation.
---

To ensure zero regressions in infrastructure generation and safe local execution, `grada` relies on a multi-layered testing strategy split between fast local snapshots and rigid CI/CD validation.

## 1. Unit & argument testing
We use pure Node.js unit tests (via Vitest) to validate the CLI argument parser (`src/core/parser.js`). This ensures that flags (like `--headless` or `--no-telemetry`) are routed correctly and never hijack positional arguments like file paths.

## 1.5. Ecosystem integration contracts
Because `grada` acts as the underlying engine for ecosystem wrappers (e.g., `nest-grada`, `cookiecutter-fastapi`), we strictly test execution flags that bypass interactive prompts (written contract: `specs/integration-suite.md`, enforced by `tests/headless.test.js`):
* **Headless Validation:** Vitest deep-mocks `@clack/prompts` — the only interactive prompt library the CLI uses — and asserts that when `--headless` and `--preconfigured` are passed (e.g., `--framework=nestjs --port=3000`), none of its prompt functions (`text`, `select`, `multiselect`, `confirm`, `group`) ever fire and no interactive warnings are thrown. The suite also asserts flag values win over interactive defaults in the generated `terraform/main.tf` and `Dockerfile`, running end to end inside a temp directory so no files pollute the repo. This guarantees stability for automated ecosystem integrations.

## 2. Infrastructure snapshot harness (the static contract)
Because `grada` generates highly dynamic Terraform (`.tf`), GitHub Actions (`.yml`), and `Dockerfile` configurations, we use **Vitest Snapshots** to lock in the expected text outputs.
* **The Matrix:** The test suite generates dummy projects across 11 architectural topologies (including Django, Rails, Go, Nuxt, Next.js, SvelteKit, and Vercel/Heroku migrations).
* **Negative Testing:** The suite explicitly checks for the *absence* of files (e.g., ensuring `database.tf` or `worker.tf` are not generated for static sites).
* **Updating Snapshots:** If a template change is intentional, developers must run `npm run test:update` to overwrite the baseline `__snapshots__`.

## 3. External API mocking
To ensure tests run sub-second and deterministically without requiring real AWS credentials, we intercept network boundaries. Shared mock factories live in `tests/helpers/` (`clack.js` for `@clack/prompts`, `telemetry.js` for PostHog tracking, `console.js` for process/console spies, `tmpdir.js` for fixture directories) so new suites reuse one-liner `vi.mock` delegations instead of hand-rolling mocks:
* **AWS Secrets Manager:** `tests/secrets.test.js` uses Vitest's `vi.hoisted()` and `vi.mock()` to intercept `@aws-sdk/client-secrets-manager` (plus an injected ECS client for the restart path). This verifies push/pull/audit payload handling, key-change detection, and network exceptions (like `ResourceNotFoundException`) completely offline.
* **ECS & CloudWatch Logs:** `tests/diagnose.test.js` injects mock ECS/CloudWatch clients to verify failure analysis (stopped reasons, exit codes, log extraction) and behavior contracts — e.g., expired sessions (`UnrecognizedClientException`) exit gracefully with code 1, and unrecognized `secrets push` filenames fall back to `.env` with a warning.
* **Telemetry:** PostHog tracking is mocked to prevent test executions from polluting production analytics.

## 4. Continuous integration & execution validation (CI)
While Vitest proves the CLI generates the *correct* files, GitHub Actions proves those files *actually work*. Unit and snapshot tests are gated via `.github/workflows/test.yml`; live template compilation is gated via `.github/workflows/iac-validation.yml`.
* **Phase 1 (Generation):** Vitest runs unit and snapshot tests to verify the CLI contract.
* **Phase 2 (Static Application Security Testing - SAST):** CI runs a pinned Trivy filesystem scan (`aquasecurity/trivy-action` by SHA) against each generated project directory, writing advisory `trivy-fs-results.txt` reports (`HIGH,CRITICAL`, `exit-code: 0`) instead of failing the build.
* **Phase 3 (IaC Validation):** The `iac-validation` matrix workflow scaffolds all 10 supported frameworks headlessly (`--headless --preconfigured`), then runs `terraform init -backend=false` + `terraform validate`, `tflint`, the advisory filesystem scan, a stripped-Dockerfile `docker build`, and an advisory container-image scan (`trivy-image-results.txt`).
* **Phase 4 (Release gate):** `.github/workflows/publish.yml` reuses `iac-validation.yml` via `workflow_call` as a `validate` job; `build-and-publish` has `needs: [validate]`, so NPM publishing on release is blocked until the full matrix passes.

## 5. End-to-end lifecycle testing
Black-box suites under `tests/e2e/` execute the real `bin/cli.js` via `child_process` with stdin closed (a prompt crashes loudly instead of hanging) and `DO_NOT_TRACK=1`. They are excluded from the default `npm test` run and have dedicated configs:
* **Tier 0 (`npm run test:e2e:tier0`, every PR):** mock-AWS scaffold checks with `CI_MOCK_AWS=true` (`init` for ECS, Lambda, and static targets — including the static framework-mismatch rejection — the full 7-capability `add` matrix plus an `init --with` composition, `terraform validate`), local checks (`doctor`, `eject`), and failure-path contracts (clean exit-1 shapes, no stack traces, headless exit-code restoration). Runs in `.github/workflows/e2e.yml` alongside Tier 1.
* **Tier 1 (`npm run test:e2e:tier1`, nightly/manual only):** the full live lifecycle (`init` → `apply --auto-approve` → `status` with a retry-until-healthy loop → `destroy --yes`) against real AWS. Credentials come from `configure-aws-credentials` (backed by `AWS_ACCESS_KEY_ID` secrets in CI); without them the suite skips gracefully.
