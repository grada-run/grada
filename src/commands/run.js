import { ECSClient } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import color from 'picocolors';
import { intro, outro, spinner, text, isCancel } from '@clack/prompts';
import { setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { failCommand, failAwsError, trackAwsFailure, failProjectNotInitialized, refuseUnknownFlags } from '../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { isAuthError, handleAuthErrorBranch, resolveClient } from '../utils/aws.js';
import {
    resolveRegion,
    resolveProjectName,
    resolveCluster,
    resolveService,
    resolveLogGroup,
    resolveAppName,
    resolveHeadless,
    resolveCwd,
    guardComputeTarget,
} from '../utils/resolvers.js';
import { resolveContainer } from '../utils/ecs.js';
import { runEphemeralEcsTask, buildRunnerCommand, parseRunnerTimeout, guardNpmStrippedRunner, reportRunnerOutcome } from '../utils/ecs-runner.js';

export const DEFAULT_RUN_TIMEOUT_SECONDS = 600;
export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_FLUSH_MAX_POLLS = 6;
export const DEFAULT_FLUSH_INTERVAL_MS = 1000;

export const RUN_NODE_EXAMPLE = 'node ./dist/backfill.cjs';

const LAMBDA_TARGET_HINT = '  Ephemeral Fargate tasks need an ECS service — remote execution is not supported on Lambda targets yet.\n';
const STATIC_TARGET_HINT = '  Static sites provision no compute — there is no container to execute against.\n';

export function parseRunArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'run') args.shift();
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
        boolean: ['headless'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0) options.unexpectedPositionals = positionals;
    if (unknown.length > 0) options.unknownFlags = unknown;
    return options;
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runRun(input = {}) {
    setActiveCommandName('run');
    try {
        return await runRunMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runRunMain(input = {}) {
    const options = normalizeOptions(input);
    const unknownRefusal = await refuseUnknownFlags(options, { command: 'run', event: 'run_run' });
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
        return failProjectNotInitialized({ event: 'run_run' });
    }
    const headless = resolveHeadless(options);

    intro(color.bgCyan(color.black(' grada run 🏃 ')));

    if (Array.isArray(options.unexpectedPositionals) && options.unexpectedPositionals.length > 0) {
        return failCommand({
            message: `\n✖ Unexpected argument "${options.unexpectedPositionals[0]}". Wrap multi-word --cmd values in quotes: --cmd "${options.unexpectedPositionals.join(' ')}".\n`,
            event: 'run_run',
            telemetry: { projectName },
            errorCode: 'UNEXPECTED_POSITIONAL_ARGS',
            reason: 'unexpected-positional-args',
            resultExtra: { cluster, service, region },
        });
    }

    // One-off tasks run on ECS Fargate — refuse other targets before
    // prompting or constructing AWS clients.
    const targetGuard = guardComputeTarget({ cwd, command: 'Remote command execution', supported: ['ecs'] });
    if (targetGuard) {
        return failCommand({
            message: targetGuard.message,
            hint: targetGuard.actual === 'lambda' ? LAMBDA_TARGET_HINT : STATIC_TARGET_HINT,
            event: 'run_run',
            telemetry: { projectName },
            errorCode: targetGuard.errorCode,
            reason: targetGuard.reason,
            resultExtra: { cluster, service, region },
        });
    }

    const parsedTimeout = await parseRunnerTimeout(options.timeout, DEFAULT_RUN_TIMEOUT_SECONDS, {
        event: 'run_run',
        telemetry: { projectName },
        resultExtra: { cluster, service, region },
    });
    if (typeof parsedTimeout !== 'number') return parsedTimeout;
    const timeoutSeconds = parsedTimeout;

    // Resolve the command: explicit --cmd, else an interactive prompt.
    // Generic commands cannot be auto-detected like migrations, so
    // headless runs without --cmd fail closed.
    let resolvedCmd = null;
    let cmdSource = null;
    if (typeof options.cmd === 'string' && options.cmd.trim()) {
        resolvedCmd = options.cmd.trim();
        cmdSource = 'explicit';
    } else if (!headless) {
        const answer = await text({
            message: 'Command to run inside the VPC:',
            placeholder: 'e.g. node ./dist/backfill.cjs',
        });
        if (isCancel(answer) || typeof answer !== 'string' || !answer.trim()) {
            outro(color.yellow('Run cancelled.'));
            return { ok: false, reason: 'cancelled', cluster, service, region };
        }
        resolvedCmd = answer.trim();
        cmdSource = 'prompted';
    } else {
        return failCommand({
            message: '\n✖ No command to run. Pass --cmd "<command>" (e.g. --cmd "node ./dist/backfill.cjs").\n',
            event: 'run_run',
            telemetry: { projectName, cmd_source: 'none' },
            errorCode: 'MISSING_RUN_CMD',
            reason: 'missing-run-cmd',
            resultExtra: { cluster, service, region },
        });
    }

    // Stripped-runner guard (shared with `db migrate`).
    const strippedRefusal = await guardNpmStrippedRunner({
        resolvedCmd, cwd, headless,
        event: 'run_run',
        telemetry: { projectName, cmd_source: cmdSource },
        resultExtra: { cluster, service, region },
        nodeExample: RUN_NODE_EXAMPLE,
    });
    if (strippedRefusal) return strippedRefusal;

    // Live run: discover the service and launch a one-off task.
    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });
    const logsClient = resolveClient(options.logsClient ?? options.cloudwatchClient, CloudWatchLogsClient, { region });
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxFlushPolls = options.maxFlushPolls ?? DEFAULT_FLUSH_MAX_POLLS;
    const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? timeoutSeconds * 1000;

    const s = spinner();
    s.start('Starting one-off task...');

    try {
        const outcome = await runEphemeralEcsTask({
            ecsClient,
            logsClient,
            cluster,
            service,
            containerName,
            taskDef: (typeof options.taskDef === 'string' && options.taskDef.trim()) ? options.taskDef.trim() : null,
            command: (containerDef) => buildRunnerCommand(resolvedCmd, containerDef),
            startedBy: 'grada-run',
            logGroupName,
            timeoutMs,
            timeoutSeconds,
            pollIntervalMs,
            maxFlushPolls,
            flushIntervalMs,
            spinner: s,
            taskNoun: 'one-off',
        });

        // Outcome mapping shared with `db migrate` (labels parameterize the copy).
        return reportRunnerOutcome({
            outcome, spinner: s,
            event: 'run_run',
            telemetry: { projectName, cmd_source: cmdSource },
            cluster, service, region,
            containerName,
            label: 'Task',
            taskPhrase: 'one-off task',
            timeoutSeconds,
            timeoutCode: 'RUN_TIMEOUT',
            timeoutReason: 'run-timeout',
            taskFailedCode: 'RUN_COMMAND_FAILED',
            taskFailedReason: 'run-command-failed',
        });
    } catch (error) {
        if (isAuthError(error)) {
            await trackAwsFailure('run_run', error, { projectName, cmd_source: cmdSource });
            handleAuthErrorBranch(error, s, options);
            return { ok: false, reason: 'error', cluster, service, region };
        }
        try { s.stop(color.red('❌ Run failed.')); } catch { /* spinner already stopped */ }
        return failAwsError({
            event: 'run_run',
            error,
            telemetry: { projectName, cmd_source: cmdSource },
            reason: 'error',
            resultExtra: { cluster, service, region },
        });
    }
}

export default runRun;
