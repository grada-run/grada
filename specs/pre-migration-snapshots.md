# Specification: Automated Pre-Migration Snapshots

## 1. Context & Problem
Currently, the pre-deploy migration gate (`grada db migrate --setup-ci`) executes schema changes against the live database during the GitHub Actions deployment pipeline. If a migration contains a destructive or corrupting data operation, the user has no automatic rollback point. Taking a snapshot before executing schema changes is a critical AWS best practice. Grada already has a functional `grada db backup` command; it needs to be injected into the CI pipeline immediately preceding the migration gate.

## 2. Scope of Work
Update the `.github/workflows/deploy.yml` generator to automatically include a pre-migration snapshot step whenever the migration gate is enabled.

## 3. Implementation Details
1. **Template Injection (`deploy.yml`)**:
   - Locate the logic that injects the `grada db migrate` step when `--setup-ci-migrate` is active.
   - Insert a new step immediately *before* the schema migration step.
   - **Step Name:** `Take pre-migration database snapshot`
   - **Command:** `npx grada db backup --id pre-deploy-${{ github.sha }} --headless` (or `--yes`, matching the existing CI override flags so it bypasses any interactive prompts).
   - This step must only run if a database addon (`needsDatabase` / `db:postgres` / etc.) is present in the project.

2. **Snapshot ID Format**:
   - Use the Git commit SHA (`${{ github.sha }}`) or a shortened version of it to uniquely identify the snapshot (e.g., `pre-deploy-a1b2c3d`). This allows developers to easily map a snapshot back to the exact commit that triggered it.

3. **Error Handling**:
   - If the snapshot fails (e.g., due to AWS limits on manual snapshots or RDS state), the CI pipeline MUST fail and halt the deployment, preventing the subsequent `db migrate` step from running.

4. **UX & Telemetry**:
   - When Grada generates the CI workflows and outputs its completion summary, explicitly mention the backup step. 
   - *Example string:* `"Wired pre-deploy migration gate (with automated pre-migration RDS snapshots)."`

## 4. Acceptance Criteria
- `npm test` passes.
- Running `init --headless --needsDatabase --setup-ci-migrate` outputs a `deploy.yml` containing the new `grada db backup` step immediately preceding the `grada db migrate` step.
- The generated YAML uses valid GitHub Actions syntax for the `${{ github.sha }}` variable.
- Running the generated CI pipeline on AWS successfully creates the RDS snapshot and proceeds to the migration.