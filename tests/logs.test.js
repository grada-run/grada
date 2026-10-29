import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    runLogs,
    parseSinceDuration,
    parseSince,
    isErrorLine,
    matchesErrorFilter,
    formatLogLine,
    formatLogEvent,
    parseLogsArgs,
    normalizeTailLines,
    buildLogStreamName,
    isNotFoundError,
    DEFAULT_TAIL_LINES,
} from '../src/commands/logs.js';
import { resolveRegion, resolveLogGroup } from '../src/utils/resolvers.js';
import { trackEvent } from '../src/core/telemetry.js';

const {
    mockLogsSend,
    MockLogsClient,
    MockFilterLogEventsCommand,
    MockDescribeLogStreamsCommand,
} = vi.hoisted(() => {
    const send = vi.fn();
    return {
        mockLogsSend: send,
        MockLogsClient: vi.fn(function () {
            this.send = send;
        }),
        MockFilterLogEventsCommand: vi.fn(function (input) {
            Object.assign(this, input);
        }),
        MockDescribeLogStreamsCommand: vi.fn(function (input) {
            Object.assign(this, input);
        }),
    };
});

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
    CloudWatchLogsClient: MockLogsClient,
    FilterLogEventsCommand: MockFilterLogEventsCommand,
    DescribeLogStreamsCommand: MockDescribeLogStreamsCommand,
}));


function makeEvents(count, prefix = 'log line') {
    const base = Date.now() - count * 1000;
    return Array.from({ length: count }, (_, i) => ({
        eventId: `event-${i}`,
        timestamp: base + i * 1000,
        message: `${prefix} ${i + 1}`,
        logStreamName: `ecs-app/abc123${i}`,
    }));
}

describe('logs: region resolution precedence', () => {
    const savedEnv = process.env.AWS_REGION;
    let tmpDir;

    beforeEach(() => {
        delete process.env.AWS_REGION;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-region-'));
    });

    afterEach(() => {
        if (savedEnv === undefined) delete process.env.AWS_REGION;
        else process.env.AWS_REGION = savedEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeMainTf(region) {
        fs.mkdirSync(path.join(tmpDir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'terraform', 'main.tf'), `provider "aws" {\n  region = "${region}"\n}\n`);
    }

    it('explicit --region flag wins over env and terraform', () => {
        process.env.AWS_REGION = 'eu-west-1';
        writeMainTf('ap-south-1');
        expect(resolveRegion({ region: 'us-west-2' }, tmpDir)).toBe('us-west-2');
    });

    it('AWS_REGION env wins over terraform/main.tf', () => {
        process.env.AWS_REGION = 'eu-west-1';
        writeMainTf('ap-south-1');
        expect(resolveRegion({}, tmpDir)).toBe('eu-west-1');
    });

    it('falls back to terraform/main.tf region', () => {
        writeMainTf('ap-south-1');
        expect(resolveRegion({}, tmpDir)).toBe('ap-south-1');
    });

    it('falls back to us-east-2 when nothing is configured', () => {
        expect(resolveRegion({}, tmpDir)).toBe('us-east-2');
    });
});

describe('logs: --since parsing', () => {
    it('parses minute/hour/day shorthands to milliseconds', () => {
        expect(parseSinceDuration('5m')).toBe(5 * 60 * 1000);
        expect(parseSinceDuration('1h')).toBe(60 * 60 * 1000);
        expect(parseSinceDuration('1d')).toBe(24 * 60 * 60 * 1000);
        expect(parseSinceDuration('30s')).toBe(30 * 1000);
    });

    it('defaults to 1h for missing or invalid input', () => {
        expect(parseSinceDuration(undefined)).toBe(60 * 60 * 1000);
        expect(parseSince(undefined)).toBe(60 * 60 * 1000);
        expect(parseSinceDuration('not-a-duration')).toBe(60 * 60 * 1000);
    });
});

describe('logs: error filtering helpers', () => {
    it('matches every documented failure keyword', () => {
        for (const keyword of ['ERROR boom', 'FATAL exit', 'Value Exception raised', 'request fail ed', 'status 500', 'bad gateway 502']) {
            expect(isErrorLine(keyword)).toBe(true);
            expect(matchesErrorFilter(keyword)).toBe(true);
        }
    });

    it('leaves healthy lines alone', () => {
        expect(isErrorLine('INFO request completed in 12ms')).toBe(false);
        expect(isErrorLine('GET /health 200 OK')).toBe(false);
    });

    it('formats lines with dimmed ISO timestamp and highlights errors', () => {
        const line = formatLogLine({ timestamp: 1700000000000, message: 'ERROR disk full', logStreamName: 'ecs-app/task123' });
        expect(formatLogEvent({ timestamp: 1700000000000, message: 'ok', logStreamName: 'ecs-app/task123' })).toContain('ok');
        expect(line).toContain(new Date(1700000000000).toISOString());
        expect(line).toContain('task123');
        expect(line).toContain('ERROR disk full');
    });

    it('clamps invalid tail values to the default', () => {
        expect(normalizeTailLines(10)).toBe(10);
        expect(normalizeTailLines('25')).toBe(25);
        expect(normalizeTailLines(0)).toBe(DEFAULT_TAIL_LINES);
        expect(normalizeTailLines('junk')).toBe(DEFAULT_TAIL_LINES);
    });

    it('parses CLI args for service and flags', () => {
        expect(parseLogsArgs(['logs', 'api', '--tail', '10', '--follow', '--error', '--since', '5m', '--region', 'eu-west-1'])).toEqual({
            service: 'api',
            tail: 10,
            follow: true,
            error: true,
            since: '5m',
            region: 'eu-west-1',
        });
        expect(parseLogsArgs(['logs', '-f', '--tail=5'])).toEqual({ follow: true, tail: 5 });
        expect(parseLogsArgs(['logs', '--workspace', 'pr-7'])).toEqual({ workspace: 'pr-7' });
        expect(parseLogsArgs(['logs'])).toEqual({});
    });
});

describe('Command: logs (mocked CloudWatch Logs)', () => {
    const savedEnv = process.env.AWS_REGION;

    beforeEach(() => {
        vi.clearAllMocks();
        mockLogsSend.mockReset();
        delete process.env.AWS_REGION;
        // Log-group verification succeeds by default.
        mockLogsSend.mockImplementation((cmd) => {
            if (cmd instanceof MockDescribeLogStreamsCommand) return Promise.resolve({ logStreams: [] });
            return Promise.resolve({ events: [], nextToken: undefined });
        });
    });

    afterEach(() => {
        if (savedEnv === undefined) delete process.env.AWS_REGION;
        else process.env.AWS_REGION = savedEnv;
    });

    it('truncates output to the requested tail line count', async () => {
        mockLogsSend.mockImplementation((cmd) => {
            if (cmd instanceof MockDescribeLogStreamsCommand) return Promise.resolve({ logStreams: [] });
            return Promise.resolve({ events: makeEvents(80) });
        });
        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });

        try {
            const result = await runLogs({ service: 'api', tail: 10, region: 'us-east-2' });
            expect(result.logs).toHaveLength(10);
            expect(result.logs[0]).toContain('log line 71');
            expect(MockFilterLogEventsCommand).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
            expect(output).toHaveLength(10);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('reads the newest N lines on groups larger than one page', async () => {
        const oldPage = makeEvents(10).map((e, i) => ({ ...e, eventId: `p1-${i}`, message: `old line ${i + 1}` }));
        const newPage = makeEvents(90).map((e, i) => ({ ...e, eventId: `p2-${i}`, message: `new line ${i + 1}` }));
        mockLogsSend.mockImplementation((cmd) => {
            if (cmd instanceof MockDescribeLogStreamsCommand) return Promise.resolve({ logStreams: [] });
            if (cmd.nextToken === 's1') return Promise.resolve({ events: newPage });
            if (cmd.limit === 10000) return Promise.resolve({ events: oldPage, nextToken: 's1' });
            return Promise.resolve({ events: oldPage, nextToken: 't1' }); // small probe page
        });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runLogs({ service: 'api', tail: 10, region: 'us-east-2' });
            expect(result.logs).toHaveLength(10);
            expect(result.logs[0]).toContain('new line 81');
            expect(result.logs[9]).toContain('new line 90');
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('fails loud on invalid --tail instead of silently defaulting', async () => {
        const result = await runLogs({ tail: 'junk', region: 'us-east-2', json: true });
        expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'invalid-tail', exitCode: 1 }));
        expect(mockLogsSend).not.toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith('logs_streamed', expect.objectContaining({ success: false, error_code: 'INVALID_TAIL' }));
    });

    it('fails loud on invalid --since instead of silently defaulting', async () => {
        const result = await runLogs({ since: 'not-a-duration', region: 'us-east-2', json: true });
        expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'invalid-since', exitCode: 1 }));
        expect(mockLogsSend).not.toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith('logs_streamed', expect.objectContaining({ success: false, error_code: 'INVALID_SINCE' }));
    });

    it('namespaces the log group with --workspace', async () => {
        mockLogsSend.mockImplementation((cmd) => {
            if (cmd instanceof MockDescribeLogStreamsCommand) return Promise.resolve({ logStreams: [] });
            return Promise.resolve({ events: [] });
        });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runLogs({ projectName: 'myapp', workspace: 'pr-7', tail: 10, region: 'us-east-2' });
            const filterCall = mockLogsSend.mock.calls.map(([c]) => c).find((c) => c instanceof MockFilterLogEventsCommand);
            expect(filterCall.logGroupName).toBe('/ecs/myapp-pr-7');
            expect(result.logGroup).toBe('/ecs/myapp-pr-7');
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('filters to failure keywords when --error is set', async () => {
        const events = [
            { eventId: '1', timestamp: Date.now(), message: 'INFO all good', logStreamName: 'ecs-app/t1' },
            { eventId: '2', timestamp: Date.now(), message: 'ERROR disk full', logStreamName: 'ecs-app/t1' },
            { eventId: '3', timestamp: Date.now(), message: 'WARN slow query', logStreamName: 'ecs-app/t1' },
            { eventId: '4', timestamp: Date.now(), message: 'upstream returned 502', logStreamName: 'ecs-app/t1' },
        ];
        mockLogsSend.mockImplementation((cmd) => {
            if (cmd instanceof MockDescribeLogStreamsCommand) return Promise.resolve({ logStreams: [] });
            return Promise.resolve({ events });
        });

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runLogs({ tail: 50, error: true, region: 'us-east-2' });
            expect(result.logs).toHaveLength(2);
            expect(result.logs.join('\n')).toContain('ERROR disk full');
            expect(result.logs.join('\n')).toContain('502');
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('exits gracefully with guidance when the log group is missing', async () => {
        const missing = new Error('The specified log group does not exist.');
        missing.name = 'ResourceNotFoundException';
        mockLogsSend.mockRejectedValue(missing);

        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });

        try {
            const result = await runLogs({ tail: 5, region: 'us-east-2' });
            expect(result.logs).toEqual([]);
            expect(output.join('\n')).toMatch(/No log group found/);
            expect(exitSpy).not.toHaveBeenCalled();
        } finally {
            consoleSpy.mockRestore();
            exitSpy.mockRestore();
        }
    });

    it('prints SSO recovery guidance and exits 1 on expired sessions', async () => {
        const expired = new Error('Token expired');
        expired.name = 'ExpiredTokenException';
        // Verification probe passes; the fetch itself expires.
        mockLogsSend.mockImplementation((cmd) => {
            if (cmd instanceof MockDescribeLogStreamsCommand) return Promise.resolve({ logStreams: [] });
            return Promise.reject(expired);
        });

        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });

        try {
            await runLogs({ tail: 5, region: 'us-east-2', spawnSyncImpl: () => ({ status: 0 }) });
            expect(output.join('\n')).toContain('aws sso login');
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            consoleSpy.mockRestore();
            exitSpy.mockRestore();
        }
    });

    it('wraps unexpected SDK failures in a clean message and exits 1 instead of throwing', async () => {
        const failure = new Error('socket hang up');
        failure.name = 'NetworkingError';
        // Verification probe passes; the fetch itself fails.
        mockLogsSend.mockImplementation((cmd) => {
            if (cmd instanceof MockDescribeLogStreamsCommand) return Promise.resolve({ logStreams: [] });
            return Promise.reject(failure);
        });

        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });

        try {
            const result = await runLogs({ tail: 5, region: 'us-east-2' });
            expect(result.ok).toBe(false);
            const text = output.join('\n');
            expect(text).toContain('socket hang up');
            expect(text).toContain('credentials');
            expect(text).not.toContain('$metadata');
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            consoleSpy.mockRestore();
            exitSpy.mockRestore();
        }
    });

    it('returns a structured failure without exiting when headless', async () => {
        const failure = new Error('socket hang up');
        failure.name = 'NetworkingError';
        mockLogsSend.mockImplementation((cmd) => {
            if (cmd instanceof MockDescribeLogStreamsCommand) return Promise.resolve({ logStreams: [] });
            return Promise.reject(failure);
        });

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });

        try {
            const result = await runLogs({ tail: 5, region: 'us-east-2', isHeadless: true });
            expect(result).toEqual(expect.objectContaining({ ok: false, exitCode: 1 }));
            expect(exitSpy).not.toHaveBeenCalled();
        } finally {
            consoleSpy.mockRestore();
            exitSpy.mockRestore();
        }
    });

    it('resolves the default log group from the project name', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runLogs({ projectName: 'myapp', region: 'us-east-2' });
            expect(result.logGroup).toBe('/ecs/myapp');
            expect(resolveLogGroup({ logGroup: '/custom/group' })).toBe('/custom/group');
            expect(MockFilterLogEventsCommand).toHaveBeenCalledWith(
                expect.objectContaining({ logGroupName: '/ecs/myapp' })
            );
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('follow mode terminates after maxPolls without hanging', async () => {
        let calls = 0;
        mockLogsSend.mockImplementation((cmd) => {
            if (cmd instanceof MockDescribeLogStreamsCommand) return Promise.resolve({ logStreams: [] });
            calls += 1;
            return Promise.resolve({ events: makeEvents(2, `poll-${calls}`) });
        });

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runLogs({ follow: true, maxPolls: 2, pollIntervalMs: 0, region: 'us-east-2' });
            expect(calls).toBe(2);
            expect(result.logs.length).toBeGreaterThan(0);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('is wired into bin/cli.js', () => {
        const cliPath = path.resolve(__dirname, '../bin/cli.js');
        const content = fs.readFileSync(cliPath, 'utf8');
        expect(content).toContain('runLogs');
        expect(content).toContain("'logs'");
    });

    it('prints a friendly waiting message when the log group exists but is empty', async () => {
        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });

        // The beforeEach block already mocks an empty events array for us!
        await runLogs({ tail: 10, region: 'us-east-2' });

        const fullOutput = output.join('\n');
        expect(fullOutput).toContain('Waiting for logs...');
        expect(fullOutput).toContain('no application logs have been written yet');

        consoleSpy.mockRestore();
    });
});

describe('log stream helpers', () => {
    it('buildLogStreamName mirrors the awslogs stream-prefix convention', () => {
        expect(buildLogStreamName('myapp-container', 'abc123')).toBe('ecs/myapp-container/abc123');
    });

    it('buildLogStreamName honors a custom stream prefix from the task definition', () => {
        expect(buildLogStreamName('myapp-container', 'abc123', 'custom')).toBe('custom/myapp-container/abc123');
    });

    it('isNotFoundError matches SDK names and missing-group messages', () => {
        expect(isNotFoundError({ name: 'ResourceNotFoundException' })).toBe(true);
        expect(isNotFoundError({ name: 'Other', message: 'The log group "/ecs/myapp" does not exist.' })).toBe(true);
        expect(isNotFoundError({ name: 'AccessDenied', message: 'nope' })).toBe(false);
        expect(isNotFoundError(null)).toBeFalsy();
    });
});

describe('logs: fuzzer hardening', () => {
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
            const result = await runLogs(null);
            expect(result).toEqual({ ok: false, reason: 'project-not-initialized' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(trackEvent).toHaveBeenCalledWith('logs_streamed', expect.objectContaining({
                success: false,
                error_code: 'PROJECT_NOT_INITIALIZED',
            }));
        } finally {
            cwdSpy.mockRestore();
        }
    });

    it.each([null, 42, true, { port: 'string' }])('parseLogsArgs(%s) returns defaults', (bad) => {
        expect(parseLogsArgs(bad)).toEqual({});
    });
});

describe('Command: logs on --target lambda projects', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockLogsSend.mockReset();
        mockLogsSend.mockImplementation((cmd) => {
            if (cmd instanceof MockDescribeLogStreamsCommand) return Promise.resolve({ logStreams: [] });
            return Promise.resolve({ events: [], nextToken: undefined });
        });
    });

    function lambdaDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-lambda-test-'));
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "myapp${local.env_suffix}"\n}\nresource "aws_lambda_function" "app" {}\n'
        );
        return dir;
    }

    it('defaults to the function log group and skips the stream-prefix filter', async () => {
        const dir = lambdaDir();
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runLogs({ cwd: dir, service: 'myapp', tail: 5, region: 'us-east-2' });
            expect(result.logGroup).toBe('/aws/lambda/myapp-fn');
            expect(MockFilterLogEventsCommand).toHaveBeenCalledWith(expect.objectContaining({
                logGroupName: '/aws/lambda/myapp-fn',
            }));
            for (const call of MockFilterLogEventsCommand.mock.calls) {
                expect(call[0]).not.toHaveProperty('logStreamNamePrefix');
            }
        } finally {
            consoleSpy.mockRestore();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('points missing-group guidance at the lambda prefix', async () => {
        const dir = lambdaDir();
        const missing = new Error('The specified log group does not exist.');
        missing.name = 'ResourceNotFoundException';
        mockLogsSend.mockRejectedValue(missing);
        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });
        try {
            await runLogs({ cwd: dir, tail: 5, region: 'us-east-2' });
            expect(output.join('\n')).toContain('--log-group-name-prefix "/aws/lambda/"');
        } finally {
            consoleSpy.mockRestore();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
