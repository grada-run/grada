import { ECSClient } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import color from 'picocolors';
import { intro, outro, spinner, text, isCancel } from '@clack/prompts';
import { trackEvent, trackSuccess, setActiveCommandName, resetActiveCommandName, getCliVersion } from '../../core/telemetry.js';
import { failCommand, failAwsError, trackAwsFailure, failProjectNotInitialized, refuseUnknownFlags } from '../../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../../utils/args.js';
import { isAuthError, handleAuthErrorBranch, resolveClient } from '../../utils/aws.js';
import {
    resolveRegion,
    resolveProjectName,
    resolveCluster,
    resolveService,
    resolveLogGroup,
    resolveAppName,
    resolveHeadless,
    resolveCwd,
    readFileSafe,
    readTerraformComputeTarget,
} from '../../utils/resolvers.js';
import { detectMigrationCommand, isNpmShimCommand, dockerfileStripsNpmShims } from '../../utils/detector.js';
import { resolveContainer } from '../../utils/ecs.js';
import { runEphemeralEcsTask } from '../../utils/ecs-runner.js';
import { parseTimeoutSeconds } from '../../utils/system.js';
import fsSync from 'fs';
import path from 'path';

export const DEFAULT_MIGRATE_TIMEOUT_SECONDS = 600;
export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_FLUSH_MAX_POLLS = 6;
export const DEFAULT_FLUSH_INTERVAL_MS = 1000;

export const GATE_START_MARKER = '# grada:db-migrate-start';
export const GATE_END_MARKER = '# grada:db-migrate-end';
export const LEGACY_GATE_START_MARKER = '# deploy-stack:db-migrate-start';
export const LEGACY_GATE_END_MARKER = '# deploy-stack:db-migrate-end';

// Locates a previously injected gate block in either brand variant so
// re-runs refresh (and migrate) legacy blocks instead of duplicating
// them. Returns `{ startIdx, endIdx }` or null. Pure and unit-tested.
export function findGateBlock(workflowContent) {
    const base = String(workflowContent ?? '');
    const starts = [GATE_START_MARKER, LEGACY_GATE_START_MARKER]
        .map((marker) => base.indexOf(marker))
        .filter((idx) => idx !== -1)
        .sort((a, b) => a - b);
    for (const startIdx of starts) {
        const ends = [GATE_END_MARKER, LEGACY_GATE_END_MARKER]
            .map((marker) => base.indexOf(marker, startIdx))
            .filter((endIdx) => endIdx !== -1 && endIdx > startIdx)
            .sort((a, b) => a - b);
        if (ends.length > 0) return { startIdx, endIdx: ends[0] };
    }
    return null;
}

export function parseDbMigrateArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'db') args.shift();
    if (args[0] === 'migrate') args.shift();
    const { options, rest, unknown } = parseFlags(args, {
        string: [
            { name: 'cmd', key: 'cmd', greedy: true },
            { name: 'task-def', key: 'taskDef' },
            { name: 'timeout', key: 'timeout' },
            { name: 'project-name', key: 'projectName' },
            { name: 'region', key: 'region' },
            { name: 'workspace', key: 'workspace' },
            { name: 'cluster', key: 'cluster' },
            { name: 'service', key: 'service' },
            { name: 'container', key: 'container' },
        ],
        boolean: ['setup-ci', 'headless'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0) options.unexpectedPositionals = positionals;
    if (unknown.length > 0) options.unknownFlags = unknown;
    return options;
}

// Single-quote a shell argument for embedding in the workflow `run: |` block
// (literal block scalars need no YAML escaping).
export function quoteShellArg(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function renderGateBlock({ includeSetupNode, stepName, runLine }) {
    const lines = [`      ${GATE_START_MARKER}`];
    if (includeSetupNode) {
        lines.push(
            '      - name: Setup Node.js for migrations',
            '        uses: actions/setup-node@v4',
            '        with:',
            "          node-version: '20'",
            ''
        );
    }
    lines.push(
        `      - name: ${stepName}`,
        '        run: |',
        `          ${runLine}`,
        `      ${GATE_END_MARKER}`
    );
    return `${lines.join('\n')}\n`;
}

// Strips any previous gate block first so the setup-node check below
// never matches a node step that only exists inside the old block.
function stripPreviousGateBlock(content) {
    const previous = findGateBlock(content);
    if (!previous) return content;
    const lineStart = content.lastIndexOf('\n', previous.startIdx) + 1;
    const lineEnd = content.indexOf('\n', previous.endIdx);
    return content.slice(0, lineStart) + content.slice(lineEnd === -1 ? content.length : lineEnd + 1);
}

// Builds the CI invocation of this CLI for injected gate blocks: pinned to
// the installing version so pipelines stay reproducible across releases.
// Falls back to the unpinned runner when the version is unknowable
// (source checkouts report 'unknown').
export function buildRunnerInvocation(cliVersion) {
    const ver = typeof cliVersion === 'string' ? cliVersion.trim() : '';
    if (ver === '' || ver === 'unknown') return 'npx --yes grada-run';
    return `npx --yes @grada-run/grada@${ver}`;
}

// Shared injection core: strips any previous gate, renders the block, and
// splices it before the anchor step. Returns null without the anchor.
function injectGateBlock(content, { runLine, stepName, anchor }) {
    const base = stripPreviousGateBlock(String(content ?? ''));
    const includeSetupNode = !base.includes('actions/setup-node');
    const block = renderGateBlock({ includeSetupNode, stepName, runLine });
    const anchorIdx = base.indexOf(anchor);
    if (anchorIdx === -1) return null;
    const insertAt = base.lastIndexOf('\n', anchorIdx) + 1;
    return `${base.slice(0, insertAt)}${block}${base.slice(insertAt)}`;
}

// Idempotently injects (or refreshes) the migration gate block into a
// deploy.yml document. Returns the updated content, or null when neither
// anchor step is present. Pure and unit-tested.
export function injectMigrationGate(workflowContent, { cmd, cliVersion } = {}) {
    const taskDefRef = '${{ steps.register-task-def.outputs.task-arn }}';
    return injectGateBlock(workflowContent, {
        stepName: 'Pre-Deploy Database Migration',
        runLine: `${buildRunnerInvocation(cliVersion)} db migrate --cmd ${quoteShellArg(cmd)} --task-def "${taskDefRef}" --headless`,
        anchor: '- name: Force ECS deployment',
    });
}

// Idempotently injects (or refreshes) the migration gate block into a
// preview.yml document (ECS only — Lambda has no migrate-gate story yet).
// Previews have no register step, so `db migrate` resolves the workspace
// service itself via --workspace. Returns null without the anchor.
export function injectPreviewMigrationGate(workflowContent, { cmd, cliVersion } = {}) {
    return injectGateBlock(workflowContent, {
        stepName: 'Preview Database Migration',
        runLine: `${buildRunnerInvocation(cliVersion)} db migrate --cmd ${quoteShellArg(cmd)} --workspace "\${{ env.WORKSPACE }}" --headless`,
        anchor: '- name: Comment PR',
    });
}

// Builds the container override command for the migration task. When the
// task definition provides discrete `DB_*` credentials but no
// `DATABASE_URL`, the command exports a runtime-synthesized URL (from the
// container's own environment, so secrets never cross the RunTask API
// call) before running the user's migration command. Pure and unit-tested.
export function buildMigrationCommand(resolvedCmd, containerDef) {
    const cmd = String(resolvedCmd ?? '');
    const environment = Array.isArray(containerDef?.environment) ? containerDef.environment : [];
    const secrets = Array.isArray(containerDef?.secrets) ? containerDef.secrets : [];
    const entries = [...environment, ...secrets];
    const names = new Set(entries.map((entry) => entry?.name));
    if (names.has('DATABASE_URL')) return ['sh', '-c', cmd];
    if (!names.has('DB_HOST') || !names.has('DB_USER') || !names.has('DB_PASSWORD')) {
        return ['sh', '-c', cmd];
    }
    const values = new Map(entries.map((entry) => [entry?.name, entry?.value]));
    const scheme = values.get('DB_PORT') === '3306' || values.get('DB_ENGINE') === 'mysql' ? 'mysql' : 'postgresql';
    // RDS/Aurora enforces `rds.force_ssl = 1` by default: require TLS for
    // synthesized postgres URLs so libpq-based migrations never fail on a
    // plaintext connection (MySQL clients ignore PGSSLMODE; leave them alone).
    const tlsPrefix = scheme === 'postgresql' ? 'export PGSSLMODE="${PGSSLMODE:-require}"; ' : '';
    return ['sh', '-c', `${tlsPrefix}export DATABASE_URL="\${DATABASE_URL:-${scheme}://\${DB_USER}:\${DB_PASSWORD}@\${DB_HOST}:\${DB_PORT:-5432}/\${DB_NAME:-postgres}}"; ${cmd}`];
}

// Identity keys for one log line. FilterLogEvents results carry `eventId`
// but GetLogEvents results do not, so every line registers its
// timestamp:message fingerprint (present in both APIs) plus its `eventId`
// when it has one — the final head-flush then never reprints live lines.
function eventKeys(event) {
    const keys = [`${event.timestamp ?? ''}:${event.message ?? ''}`];
    if (event.eventId) keys.push(`id:${event.eventId}`);
    return keys;
}

function printNewEvents(events, seen) {
    if (seen.size > 5000) seen.clear();
    for (const event of events || []) {
        const keys = eventKeys(event);
        if (keys.some((key) => seen.has(key))) continue;
        for (const key of keys) seen.add(key);
        console.log(String(event.message ?? '').replace(/\n$/, ''));
    }
}

// Live tail: FilterLogEvents scoped to the single task stream. `startTime`
// is deliberately omitted — the stream is unique per task run, so there is
// nothing stale to exclude and local clock skew can never drop early lines.
async function fetchNewLogEvents({ logsClient, logGroupName, logStreamName, seen }) {
    let events = [];
    try {
        const resp = await logsClient.send(new FilterLogEventsCommand({
            logGroupName,
            logStreamNames: [logStreamName],
        }));
        events = resp.events || [];
    } catch (error) {
        // The stream does not exist until the container starts emitting.
        if (isNotFoundError(error)) return;
        throw error;
    }
    printNewEvents(events, seen);
}

// Final flush: GetLogEvents reads the exact stream from the head, catching
// anything the live tail missed (Fargate ingestion lags several seconds on
// sub-second commands). Shares the `seen` set so lines print exactly once.
async function flushRemainingLogs({ logsClient, logGroupName, logStreamName, seen }) {
    let nextToken;
    for (;;) {
        let resp;
        try {
            resp = await logsClient.send(new GetLogEventsCommand({
                logGroupName,
                logStreamName,
                startFromHead: true,
                ...(nextToken ? { nextToken } : {}),
            }));
        } catch (error) {
            if (isNotFoundError(error)) return;
            throw error;
        }
        printNewEvents(resp.events, seen);
        const forward = resp.nextForwardToken;
        if (!forward || forward === nextToken) return;
        nextToken = forward;
    }
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runDbMigrate(input = {}) {
    setActiveCommandName('db_migrate');
    try {
        return await runDbMigrateMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runDbMigrateMain(input = {}) {
    const options = normalizeOptions(input);
    const unknownRefusal = await refuseUnknownFlags(options, { command: 'db migrate', event: 'db_migrate_run' });
    if (unknownRefusal) return unknownRefusal;
    let cwd;
    let region;
    let projectName;
    let cluster;
    let service;
    let containerName;
    let logGroupName;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
        const appName = resolveAppName(projectName, options.workspace, cwd);
        const namespacedOptions = { ...options, projectName: appName };
        cluster = resolveCluster(namespacedOptions, cwd);
        service = resolveService(namespacedOptions, cwd);
        containerName = resolveContainer(namespacedOptions, cwd);
        logGroupName = resolveLogGroup(namespacedOptions, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'db_migrate_run' });
    }
    const headless = resolveHeadless(options);

    const setupCi = options.setupCi === true || options.setupCi === 'true';

    intro(color.bgCyan(color.black(' grada db migrate 🚀 ')));

    if (Array.isArray(options.unexpectedPositionals) && options.unexpectedPositionals.length > 0) {
        return failCommand({
            message: `\n✖ Unexpected argument "${options.unexpectedPositionals[0]}". Wrap multi-word --cmd values in quotes: --cmd "${options.unexpectedPositionals.join(' ')}".\n`,
            event: 'db_migrate_run',
            telemetry: { projectName },
            errorCode: 'UNEXPECTED_POSITIONAL_ARGS',
            reason: 'unexpected-positional-args',
            resultExtra: { cluster, service, region },
        });
    }

    const timeoutSeconds = parseTimeoutSeconds(options.timeout, DEFAULT_MIGRATE_TIMEOUT_SECONDS);
    if (timeoutSeconds === null) {
        return failCommand({
            message: `\n✖ Invalid --timeout "${options.timeout}". Use a positive number of seconds (default ${DEFAULT_MIGRATE_TIMEOUT_SECONDS}).\n`,
            event: 'db_migrate_run',
            telemetry: { projectName },
            errorCode: 'INVALID_TIMEOUT',
            reason: 'invalid-timeout',
            resultExtra: { cluster, service, region },
        });
    }

    // 1. Resolve the migration command (shared by live runs and --setup-ci).
    let resolvedCmd = null;
    let cmdSource = null;
    if (typeof options.cmd === 'string' && options.cmd.trim()) {
        resolvedCmd = options.cmd.trim();
        cmdSource = 'explicit';
    } else {
        const detectedCmd = detectMigrationCommand(cwd);
        if (!headless) {
            const answer = await text({
                message: 'Migration command to run inside the VPC:',
                placeholder: 'e.g. npx prisma migrate deploy',
                initialValue: detectedCmd || '',
            });
            if (isCancel(answer) || typeof answer !== 'string' || !answer.trim()) {
                outro(color.yellow('Migration cancelled.'));
                return { ok: false, reason: 'cancelled', cluster, service, region };
            }
            resolvedCmd = answer.trim();
            cmdSource = 'prompted';
        } else if (detectedCmd) {
            resolvedCmd = detectedCmd;
            cmdSource = 'detected';
            console.log(color.dim(`  Using detected migration command: ${resolvedCmd}`));
        } else {
            return failCommand({
                message: '\n✖ No migration command found. Pass --cmd "<command>" (e.g. --cmd "npx prisma migrate deploy").\n',
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: 'none', ci_setup: setupCi },
                errorCode: 'MISSING_MIGRATION_CMD',
                reason: 'missing-migration-cmd',
                resultExtra: { cluster, service, region },
            });
        }
    }

    // 1b. Stripped-runner guard: Grada's node-family images
    // remove npm/npx/yarn from the runner stage, so an npm-shim command
    // is a guaranteed `command not found` inside the task. Fail fast
    // headless; warn loudly (and proceed) interactively. Fail-open when
    // no Dockerfile is present — nothing to prove breakage against.
    if (isNpmShimCommand(resolvedCmd) && dockerfileStripsNpmShims(readFileSafe(path.join(cwd, 'Dockerfile')))) {
        if (headless) {
            return failCommand({
                message: `\n✖ Refusing to run "${resolvedCmd}": your Dockerfile strips npm/npx from the runner image, so this command would fail with "command not found" inside the task.\n`,
                hint: '  Bundle a framework-compiled runner instead and re-run with an explicit node-based command, e.g. --cmd "node ./dist/migrate.cjs".\n',
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: setupCi, error_code: 'NPM_CMD_STRIPPED_RUNNER' },
                errorCode: 'NPM_CMD_STRIPPED_RUNNER',
                reason: 'npm-cmd-stripped-runner',
                resultExtra: { cluster, service, region },
            });
        }
        console.log(color.yellow(`⚠️  "${resolvedCmd}" starts with npm/npx but your Dockerfile strips those binaries from the runner image — this will fail with "command not found" unless you switch to a node-based command (e.g. "node ./dist/migrate.cjs").`));
        trackEvent('npm_cmd_stripped_runner', { projectName, cmd_source: cmdSource, ci_setup: setupCi });
    }

    // 2. --setup-ci: patch the workflow file, no AWS calls.
    if (setupCi) {
        const workflowFile = path.join(cwd, '.github', 'workflows', 'deploy.yml');
        let workflowContent = null;
        try {
            if (fsSync.existsSync(workflowFile)) workflowContent = fsSync.readFileSync(workflowFile, 'utf8');
        } catch {
            workflowContent = null;
        }
        if (workflowContent === null) {
            return failCommand({
                message: `\n✖ Workflow not found at ${color.cyan('.github/workflows/deploy.yml')}. Run ${color.green('npx grada-run')} first.\n`,
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: true },
                errorCode: 'WORKFLOW_NOT_FOUND',
                reason: 'workflow-not-found',
                resultExtra: { cluster, service, region },
            });
        }
        const updated = injectMigrationGate(workflowContent, { cmd: resolvedCmd, cliVersion: getCliVersion() });
        if (updated === null) {
            return failCommand({
                message: '\n✖ Could not find the task-definition registration or ECS deployment step in .github/workflows/deploy.yml to anchor the migration gate.\n',
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: true },
                errorCode: 'WORKFLOW_ANCHOR_NOT_FOUND',
                reason: 'workflow-anchor-not-found',
                resultExtra: { cluster, service, region },
            });
        }
        fsSync.writeFileSync(workflowFile, updated, 'utf8');
        console.log(color.green('\n✅ Pre-deploy migration gate installed in .github/workflows/deploy.yml.'));
        console.log(color.dim('  Migrations now run against the new image revision before the ECS service updates.\n'));
        if (readTerraformComputeTarget(cwd) === 'ecs') {
            const previewFile = path.join(cwd, '.github', 'workflows', 'preview.yml');
            let previewContent = null;
            try {
                if (fsSync.existsSync(previewFile)) previewContent = fsSync.readFileSync(previewFile, 'utf8');
            } catch {
                previewContent = null;
            }
            if (previewContent !== null) {
                const previewUpdated = injectPreviewMigrationGate(previewContent, { cmd: resolvedCmd, cliVersion: getCliVersion() });
                if (previewUpdated !== null) {
                    fsSync.writeFileSync(previewFile, previewUpdated, 'utf8');
                    console.log(color.green('✅ Preview migration gate installed in .github/workflows/preview.yml.'));
                } else {
                    console.log(color.yellow('⚠️  Could not wire the preview migration gate: the Comment PR anchor was not found in .github/workflows/preview.yml.'));
                }
            }
        }
        await trackSuccess('db_migrate_run', { projectName, cmd_source: cmdSource, ci_setup: true });
        outro(color.green('Setup complete.'));
        return { ok: true, ciSetup: true, workflowFile, cmdSource };
    }

    // 3. Live run: discover the service and launch a one-off task.
    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });
    const logsClient = resolveClient(options.logsClient ?? options.cloudwatchClient, CloudWatchLogsClient, { region });
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxFlushPolls = options.maxFlushPolls ?? DEFAULT_FLUSH_MAX_POLLS;
    const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? timeoutSeconds * 1000;

    const s = spinner();
    s.start('Starting migration task...');

    try {
        const outcome = await runEphemeralEcsTask({
            ecsClient,
            logsClient,
            cluster,
            service,
            containerName,
            taskDef: (typeof options.taskDef === 'string' && options.taskDef.trim()) ? options.taskDef.trim() : null,
            command: (containerDef) => buildMigrationCommand(resolvedCmd, containerDef),
            startedBy: 'grada-db-migrate',
            logGroupName,
            timeoutMs,
            timeoutSeconds,
            pollIntervalMs,
            maxFlushPolls,
            flushIntervalMs,
            spinner: s,
            taskNoun: 'migration',
        });

        if (!outcome.ok && outcome.code === 'ECS_SERVICE_NOT_FOUND') {
            s.stop(color.yellow('Service not found.'));
            return failCommand({
                print: () => {
                    console.log(`\n  The ECS service ${color.cyan(service)} does not exist or is inactive.`);
                    console.log(`  Run ${color.green('npx grada-run apply')} to provision your infrastructure.\n`);
                },
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: false },
                errorCode: 'ECS_SERVICE_NOT_FOUND',
                reason: 'ecs-service-not-found',
                resultExtra: { cluster, service, region },
            });
        }

        if (!outcome.ok && outcome.code === 'NO_VPC_CONFIG') {
            s.stop(color.red('Service has no VPC configuration.'));
            return failCommand({
                message: `\n✖ The ECS service ${color.cyan(service)} has no VPC network configuration, so the migration task cannot be placed.\n`,
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: false },
                errorCode: 'RUN_TASK_FAILED',
                reason: 'run-task-failed',
                resultExtra: { cluster, service, region },
            });
        }

        if (!outcome.ok && outcome.code === 'CONTAINER_NOT_FOUND') {
            s.stop(color.red('Container not found.'));
            return failCommand({
                message: `\n✖ Container "${containerName}" does not exist in task definition "${outcome.targetTaskDef}".\n`,
                hint: `Override with --container <name>. Available: ${outcome.available.join(', ') || 'none'}\n`,
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: false },
                errorCode: 'CONTAINER_NOT_FOUND',
                reason: 'container-not-found',
                resultExtra: { cluster, service, region },
            });
        }

        if (!outcome.ok && outcome.code === 'RUN_TASK_FAILED') {
            s.stop(color.red('Failed to start migration task.'));
            return failCommand({
                message: `\n✖ ECS could not start the migration task: ${outcome.reason}.\n`,
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: false },
                errorCode: 'RUN_TASK_FAILED',
                reason: 'run-task-failed',
                resultExtra: { cluster, service, region },
            });
        }
        if (!outcome.ok && outcome.code === 'TIMEOUT') {
            try { s.stop(color.yellow('Migration timed out.')); } catch { /* already stopped */ }
            return failCommand({
                message: `\n✖ Migration timed out after ${timeoutSeconds}s. The task was stopped (best-effort); increase --timeout and retry.\n`,
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: false },
                errorCode: 'MIGRATION_TIMEOUT',
                reason: 'migration-timeout',
                resultExtra: { cluster, service, region, taskArn: outcome.taskArn },
            });
        }

        const exitCode = outcome.exitCode;
        const stoppedReason = outcome.stoppedReason;
        if (exitCode === 0) {
            console.log(color.green('\n✅ Migration succeeded.'));
            await trackSuccess('db_migrate_run', { projectName, cmd_source: cmdSource, ci_setup: false });
            outro(color.green('Done.'));
            return { ok: true, success: true, exitCode: 0, taskArn: outcome.taskArn };
        }
        const propagated = (typeof exitCode === 'number' && exitCode > 0) ? exitCode : 1;
        return failCommand({
            message: `\n✖ Migration failed with exit code ${exitCode ?? 'unknown'}: ${stoppedReason}.\n`,
            event: 'db_migrate_run',
            telemetry: { projectName, cmd_source: cmdSource, ci_setup: false },
            errorCode: 'MIGRATION_TASK_FAILED',
            extra: { exit_code: exitCode ?? -1 },
            reason: 'migration-task-failed',
            resultExtra: { cluster, service, region, taskArn: outcome.taskArn },
            exitCode: propagated,
        });
    } catch (error) {
        if (isAuthError(error)) {
            await trackAwsFailure('db_migrate_run', error, { projectName, cmd_source: cmdSource, ci_setup: false });
            handleAuthErrorBranch(error, s, options);
            return { ok: false, reason: 'error', cluster, service, region };
        }
        try { s.stop(color.red('❌ Db migrate failed.')); } catch { /* spinner already stopped */ }
        return failAwsError({
            event: 'db_migrate_run',
            error,
            telemetry: { projectName, cmd_source: cmdSource, ci_setup: false },
            reason: 'error',
            resultExtra: { cluster, service, region },
        });
    }
}

export default runDbMigrate;
