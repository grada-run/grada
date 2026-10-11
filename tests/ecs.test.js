import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    SESSION_MANAGER_PLUGIN_URL,
    resolveContainer,
    hasSessionManagerPlugin,
    fetchActiveService,
    pickRuntimeContainer,
    printAwsCliGuidance,
    printSessionManagerGuidance,
    printNoTasksGuidance,
    findRecentStoppedTasks,
    findPendingPullFailures,
    detectTaskFailure,
    formatTaskFailure,
    ECS_CRASH_LOOP_THRESHOLD,
} from '../src/utils/ecs.js';

afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ECS_CONTAINER;
});

function capturedOutput(fn) {
    const lines = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
        lines.push(args.join(' '));
    });
    fn();
    return lines.join('\n');
}

describe('ecs shared module', () => {
    it('exposes the Session Manager plugin install URL', () => {
        expect(SESSION_MANAGER_PLUGIN_URL).toContain('session-manager-working-with-install-plugin.html');
    });

    it('resolveContainer prefers explicit flags, then ECS_CONTAINER, then project default', () => {
        expect(resolveContainer({ projectName: 'myapp' }, '/tmp')).toBe('myapp-container');
        expect(resolveContainer({ projectName: 'myapp', container: '  web  ' }, '/tmp')).toBe('web');
        expect(resolveContainer({ projectName: 'myapp', containerName: 'api' }, '/tmp')).toBe('api');
        process.env.ECS_CONTAINER = 'from-env';
        expect(resolveContainer({ projectName: 'myapp' }, '/tmp')).toBe('from-env');
    });

    it('hasSessionManagerPlugin reports ENOENT and spawn failures as missing', () => {
        const enoent = new Error('not found');
        enoent.code = 'ENOENT';
        expect(hasSessionManagerPlugin({ spawnSyncImpl: () => { throw new Error('boom'); } })).toBe(false);
        expect(hasSessionManagerPlugin({ spawnSyncImpl: () => ({ error: enoent }) })).toBe(false);
        expect(hasSessionManagerPlugin({ spawnSyncImpl: () => ({}) })).toBe(true);
    });

    it('printAwsCliGuidance defaults to exec wording', () => {
        const out = capturedOutput(() => printAwsCliGuidance());
        expect(out).toContain('exec');
        expect(out).toContain('to open a shell in your container.');
        expect(out).toContain(SESSION_MANAGER_PLUGIN_URL);
    });

    it('printAwsCliGuidance accepts per-command wording', () => {
        const out = capturedOutput(() => printAwsCliGuidance({
            commandName: 'db connect',
            purpose: 'to open a secure tunnel to your database',
        }));
        expect(out).toContain('db connect');
        expect(out).toContain('to open a secure tunnel to your database.');
    });

    it('printSessionManagerGuidance defaults to exec wording', () => {
        const out = capturedOutput(() => printSessionManagerGuidance());
        expect(out).toContain('exec');
        expect(out).toContain('to securely tunnel into your container.');
    });

    it('printSessionManagerGuidance accepts per-command wording', () => {
        const out = capturedOutput(() => printSessionManagerGuidance({
            commandName: 'db connect',
            purpose: 'to securely tunnel to your database',
        }));
        expect(out).toContain('db connect');
        expect(out).toContain('to securely tunnel to your database.');
    });

    it('printNoTasksGuidance names the service, cluster, and reason', () => {
        const out = capturedOutput(() => printNoTasksGuidance('svc', 'clu'));
        expect(out).toContain('svc');
        expect(out).toContain('clu');
        expect(out).toContain('to open an interactive shell.');
        const dbOut = capturedOutput(() => printNoTasksGuidance('svc', 'clu', 'to act as a jump host for the tunnel'));
        expect(dbOut).toContain('to act as a jump host for the tunnel.');
    });

    it('fetchActiveService returns the service only when ACTIVE', async () => {
        const active = { serviceName: 's', status: 'ACTIVE' };
        const seen = [];
        const client = {
            send: vi.fn((cmd) => {
                seen.push(cmd.input);
                return Promise.resolve({ services: [active] });
            }),
        };
        await expect(fetchActiveService(client, 'c', 's')).resolves.toBe(active);
        expect(seen[0]).toEqual({ cluster: 'c', services: ['s'] });

        const inactive = { send: vi.fn(() => Promise.resolve({ services: [{ status: 'INACTIVE' }] })) };
        await expect(fetchActiveService(inactive, 'c', 's')).resolves.toBeNull();
        const missing = { send: vi.fn(() => Promise.resolve({ services: [] })) };
        await expect(fetchActiveService(missing, 'c', 's')).resolves.toBeNull();
    });

    it('pickRuntimeContainer prefers the expected name, then RUNNING, then first', () => {
        const task = {
            containers: [
                { name: 'redis', lastStatus: 'RUNNING', runtimeId: 'rt-redis' },
                { name: 'myapp-container', lastStatus: 'RUNNING', runtimeId: 'rt-app' },
            ],
        };
        expect(pickRuntimeContainer(task, 'myapp-container').runtimeId).toBe('rt-app');
        expect(pickRuntimeContainer(task, 'missing').runtimeId).toBe('rt-redis');
        expect(pickRuntimeContainer({ containers: [{ name: 'only' }] }, 'missing').name).toBe('only');
        expect(pickRuntimeContainer({ containers: [] }, 'missing')).toBeNull();
    });

    it('pickRuntimeContainer also reads task-definition containerDefinitions', () => {
        const taskDef = { containerDefinitions: [{ name: 'a' }, { name: 'b' }] };
        expect(pickRuntimeContainer(taskDef, 'b').name).toBe('b');
        expect(pickRuntimeContainer(taskDef, 'missing').name).toBe('a');
        expect(pickRuntimeContainer({}, 'missing')).toBeNull();
    });

    it('resolveContainer appends the resource suffix on suffixed trees', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecs-sfx-'));
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), 'locals {\n  grada_resource_suffix = "-a1b2c3"\n}\n');
        expect(resolveContainer({ projectName: 'myapp' }, dir)).toBe('myapp-a1b2c3-container');
        expect(resolveContainer({ projectName: 'myapp' }, '/tmp')).toBe('myapp-container');
    });

    it.each([null, undefined, 'string', 42, true, { port: 'string' }])('resolveContainer(%s) behaves like {}', (bad) => {
        expect(resolveContainer(bad)).toBe(resolveContainer({}));
        expect(resolveContainer(bad, 42)).toBe(resolveContainer({}));
    });
});

describe('ecs crash detection', () => {
    const SINCE = 1_000_000;

    function stoppedTask(arn, stoppedAtMs, overrides = {}) {
        return {
            taskArn: arn,
            lastStatus: 'STOPPED',
            stoppedAt: new Date(stoppedAtMs),
            stoppedReason: 'Essential container in task exited',
            containers: [{ name: 'web', exitCode: 1, reason: 'Essential container in task exited' }],
            ...overrides,
        };
    }

    function mockEcsClient({ arnsByService = {}, tasksByArn = {}, listError = null, describeError = null } = {}) {
        return {
            send: vi.fn(async (command) => {
                const name = command.constructor.name;
                if (name === 'ListTasksCommand') {
                    if (listError) throw listError;
                    expect(['STOPPED', 'PENDING']).toContain(command.input.desiredStatus);
                    return { taskArns: arnsByService[command.input.serviceName] || [] };
                }
                if (name === 'DescribeTasksCommand') {
                    if (describeError) throw describeError;
                    return { tasks: (command.input.tasks || []).map((arn) => tasksByArn[arn]).filter(Boolean) };
                }
                throw new Error(`unexpected ECS command: ${name}`);
            }),
        };
    }

    it('exposes a crash-loop threshold above one (a single crash can be a flake)', () => {
        expect(ECS_CRASH_LOOP_THRESHOLD).toBe(2);
    });

    it('returns empty when no tasks stopped', async () => {
        const ecsClient = mockEcsClient();
        const found = await findRecentStoppedTasks({ ecsClient, cluster: 'c', services: ['svc'], sinceMs: SINCE });
        expect(found).toEqual([]);
    });

    it('ignores tasks stopped before the wait began (e.g. sleep scale-to-0)', async () => {
        const old = stoppedTask('arn-old', SINCE - 60_000);
        const ecsClient = mockEcsClient({ arnsByService: { svc: ['arn-old'] }, tasksByArn: { 'arn-old': old } });
        const found = await findRecentStoppedTasks({ ecsClient, cluster: 'c', services: ['svc'], sinceMs: SINCE });
        expect(found).toEqual([]);
    });

    it('aggregates fresh stops across services', async () => {
        const t1 = stoppedTask('arn-1', SINCE + 10_000);
        const t2 = stoppedTask('arn-2', SINCE + 20_000);
        const ecsClient = mockEcsClient({
            arnsByService: { 'svc-a': ['arn-1'], 'svc-b': ['arn-2'] },
            tasksByArn: { 'arn-1': t1, 'arn-2': t2 },
        });
        const found = await findRecentStoppedTasks({ ecsClient, cluster: 'c', services: ['svc-a', 'svc-b'], sinceMs: SINCE });
        expect(found.map((t) => t.taskArn)).toEqual(['arn-1', 'arn-2']);
    });

    it('dedupes tasks listed under multiple services', async () => {
        const t1 = stoppedTask('arn-1', SINCE + 10_000);
        const ecsClient = mockEcsClient({
            arnsByService: { 'svc-a': ['arn-1'], 'svc-b': ['arn-1'] },
            tasksByArn: { 'arn-1': t1 },
        });
        const found = await findRecentStoppedTasks({ ecsClient, cluster: 'c', services: ['svc-a', 'svc-b'], sinceMs: SINCE });
        expect(found.map((t) => t.taskArn)).toEqual(['arn-1']);
    });

    it('returns empty instead of throwing when the probe fails', async () => {
        const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        const listFail = mockEcsClient({ listError: denied });
        await expect(findRecentStoppedTasks({ ecsClient: listFail, cluster: 'c', services: ['svc'], sinceMs: SINCE })).resolves.toEqual([]);
        const describeFail = mockEcsClient({
            arnsByService: { svc: ['arn-1'] },
            tasksByArn: {},
            describeError: denied,
        });
        await expect(findRecentStoppedTasks({ ecsClient: describeFail, cluster: 'c', services: ['svc'], sinceMs: SINCE })).resolves.toEqual([]);
    });

    it.each([
        'CannotPullContainerError: Error response from daemon: manifest unknown',
        'cannotpullcontainererror: repository does not exist',
        'InspectFailed: failed to inspect image',
        'ImagePullBackOff: back-off pulling image',
        'unable to pull secrets or registry auth: execution resource retrieval failed',
    ])('flags a pending task with a fatal pull reason: %s', (reason) => {
        const pending = {
            taskArn: 'arn-pending',
            lastStatus: 'PENDING',
            containers: [{ name: 'web', reason }],
        };
        const ecsClient = mockEcsClient({
            arnsByService: { svc: ['arn-pending'] },
            tasksByArn: { 'arn-pending': pending },
        });
        return expect(findPendingPullFailures({ ecsClient, cluster: 'c', services: ['svc'] }))
            .resolves.toEqual([pending]);
    });

    it('ignores pending tasks with no reason (still starting)', async () => {
        const pending = { taskArn: 'arn-pending', lastStatus: 'PENDING', containers: [{ name: 'web' }] };
        const ecsClient = mockEcsClient({
            arnsByService: { svc: ['arn-pending'] },
            tasksByArn: { 'arn-pending': pending },
        });
        await expect(findPendingPullFailures({ ecsClient, cluster: 'c', services: ['svc'] })).resolves.toEqual([]);
    });

    it('returns empty instead of throwing when the pending probe fails', async () => {
        const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        const ecsClient = mockEcsClient({ listError: denied });
        await expect(findPendingPullFailures({ ecsClient, cluster: 'c', services: ['svc'] })).resolves.toEqual([]);
    });

    it('detectTaskFailure reports pull-failure for a single pending pull error', async () => {
        const pending = {
            taskArn: 'arn-pending',
            lastStatus: 'PENDING',
            containers: [{ name: 'web', reason: 'CannotPullContainerError: manifest unknown' }],
        };
        const ecsClient = {
            send: vi.fn(async (command) => {
                const name = command.constructor.name;
                if (name === 'ListTasksCommand') {
                    return { taskArns: command.input.desiredStatus === 'PENDING' ? ['arn-pending'] : [] };
                }
                if (name === 'DescribeTasksCommand') return { tasks: [pending] };
                throw new Error(`unexpected ECS command: ${name}`);
            }),
        };
        const found = await detectTaskFailure({ ecsClient, cluster: 'c', services: ['svc'], sinceMs: SINCE });
        expect(found.kind).toBe('pull-failure');
        expect(found.detail).toBe('CannotPullContainerError: manifest unknown');
    });

    it('detectTaskFailure reports crash-loop at the stopped threshold', async () => {
        const t1 = stoppedTask('arn-1', SINCE + 10_000);
        const t2 = stoppedTask('arn-2', SINCE + 20_000);
        const ecsClient = {
            send: vi.fn(async (command) => {
                const name = command.constructor.name;
                if (name === 'ListTasksCommand') {
                    return { taskArns: command.input.desiredStatus === 'STOPPED' ? ['arn-1', 'arn-2'] : [] };
                }
                if (name === 'DescribeTasksCommand') return { tasks: [t1, t2] };
                throw new Error(`unexpected ECS command: ${name}`);
            }),
        };
        const found = await detectTaskFailure({ ecsClient, cluster: 'c', services: ['svc'], sinceMs: SINCE });
        expect(found.kind).toBe('crash-loop');
        expect(found.detail).toBe('Essential container in task exited (exit 1)');
        expect(found.stoppedTasks).toBe(2);
    });

    it('detectTaskFailure prefers the live pull failure over older stops', async () => {
        const old = stoppedTask('arn-old', SINCE + 10_000);
        const pending = {
            taskArn: 'arn-pending',
            lastStatus: 'PENDING',
            containers: [{ name: 'web', reason: 'CannotPullContainerError: manifest unknown' }],
        };
        const ecsClient = {
            send: vi.fn(async (command) => {
                const name = command.constructor.name;
                if (name === 'ListTasksCommand') {
                    return { taskArns: command.input.desiredStatus === 'PENDING' ? ['arn-pending'] : ['arn-old'] };
                }
                if (name === 'DescribeTasksCommand') {
                    const wantPending = (command.input.tasks || []).includes('arn-pending');
                    return { tasks: wantPending ? [pending] : [old] };
                }
                throw new Error(`unexpected ECS command: ${name}`);
            }),
        };
        const found = await detectTaskFailure({ ecsClient, cluster: 'c', services: ['svc'], sinceMs: SINCE });
        expect(found.kind).toBe('pull-failure');
        expect(found.detail).toBe('CannotPullContainerError: manifest unknown');
    });

    it('detectTaskFailure reports nothing below every threshold', async () => {
        const ecsClient = mockEcsClient();
        const found = await detectTaskFailure({ ecsClient, cluster: 'c', services: ['svc'], sinceMs: SINCE });
        expect(found).toEqual({ kind: null, detail: null, stoppedTasks: 0 });
    });

    it('detectTaskFailure still names a lone sub-threshold stop for timeout messages', async () => {
        const t1 = stoppedTask('arn-1', SINCE + 10_000);
        const ecsClient = {
            send: vi.fn(async (command) => {
                const name = command.constructor.name;
                if (name === 'ListTasksCommand') {
                    return { taskArns: command.input.desiredStatus === 'STOPPED' ? ['arn-1'] : [] };
                }
                if (name === 'DescribeTasksCommand') return { tasks: [t1] };
                throw new Error(`unexpected ECS command: ${name}`);
            }),
        };
        const found = await detectTaskFailure({ ecsClient, cluster: 'c', services: ['svc'], sinceMs: SINCE });
        expect(found).toEqual({
            kind: null,
            detail: 'Essential container in task exited (exit 1)',
            stoppedTasks: 1,
        });
    });

    it('formatTaskFailure prefers the container exit reason and code', () => {
        expect(formatTaskFailure(stoppedTask('arn', SINCE))).toBe('Essential container in task exited (exit 1)');
    });

    it('formatTaskFailure falls back to the task stoppedReason, then unknown', () => {
        expect(formatTaskFailure(stoppedTask('arn', SINCE, { containers: [], stoppedReason: 'Task failed to start' })))
            .toBe('Task failed to start');
        expect(formatTaskFailure(stoppedTask('arn', SINCE, { containers: [], stoppedReason: '' }))).toBe('unknown reason');
        expect(formatTaskFailure(null)).toBe('unknown reason');
    });
});
