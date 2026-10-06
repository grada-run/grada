import { spawnSync } from 'child_process';
import { ECSClient, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackEvent, flushTelemetry, trackSuccess, trackFailure, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { failCommand, failProjectNotInitialized, isProgrammaticCall } from '../utils/command.js';
import { normalizeOptions } from '../utils/args.js';
import { handleAuthErrorBranch, resolveClient } from '../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveCluster, resolveLogGroup, resolveCwd, readTerraformComputeTarget, guardComputeTarget } from '../utils/resolvers.js';

export const LOG_FETCH_LIMIT = 50;

export function extractStoppedReason(task) {
    return task?.stoppedReason || 'Unknown';
}

export function getFailingContainer(task) {
    const containers = task?.containers || [];
    return (
        containers.find((c) => c.exitCode !== undefined && c.exitCode !== 0) ||
        containers.find((c) => c.reason && c.reason !== 'Essential container in task exited') ||
        containers[0] ||
        {}
    );
}

function taskActivityTime(task) {
    // Prefer container exit time over ENI deprovisioning time when present.
    const stamp = task?.executionStoppedAt ?? task?.stoppingAt ?? task?.stoppedAt
        ?? task?.startedAt ?? task?.createdAt;
    if (stamp === undefined || stamp === null) return 0;
    return new Date(stamp).getTime() || 0;
}

// Parses `.../task-definition/<family>:<revision>` (ECS-managed format).
// Returns null when the ARN is missing or doesn't match, so callers fail
// closed into the timestamp rule below.
export function parseTaskDefinitionRef(taskDefinitionArn) {
    if (typeof taskDefinitionArn !== 'string') return null;
    const match = taskDefinitionArn.match(/task-definition\/([^/:]+):(\d+)\s*$/);
    if (!match) return null;
    return { family: match[1], revision: parseInt(match[2], 10) };
}

function taskStartTime(task) {
    // `startedAt` is set when the task actually starts running. `createdAt`
    // predates provisioning, so it must never stand in for uptime — a task
    // without `startedAt` has not run yet and fails closed to 0.
    const stamp = task?.startedAt;
    if (stamp === undefined || stamp === null) return 0;
    return new Date(stamp).getTime() || 0;
}

export function formatAge(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

export function pickMostRecentTask(tasks) {
    if (!tasks || tasks.length === 0) return null;
    return [...tasks].sort((a, b) => taskActivityTime(b) - taskActivityTime(a))[0];
}

export function extractTaskIdFromArn(taskArn) {
    if (typeof taskArn !== 'string' || !taskArn.includes('/')) return '';
    return taskArn.split('/').pop() || '';
}

function isLogGroupNotFoundError(error) {
    return !!error && error.name === 'ResourceNotFoundException';
}

// Lambda diagnosis without new dependencies: function configuration comes
// from the AWS CLI (`get-function`), recent output from the CloudWatch Logs
// SDK client the ECS path already uses.
export async function runLambdaDiagnose(input = {}) {
    const options = normalizeOptions(input);
    const noExit = isProgrammaticCall(options);
    const projectName = options.projectName;
    const region = options.region;
    const logGroup = options.logGroup;
    const functionName = typeof options.functionName === 'string' && options.functionName.trim()
        ? options.functionName.trim()
        : `${projectName}-fn`;
    const runSync = options.spawnSyncImpl || spawnSync;

    intro(color.bgCyan(color.black(' grada diagnose 🩺 ')));

    const s = spinner();
    s.start('Looking up the Lambda function configuration...');

    const logsClient = resolveClient(options.logsClient, CloudWatchLogsClient, { region });

    const res = runSync('aws', [
        'lambda', 'get-function',
        '--function-name', functionName,
        '--region', region,
        '--output', 'json',
    ], { encoding: 'utf8' });

    if (res?.error?.code === 'ENOENT') {
        s.stop(color.red('❌ Diagnose failed.'));
        await trackFailure('diagnose_run', { error_code: 'AWS_CLI_MISSING', log_source: 'none' });
        return failCommand({
            noExit,
            message: '✖ The AWS CLI is required for Lambda diagnosis.',
            hint: 'Install it from https://aws.amazon.com/cli/, then try again.',
            reason: 'aws-cli-missing',
            resultExtra: { functionName, region },
        });
    }

    if (res?.status !== 0) {
        const detail = String(res?.stderr || res?.stdout || '').trim();
        if (/ResourceNotFound/i.test(detail)) {
            s.stop('Function not found.');
            console.log(`\n  The Lambda function ${color.cyan(functionName)} does not exist.`);
            console.log(`  Run ${color.green('npx grada-run apply')} to provision your infrastructure.\n`);
            await trackFailure('diagnose_run', { error_code: 'NOT_DEPLOYED', log_source: 'none' });
            return { healthy: false, reason: 'not-deployed', functionName, logs: [] };
        }
        s.stop(color.red('❌ Diagnose failed.'));
        await trackFailure('diagnose_run', { error_code: 'GET_FUNCTION_FAILED', log_source: 'none' });
        return failCommand({
            noExit,
            message: `✖ ${detail || 'aws lambda get-function failed.'}`,
            hint: 'Check your AWS credentials and region, then try again.',
            resultExtra: { functionName, region },
        });
    }

    let configuration;
    try {
        configuration = JSON.parse(res.stdout || '{}').Configuration || {};
    } catch {
        s.stop(color.red('❌ Diagnose failed.'));
        await trackFailure('diagnose_run', { error_code: 'BAD_RESPONSE', log_source: 'none' });
        return failCommand({
            noExit,
            message: '✖ Could not parse the Lambda get-function response.',
            hint: 'Check your AWS CLI version, then try again.',
            resultExtra: { functionName, region },
        });
    }

    const state = configuration.State || 'UNKNOWN';
    const lastUpdateStatus = configuration.LastUpdateStatus || 'UNKNOWN';
    const configUnhealthy = state !== 'Active' || lastUpdateStatus === 'Failed';

    s.message(`Fetching last ${LOG_FETCH_LIMIT} log lines for "${functionName}"...`);
    let logs = [];
    let logGroupMissing = false;
    try {
        const logsResp = await logsClient.send(new FilterLogEventsCommand({
            logGroupName: logGroup,
            startTime: Date.now() - 60 * 60 * 1000,
            limit: LOG_FETCH_LIMIT,
        }));
        logs = (logsResp.events || []).slice(-LOG_FETCH_LIMIT).map((e) => e.message);
    } catch (logsError) {
        if (handleAuthErrorBranch(logsError, s, options)) return;
        if (isLogGroupNotFoundError(logsError)) {
            logGroupMissing = true;
            logs = [];
        } else {
            logs = [];
        }
    }

    const errorLines = logs.filter((line) => /error|exception|failed|fatal|outofmemory|killed/i.test(String(line ?? '')));
    const healthy = !configUnhealthy && errorLines.length === 0;

    s.stop('Diagnosis complete.\n');

    if (!healthy && configUnhealthy) {
        console.log(`  ${color.red(color.bold('✖ Function state:'))} ${color.red(`${state} / ${lastUpdateStatus}`)}`);
    }
    console.log(`  ${color.dim('Function:')} ${color.cyan(functionName)}`);
    console.log(`  ${color.dim('State:')} ${state === 'Active' ? color.green(state) : color.yellow(state)} ${color.dim(`/ ${lastUpdateStatus}`)}`);
    if (configuration.LastModified) console.log(`  ${color.dim('Modified:')} ${configuration.LastModified}`);

    if (logs.length > 0) {
        console.log(`\n  ${color.bold(`Last ${logs.length} log lines (${color.cyan(logGroup)}):`)}`);
        for (const line of logs) {
            console.log(`  ${color.dim('│')} ${highlightErrorLine(line)}`);
        }
    } else if (logGroupMissing) {
        console.log(color.yellow(`\n⚠ Log group not found (expected ${logGroup}).`));
        console.log(color.dim(`List matching groups with: aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/" --region ${region}`));
    } else {
        console.log(color.dim(`\n  No recent log events found in ${logGroup}.`));
    }

    if (healthy) {
        outro(color.green('Diagnose complete. Nothing to fix!'));
        await trackSuccess('diagnose_run', { healthy: true, log_source: logs.length > 0 ? 'group-fallback' : 'none' });
        return { healthy: true, functionName, state, lastUpdateStatus, logs: [] };
    }

    outro(color.green('Diagnose complete. Fix the error above, then redeploy. 🚀'));
    await trackSuccess('diagnose_run', { healthy: false, log_source: logs.length > 0 ? 'group-fallback' : 'none' });
    return { healthy: false, functionName, state, lastUpdateStatus, logs };
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runDiagnose(input = {}) {
    setActiveCommandName('diagnose');
    try {
        return await runDiagnoseMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runDiagnoseMain(input = {}) {
    const options = normalizeOptions(input);
    const noExit = isProgrammaticCall(options);
    let cwd;
    let projectName;
    let region;
    let cluster;
    let logGroup;
    try {
        cwd = resolveCwd(options);
        projectName = resolveProjectName(options, cwd);
        region = resolveRegion(options, cwd);
        cluster = resolveCluster(options, cwd);
        logGroup = resolveLogGroup(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'diagnose_run', noExit });
    }

    if (readTerraformComputeTarget(cwd) === 'lambda') {
        return runLambdaDiagnose({ ...options, cwd, projectName, region, logGroup });
    }

    const targetGuard = guardComputeTarget({
        cwd,
        command: 'Diagnose',
        supported: ['ecs', 'lambda'],
        hint: 'Static sites have no containers to inspect — check the distribution state with npx grada-run status instead.',
    });
    if (targetGuard) {
        return failCommand({
            noExit,
            message: targetGuard.message,
            hint: targetGuard.hint,
            event: 'diagnose_run',
            telemetry: { projectName },
            errorCode: targetGuard.errorCode,
            reason: targetGuard.reason,
            resultExtra: { cluster, region },
        });
    }

    intro(color.bgCyan(color.black(' grada diagnose 🩺 ')));

    const s = spinner();
    s.start('Looking up recent stopped ECS tasks...');

    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });
    const logsClient = resolveClient(options.logsClient, CloudWatchLogsClient, { region });

    try {
        const listResp = await ecsClient.send(
            new ListTasksCommand({
                cluster,
                desiredStatus: 'STOPPED',
                sort: 'DESC',
                maxResults: 100
            })
        );

        const taskArns = listResp.taskArns || [];

        if (taskArns.length === 0) {
            s.stop('No stopped tasks found.');
            console.log(color.green('✅ No stopped tasks — your service looks healthy.'));
            outro(color.green('Diagnose complete. Nothing to fix!'));
            await trackSuccess('diagnose_run', { healthy: true, log_source: 'none' });
            return { healthy: true, stoppedReason: null, logs: [] };
        }

        // ListTasks order is arbitrary — describe the full batch (up to the
        // DescribeTasks 100-ARN limit) and pick the latest stopped task below.
        s.message(`Describing ${Math.min(taskArns.length, 100)} stopped task(s)...`);
        const descResp = await ecsClient.send(
            new DescribeTasksCommand({
                cluster,
                tasks: taskArns.slice(0, 100)
            })
        );

        const tasks = descResp.tasks || [];
        if (tasks.length === 0) {
            s.stop('No task details returned.');
            console.log(color.yellow('⚠ Stopped task ARNs were listed, but ECS returned no task details.'));
            outro(color.yellow('Diagnose finished with no details.'));
            await trackFailure('diagnose_run', { error_code: 'NO_TASK_DETAILS', log_source: 'none' });
            return { healthy: false, stoppedReason: null, logs: [] };
        }

        const failedTask = pickMostRecentTask(tasks);
        const stoppedReason = extractStoppedReason(failedTask);
        const failingContainer = getFailingContainer(failedTask);
        const containerName = failingContainer.name || 'unknown';
        const exitCode = failingContainer.exitCode;
        const containerReason = failingContainer.reason;

        // A STOPPED task from an old crash lingers in ECS for ~1h. If a
        // RUNNING task started after the latest stop, the service has already
        // recovered — report that instead of the stale crash.
        s.message('Checking for running tasks...');
        const stoppedActivity = taskActivityTime(failedTask);
        const runningListResp = await ecsClient.send(
            new ListTasksCommand({
                cluster,
                desiredStatus: 'RUNNING',
                sort: 'DESC',
                maxResults: 100
            })
        );
        const runningArns = runningListResp.taskArns || [];
        let newestRunning = null;
        if (runningArns.length > 0) {
            const runningDescResp = await ecsClient.send(
                new DescribeTasksCommand({
                    cluster,
                    tasks: runningArns.slice(0, 100)
                })
            );
            const runningTasks = runningDescResp.tasks || [];
            for (const task of runningTasks) {
                // ListTasks({ desiredStatus: 'RUNNING' }) also returns tasks
                // still PROVISIONING/PENDING toward that goal. Only a task
                // whose actual lastStatus is RUNNING — and which isn't
                // UNHEALTHY — proves the service recovered.
                if (task?.lastStatus !== 'RUNNING' || task?.healthStatus === 'UNHEALTHY') continue;
                if (!newestRunning || taskStartTime(task) > taskStartTime(newestRunning)) {
                    newestRunning = task;
                }
            }
        }
        const latestRunningStart = newestRunning ? taskStartTime(newestRunning) : 0;

        // A crash on a superseded revision is stale by construction, even when
        // its stop timestamp postdates the running task (normal drain order).
        // Anything else falls through to the timestamp comparison.
        const stoppedRef = parseTaskDefinitionRef(failedTask.taskDefinitionArn);
        const runningRef = newestRunning ? parseTaskDefinitionRef(newestRunning.taskDefinitionArn) : null;
        const supersededRevision = Boolean(
            stoppedRef && runningRef
            && stoppedRef.family === runningRef.family
            && stoppedRef.revision < runningRef.revision
        );
        const recoveredByTimestamp = Boolean(newestRunning) && latestRunningStart > stoppedActivity;

        if (supersededRevision || recoveredByTimestamp) {
            const now = Date.now();
            const sinceClock = new Date(latestRunningStart).toISOString().slice(11, 19);
            const exitSuffix = exitCode !== undefined ? ` (exit code ${exitCode})` : '';
            const crashContext = supersededRevision
                ? `ℹ Previous crash (revision ${stoppedRef.revision}, ${formatAge(now - stoppedActivity)} ago): ${stoppedReason} — ${containerName}${exitSuffix}. Revision ${runningRef.revision} is now running. No action needed.`
                : `ℹ Previous crash (${formatAge(now - stoppedActivity)} ago): ${stoppedReason} — ${containerName}${exitSuffix}. No action needed.`;
            s.stop('Service recovered.');
            console.log(color.green(`\n✔ Service recovered — a healthy task has been running since ${sinceClock} (${formatAge(now - latestRunningStart)}).`));
            console.log(color.dim(crashContext));
            outro(color.green('Diagnose complete. The service recovered after that crash. ✅'));
            await trackSuccess('diagnose_run', { healthy: true, recovered: true, log_source: 'none' });
            return {
                healthy: true,
                recovered: true,
                stoppedReason,
                taskArn: failedTask.taskArn,
                containerName,
                logs: [],
            };
        }

        s.message(`Fetching last ${LOG_FETCH_LIMIT} log lines for "${containerName}"...`);

        // CloudWatch stream names follow `ecs/<containerName>/<taskId>`.
        const taskId = extractTaskIdFromArn(failedTask.taskArn);
        const streamPrefix = containerName && containerName !== 'unknown' && taskId
            ? `ecs/${containerName}/${taskId}`
            : '';

        const fetchLogMessages = async (input) => {
            const logsResp = await logsClient.send(new FilterLogEventsCommand(input));
            return (logsResp.events || []).slice(-LOG_FETCH_LIMIT).map((e) => e.message);
        };

        let logs = [];
        let logGroupMissing = false;
        let logSource = 'none';
        if (streamPrefix) {
            try {
                logs = await fetchLogMessages({
                    logGroupName: logGroup,
                    logStreamNamePrefix: streamPrefix,
                    limit: LOG_FETCH_LIMIT,
                });
                if (logs.length > 0) logSource = 'task-stream';
            } catch (scopedError) {
                if (isLogGroupNotFoundError(scopedError)) {
                    logGroupMissing = true;
                    logs = [];
                }
                // Any other scoped-query error falls through to the group fallback.
            }
        }
        if (!logGroupMissing && logs.length === 0) {
            try {
                logs = await fetchLogMessages({
                    logGroupName: logGroup,
                    startTime: Date.now() - 60 * 60 * 1000,
                    limit: LOG_FETCH_LIMIT,
                });
                if (logs.length > 0) logSource = 'group-fallback';
            } catch (fallbackError) {
                if (isLogGroupNotFoundError(fallbackError)) logGroupMissing = true;
                logs = [];
            }
        }

        s.stop('Diagnosis complete.\n');

        console.log(`  ${color.red(color.bold('✖ Stopped reason:'))} ${color.red(stoppedReason)}`);
        console.log(`  ${color.dim('Cluster:')} ${color.cyan(cluster)}`);
        console.log(`  ${color.dim('Task:')} ${color.dim(failedTask.taskArn || taskArns[0])} ${color.dim(`(stopped ${formatAge(Date.now() - stoppedActivity)} ago)`)}`);
        console.log(`  ${color.dim('Container:')} ${color.yellow(containerName)}${exitCode !== undefined ? color.dim(` (exit code ${exitCode})`) : ''}`);
        if (containerReason && containerReason !== stoppedReason) {
            console.log(`  ${color.dim('Container reason:')} ${color.yellow(containerReason)}`);
        }

        if (logs.length > 0) {
            console.log(`\n  ${color.bold(`Last ${logs.length} log lines (${color.cyan(logGroup)}):`)}`);
            for (const line of logs) {
                console.log(`  ${color.dim('│')} ${highlightErrorLine(line)}`);
            }
        } else if (logGroupMissing) {
            console.log(color.yellow(`\n⚠ Log group not found (expected ${logGroup}).`));
            console.log(color.dim(`List matching groups with: aws logs describe-log-groups --log-group-name-prefix "/ecs/" --region ${region}`));
        } else {
            console.log(color.dim(`\n  No recent log events found in ${logGroup}.`));
        }

        outro(color.green('Diagnose complete. Fix the error above, then redeploy. 🚀'));

        await trackSuccess('diagnose_run', { healthy: false, log_source: logSource });

        return {
            healthy: false,
            cluster,
            taskArn: failedTask.taskArn || taskArns[0],
            stoppedReason,
            containerName,
            exitCode,
            containerReason,
            logs
        };
    } catch (error) {
        await trackFailure('diagnose_run', {
            error_code: error.name || 'UNKNOWN',
            error_message: error.message,
            stack_trace: error.name === 'TypeError' ? error.stack : undefined,
            log_source: 'none'
        });
        if (handleAuthErrorBranch(error, s, options)) {
            return;
        }
        s.stop(color.red('❌ Diagnose failed.'));
        return failCommand({
            noExit,
            message: `✖ ${error.message || error}`,
            hint: 'Check your AWS credentials and region, then try again.',
        });
    }
}

function highlightErrorLine(line) {
    if (/error|exception|failed|fatal|outofmemory|killed/i.test(line)) {
        return color.red(line);
    }
    if (/warn/i.test(line)) {
        return color.yellow(line);
    }
    return color.gray(line);
}
