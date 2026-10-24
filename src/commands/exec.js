import { ECSClient, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { spawn } from 'child_process';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackEvent, flushTelemetry, trackSuccess, trackFailure, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { hasAwsCli, AWS_CLI_INSTALL_URL, isAuthError, handleAuthErrorBranch, resolveClient } from '../utils/aws.js';
import { failCommand, failAwsError, trackAwsFailure, failProjectNotInitialized, isProgrammaticCall, refuseUnknownFlags } from '../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { resolveRegion, resolveProjectName, resolveCluster, resolveService, resolveCwd, guardComputeTarget } from '../utils/resolvers.js';
import {
    hasSessionManagerPlugin,
    resolveContainer,
    printAwsCliGuidance,
    printSessionManagerGuidance,
    printNoTasksGuidance,
    pickNewestRunningTask,
} from '../utils/ecs.js';

// Re-exported from the shared ECS module for backward compatibility.
export {
    SESSION_MANAGER_PLUGIN_URL,
    hasSessionManagerPlugin,
    resolveContainer,
} from '../utils/ecs.js';

export const DEFAULT_SHELL = '/bin/sh';

export function resolveShellCommand(options = {}) {
    if (typeof options.command === 'string' && options.command.trim()) return options.command.trim();
    if (typeof options.shell === 'string' && options.shell.trim()) return options.shell.trim();
    return DEFAULT_SHELL;
}

export function parseExecArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'exec') args.shift();
    const { options, rest, unknown } = parseFlags(args, {
        string: ['cluster', 'service', 'container', { name: 'command', greedy: true }, 'region'],
        boolean: ['headless'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0 && !options.service) options.service = positionals[0];
    if (positionals.length > 1) options.unexpectedPositionals = positionals.slice(1);
    if (unknown.length > 0) options.unknownFlags = unknown;
    return options;
}

export function buildExecuteCommandArgs({ cluster, taskArn, container, command = DEFAULT_SHELL, region }) {
    const args = [
        'ecs', 'execute-command',
        '--cluster', cluster,
        '--task', taskArn,
        '--container', container,
        '--interactive',
        '--command', command,
    ];
    if (region) args.push('--region', region);
    return args;
}

function pickContainerName(task, fallback) {
    const containers = task?.containers || [];
    if (containers.length === 0) return fallback;
    const exact = containers.find((c) => c.name === fallback);
    if (exact) return exact.name;
    const running = containers.find((c) => c.lastStatus === 'RUNNING');
    if (running?.name) return running.name;
    if (containers[0]?.name) return containers[0].name;
    return fallback;
}

export async function findRunningTask(ecsClient, { cluster, service }) {
    const listResp = await ecsClient.send(
        new ListTasksCommand({ cluster, serviceName: service, desiredStatus: 'RUNNING', maxResults: 10 })
    );
    const taskArns = listResp.taskArns || [];
    if (taskArns.length === 0) return null;
    const descResp = await ecsClient.send(
        new DescribeTasksCommand({ cluster, tasks: taskArns.slice(0, 10) })
    );
    const newest = pickNewestRunningTask(descResp.tasks || []);
    if (!newest) return null;
    return { taskArn: newest.taskArn || taskArns[0], containerName: newest.containers?.[0]?.name || null, task: newest };
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runExec(input = {}) {
    setActiveCommandName('exec');
    try {
        return await runExecMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runExecMain(input = {}) {
    const options = normalizeOptions(input);
    const unknownRefusal = await refuseUnknownFlags(options, { command: 'exec', event: 'exec_run' });
    if (unknownRefusal) return unknownRefusal;
    const noExit = isProgrammaticCall(options);
    let cwd;
    let region;
    let projectName;
    let cluster;
    let service;
    let expectedContainer;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
        cluster = resolveCluster(options, cwd);
        service = resolveService(options, cwd);
        expectedContainer = resolveContainer(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'exec_run', noExit });
    }

    if (Array.isArray(options.unexpectedPositionals) && options.unexpectedPositionals.length > 0) {
        return failCommand({
            noExit,
            message: `\n✖ Unexpected argument "${options.unexpectedPositionals[0]}". Pass at most one service: exec [service].\n`,
            event: 'exec_run',
            telemetry: { projectName },
            errorCode: 'UNEXPECTED_POSITIONAL_ARGS',
            reason: 'unexpected-positional-args',
            resultExtra: { cluster, service, region },
        });
    }

    const shellCommand = resolveShellCommand(options);

    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });

    const spawnImpl = options.spawnImpl || spawn;
    const awsCliPresent = options.hasAwsCli ?? hasAwsCli({ spawnSyncImpl: options.spawnSyncImpl });
    const ssmPluginPresent = options.hasSsmPlugin ?? hasSessionManagerPlugin({ spawnSyncImpl: options.spawnSyncImpl });

    intro(color.bgCyan(color.black(' grada exec 🐚 ')));

    const targetGuard = guardComputeTarget({
        cwd,
        command: 'ECS Exec',
        supported: ['ecs'],
        hint: 'Lambda functions and static sites have no shell to attach to — inspect recent output with npx grada-run logs instead.',
    });
    if (targetGuard) {
        return failCommand({
            noExit,
            message: targetGuard.message,
            hint: targetGuard.hint,
            event: 'exec_run',
            telemetry: { projectName },
            errorCode: targetGuard.errorCode,
            reason: targetGuard.reason,
            resultExtra: { cluster, service, region },
        });
    }

    if (!awsCliPresent) {
        return failCommand({
            noExit,
            print: printAwsCliGuidance,
            event: 'exec_run',
            telemetry: { projectName, error_code: 'AWS_CLI_MISSING' },
            reason: 'aws-cli-missing',
            resultExtra: { cluster, service, region },
        });
    }

    if (!ssmPluginPresent) {
        return failCommand({
            noExit,
            print: printSessionManagerGuidance,
            event: 'exec_run',
            telemetry: { projectName, error_code: 'SSM_PLUGIN_MISSING' },
            reason: 'ssm-plugin-missing',
            resultExtra: { cluster, service, region },
        });
    }

    const s = spinner();
    s.start('Finding a running container...');

    try {
        const found = await findRunningTask(ecsClient, { cluster, service });

        if (!found) {
            s.stop(color.yellow('No running tasks.'));
            return failCommand({
                noExit,
                print: () => printNoTasksGuidance(service, cluster),
                event: 'exec_run',
                telemetry: { projectName, error_code: 'NO_RUNNING_TASKS' },
                reason: 'no-running-tasks',
                resultExtra: { cluster, service, region },
            });
        }

        const container = found.containerName || expectedContainer;
        const taskArn = found.taskArn;
        // Prefer the exact expected container name when the task actually runs it.
        const resolvedContainer = found.task ? pickContainerName(found.task, expectedContainer) : container;

        s.stop(color.green('Container found. Connecting...'));
        console.log(`  ${color.dim('Cluster:')} ${color.cyan(cluster)}`);
        console.log(`  ${color.dim('Task:')} ${color.dim(taskArn)}`);
        console.log(`  ${color.dim('Container:')} ${color.yellow(resolvedContainer)}`);
        console.log(color.dim(`  Opening ${shellCommand} — type 'exit' to leave.\n`));

        const cliArgs = buildExecuteCommandArgs({
            cluster,
            taskArn,
            container: resolvedContainer,
            command: shellCommand,
            region,
        });

        const { code } = await new Promise((resolve) => {
            const child = spawnImpl('aws', cliArgs, { stdio: 'inherit' });
            child.on('error', (err) => {
                console.log(color.red(`\n✖ Failed to start AWS CLI: ${err?.message || err}`));
                console.log(color.dim(`Install help: ${AWS_CLI_INSTALL_URL}`));
                resolve({ code: 1 });
            });
            // A null close code means the process died by signal — never
            // report that as success.
            child.on('close', (code) => resolve({ code: code ?? 1 }));
        });

        if (code === 0) {
            outro(color.green('Shell session ended. 👋'));
            await trackSuccess('exec_run', { projectName, exit_code: 0 });
        } else {
            console.log(color.yellow(`\nShell exited with code ${code}.`));
            console.log(color.dim(`If the connection failed, ensure ECS Exec is enabled (re-run ${color.green('npx grada-run apply')}) and the Session Manager plugin is installed.`));
            outro(color.yellow('Exec finished.'));
            await trackFailure('exec_run', { projectName, error_code: 'EXEC_SESSION_FAILED', exit_code: code });
        }

        return { ok: code === 0, exitCode: code, cluster, service, taskArn, container: resolvedContainer, region };
    } catch (error) {
        if (isAuthError(error)) {
            await trackAwsFailure('exec_run', error, { projectName });
            handleAuthErrorBranch(error, s, options);
            return { ok: false, reason: 'error', cluster, service, region };
        }
        s.stop(color.red('❌ Exec failed.'));
        return failAwsError({
            event: 'exec_run',
            error,
            noExit,
            telemetry: { projectName },
            reason: 'error',
            resultExtra: { cluster, service, region },
        });
    }
}

// Convenience alias mirroring the CLI verb.
export const execCommand = runExec;

export default runExec;
