import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { mockText } from './helpers/clack.js';
import { mockTrackEvent } from './helpers/telemetry.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stripVTControlCharacters } from 'node:util';
import { runRun, parseRunArgs } from '../src/commands/run.js';

const {
    MockDescribeTasksCommand,
    MockDescribeServicesCommand,
    MockDescribeTaskDefinitionCommand,
    MockRunTaskCommand,
    MockStopTaskCommand,
    MockFilterLogEventsCommand,
    MockGetLogEventsCommand,
} = vi.hoisted(() => {
    const cmd = () => vi.fn(function (input) { Object.assign(this, input); });
    return {
        MockDescribeTasksCommand: cmd(),
        MockDescribeServicesCommand: cmd(),
        MockDescribeTaskDefinitionCommand: cmd(),
        MockRunTaskCommand: cmd(),
        MockStopTaskCommand: cmd(),
        MockFilterLogEventsCommand: cmd(),
        MockGetLogEventsCommand: cmd(),
    };
});

vi.mock('@aws-sdk/client-ecs', () => ({
    ECSClient: vi.fn(function () { this.send = vi.fn(); }),
    DescribeTasksCommand: MockDescribeTasksCommand,
    DescribeServicesCommand: MockDescribeServicesCommand,
    DescribeTaskDefinitionCommand: MockDescribeTaskDefinitionCommand,
    RunTaskCommand: MockRunTaskCommand,
    StopTaskCommand: MockStopTaskCommand,
}));

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
    CloudWatchLogsClient: vi.fn(function () { this.send = vi.fn(); }),
    FilterLogEventsCommand: MockFilterLogEventsCommand,
    GetLogEventsCommand: MockGetLogEventsCommand,
}));

const RUN_TASK_ARN = 'arn:aws:ecs:us-east-2:123456789012:task/myapp-cluster/run123abc';

function activeServiceDesc(overrides = {}) {
    return {
        serviceName: 'myapp-service',
        status: 'ACTIVE',
        taskDefinition: 'arn:aws:ecs:us-east-2:123456789012:task-definition/myapp-task:7',
        networkConfiguration: {
            awsvpcConfiguration: { subnets: ['sub-1', 'sub-2'], securityGroups: ['sg-1'], assignPublicIp: 'ENABLED' },
        },
        ...overrides,
    };
}

function runningTask() {
    return { taskArn: RUN_TASK_ARN, lastStatus: 'RUNNING', containers: [{ name: 'myapp-container' }] };
}

function stoppedTask(exitCode, reason = 'Essential container exited') {
    const container = exitCode === undefined
        ? { name: 'myapp-container', reason }
        : { name: 'myapp-container', exitCode, reason };
    return { taskArn: RUN_TASK_ARN, lastStatus: 'STOPPED', stoppedReason: 'task-level', containers: [container] };
}

function mockEcsRunClient({
    service = activeServiceDesc(),
    taskDefNames = ['myapp-container'],
    containerDefinitions = null,
    runTasks = [{ taskArn: RUN_TASK_ARN }],
    failures = [],
    taskSequence = [],
} = {}) {
    const queue = [...taskSequence];
    const runs = [];
    const stops = [];
    const client = {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockDescribeServicesCommand) {
                return Promise.resolve({ services: service ? [service] : [] });
            }
            if (cmd instanceof MockDescribeTaskDefinitionCommand) {
                const defs = containerDefinitions || taskDefNames.map((name) => ({ name }));
                return Promise.resolve({ taskDefinition: { containerDefinitions: defs } });
            }
            if (cmd instanceof MockRunTaskCommand) {
                runs.push(cmd);
                return Promise.resolve({ tasks: runTasks, failures });
            }
            if (cmd instanceof MockDescribeTasksCommand) {
                const next = queue.length > 0 ? queue.shift() : runningTask();
                return Promise.resolve({ tasks: [next] });
            }
            if (cmd instanceof MockStopTaskCommand) {
                stops.push(cmd);
                return Promise.resolve({});
            }
            return Promise.resolve({});
        }),
        runs,
        stops,
    };
    return client;
}

function mockLogsClient(script = [], flushScript = []) {
    const queue = [...script];
    const flushQueue = [...flushScript];
    const client = {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockGetLogEventsCommand) {
                const next = flushQueue.length > 0 ? flushQueue.shift() : { events: [] };
                return Promise.resolve({ events: next.events || [], nextForwardToken: next.nextForwardToken });
            }
            const next = queue.length > 0 ? queue.shift() : { events: [] };
            return Promise.resolve({ events: next.events || [] });
        }),
    };
    return client;
}

function runOptions(overrides = {}) {
    return {
        projectName: 'myapp',
        region: 'us-east-2',
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-')),
        cmd: 'echo hello',
        isHeadless: true,
        pollIntervalMs: 5,
        flushIntervalMs: 0,
        ...overrides,
    };
}

describe('run: CLI args', () => {
    it('parses the full migrate-parity flag surface', () => {
        expect(parseRunArgs(['run', '--cmd', 'echo hello', '--task-def', 'myapp:9', '--timeout', '120',
            '--project-name', 'myapp', '--region', 'eu-west-1', '--workspace', 'pr-7',
            '--cluster', 'c', '--service', 's', '--container', 'web', '--headless'])).toEqual({
            cmd: 'echo hello',
            taskDef: 'myapp:9',
            timeout: '120',
            projectName: 'myapp',
            region: 'eu-west-1',
            workspace: 'pr-7',
            cluster: 'c',
            service: 's',
            container: 'web',
            headless: true,
        });
    });

    it('supports = syntax and bare run', () => {
        expect(parseRunArgs(['run', '--cluster=c1', '--region=us-west-2'])).toEqual({ cluster: 'c1', region: 'us-west-2' });
        expect(parseRunArgs(['run'])).toEqual({});
    });

    it('greedily consumes dash-leading --cmd values', () => {
        const out = parseRunArgs(['run', '--cmd', '--dry-run']);
        expect(out.cmd).toBe('--dry-run');
        expect(out.unknownFlags).toBeUndefined();
    });

    it('flags positionals and unknown flags', () => {
        expect(parseRunArgs(['run', '--cmd', 'echo hi', 'bogus']).unexpectedPositionals).toEqual(['bogus']);
        expect(parseRunArgs(['run', '--bogus-flag']).unknownFlags).toEqual(['--bogus-flag']);
    });
});

describe('Command: run (mocked AWS)', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
        mockText.mockReset();
        output = [];
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });
    });

    afterEach(() => {
        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });

    function assertNoCmdLeak(cmd) {
        const serialized = JSON.stringify(mockTrackEvent.mock.calls);
        expect(serialized).not.toContain(cmd);
    }

    it('fails fast on invalid --timeout before AWS calls', async () => {
        const ecsClient = mockEcsRunClient();
        const result = await runRun(runOptions({ timeout: 'soon', ecsClient, logsClient: mockLogsClient() }));
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('invalid-timeout');
        expect(ecsClient.send).not.toHaveBeenCalled();
        expect(mockTrackEvent).toHaveBeenCalledWith('run_run', expect.objectContaining({
            success: false, error_code: 'INVALID_TIMEOUT',
        }));
    });

    it('refuses unknown flags without AWS calls', async () => {
        const ecsClient = mockEcsRunClient();
        const result = await runRun(runOptions({ unknownFlags: ['--bogus'], ecsClient, logsClient: mockLogsClient() }));
        expect(result.reason).toBe('unknown-flag');
        expect(ecsClient.send).not.toHaveBeenCalled();
    });

    it('guides multi-word --cmd values on unexpected positionals', async () => {
        const ecsClient = mockEcsRunClient();
        const result = await runRun(runOptions({ unexpectedPositionals: ['hello'], ecsClient, logsClient: mockLogsClient() }));
        expect(result.reason).toBe('unexpected-positional-args');
        expect(ecsClient.send).not.toHaveBeenCalled();
        expect(stripVTControlCharacters(output.join('\n'))).toContain('Wrap multi-word --cmd values in quotes');
    });

    it('headless without --cmd fails closed with a named error', async () => {
        const ecsClient = mockEcsRunClient();
        const { cmd: _cmd, ...noCmd } = runOptions({ ecsClient, logsClient: mockLogsClient() });
        const result = await runRun(noCmd);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('missing-run-cmd');
        expect(ecsClient.send).not.toHaveBeenCalled();
        expect(mockTrackEvent).toHaveBeenCalledWith('run_run', expect.objectContaining({
            success: false, error_code: 'MISSING_RUN_CMD',
        }));
    });

    it('interactive without --cmd prompts and runs the answer', async () => {
        const ecsClient = mockEcsRunClient({ taskSequence: [stoppedTask(0)] });
        mockText.mockResolvedValueOnce('node ./dist/backfill.cjs');
        const { cmd: _cmd, ...noCmd } = runOptions({
            cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'run-prompt-')),
            isHeadless: false, ecsClient, logsClient: mockLogsClient(),
        });
        const result = await runRun(noCmd);
        expect(result.success).toBe(true);
        expect(mockText).toHaveBeenCalledWith(expect.objectContaining({ message: 'Command to run inside the VPC:' }));
        expect(ecsClient.runs[0].overrides.containerOverrides[0].command[2]).toBe('node ./dist/backfill.cjs');
        expect(mockTrackEvent).toHaveBeenCalledWith('run_run', expect.objectContaining({ cmd_source: 'prompted' }));
        assertNoCmdLeak('node ./dist/backfill.cjs');
    });

    it('prompt cancellation stops before AWS calls', async () => {
        const ecsClient = mockEcsRunClient();
        mockText.mockResolvedValueOnce(Symbol('clack-cancel'));
        const { cmd: _cmd, ...noCmd } = runOptions({ isHeadless: false, ecsClient, logsClient: mockLogsClient() });
        const result = await runRun(noCmd);
        expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'cancelled' }));
        expect(ecsClient.send).not.toHaveBeenCalled();
    });

    it('runs headless with --cmd, streams logs, and exits 0', async () => {
        const ecsClient = mockEcsRunClient({ taskSequence: [stoppedTask(0)] });
        const logsClient = mockLogsClient(
            [{ events: [{ timestamp: 1, message: 'hello\n' }] }],
            [{ events: [] }]
        );
        const result = await runRun(runOptions({ ecsClient, logsClient }));
        expect(result).toEqual(expect.objectContaining({ ok: true, success: true, exitCode: 0 }));
        expect(result.taskArn).toBe(RUN_TASK_ARN);
        expect(ecsClient.runs).toHaveLength(1);
        expect(ecsClient.runs[0].startedBy).toBe('grada-run');
        expect(ecsClient.runs[0].overrides.containerOverrides[0].command).toEqual(['sh', '-c', 'echo hello']);
        expect(stripVTControlCharacters(output.join('\n'))).toContain('hello');
        expect(mockTrackEvent).toHaveBeenCalledWith('run_run', expect.objectContaining({ success: true, cmd_source: 'explicit' }));
        assertNoCmdLeak('echo hello');
    });

    it('propagates a crashing exit code to the CLI', async () => {
        const ecsClient = mockEcsRunClient({ taskSequence: [stoppedTask(3, 'backfill boom')] });
        const result = await runRun(runOptions({ cmd: 'exit 3', ecsClient, logsClient: mockLogsClient() }));
        expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'run-command-failed' }));
        expect(exitSpy).toHaveBeenCalledWith(3);
        expect(mockTrackEvent).toHaveBeenCalledWith('run_run', expect.objectContaining({
            success: false, error_code: 'RUN_COMMAND_FAILED', exit_code: 3,
        }));
        expect(stripVTControlCharacters(output.join('\n'))).toContain('exit code 3');
    });

    it('synthesizes DATABASE_URL for containers with discrete DB credentials', async () => {
        const ecsClient = mockEcsRunClient({
            taskSequence: [stoppedTask(0)],
            containerDefinitions: [{
                name: 'myapp-container',
                environment: [
                    { name: 'DB_HOST', value: 'db.internal' },
                    { name: 'DB_USER', value: 'app' },
                    { name: 'DB_PASSWORD', value: 'secret' },
                ],
                secrets: [],
            }],
        });
        const result = await runRun(runOptions({ cmd: 'node ./dist/seed.cjs', ecsClient, logsClient: mockLogsClient() }));
        expect(result.success).toBe(true);
        const script = ecsClient.runs[0].overrides.containerOverrides[0].command[2];
        expect(script).toContain('DATABASE_URL');
        expect(script).toContain('node ./dist/seed.cjs');
    });

    it('headless refuses npm-shim commands against a stripped runner', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-stripped-'));
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:22-alpine AS runner\nRUN rm -rf /usr/local/bin/npx\n');
        const ecsClient = mockEcsRunClient();
        const result = await runRun(runOptions({
            cwd: dir, cmd: 'npx drizzle-kit migrate', ecsClient, logsClient: mockLogsClient(),
        }));
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('npm-cmd-stripped-runner');
        expect(ecsClient.runs).toHaveLength(0);
        expect(stripVTControlCharacters(output.join('\n'))).toContain('node ./');
    });

    it('interactive warns but proceeds on a stripped runner', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-stripped-'));
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:22-alpine AS runner\nRUN rm -rf /usr/local/bin/npx\n');
        const ecsClient = mockEcsRunClient({ taskSequence: [stoppedTask(0)] });
        const result = await runRun(runOptions({
            cwd: dir, isHeadless: false, cmd: 'npm run backfill',
            ecsClient, logsClient: mockLogsClient(),
        }));
        expect(result.success).toBe(true);
        expect(stripVTControlCharacters(output.join('\n'))).toContain('npm');
        expect(mockTrackEvent).toHaveBeenCalledWith('npm_cmd_stripped_runner', expect.objectContaining({
            cmd_source: 'explicit',
        }));
    });

    it('node-based commands pass the stripped-runner guard headless', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-stripped-'));
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:22-alpine AS runner\nRUN rm -rf /usr/local/bin/npx\n');
        const ecsClient = mockEcsRunClient({ taskSequence: [stoppedTask(0)] });
        const result = await runRun(runOptions({
            cwd: dir, cmd: 'node ./dist/backfill.cjs', ecsClient, logsClient: mockLogsClient(),
        }));
        expect(result.success).toBe(true);
    });

    it('fails when the service is missing or inactive', async () => {
        const ecsClient = mockEcsRunClient({ service: null });
        const result = await runRun(runOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.reason).toBe('ecs-service-not-found');
        expect(ecsClient.runs).toHaveLength(0);
        expect(mockTrackEvent).toHaveBeenCalledWith('run_run', expect.objectContaining({
            success: false, error_code: 'ECS_SERVICE_NOT_FOUND',
        }));
    });

    it('fails before RunTask when the container is missing from the task definition', async () => {
        const ecsClient = mockEcsRunClient({ taskDefNames: ['sidecar'] });
        const result = await runRun(runOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.reason).toBe('container-not-found');
        expect(ecsClient.runs).toHaveLength(0);
        expect(stripVTControlCharacters(output.join('\n'))).toContain('--container');
    });

    it('fails when RunTask reports failures', async () => {
        const ecsClient = mockEcsRunClient({ runTasks: [], failures: [{ reason: 'RESOURCE:ENI' }] });
        const result = await runRun(runOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.reason).toBe('run-task-failed');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('RESOURCE:ENI');
    });

    it('times out stuck tasks with a named error', async () => {
        const ecsClient = mockEcsRunClient();
        const result = await runRun(runOptions({
            ecsClient, logsClient: mockLogsClient(), timeoutMs: 30,
        }));
        expect(result.reason).toBe('run-timeout');
        expect(mockTrackEvent).toHaveBeenCalledWith('run_run', expect.objectContaining({
            success: false, error_code: 'RUN_TIMEOUT',
        }));
    });

    it('fails when the named container is missing from the stopped task', async () => {
        const ecsClient = mockEcsRunClient({
            taskSequence: [{
                taskArn: RUN_TASK_ARN, lastStatus: 'STOPPED', stoppedReason: 'task-level',
                containers: [{ name: 'sidecar', exitCode: 0, reason: 'done' }],
            }],
        });
        const result = await runRun(runOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.reason).toBe('named-container-missing');
        expect(mockTrackEvent).toHaveBeenCalledWith('run_run', expect.objectContaining({
            success: false, error_code: 'NAMED_CONTAINER_MISSING',
        }));
    });

    it('namespaces cluster and service with --workspace', async () => {
        const container = 'myapp-pr-7-container';
        const ecsClient = mockEcsRunClient({
            taskDefNames: [container],
            taskSequence: [{
                taskArn: RUN_TASK_ARN, lastStatus: 'STOPPED', stoppedReason: 'task-level',
                containers: [{ name: container, exitCode: 0, reason: 'done' }],
            }],
        });
        const result = await runRun(runOptions({ workspace: 'pr-7', ecsClient, logsClient: mockLogsClient() }));
        expect(result.success).toBe(true);
        const runCall = ecsClient.runs[0];
        expect(runCall.cluster).toBe('myapp-pr-7-cluster');
    });

    it('uses an explicit --task-def revision for validation and RunTask', async () => {
        const ecsClient = mockEcsRunClient({ taskSequence: [stoppedTask(0)] });
        const result = await runRun(runOptions({
            taskDef: 'myapp-task:9', ecsClient, logsClient: mockLogsClient(),
        }));
        expect(result.success).toBe(true);
        expect(ecsClient.runs[0].taskDefinition).toBe('myapp-task:9');
    });
});

describe('run on --target lambda projects', () => {
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

    it('fails gracefully with the Lambda hint instead of probing ECS', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-lambda-test-'));
        try {
            fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'terraform', 'main.tf'),
                'locals {\n  app_name = "myapp${local.env_suffix}"\n}\nresource "aws_lambda_function" "app" {}\n'
            );
            const ecsClient = mockEcsRunClient();
            const result = await runRun({ cwd: dir, cmd: 'echo hello', isHeadless: true, ecsClient, logsClient: mockLogsClient() });
            expect(result).toMatchObject({ ok: false, reason: 'lambda-target-unsupported' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(ecsClient.send).not.toHaveBeenCalled();
            expect(mockTrackEvent).toHaveBeenCalledWith('run_run', expect.objectContaining({ error_code: 'LAMBDA_TARGET_UNSUPPORTED' }));
            expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('Lambda');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('run on --target static projects', () => {
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

    it('fails cleanly instead of probing for ECS resources', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-static-test-'));
        try {
            fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'terraform', 'main.tf'),
                'locals {\n  app_name = "myapp"\n}\nresource "aws_cloudfront_distribution" "site" {}\n'
            );
            const ecsClient = mockEcsRunClient();
            const result = await runRun({ cwd: dir, cmd: 'echo hello', isHeadless: true, ecsClient, logsClient: mockLogsClient() });
            expect(result).toMatchObject({ ok: false, reason: 'static-target-unsupported' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(ecsClient.send).not.toHaveBeenCalled();
            expect(mockTrackEvent).toHaveBeenCalledWith('run_run', expect.objectContaining({ error_code: 'STATIC_TARGET_UNSUPPORTED' }));
            expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('not supported on Lambda or Static targets');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
