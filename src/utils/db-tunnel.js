import { ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { spawnSync } from 'child_process';
import net from 'node:net';
import { pickRuntimeContainer, pickNewestRunningTask } from './ecs.js';
import { pollUntil } from './system.js';

// SSM port-forwarding session arguments for tunneling to a database
// through an ECS container. `remotePort` is the database port (5432 for
// PostgreSQL/Aurora, 3306 for MySQL); `localPort` is the loopback port.
export function buildSsmArgs({ cluster, taskId, runtimeId, dbHost, remotePort = '5432', localPort, region }) {
    const args = [
        'ssm', 'start-session',
        '--target', `ecs:${cluster}_${taskId}_${runtimeId}`,
        '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
        '--parameters', `{"host":["${dbHost}"],"portNumber":["${remotePort}"],"localPortNumber":["${localPort}"]}`,
    ];
    if (region) args.push('--region', region);
    return args;
}

// Fetches the managed master credentials for `secretArn`. Returns
// `{ username, password }`, or `null` when the secret is missing or
// malformed (callers report SECRET_MALFORMED).
export async function fetchManagedDbCredentials(secretsClient, secretArn) {
    const secretResp = await secretsClient.send(
        new GetSecretValueCommand({ SecretId: secretArn })
    );
    try {
        const parsed = JSON.parse(secretResp.SecretString || '{}');
        if (parsed.username && parsed.password) {
            return { username: parsed.username, password: parsed.password };
        }
        return null;
    } catch {
        return null;
    }
}

// Picks a running ECS task to act as the SSM jump host. Returns
// `{ taskArn, taskId, containerName, runtimeId }`, or `{ error }` with
// `NO_RUNNING_TASKS` / `NO_RUNTIME_ID` for the caller to report.
export async function findJumpHostTarget(ecsClient, { cluster, service, expectedContainer }) {
    const listResp = await ecsClient.send(
        new ListTasksCommand({ cluster, serviceName: service, desiredStatus: 'RUNNING', maxResults: 10 })
    );
    const taskArns = listResp.taskArns || [];
    if (taskArns.length === 0) return { error: 'NO_RUNNING_TASKS' };
    // ListTasks order is arbitrary and desiredStatus RUNNING still
    // returns tasks PROVISIONING/PENDING toward that goal — describe the
    // batch and pick the newest actually-RUNNING task with a runtimeId
    // instead of trusting arns[0].
    const descResp = await ecsClient.send(
        new DescribeTasksCommand({ cluster, tasks: taskArns.slice(0, 10) })
    );
    const described = descResp.tasks || [];
    const withRuntime = described.filter(
        (candidate) => pickRuntimeContainer(candidate, expectedContainer)?.runtimeId
    );
    const task = pickNewestRunningTask(withRuntime);
    if (!task?.taskArn) {
        const anyRunning = described.some((candidate) => candidate?.lastStatus === 'RUNNING');
        return { error: anyRunning ? 'NO_RUNTIME_ID' : 'NO_RUNNING_TASKS' };
    }
    const container = pickRuntimeContainer(task, expectedContainer);
    const runtimeId = container?.runtimeId;
    return {
        taskArn: task.taskArn,
        taskId: task.taskArn.split('/').pop(),
        containerName: container?.name,
        runtimeId,
    };
}

function probeTcpPort(host, port, timeoutMs = 2000) {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (open) => {
            socket.destroy();
            resolve(open);
        };
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
        socket.setTimeout(timeoutMs, () => done(false));
    });
}

// Waits until `host:port` accepts TCP connections (an SSM tunnel coming
// up). Resolves `{ done: true }`, or `{ timedOut: true }` after `timeoutMs`.
export async function waitForTcpPort(host, port, { timeoutMs = 30000, pollIntervalMs = 500 } = {}) {
    return pollUntil({
        intervalMs: pollIntervalMs,
        timeoutMs,
        onTick: async () => {
            const open = await probeTcpPort(host, port);
            return open ? { done: true, value: true } : { done: false };
        },
    });
}

// Allocates an ephemeral free loopback port so background tunnels never
// collide with a local Postgres/MySQL on 5432/3306.
export function getFreeLocalPort(host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, host, () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

// Masks the password in a `scheme://user:password@host/...` URI for safe
// terminal and error output. URIs without userinfo pass through unchanged.
export function redactUri(uri) {
    const text = String(uri ?? '');
    const schemeIdx = text.indexOf('://');
    if (schemeIdx === -1) return text;
    const authStart = schemeIdx + 3;
    const slashIdx = text.indexOf('/', authStart);
    const authEnd = slashIdx === -1 ? text.length : slashIdx;
    const authority = text.slice(authStart, authEnd);
    const atIdx = authority.lastIndexOf('@');
    if (atIdx === -1) return text;
    const userinfo = authority.slice(0, atIdx);
    const colonIdx = userinfo.indexOf(':');
    if (colonIdx === -1) return text;
    return text.slice(0, authStart) + userinfo.slice(0, colonIdx) + ':****' + text.slice(authStart + atIdx);
}

// Parses a `--from` source URI into discrete connection parts (so passwords
// travel via process env, never argv). Returns `{ scheme, user, password,
// host, port, database }`, or `null` when the URI is unusable.
export function parseSourceUri(uri) {
    const text = String(uri ?? '').trim();
    const match = /^(postgres(?:ql)?|mysql):\/\/(.*)$/i.exec(text);
    if (!match) return null;
    const scheme = match[1].toLowerCase() === 'mysql' ? 'mysql' : 'postgresql';
    let parsed;
    try {
        // WHATWG URL requires a valid scheme; normalize postgres:// first.
        parsed = new URL(text.replace(/^[a-z]+:\/\//i, `${scheme}://`));
    } catch {
        return null;
    }
    if (!parsed.hostname) return null;
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
    if (!database) return null;
    return {
        scheme,
        user: decodeURIComponent(parsed.username || ''),
        password: decodeURIComponent(parsed.password || ''),
        host: parsed.hostname,
        port: parsed.port || (scheme === 'mysql' ? '3306' : '5432'),
        database,
    };
}

// Reports which of `names` are missing from PATH (via `<bin> --version`,
// mirroring the Session Manager plugin check). Pure ENOENT detection:
// a binary that spawns at all counts as present.
export function findMissingBinaries(names, { spawnSyncImpl = spawnSync } = {}) {
    const missing = [];
    for (const name of names || []) {
        try {
            const result = spawnSyncImpl(name, ['--version'], { stdio: 'ignore' });
            if (result && result.error && result.error.code === 'ENOENT') missing.push(name);
        } catch {
            missing.push(name);
        }
    }
    return missing;
}
