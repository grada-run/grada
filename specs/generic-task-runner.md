# Specification: Generic One-Off Task Runner (`grada run`)

## 1. Context & Problem
Developers frequently need to run ad-hoc commands securely inside their production environment—such as data backfills, database seeders, administrative scripts (e.g., `rails console`, `python manage.py`), or cache clearing. 

Instead of forcing users to deploy bastion hosts or `exec` into running web containers (which violates immutable infrastructure principles), Grada needs a generic task runner. The core orchestration (`RunTask`, polling, log-streaming, SIGINT lifecycle) already exists in `src/utils/ecs-runner.js`. This spec introduces `grada run` as the third consumer of that utility, sitting alongside `db migrate` and `db enable-vector`.

## 2. Scope of Work
Introduce a new top-level CLI command: `grada run --cmd "<command>"`. 
This command will provision an ephemeral ECS Fargate task using the currently deployed application image and environment variables, synthesize database URLs, execute the specified command, stream live CloudWatch logs, and propagate the final exit code.

## 3. Implementation Details

1. **Command Interface & Flag Surface**:
   - Primary Signature: `grada run --cmd "<command>"`
   - Maintain sibling parity with `db migrate` by supporting its full flag surface: `--headless`, `--timeout`, `--workspace`, `--project-name`, `--task-def`, `--cluster`, `--service`, `--container`, and `--region`.
   - `--workspace` must be supported so developers can explicitly target preview environments, but it defaults to the current stack (it does not block execution if omitted).
   - If invoked interactively without `--cmd`, prompt the user. 
   - If invoked `headless` without `--cmd`, it MUST fail closed with a named missing-command error (since generic commands cannot be auto-detected like migrations).

2. **Execution Logic & Refactoring**:
   - Consume `runEphemeralEcsTask` from `src/utils/ecs-runner.js`. 
   - **R1 (DB Env Synthesis):** Move the synthesis logic to `ecs-runner.js` and rename it to `buildRunnerCommand` (leaving a re-export alias in its old location to avoid breaking `migrate.js` abruptly). Consume this to synthesize `DATABASE_URL` (and `PGSSLMODE`) for the run command. This gracefully supports database seeders/backfills while remaining harmless if no DB variables exist.
   - **R2 (Orchestration Extraction - Scoped):** Extract the shared preamble (timeout parsing, stripped-runner guard parameterized by event/telemetry) and the shared postamble (outcome mapping via `reportRunnerOutcome`) into `ecs-runner.js`. *Keep command resolution isolated* in `run.js` and `migrate.js` respectively, as migration auto-detection logic does not apply to generic runs.
   - **R3 (UX Polish):** Pass `taskNoun: 'one-off'` to the runner to avoid stuttering prints like "Starting task task".

3. **Security & Stripped Runner Guardrails**:
   - Apply the logic extracted in R2 (`isNpmShimCommand` + `dockerfileStripsNpmShims` + `ormMappedHintSegment`).
   - If a stripped command is detected, fail-closed on `--headless` (`NPM_CMD_STRIPPED_RUNNER`) and issue a loud warning on interactive runs.

4. **Target Guardrails**:
   - Enforce `guardComputeTarget({ supported: ['ecs'] })`.
   - Add a specific hint for `--target lambda` (by branching on `targetGuard.actual`) explaining that remote ephemeral execution is not yet supported for Lambda targets.

5. **Log Streaming & Exit Codes**:
   - Rely on `runEphemeralEcsTask` for CloudWatch streaming.
   - Map terminal outcomes via `failCommand({ exitCode: propagated })` to ensure CI/CD failures bubble up correctly.

6. **Documentation & Disambiguation (R4)**:
   - Create `cli/run.md` and add the `HELP_TEXT` branch.
   - Explicitly disambiguate `run` vs `exec` in the docs: `exec` (`--command`) uses SSM to drop into an *already running* immutable container, while `run` (`--cmd`) spins up a clean, ephemeral ECS task specifically for the job.
   - Update `headless.md` to list `run` in the `NPM_CMD_STRIPPED_RUNNER` section.
   - Check off the "Generic One-Off Task Runner" item in the roadmap. (Note: No `--setup-ci` deploy-gate story applies to `run`).

## 4. Acceptance Criteria
- `npm test` passes (specifically `tests/ecs-runner.test.js`, `tests/target-matrix.test.js`, and `migrate.js` tests remain green post-refactoring R1/R2).
- Target matrix enforcement: running `grada run` on a `lambda` or `static` project fails cleanly with the target error and Lambda hint.
- Headless invocation without `--cmd` fails cleanly with a named missing-command error.
- Successfully running a command returns the correct exit code (`0`).
- Running a command that crashes (e.g., `grada run --cmd "exit 1"`) correctly exits the local CLI with a non-zero status code (`1`).