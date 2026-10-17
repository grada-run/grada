import { spawnSync } from 'child_process';
import color from 'picocolors';
import { DescribeServicesCommand, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { resolveProjectName, readResourceSuffix } from './resolvers.js';
import { normalizeOptions } from './args.js';
import { AWS_CLI_INSTALL_URL } from './aws.js';

export const SESSION_MANAGER_PLUGIN_URL = 'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html';

// The container name an interactive command (exec, db connect) expects to
// find: explicit flag first, then ECS_CONTAINER, then the project default.
export function resolveContainer(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    if (typeof opts.container === 'string' && opts.container.trim()) return opts.container.trim();
    if (typeof opts.containerName === 'string' && opts.containerName.trim()) {
        return opts.containerName.trim();
    }
    if (typeof process.env.ECS_CONTAINER === 'string' && process.env.ECS_CONTAINER.trim()) {
        return process.env.ECS_CONTAINER.trim();
    }
    return `${resolveProjectName(opts, cwd)}${readResourceSuffix(cwd)}-container`;
}

// Shared active-service lookup: the service object when it exists and is
// ACTIVE, otherwise null. Never throws for a missing/inactive service;
// unexpected AWS errors propagate to the caller's catch block.
export async function fetchActiveService(ecsClient, clusterName, serviceName) {
    const resp = await ecsClient.send(
        new DescribeServicesCommand({ cluster: clusterName, services: [serviceName] })
    );
    const service = (resp.services || [])[0] || null;
    if (!service || service.status !== 'ACTIVE') return null;
    return service;
}

// `startedAt` is set when the task actually starts running. `createdAt`
// predates provisioning, so it must never stand in for uptime — a task
// without `startedAt` has not run yet and fails closed to 0.
export function taskStartedAtMs(task) {
    const stamp = task?.startedAt;
    if (stamp === undefined || stamp === null) return 0;
    return new Date(stamp).getTime() || 0;
}

// Newest actually-RUNNING task from a described batch.
// ListTasks({ desiredStatus: 'RUNNING' }) also returns tasks still
// PROVISIONING/PENDING toward that goal, and its order is arbitrary —
// so filter on lastStatus and compare start times instead of trusting
// position. `excludeUnhealthy` proves service recovery (diagnose); exec
// keeps unhealthy-but-running tasks (often the debug target).
export function pickNewestRunningTask(tasks = [], { excludeUnhealthy = false } = {}) {
    let newest = null;
    let newestStart = 0;
    for (const task of tasks || []) {
        if (task?.lastStatus !== 'RUNNING') continue;
        if (excludeUnhealthy && task?.healthStatus === 'UNHEALTHY') continue;
        const started = taskStartedAtMs(task);
        if (!newest || started > newestStart) {
            newest = task;
            newestStart = started;
        }
    }
    return newest;
}

// Container preference shared by the interactive commands: the expected
// name first, then the first RUNNING container, then the first entry.
// Works for both live tasks and task-definition `containerDefinitions`
// (which simply never match the RUNNING step).
export function pickRuntimeContainer(task, expectedName) {
    const containers = task?.containers || task?.containerDefinitions || [];
    if (containers.length === 0) return null;
    const exact = containers.find((c) => c.name === expectedName);
    if (exact) return exact;
    const running = containers.find((c) => c.lastStatus === 'RUNNING');
    if (running) return running;
    return containers[0];
}

export function hasSessionManagerPlugin(options = {}) {
    const runSync = options.spawnSyncImpl || spawnSync;
    try {
        const result = runSync('session-manager-plugin', ['--version'], { stdio: 'ignore' });
        if (result && result.error && result.error.code === 'ENOENT') return false;
        return true;
    } catch {
        return false;
    }
}

// Shared pre-flight guidance for the interactive ECS commands. `commandName`
// is the CLI verb shown in bold (`exec`, `db connect`); `purpose` completes
// the sentence ("needs the AWS CLI ... <purpose>.").
export function printAwsCliGuidance({ commandName = 'exec', purpose = 'to open a shell in your container' } = {}) {
    console.log(color.red('\n✖ AWS CLI not found.'));
    console.log(`  ${color.bold(commandName)} needs the AWS CLI (plus the Session Manager plugin) ${purpose}.`);
    console.log(`  Install the AWS CLI: ${color.blue(color.underline(AWS_CLI_INSTALL_URL))}`);
    console.log(`  Install the Session Manager plugin: ${color.blue(color.underline(SESSION_MANAGER_PLUGIN_URL))}`);
    console.log(color.dim('  Then run `aws sso login` (or `aws configure`) and try again.\n'));
}

export function printSessionManagerGuidance({ commandName = 'exec', purpose = 'to securely tunnel into your container' } = {}) {
    console.log(color.red('\n✖ AWS Session Manager plugin not found.'));
    console.log(`  ${color.bold(commandName)} requires a system-level AWS plugin ${purpose}.`);
    console.log(color.yellow('\n  To install it:'));

    if (process.platform === 'darwin') {
        console.log(`  Mac:   ${color.cyan('brew install session-manager-plugin')}`);
    } else if (process.platform === 'win32') {
        console.log(`  Win:   Download from ${color.blue(color.underline(`${SESSION_MANAGER_PLUGIN_URL}#install-plugin-windows`))}`);
    } else {
        console.log(`  Linux: See ${color.blue(color.underline(`${SESSION_MANAGER_PLUGIN_URL}#install-plugin-linux`))}`);
    }
    console.log('');
}

export function printNoTasksGuidance(service, cluster, reason = 'to open an interactive shell') {
    console.log(color.yellow('\n⚠ No running containers found.'));
    console.log(`  The ECS service ${color.cyan(service)} in cluster ${color.cyan(cluster)} has no RUNNING tasks.`);
    console.log(`  A running container is required ${reason}.`);
    console.log(`  Check status with ${color.green('npx grada-run status')}, then run ${color.green('npx grada-run apply')} to start your service.\n`);
}

// Distinct stopped tasks before a service-ready wait concludes crash-loop
// instead of slow start. One crash can be a flake; two is a pattern.
export const ECS_CRASH_LOOP_THRESHOLD = 2;

// Best-effort crash evidence for service-ready waits: lists STOPPED tasks
// per service and describes them, keeping only tasks that stopped after
// `sinceMs` (older stops predate the wait — e.g. sleep's own scale-to-0).
// Never throws: detection must not break the wait it informs.
export async function findRecentStoppedTasks({ ecsClient, cluster, services, sinceMs }) {
    try {
        const arns = [];
        for (const service of services || []) {
            const listed = await ecsClient.send(new ListTasksCommand({ cluster, serviceName: service, desiredStatus: 'STOPPED' }));
            arns.push(...(listed.taskArns || []));
        }
        if (arns.length === 0) return [];
        const described = await ecsClient.send(new DescribeTasksCommand({ cluster, tasks: arns }));
        return uniqueTasks(described.tasks).filter((task) => {
            const stoppedAt = task.stoppedAt instanceof Date ? task.stoppedAt.getTime() : Number(task.stoppedAt);
            return Number.isFinite(stoppedAt) && stoppedAt >= sinceMs;
        });
    } catch {
        return [];
    }
}

// Fatal container reasons on a PENDING task: the task will never start no
// matter how long the waiter waits (missing image, bad auth, dead
// registry path). A pending task with no (or any other) reason is still
// possibly starting and must NOT match.
const PENDING_FATAL_REASON_PATTERNS = [
    /cannotpullcontainererror/i,
    /inspectfailed/i,
    /imagepullbackoff/i,
    /unable to pull/i,
    /manifest unknown/i,
];

// Best-effort pull-failure evidence: PENDING tasks whose container reason
// matches a fatal pull pattern. Unlike stopped tasks there is no time
// filter — a pending task failing to pull right now is actionable no
// matter when it was created. Never throws.
export async function findPendingPullFailures({ ecsClient, cluster, services }) {
    try {
        const arns = [];
        for (const service of services || []) {
            const listed = await ecsClient.send(new ListTasksCommand({ cluster, serviceName: service, desiredStatus: 'PENDING' }));
            arns.push(...(listed.taskArns || []));
        }
        if (arns.length === 0) return [];
        const described = await ecsClient.send(new DescribeTasksCommand({ cluster, tasks: arns }));
        return uniqueTasks(described.tasks).filter((task) => {
            const reasons = (task.containers || []).map((container) => container?.reason || '');
            return reasons.some((reason) => PENDING_FATAL_REASON_PATTERNS.some((pattern) => pattern.test(reason)));
        });
    } catch {
        return [];
    }
}

function uniqueTasks(tasks) {
    const seen = new Set();
    return (tasks || []).filter((task) => {
        if (!task?.taskArn || seen.has(task.taskArn)) return false;
        seen.add(task.taskArn);
        return true;
    });
}

function mostRecentStopped(stopped) {
    return stopped.reduce((a, b) => {
        const aMs = a.stoppedAt instanceof Date ? a.stoppedAt.getTime() : Number(a.stoppedAt);
        const bMs = b.stoppedAt instanceof Date ? b.stoppedAt.getTime() : Number(b.stoppedAt);
        return bMs > aMs ? b : a;
    });
}

// One composed probe for service-ready waits. A single pending pull
// failure is already fatal (no threshold — an unpullable image never
// resolves by waiting) and takes precedence as the live blocker; the
// stopped-task crash loop stays thresholded. `kind` drives the
// short-circuit decision; `detail` is always the best cause found (even
// sub-threshold, for timeout messages). Returns `{ kind: null |
// 'pull-failure' | 'crash-loop', detail, stoppedTasks }`.
export async function detectTaskFailure({ ecsClient, cluster, services, sinceMs }) {
    const pending = await findPendingPullFailures({ ecsClient, cluster, services });
    const stopped = await findRecentStoppedTasks({ ecsClient, cluster, services, sinceMs });
    const detail = pending.length > 0
        ? formatTaskFailure(pending[0])
        : stopped.length > 0 ? formatTaskFailure(mostRecentStopped(stopped)) : null;
    if (pending.length > 0) {
        return { kind: 'pull-failure', detail, stoppedTasks: stopped.length };
    }
    if (stopped.length >= ECS_CRASH_LOOP_THRESHOLD) {
        return { kind: 'crash-loop', detail, stoppedTasks: stopped.length };
    }
    return { kind: null, detail, stoppedTasks: stopped.length };
}

// One-line human cause for a stopped task: the failed container's exit
// reason/code first, the task stoppedReason as fallback.
export function formatTaskFailure(task) {
    const containers = Array.isArray(task?.containers) ? task.containers : [];
    const failed = containers.find((c) => typeof c?.exitCode === 'number' && c.exitCode !== 0)
        || containers.find((c) => c?.reason);
    if (failed) {
        const reason = failed.reason || 'container exited';
        return typeof failed.exitCode === 'number' ? `${reason} (exit ${failed.exitCode})` : reason;
    }
    return task?.stoppedReason || 'unknown reason';
}
