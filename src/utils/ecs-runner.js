import {
    DescribeTasksCommand,
    DescribeTaskDefinitionCommand,
    RunTaskCommand,
    StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { FilterLogEventsCommand, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import color from 'picocolors';
import { fetchActiveService, pickRuntimeContainer } from './ecs.js';
import { sleep, pollUntil } from './system.js';
import { truncateSpinnerText } from './spinner-text.js';
import { isNotFoundError, buildLogStreamName } from '../commands/logs.js';

export const DEFAULT_RUNNER_POLL_INTERVAL_MS = 2000;
export const DEFAULT_RUNNER_FLUSH_MAX_POLLS = 6;
export const DEFAULT_RUNNER_FLUSH_INTERVAL_MS = 1000;

function capNoun(noun) {
    const text = String(noun || 'migration');
    return text.charAt(0).toUpperCase() + text.slice(1);
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

// Runs a one-off Fargate task from the service's task definition, streams
// its CloudWatch logs live, and resolves with the container outcome.
// Shared by `db migrate` and `db enable-vector` so the RunTask / poll /
// log-streaming / SIGINT lifecycle lives in exactly one place.
//
// Outcomes (the spinner is left running on failure paths so the caller can
// stop it with command-specific wording before reporting):
//   { ok: true, taskArn, exitCode, stoppedReason }
//   { ok: false, code: 'ECS_SERVICE_NOT_FOUND' }
//   { ok: false, code: 'NO_VPC_CONFIG' }
//   { ok: false, code: 'CONTAINER_NOT_FOUND', targetTaskDef, available: [names] }
//   { ok: false, code: 'RUN_TASK_FAILED', reason }
//   { ok: false, code: 'TIMEOUT', taskArn } (task stop attempted best-effort)
//
// `command` is the container override: either the array itself or a builder
// `(containerDef) => string[]` invoked with the selected task-definition
// container (so callers can synthesize env-dependent commands without a
// second DescribeTaskDefinition call).
export async function runEphemeralEcsTask({
    ecsClient,
    logsClient,
    cluster,
    service,
    containerName,
    taskDef = null,
    command,
    startedBy,
    logGroupName,
    timeoutMs,
    timeoutSeconds,
    pollIntervalMs = DEFAULT_RUNNER_POLL_INTERVAL_MS,
    maxFlushPolls = DEFAULT_RUNNER_FLUSH_MAX_POLLS,
    flushIntervalMs = DEFAULT_RUNNER_FLUSH_INTERVAL_MS,
    spinner = null,
    taskNoun = 'migration',
}) {
    const label = capNoun(taskNoun);
    let taskArn = null;
    const onSigint = () => {
        if (taskArn) {
            ecsClient.send(new StopTaskCommand({
                cluster,
                task: taskArn,
                reason: 'Cancelled by user via SIGINT',
            })).catch(() => {});
        }
        process.exit(130);
    };

    const serviceDesc = await fetchActiveService(ecsClient, cluster, service);
    if (!serviceDesc) {
        return { ok: false, code: 'ECS_SERVICE_NOT_FOUND' };
    }

    const vpcConfig = serviceDesc.networkConfiguration?.awsvpcConfiguration;
    const subnets = vpcConfig?.subnets || [];
    const securityGroups = vpcConfig?.securityGroups || [];
    if (subnets.length === 0 || securityGroups.length === 0) {
        return { ok: false, code: 'NO_VPC_CONFIG' };
    }
    // Mirror the service's own placement; the generated service uses
    // public subnets with ENABLED, custom private-subnet services inherit
    // their own value instead of a hard-coded default.
    const assignPublicIp = vpcConfig.assignPublicIp || 'ENABLED';

    const targetTaskDef = (typeof taskDef === 'string' && taskDef.trim())
        ? taskDef.trim()
        : serviceDesc.taskDefinition;
    const taskDefResp = await ecsClient.send(
        new DescribeTaskDefinitionCommand({ taskDefinition: targetTaskDef })
    );
    const selected = pickRuntimeContainer(taskDefResp.taskDefinition, containerName);
    if (!selected || selected.name !== containerName) {
        return {
            ok: false,
            code: 'CONTAINER_NOT_FOUND',
            targetTaskDef,
            available: (taskDefResp.taskDefinition?.containerDefinitions || []).map((c) => c.name),
        };
    }

    // Stream coordinates from the task definition itself so custom log
    // drivers, groups, and stream prefixes always match the live tail.
    let groupName = logGroupName;
    const logOptions = selected.logConfiguration?.options || {};
    if (typeof logOptions['awslogs-group'] === 'string' && logOptions['awslogs-group']) {
        groupName = logOptions['awslogs-group'];
    }
    let logStreamPrefix = 'ecs';
    if (typeof logOptions['awslogs-stream-prefix'] === 'string' && logOptions['awslogs-stream-prefix']) {
        logStreamPrefix = logOptions['awslogs-stream-prefix'];
    }
    const overrideCommand = typeof command === 'function' ? command(selected) : command;
    const runResp = await ecsClient.send(new RunTaskCommand({
        cluster,
        taskDefinition: targetTaskDef,
        launchType: 'FARGATE',
        networkConfiguration: { awsvpcConfiguration: { subnets, securityGroups, assignPublicIp } },
        startedBy,
        overrides: { containerOverrides: [{ name: containerName, command: overrideCommand }] },
    }));
    taskArn = runResp.tasks?.[0]?.taskArn || null;
    if (!taskArn || (runResp.failures || []).length > 0) {
        const failureReason = runResp.failures?.[0]?.reason || 'no task ARN returned';
        taskArn = null;
        return { ok: false, code: 'RUN_TASK_FAILED', reason: failureReason };
    }
    const taskId = taskArn.split('/').pop();
    const logStreamName = buildLogStreamName(containerName, taskId, logStreamPrefix);
    const seen = new Set();

    // Registered immediately so Ctrl+C aborts even while provisioning;
    // the task line itself prints once the spinner stops (below) so the
    // two never share a terminal line.
    process.once('SIGINT', onSigint);

    let finalTask = null;
    let streaming = false;
    let lastPhase = null;
    const shortTaskId = taskId.slice(0, 8);
    const phaseMessage = (status) => {
        if (status === 'PROVISIONING' || status === 'PENDING' || status === 'ACTIVATING') {
            return `Starting ${taskNoun} task (${status}, ${shortTaskId})...`;
        }
        return `Waiting on Fargate task (${status}, ${shortTaskId})...`;
    };
    // Strict by name only — never the containers[0] fallback: a sidecar
    // finishing first must not end the run early.
    const matchContainerStrict = (task) => {
        const list = task?.containers || [];
        return list.find((c) => c.name === containerName) || null;
    };
    try {
        const outcome = await pollUntil({
            intervalMs: pollIntervalMs,
            timeoutMs,
            onTick: async () => {
                await fetchNewLogEvents({ logsClient, logGroupName: groupName, logStreamName, seen });
                const descResp = await ecsClient.send(
                    new DescribeTasksCommand({ cluster, tasks: [taskArn] })
                );
                const task = (descResp.tasks || [])[0] || null;
                const status = task?.lastStatus;
                const match = matchContainerStrict(task);
                const containerDone = !!match
                    && match.lastStatus === 'STOPPED'
                    && typeof match.exitCode === 'number';
                if ((task && status === 'STOPPED') || containerDone) {
                    // Flush CloudWatch (retrying while nothing has printed
                    // yet: Fargate ingestion lags several seconds), then
                    // stop the task if Fargate has not already done so.
                    for (let attempt = 0; ; attempt++) {
                        await flushRemainingLogs({ logsClient, logGroupName: groupName, logStreamName, seen });
                        if (seen.size > 0 || attempt + 1 >= maxFlushPolls) break;
                        await sleep(flushIntervalMs);
                    }
                    if (task?.lastStatus !== 'STOPPED') {
                        try {
                            await ecsClient.send(new StopTaskCommand({
                                cluster,
                                task: taskArn,
                                reason: `${label} container finished; stopping task`,
                            }));
                        } catch {
                            // Best-effort: the result below is authoritative.
                        }
                    }
                    if (!streaming) spinner?.stop(`${label} task stopped.`);
                    return { done: true, value: task };
                }
                if (status === 'RUNNING' && !streaming) {
                    streaming = true;
                    spinner?.stop(color.green(`${label} container running. Streaming logs...`));
                    console.log(color.dim(`  task ${taskId} — press Ctrl+C to abort and stop the remote task.\n`));
                } else if (!streaming && status && status !== lastPhase) {
                    lastPhase = status;
                    spinner?.message(truncateSpinnerText(phaseMessage(status)));
                }
                return { done: false };
            },
        });
        if (outcome.timedOut) {
            try {
                await ecsClient.send(new StopTaskCommand({
                    cluster,
                    task: taskArn,
                    reason: `${label} timed out after ${timeoutSeconds}s`,
                }));
            } catch {
                // Best-effort: the timeout below is authoritative.
            }
            return { ok: false, code: 'TIMEOUT', taskArn };
        }
        finalTask = outcome.value;
    } finally {
        process.removeListener('SIGINT', onSigint);
    }

    const containers = finalTask?.containers || [];
    const match = containers.find((c) => c.name === containerName) || containers[0];
    const exitCode = match?.exitCode;
    const stoppedReason = match?.reason || finalTask?.stoppedReason || 'unknown';
    return { ok: true, taskArn, exitCode, stoppedReason };
}
