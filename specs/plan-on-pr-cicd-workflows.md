# Specification: Plan-on-PR CI/CD Workflows

## 1. Context & Problem
Currently, Grada provides ephemeral PR environments (`preview.yml`), automated deployments (`deploy.yml`), and daily drift detection (`drift.yml`). However, reviewers have no visibility into proposed infrastructure changes until after the code is merged. 

A foundational requirement for team-based Infrastructure as Code (IaC) is the "Plan-on-PR" pattern: automatically running `terraform plan` and posting the proposed changes as a comment directly on the Pull Request. 

## 2. Scope of Work
Introduce a new generated GitHub Actions workflow (`.github/workflows/plan.yml`). Update the CLI's `init` command to output this file via a new flag (`--setup-ci-plan`). The pipeline must trigger on pull requests, authenticate via AWS OIDC, run `terraform plan`, and post a sticky, diff-highlighted comment to the PR.

## 3. Implementation Details

1. **Trigger & Generation**:
   - Introduce `--setup-ci-plan` to `init`. 
   - Interactive prompt defaults to `true` (asymmetric to drift's opt-in `false` default). Headless requires the flag explicitly.
   - **Q4 Fix (Paths Filter):** Apply a `paths: ['terraform/**']` filter to the trigger so docs-only PRs skip the plan. (The `grada.yml` reference in v1 was a mistake and is dropped).
   - **R1 (Template Tracking):** Add `plan.yml` to the three lists in `src/utils/backup.js` (manifest, backup, restore) alongside `preview.yml`, `teardown.yml`, and `drift.yml`.
   - **R2 (Shared Scaffolding):** Extract the render-and-write core from `scaffoldDriftWorkflow` into a shared utility, and use it for both `drift` and `plan`.

2. **Security & Trigger Logic (Q1)**:
   - **Trigger:** `on: pull_request_target` (NOT `pull_request`). This prevents attacker-controlled fork PRs from modifying `plan.yml` and executing untrusted code with the deploy role.
   - **Same-Repo Guard:** Implement the exact guard used in `preview.yml` (`github.event.pull_request.head.repo.full_name == github.repository`), skipping fork PRs with a loud notice.
   - **Checkout PIN:** The checkout action must explicitly pin the PR head SHA to avoid the silent bug of planning against the base branch.
   - **Concurrency:** Use the per-PR concurrency group from `preview.yml` so rapid pushes cancel superseded plans instead of piling onto the Terraform state lock.

3. **Authentication & Exit Semantics (Q2)**:
   - **Permissions:** `id-token: write`, `contents: read`, `pull-requests: write`.
   - **Role-to-Assume:** Include the `YOUR_AWS_ACCOUNT_ID` placeholder (patched automatically by `apply`).
   - **Fail Closed:** Mirror `deploy.yml`'s credential handling. If OIDC fails, the job MUST exit 1 (fail loud). Skip-loud is dangerous for merge signals.

4. **Terraform Execution & Capture (Q3 & Q6)**:
   - Require `terraform_wrapper: false`.
   - Execute `terraform init -input=false`.
   - Execute `terraform plan -input=false -lock-timeout=5m -detailed-exitcode -out=tfplan`, then convert it via `terraform show -no-color tfplan > plan.txt`.
   - **Exit Semantics:** Post/refresh the sticky comment on *all three* exit codes (0/1/2) so stale comments are properly overwritten when changes drop to 0. Fail the GitHub Action job *only* on exit 1 (error). Apply drift's 30k truncation to the text block.

5. **Sticky PR Comment Logic**:
   - Use `actions/github-script` with a unique HTML comment marker (e.g., `<!-- grada-plan -->`).
   - Wrap the summary in bold, hide the full plan inside `<details><summary>Show Plan</summary>`, and wrap the text in a ````diff` code block.

6. **Documentation**:
   - Check off the "Plan-on-PR" item in the roadmap.

## 4. Acceptance Criteria
- `npm test` passes.
- **R3 (Tests):** `tests/github-workflows.test.js` covers `plan.yml` automatically, but add specific assertions for: the same-repo guard, `pull-requests: write`, the sticky marker, and the concurrency group.
- Running `init --headless --setup-ci-plan` outputs a valid `.github/workflows/plan.yml`.