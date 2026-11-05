import { ECSClient } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import color from 'picocolors';
import { intro, outro, spinner, text, isCancel } from '@clack/prompts';
import { trackSuccess, setActiveCommandName, resetActiveCommandName, getCliVersion } from '../../core/telemetry.js';
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
    readTerraformComputeTarget,
} from '../../utils/resolvers.js';
import { detectMigrationCommand } from '../../utils/detector.js';
import { resolveContainer } from '../../utils/ecs.js';
import { runEphemeralEcsTask, buildRunnerCommand, parseRunnerTimeout, guardNpmStrippedRunner, reportRunnerOutcome } from '../../utils/ecs-runner.js';
import { atomicWriteFile } from '../../utils/atomic-write.js';
import { pinnedActionUse } from '../../data/action-pins.js';
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

function renderGateBlock({ includeSetupNode, steps }) {
    const lines = [`      ${GATE_START_MARKER}`];
    if (includeSetupNode) {
        lines.push(
            '      - name: Setup Node.js for migrations',
            `        uses: ${pinnedActionUse('actions/setup-node')}`,
            '        with:',
            "          node-version: '20'",
            ''
        );
    }
    for (const { stepName, runLine } of steps) {
        lines.push(
            `      - name: ${stepName}`,
            // Gates run AWS calls: honor the credential-skip outcome like
            // every other post-assume step (BUG-138). Neutral on deploy
            // (a failed assume fails the run before any gate runs).
            `        if: steps.aws-creds.outcome == 'success'`,
            '        run: |',
            `          ${runLine}`
        );
    }
    lines.push(`      ${GATE_END_MARKER}`);
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
function injectGateBlock(content, { steps, anchor }) {
    const base = stripPreviousGateBlock(String(content ?? ''));
    const includeSetupNode = !base.includes('actions/setup-node');
    const block = renderGateBlock({ includeSetupNode, steps });
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
    const runner = buildRunnerInvocation(cliVersion);
    return injectGateBlock(workflowContent, {
        steps: [
            {
                stepName: 'Take pre-migration database snapshot',
                runLine: `${runner} db backup --id "pre-deploy-\${{ github.sha }}" --headless`,
            },
            {
                stepName: 'Pre-Deploy Database Migration',
                runLine: `${runner} db migrate --cmd ${quoteShellArg(cmd)} --task-def "${taskDefRef}" --headless`,
            },
        ],
        anchor: '- name: Force ECS deployment',
    });
}

// Idempotently injects (or refreshes) the migration gate block into a
// preview.yml document (ECS only — Lambda has no migrate-gate story yet).
// Previews have no register step, so `db migrate` resolves the workspace
// service itself via --workspace. Returns null without the anchor.
export function injectPreviewMigrationGate(workflowContent, { cmd, cliVersion } = {}) {
    return injectGateBlock(workflowContent, {
        steps: [
            {
                stepName: 'Preview Database Migration',
                runLine: `${buildRunnerInvocation(cliVersion)} db migrate --cmd ${quoteShellArg(cmd)} --workspace "\${{ env.WORKSPACE }}" --headless`,
            },
        ],
        anchor: '- name: Comment PR',
    });
}

// Back-compat alias: the synthesis logic now lives in ecs-runner.js as
// buildRunnerCommand (shared by migrate, enable-vector, and run).
export { buildRunnerCommand as buildMigrationCommand };

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

    const parsedTimeout = await parseRunnerTimeout(options.timeout, DEFAULT_MIGRATE_TIMEOUT_SECONDS, {
        event: 'db_migrate_run',
        telemetry: { projectName },
        resultExtra: { cluster, service, region },
    });
    if (typeof parsedTimeout !== 'number') return parsedTimeout;
    const timeoutSeconds = parsedTimeout;

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

    // 1b. Stripped-runner guard (shared with `run`).
    const strippedRefusal = await guardNpmStrippedRunner({
        resolvedCmd, cwd, headless,
        event: 'db_migrate_run',
        telemetry: { projectName, cmd_source: cmdSource, ci_setup: setupCi },
        resultExtra: { cluster, service, region },
    });
    if (strippedRefusal) return strippedRefusal;

    // 2. --setup-ci: patch the workflow file, no AWS calls.
    if (setupCi) {
        // BUG-191: the gate runs migrations as an ephemeral ECS task —
        // refuse on lambda/static (no ECS to run on). Init auto-skips
        // with a warning; this explicit command fails closed.
        const setupTarget = readTerraformComputeTarget(cwd);
        if (setupTarget !== 'ecs') {
            return failCommand({
                message: `\n✖ --setup-ci wires an ECS pre-deploy migration gate, but this tree targets ${color.cyan(setupTarget)} (no ECS service to run it on).\n`,
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: true },
                errorCode: 'MIGRATE_SETUP_CI_UNSUPPORTED_TARGET',
                reason: 'migrate-setup-ci-unsupported-target',
                resultExtra: { cluster, service, region },
            });
        }
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
        await atomicWriteFile(workflowFile, updated, 'utf8');
        console.log(color.green('\n✅ Pre-deploy migration gate installed in .github/workflows/deploy.yml.'));
        console.log(color.dim('  Each deploy now snapshots the database, then runs migrations against the new image revision before the ECS service updates.\n'));
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
                    await atomicWriteFile(previewFile, previewUpdated, 'utf8');
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
            command: (containerDef) => buildRunnerCommand(resolvedCmd, containerDef),
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

        // Outcome mapping shared with `run` (labels parameterize the copy).
        return reportRunnerOutcome({
            outcome, spinner: s,
            event: 'db_migrate_run',
            telemetry: { projectName, cmd_source: cmdSource, ci_setup: false },
            cluster, service, region,
            containerName,
            label: 'Migration',
            taskPhrase: 'migration task',
            timeoutSeconds,
            timeoutCode: 'MIGRATION_TIMEOUT',
            timeoutReason: 'migration-timeout',
            taskFailedCode: 'MIGRATION_TASK_FAILED',
            taskFailedReason: 'migration-task-failed',
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
