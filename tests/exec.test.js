import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackPromptsMockFactory } from './helpers/clack.js';
import { telemetryMockFactory } from './helpers/telemetry.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import {
    runExec,
    parseExecArgs,
    buildExecuteCommandArgs,
    hasSessionManagerPlugin,
    findRunningTask,
    resolveContainer,
    DEFAULT_SHELL,
} from '../src/commands/exec.js';
import {
    resolveCluster,
    resolveService,
} from '../src/utils/resolvers.js';
import { hasAwsCli } from '../src/utils/aws.js';
import { trackEvent } from '../src/core/telemetry.js';

vi.mock('@clack/prompts', () => clackPromptsMockFactory());

vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));

const {
    MockListTasksCommand,
    MockDescribeTasksCommand,
} = vi.hoisted(() => ({
    MockListTasksCommand: vi.fn(function (input) { Object.assign(this, input); }),
    MockDescribeTasksCommand: vi.fn(function (input) { Object.assign(this, input); }),
}));

vi.mock('@aws-sdk/client-ecs', () => ({
    ECSClient: vi.fn(function () { this.send = vi.fn(); }),
    ListTasksCommand: MockListTasksCommand,
    DescribeTasksCommand: MockDescribeTasksCommand,
}));

function mockEcsClient({ taskArns = [], tasks = [] } = {}) {
    return {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockListTasksCommand) return Promise.resolve({ taskArns });
            if (cmd instanceof MockDescribeTasksCommand) return Promise.resolve({ tasks });
            return Promise.resolve({});
        }),
    };
}

function mockSpawnImpl(calls, exitCode = 0) {
    return vi.fn((cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('close', exitCode));
        return child;
    });
}

describe('exec: CLI args', () => {
    it('parses cluster/service/container/command/region flags', () => {
        expect(parseExecArgs(['exec', '--cluster', 'c1', '--service', 's1', '--container', 'web', '--command', '/bin/bash', '--region', 'eu-west-1'])).toEqual({
            cluster: 'c1',
            service: 's1',
            container: 'web',
            command: '/bin/bash',
            region: 'eu-west-1',
        });
    });

    it('supports = syntax and bare exec', () => {
        expect(parseExecArgs(['exec', '--cluster=c1', '--region=us-west-2'])).toEqual({ cluster: 'c1', region: 'us-west-2' });
        expect(parseExecArgs(['exec'])).toEqual({});
    });

    it('treats the first positional as the service and flags the rest', () => {
        expect(parseExecArgs(['exec', 'web'])).toEqual({ service: 'web' });
        expect(parseExecArgs(['exec', 'web', 'bogus'])).toEqual({ service: 'web', unexpectedPositionals: ['bogus'] });
    });

    it('resolves names from project directory with env overrides', () => {
        expect(resolveCluster({ projectName: 'myapp' }, '/tmp')).toBe('myapp-cluster');
        expect(resolveService({ projectName: 'myapp' }, '/tmp')).toBe('myapp-service');
        expect(resolveContainer({ projectName: 'myapp' }, '/tmp')).toBe('myapp-container');
    });
});

describe('exec: AWS CLI command construction', () => {
    it('builds the exact execute-command arguments', () => {
        const args = buildExecuteCommandArgs({
            cluster: 'myapp-cluster',
            taskArn: 'arn:aws:ecs:us-east-2:123:task/myapp-cluster/abc',
            container: 'myapp-container',
            command: '/bin/sh',
            region: 'us-east-2',
        });
        expect(args).toEqual([
            'ecs', 'execute-command',
            '--cluster', 'myapp-cluster',
            '--task', 'arn:aws:ecs:us-east-2:123:task/myapp-cluster/abc',
            '--container', 'myapp-container',
            '--interactive',
            '--command', '/bin/sh',
            '--region', 'us-east-2',
        ]);
    });

    it('defaults to /bin/sh', () => {
        const args = buildExecuteCommandArgs({ cluster: 'c', taskArn: 't', container: 'web' });
        expect(args).toContain('/bin/sh');
        expect(DEFAULT_SHELL).toBe('/bin/sh');
    });

    it('detects a missing AWS CLI via spawnSync', () => {
        expect(hasAwsCli({ spawnSyncImpl: () => { throw new Error('ENOENT'); } })).toBe(false);
        expect(hasAwsCli({ spawnSyncImpl: () => ({ status: 0 }) })).toBe(true);
        expect(hasAwsCli({ spawnSyncImpl: () => ({ status: 1 }) })).toBe(false);
    });

    it('detects a missing Session Manager plugin via spawnSync', () => {
        expect(hasSessionManagerPlugin({ spawnSyncImpl: () => { throw new Error('ENOENT'); } })).toBe(false);
        const enoent = new Error('spawnSync session-manager-plugin ENOENT');
        enoent.code = 'ENOENT';
        expect(hasSessionManagerPlugin({ spawnSyncImpl: () => ({ error: enoent }) })).toBe(false);
        expect(hasSessionManagerPlugin({ spawnSyncImpl: () => ({}) })).toBe(true);
    });
});

describe('Command: exec (mocked ECS + spawn)', () => {
    let exitSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
    });

    afterEach(() => {
        exitSpy.mockRestore();
    });

    it('spawns aws ecs execute-command with inherited stdio on success', async () => {
        const taskArn = 'arn:aws:ecs:us-east-2:123:task/myapp-cluster/abc123';
        const ecsClient = mockEcsClient({
            taskArns: [taskArn],
            tasks: [{ taskArn, containers: [{ name: 'myapp-container', lastStatus: 'RUNNING' }] }],
        });
        const calls = [];
        const spawnImpl = mockSpawnImpl(calls, 0);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        try {
            const result = await runExec({
                projectName: 'myapp',
                region: 'us-east-2',
                ecsClient,
                spawnImpl,
                hasAwsCli: true,
                hasSsmPlugin: true,
            });
            expect(result.ok).toBe(true);
            expect(result.taskArn).toBe(taskArn);
            expect(exitSpy).not.toHaveBeenCalled();
            expect(spawnImpl).toHaveBeenCalledTimes(1);
            const [cmd, args, opts] = spawnImpl.mock.calls[0];
            expect(cmd).toBe('aws');
            expect(args).toEqual(expect.arrayContaining([
                'ecs', 'execute-command',
                '--cluster', 'myapp-cluster',
                '--task', taskArn,
                '--container', 'myapp-container',
                '--interactive',
                '--command', '/bin/sh',
            ]));
            expect(opts).toEqual(expect.objectContaining({ stdio: 'inherit' }));
            expect(calls).toHaveLength(1);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('exits gracefully when no tasks are running', async () => {
        const ecsClient = mockEcsClient({ taskArns: [], tasks: [] });
        const spawnImpl = mockSpawnImpl([], 0);
        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });

        try {
            const result = await runExec({
                projectName: 'myapp',
                region: 'us-east-2',
                ecsClient,
                spawnImpl,
                hasAwsCli: true,
                hasSsmPlugin: true,
            });
            expect(result.ok).toBe(false);
            expect(spawnImpl).not.toHaveBeenCalled();
            expect(output.join('\n')).toMatch(/running container is required|No running containers/i);
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('fails fast with install guidance when AWS CLI is missing', async () => {
        const ecsClient = mockEcsClient({ taskArns: ['t'], tasks: [] });
        const spawnImpl = mockSpawnImpl([], 0);
        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });

        try {
            const result = await runExec({
                projectName: 'myapp',
                region: 'us-east-2',
                ecsClient,
                spawnImpl,
                hasAwsCli: false,
            });
            expect(result.ok).toBe(false);
            expect(spawnImpl).not.toHaveBeenCalled();
            expect(ecsClient.send).not.toHaveBeenCalled();
            expect(output.join('\n')).toMatch(/AWS CLI not found/);
            expect(output.join('\n')).toMatch(/https:\/\//);
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('fails fast with platform guidance when the Session Manager plugin is missing', async () => {
        const ecsClient = mockEcsClient({ taskArns: ['t'], tasks: [] });
        const spawnImpl = mockSpawnImpl([], 0);
        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });

        try {
            const result = await runExec({
                projectName: 'myapp',
                region: 'us-east-2',
                ecsClient,
                spawnImpl,
                hasAwsCli: true,
                hasSsmPlugin: false,
            });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('ssm-plugin-missing');
            expect(spawnImpl).not.toHaveBeenCalled();
            expect(ecsClient.send).not.toHaveBeenCalled();
            expect(output.join('\n')).toMatch(/Session Manager plugin not found/);
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('finds a running task via ListTasks + DescribeTasks', async () => {
        const taskArn = 'arn:task/1';
        const ecsClient = mockEcsClient({
            taskArns: [taskArn],
            tasks: [{ taskArn, containers: [{ name: 'myapp-container' }] }],
        });
        const found = await findRunningTask(ecsClient, { cluster: 'myapp-cluster', service: 'myapp-service' });
        expect(found.taskArn).toBe(taskArn);
        expect(ecsClient.send).toHaveBeenCalledTimes(2);
    });

    it('returns null when no RUNNING tasks exist', async () => {
        const ecsClient = mockEcsClient({ taskArns: [] });
        await expect(findRunningTask(ecsClient, { cluster: 'c', service: 's' })).resolves.toBeNull();
    });

    it('is wired into bin/cli.js', () => {
        const cliPath = path.resolve(__dirname, '../bin/cli.js');
        const content = fs.readFileSync(cliPath, 'utf8');
        expect(content).toContain('runExec');
        expect(content).toContain("'exec'");
    });

    it('enables ECS Exec in Terraform templates with SSM permissions on the task role', () => {
        const mainTf = fs.readFileSync(path.resolve(__dirname, '../templates/terraform/main.tf'), 'utf8');
        expect(mainTf).toContain('enable_execute_command = true');
        for (const perm of [
            'ssmmessages:CreateControlChannel',
            'ssmmessages:CreateDataChannel',
            'ssmmessages:OpenControlChannel',
            'ssmmessages:OpenDataChannel',
        ]) {
            expect(mainTf).toContain(perm);
        }
        expect(mainTf).toMatch(/resource\s+"aws_iam_role_policy"\s+"ecs_exec"/);
        expect(mainTf).toMatch(/aws_iam_role\.task_role/);
    });
});

describe('exec: fuzzer hardening', () => {
    let exitSpy;
    let consoleSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });

    it('routes unresolvable projects through PROJECT_NOT_INITIALIZED', async () => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => { throw new Error('deleted'); });
        try {
            const result = await runExec(null);
            expect(result).toEqual({ ok: false, reason: 'project-not-initialized' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(trackEvent).toHaveBeenCalledWith('exec_run', expect.objectContaining({
                success: false,
                error_code: 'PROJECT_NOT_INITIALIZED',
            }));
        } finally {
            cwdSpy.mockRestore();
        }
    });

    it.each([null, 42, true, { port: 'string' }])('parseExecArgs(%s) returns defaults', (bad) => {
        expect(parseExecArgs(bad)).toEqual({});
    });
});

describe('exec on --target lambda projects', () => {
    let exitSpy;
    let logSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        exitSpy.mockRestore();
        logSpy.mockRestore();
    });

    it('fails gracefully with logs guidance instead of ECS Exec', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-lambda-test-'));
        try {
            fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'terraform', 'main.tf'),
                'locals {\n  app_name = "myapp${local.env_suffix}"\n}\nresource "aws_lambda_function" "app" {}\n'
            );
            const result = await runExec({ cwd: dir, hasAwsCli: true, hasSsmPlugin: true });
            expect(result).toMatchObject({ ok: false, reason: 'lambda-target-unsupported' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(trackEvent).toHaveBeenCalledWith('exec_run', expect.objectContaining({ error_code: 'LAMBDA_TARGET_UNSUPPORTED' }));
            expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('npx grada-run logs');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('exec on --target static projects', () => {
    let exitSpy;
    let logSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        exitSpy.mockRestore();
        logSpy.mockRestore();
    });

    it('fails cleanly instead of probing for ECS containers', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-static-test-'));
        try {
            fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'terraform', 'main.tf'),
                'locals {\n  app_name = "myapp"\n}\nresource "aws_cloudfront_distribution" "site" {}\n'
            );
            const result = await runExec({ cwd: dir, hasAwsCli: true, hasSsmPlugin: true });
            expect(result).toMatchObject({ ok: false, reason: 'static-target-unsupported' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(trackEvent).toHaveBeenCalledWith('exec_run', expect.objectContaining({ error_code: 'STATIC_TARGET_UNSUPPORTED' }));
            expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('ECS Exec is not supported on Lambda or Static targets');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
