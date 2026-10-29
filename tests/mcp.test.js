import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    TOOL_NAMES,
    InterceptedExit,
    stripAnsi,
    withStdioGuards,
    excludeTransportFromCapture,
    parseMcpArgs,
    MCP_INSTALL_EDITORS,
    mcpInstallTarget,
    installMcpConfig,
    runMcp,
    withMcpCommand,
    resolveMcpTransport,
    createHttpRequestHandler,
    runMcpHttp,
    runGuardedToolCall,
    handleAnalyzeStack,
    handleAddPrimitive,
    handleStackStatus,
    handleFetchLogs,
    handleAuditSecrets,
    createMcpServer,
} from '../src/commands/mcp.js';
import { runStatus } from '../src/commands/status.js';
import { runLogs } from '../src/commands/logs.js';
import { auditSecrets } from '../src/commands/secrets.js';
import { runAdd } from '../src/commands/add.js';
import { trackSuccess, setActiveCommandName, resetActiveCommandName, rotateRunId } from '../src/core/telemetry.js';

vi.mock('../src/commands/status.js', () => ({ runStatus: vi.fn() }));
vi.mock('../src/commands/logs.js', () => ({ runLogs: vi.fn() }));
vi.mock('../src/commands/secrets.js', () => ({ auditSecrets: vi.fn() }));
vi.mock('../src/commands/add.js', () => ({ runAdd: vi.fn() }));
vi.mock('../src/core/telemetry.js', () => ({
    getCliVersion: () => '0.0.0-test',
    trackEvent: vi.fn(),
    flushTelemetry: vi.fn().mockResolvedValue(),
    trackSuccess: vi.fn().mockResolvedValue(),
    trackFailure: vi.fn().mockResolvedValue(),
    setActiveCommandName: vi.fn(),
    resetActiveCommandName: vi.fn(),
    rotateRunId: vi.fn(),
}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'cli.js');

beforeEach(() => {
    vi.clearAllMocks();
});

describe('stripAnsi', () => {
    it('removes color escape sequences', () => {
        expect(stripAnsi('\x1B[31m✖ boom\x1B[0m plain')).toBe('✖ boom plain');
    });

    it('strips cursor-control sequences, not just SGR colors', () => {
        expect(stripAnsi('\x1B[?25l\x1B[1G\x1B[Jworking\x1B[1D\x1B[0K\x1B[?25h')).toBe('working');
    });
});

describe('withStdioGuards', () => {
    it('captures stdout and restores the original write afterwards', async () => {
        const originalWrite = process.stdout.write;
        const originalLog = console.log;
        const { result, output } = await withStdioGuards(() => {
            console.log('hello from command');
            process.stdout.write('raw write\n');
            return 'returned';
        });
        expect(result).toBe('returned');
        expect(output).toContain('hello from command');
        expect(output).toContain('raw write');
        expect(process.stdout.write).toBe(originalWrite);
        expect(console.log).toBe(originalLog);
    });

    it('converts process.exit into InterceptedExit carrying the captured output', async () => {
        const originalExit = process.exit;
        const failure = await withStdioGuards(() => {
            console.log('✖ No terraform/main.tf found.');
            process.exit(1);
        }).then(
            () => null,
            (error) => error
        );
        expect(failure).toBeInstanceOf(InterceptedExit);
        expect(failure.exitCode).toBe(1);
        expect(failure.output).toContain('No terraform/main.tf found.');
        expect(process.exit).toBe(originalExit);
    });

    it('restores guards when the wrapped function throws a regular error', async () => {
        const originalWrite = process.stdout.write;
        const originalExit = process.exit;
        await expect(withStdioGuards(() => {
            throw new Error('boom');
        })).rejects.toThrow('boom');
        expect(process.stdout.write).toBe(originalWrite);
        expect(process.exit).toBe(originalExit);
    });
});

describe('excludeTransportFromCapture', () => {
    it('lets transport sends bypass an active capture without disturbing it', async () => {
        const delivered = [];
        const fakeTransport = {
            send(message) {
                process.stdout.write(message);
                return Promise.resolve();
            },
        };
        excludeTransportFromCapture(fakeTransport);
        const realWrite = process.stdout.write;
        process.stdout.write = (chunk) => {
            delivered.push(String(chunk));
            return true;
        };
        try {
            const { output } = await withStdioGuards(async () => {
                console.log('command chatter');
                await fakeTransport.send('RESPONSE\n');
                console.log('more chatter');
            });
            expect(output).toContain('command chatter');
            expect(output).toContain('more chatter');
            expect(output).not.toContain('RESPONSE');
            expect(delivered.join('')).toContain('RESPONSE');
        } finally {
            process.stdout.write = realWrite;
        }
    });
});

describe('runGuardedToolCall', () => {
    it('serializes overlapping calls so guards never nest', async () => {
        const order = [];
        let releaseFirst;
        const gate = new Promise((resolve) => { releaseFirst = resolve; });
        const first = runGuardedToolCall(async () => {
            order.push('first-start');
            await gate;
            order.push('first-end');
            return 1;
        });
        const second = runGuardedToolCall(async () => {
            order.push('second-start');
            return 2;
        });
        await Promise.resolve();
        releaseFirst();
        await expect(first).resolves.toMatchObject({ result: 1 });
        await expect(second).resolves.toMatchObject({ result: 2 });
        expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    });
});

describe('tool handlers', () => {
    it('stack_status calls runStatus headless with json and serializes the payload', async () => {
        vi.mocked(runStatus).mockResolvedValue({ healthy: true, service: { name: 'x' } });
        const result = await handleStackStatus({ service: 'x-service' });
        expect(runStatus).toHaveBeenCalledWith({ service: 'x-service', json: true, isHeadless: true });
        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0].text)).toEqual({ healthy: true, service: { name: 'x' } });
    });

    it('fetch_logs maps hours to since and always disables follow mode', async () => {
        vi.mocked(runLogs).mockResolvedValue({ logs: ['a'], logGroup: 'g', region: 'r', service: 's' });
        const result = await handleFetchLogs({ hours: 3, service: 's' });
        expect(runLogs).toHaveBeenCalledWith(
            expect.objectContaining({ since: '3h', follow: false, isHeadless: true, service: 's' })
        );
        expect(JSON.parse(result.content[0].text).logs).toEqual(['a']);
    });

    it('fetch_logs defaults to a 1-hour lookback', async () => {
        vi.mocked(runLogs).mockResolvedValue({ logs: [] });
        await handleFetchLogs({});
        expect(runLogs).toHaveBeenCalledWith(expect.objectContaining({ since: '1h' }));
    });

    it('audit_secrets defaults the env file and resolves the project name', async () => {
        vi.mocked(auditSecrets).mockResolvedValue({ missingLocally: [], mismatched: [], untrackedLocally: [], driftCount: 0 });
        const result = await handleAuditSecrets({});
        expect(auditSecrets).toHaveBeenCalledWith('.env', expect.any(String), { region: undefined });
        expect(JSON.parse(result.content[0].text).driftCount).toBe(0);
    });

    it('add_primitive passes capability headless and serializes the result', async () => {
        vi.mocked(runAdd).mockResolvedValue({ ok: true, capability: 'queue:sqs', file: 'terraform/sqs.tf' });
        const result = await handleAddPrimitive({ capability: 'queue:sqs', region: 'us-east-2' });
        expect(runAdd).toHaveBeenCalledWith({ region: 'us-east-2', capability: 'queue:sqs', isHeadless: true });
        expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true, capability: 'queue:sqs' });
    });

    it('add_primitive maps soft ok:false failures to error results', async () => {
        vi.mocked(runAdd).mockImplementation(async () => {
            console.log('⚠ terraform/sqs.tf already exists.');
            return { ok: false, reason: 'addon-already-exists' };
        });
        const result = await handleAddPrimitive({ capability: 'queue:sqs' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('addon-already-exists');
        expect(result.content[0].text).toContain('already exists');
    });

    it('stack_status maps soft ok:false failures to error results', async () => {
        vi.mocked(runStatus).mockImplementation(async () => {
            console.log('✖ boom');
            return { ok: false, reason: 'status-probe-failed', exitCode: 1 };
        });
        const result = await handleStackStatus({});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('grada status failed (status-probe-failed).');
        expect(result.content[0].text).toContain('boom');
    });

    it('fetch_logs maps soft ok:false failures to error results', async () => {
        vi.mocked(runLogs).mockImplementation(async () => {
            console.log('✖ boom');
            return { ok: false, reason: 'log-lookup-failed', exitCode: 1, logs: [] };
        });
        const result = await handleFetchLogs({});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('grada logs failed (log-lookup-failed).');
        expect(result.content[0].text).toContain('boom');
    });

    it('audit_secrets maps soft ok:false failures to error results', async () => {
        vi.mocked(auditSecrets).mockImplementation(async () => {
            console.log('✖ boom');
            return { ok: false, reason: 'audit-failed', exitCode: 1 };
        });
        const result = await handleAuditSecrets({});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('grada secrets audit failed (audit-failed).');
        expect(result.content[0].text).toContain('boom');
    });

    it('converts intercepted exits into error results with the exit code and output', async () => {
        vi.mocked(runStatus).mockImplementation(async () => {
            console.log('✖ Could not determine the project.');
            process.exit(1);
        });
        const result = await handleStackStatus({});
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('code 1');
        expect(result.content[0].text).toContain('Could not determine the project.');
        // The server process itself must survive the wrapped exit.
        expect(typeof process.exit).toBe('function');
    });

    it.each([
        ['add', handleAddPrimitive, { capability: 'queue:sqs' }, runAdd, { ok: true }],
        ['status', handleStackStatus, {}, runStatus, { healthy: true }],
        ['logs', handleFetchLogs, {}, runLogs, { logs: [] }],
        ['secrets', handleAuditSecrets, {}, auditSecrets, { driftCount: 0 }],
    ])('names the %s command for telemetry around the wrapped call', async (name, handler, args, mocked, result) => {
        vi.mocked(mocked).mockResolvedValue(result);
        const order = [];
        vi.mocked(setActiveCommandName).mockImplementationOnce(() => order.push('set'));
        vi.mocked(mocked).mockImplementationOnce(async () => { order.push('run'); return result; });
        vi.mocked(resetActiveCommandName).mockImplementationOnce(() => order.push('reset'));
        await handler(args);
        expect(setActiveCommandName).toHaveBeenCalledWith(name);
        expect(order).toEqual(['set', 'run', 'reset']);
    });

    it('resets the command name even when the wrapped call exits', async () => {
        vi.mocked(runAdd).mockImplementation(async () => {
            process.exit(1);
        });
        const result = await handleAddPrimitive({ capability: 'queue:sqs' });
        expect(result.isError).toBe(true);
        expect(setActiveCommandName).toHaveBeenCalledWith('add');
        expect(resetActiveCommandName).toHaveBeenCalled();
    });
});

describe('withMcpCommand', () => {
    it('returns the wrapped value and always resets', async () => {
        await expect(withMcpCommand('logs', async () => 'ok')).resolves.toBe('ok');
        expect(setActiveCommandName).toHaveBeenCalledWith('logs');
        expect(resetActiveCommandName).toHaveBeenCalledTimes(1);
        await expect(withMcpCommand('logs', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(resetActiveCommandName).toHaveBeenCalledTimes(2);
    });

    it('rotates the telemetry run id once per tool call', async () => {
        await withMcpCommand('logs', async () => 'ok');
        await withMcpCommand('status', async () => 'ok');
        expect(rotateRunId).toHaveBeenCalledTimes(2);
    });
});

describe('analyze_stack', () => {
    function makeProject({ framework = 'express', computeTarget = 'lambda', addons = ['s3.tf'] } = {}) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-analyze-'));
        const deps = framework ? { dependencies: { [framework]: '*' } } : {};
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(deps));
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        const mainTf = computeTarget === 'lambda' ? 'resource "aws_lambda_function" "app" {}' : '# ecs stack';
        fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), mainTf);
        for (const file of addons) fs.writeFileSync(path.join(dir, 'terraform', file), '# addon');
        return dir;
    }

    it('reports framework, compute target, init state, and installed addons', async () => {
        const dir = makeProject();
        // An initialized tree carries `.terraform/`; main.tf alone is a
        // fresh scaffold and must read false (pinned below).
        fs.mkdirSync(path.join(dir, 'terraform', '.terraform'));
        try {
            const result = await handleAnalyzeStack({ cwd: dir });
            expect(JSON.parse(result.content[0].text)).toEqual({
                projectDir: dir,
                framework: { id: 'node', name: 'Node.js / Express' },
                computeTarget: 'lambda',
                terraformInitialized: true,
                installedAddons: ['storage:s3'],
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reports terraformInitialized false for a scaffold without .terraform', async () => {
        const dir = makeProject();
        try {
            const result = await handleAnalyzeStack({ cwd: dir });
            expect(JSON.parse(result.content[0].text)).toMatchObject({ terraformInitialized: false });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('handles empty directories without throwing', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-analyze-empty-'));
        try {
            const result = await handleAnalyzeStack({ cwd: dir });
            expect(JSON.parse(result.content[0].text)).toMatchObject({
                framework: null,
                terraformInitialized: false,
                installedAddons: [],
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('createMcpServer', () => {
    it('exposes exactly the five spec tools', () => {
        expect([...TOOL_NAMES].sort()).toEqual(
            ['add_primitive', 'analyze_stack', 'audit_secrets', 'fetch_logs', 'stack_status'].sort()
        );
        const server = createMcpServer();
        expect(typeof server.connect).toBe('function');
        expect(typeof server.close).toBe('function');
    });

    it('serves initialize and tools/list over stdio (black-box)', async () => {
        const child = spawn('node', [CLI, 'mcp'], {
            env: { ...process.env, DO_NOT_TRACK: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const stdoutChunks = [];
        child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
        const failures = [];
        const fail = (message) => failures.push(message);
        try {
            const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
            send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

            const deadline = Date.now() + 15000;
            let responses = [];
            while (Date.now() < deadline) {
                const lines = Buffer.concat(stdoutChunks).toString('utf-8').split('\n').filter(Boolean);
                responses = lines.map((line) => {
                    try {
                        return JSON.parse(line);
                    } catch {
                        fail(`non-JSON line on stdout: ${line.slice(0, 120)}`);
                        return null;
                    }
                });
                if (responses.length >= 2 && responses.every(Boolean)) break;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const byId = Object.fromEntries(responses.filter(Boolean).map((response) => [response.id, response]));
            if (!byId[1]?.result?.serverInfo) fail('missing initialize result');
            if (!byId[2]?.result?.tools) fail('missing tools/list result');
            expect(failures).toEqual([]);
            expect(byId[1].result.serverInfo.name).toBe('grada');
            const toolNames = (byId[2]?.result?.tools || []).map((tool) => tool.name).sort();
            expect(toolNames).toEqual([...TOOL_NAMES].sort());
            for (const tool of byId[2].result.tools) {
                expect(tool.inputSchema.type).toBe('object');
            }
            expect(failures).toEqual([]);
        } finally {
            child.kill('SIGKILL');
        }
    }, 20000);

    it('delivers pipelined slow+fast calls without swallowing responses (black-box)', async () => {
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pipeline-'));
        const child = spawn('node', [CLI, 'mcp'], {
            env: { ...process.env, DO_NOT_TRACK: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const stdoutChunks = [];
        child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
        try {
            const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
            send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            // Slow network-backed call first, instant filesystem call
            // second: the fast response is written while the slow call
            // still holds the stdout guard.
            send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stack_status', arguments: { cwd: emptyDir } } });
            send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'analyze_stack', arguments: { cwd: emptyDir } } });

            const deadline = Date.now() + 25000;
            let byId = {};
            while (Date.now() < deadline) {
                const lines = Buffer.concat(stdoutChunks).toString('utf-8').split('\n').filter(Boolean);
                const responses = lines.map((line) => JSON.parse(line));
                byId = Object.fromEntries(responses.map((response) => [response.id, response]));
                if (byId[1] && byId[2] && byId[3]) break;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(byId[1]?.result?.serverInfo?.name).toBe('grada');
            expect(byId[2]).toBeDefined();
            expect(byId[3]).toBeDefined();
            // The fast call's payload must arrive on its own response —
            // never swallowed into the slow call's captured output.
            const fastText = byId[3].result.content[0].text;
            expect(JSON.parse(fastText).projectDir).toBe(emptyDir);
            expect(byId[2].result.content[0].text).not.toContain('"id":3');
            expect(byId[2].result.content[0].text).not.toContain(fastText);
        } finally {
            child.kill('SIGKILL');
            fs.rmSync(emptyDir, { recursive: true, force: true });
        }
    }, 30000);
});

describe('parseMcpArgs', () => {
    it('returns no install key for a bare mcp invocation', () => {
        expect(parseMcpArgs(['mcp'])).toEqual({});
        expect(parseMcpArgs([])).toEqual({});
    });

    it('extracts the editor in space and equals forms', () => {
        expect(parseMcpArgs(['mcp', '--install', 'windsurf'])).toEqual({ install: 'windsurf' });
        expect(parseMcpArgs(['mcp', '--install=zed'])).toEqual({ install: 'zed' });
    });

    it('normalizes editor casing and whitespace', () => {
        expect(parseMcpArgs(['mcp', '--install', '  Zed '])).toEqual({ install: 'zed' });
    });

    it('maps a valueless --install to empty string for usage reporting', () => {
        expect(parseMcpArgs(['mcp', '--install'])).toEqual({ install: '' });
        expect(parseMcpArgs(['mcp', '--install='])).toEqual({ install: '' });
        expect(parseMcpArgs(['mcp', '--install', '--json'])).toEqual({ install: '', unknownFlags: ['--json'] });
    });

    it('parses transport, port, and host flags', () => {
        expect(parseMcpArgs(['mcp', '--transport', 'http', '--port', '8080', '--host', '0.0.0.0'])).toEqual({
            transport: 'http',
            port: 8080,
            host: '0.0.0.0',
        });
        expect(parseMcpArgs(['mcp', '--transport=http'])).toEqual({ transport: 'http' });
    });
});

describe('resolveMcpTransport', () => {
    it('defaults to stdio with http defaults filled', () => {
        expect(resolveMcpTransport({})).toEqual({ ok: true, transport: 'stdio', port: 3000, host: '127.0.0.1' });
        expect(resolveMcpTransport({ transport: 'STDIO' }).transport).toBe('stdio');
    });

    it('accepts explicit http with custom port and host', () => {
        expect(resolveMcpTransport({ transport: 'http', port: 8080, host: '0.0.0.0' })).toEqual({
            ok: true,
            transport: 'http',
            port: 8080,
            host: '0.0.0.0',
        });
    });

    it.each([['grpc'], [''], [null]])('rejects unknown transports (%s)', (transport) => {
        expect(resolveMcpTransport({ transport })).toMatchObject({ ok: false, reason: 'unknown-transport' });
    });

    it.each([[0], [-1], [65536], [1.5], [Number.NaN], ['8080']])('rejects bad http ports (%s)', (port) => {
        expect(resolveMcpTransport({ transport: 'http', port })).toMatchObject({ ok: false, reason: 'bad-port' });
    });

    it.each([[''], ['   '], [42], [null]])('rejects bad http hosts (%s)', (host) => {
        expect(resolveMcpTransport({ transport: 'http', host })).toMatchObject({ ok: false, reason: 'bad-host' });
    });

    it('ignores port and host on the stdio transport', () => {
        expect(resolveMcpTransport({ port: 99999, host: '' })).toMatchObject({ ok: true, transport: 'stdio' });
    });
});

describe('HTTP transport', () => {
    function fakeReq({ method = 'POST', url = '/mcp', body = '' } = {}) {
        const handlers = {};
        return {
            method,
            url,
            on(event, fn) {
                (handlers[event] ||= []).push(fn);
                return this;
            },
            _flush() {
                if (body) handlers.data?.forEach((fn) => fn(body));
                handlers.end?.forEach((fn) => fn());
            },
        };
    }

    function fakeRes() {
        return {
            status: null,
            headers: null,
            body: null,
            writeHead(status, headers) {
                this.status = status;
                this.headers = headers;
                return this;
            },
            end(body) {
                this.body = body;
            },
        };
    }

    it('delegates valid POST bodies to the transport with parsed JSON', async () => {
        const transport = { handleRequest: vi.fn().mockResolvedValue() };
        const handler = createHttpRequestHandler(transport);
        const req = fakeReq({ body: '{"jsonrpc":"2.0","id":1}' });
        const res = fakeRes();
        const pending = handler(req, res);
        req._flush();
        await pending;
        expect(transport.handleRequest).toHaveBeenCalledTimes(1);
        const [passedReq, passedRes, parsedBody] = transport.handleRequest.mock.calls[0];
        expect(passedReq).toBe(req);
        expect(passedRes).toBe(res);
        expect(parsedBody).toEqual({ jsonrpc: '2.0', id: 1 });
        expect(res.status).toBeNull();
    });

    it('delegates GET requests with no body', async () => {
        const transport = { handleRequest: vi.fn().mockResolvedValue() };
        const req = fakeReq({ method: 'GET', body: '' });
        const res = fakeRes();
        const pending = createHttpRequestHandler(transport)(req, res);
        req._flush();
        await pending;
        expect(transport.handleRequest).toHaveBeenCalledWith(req, res, undefined);
    });

    it('rejects unknown paths, methods, and malformed JSON without touching the transport', async () => {
        const transport = { handleRequest: vi.fn() };
        const handler = createHttpRequestHandler(transport);

        const notFound = fakeRes();
        const notFoundReq = fakeReq({ url: '/nope' });
        const pending404 = handler(notFoundReq, notFound);
        notFoundReq._flush();
        await pending404;
        expect(notFound.status).toBe(404);

        const badMethod = fakeRes();
        const badMethodReq = fakeReq({ method: 'PUT' });
        const pending405 = handler(badMethodReq, badMethod);
        badMethodReq._flush();
        await pending405;
        expect(badMethod.status).toBe(405);

        const badJson = fakeRes();
        const badJsonReq = fakeReq({ body: '{nope' });
        const pending400 = handler(badJsonReq, badJson);
        badJsonReq._flush();
        await pending400;
        expect(badJson.status).toBe(400);

        expect(transport.handleRequest).not.toHaveBeenCalled();
    });

    it('starts listening through the injected server factory without real sockets', async () => {
        const calls = {};
        const fakeServer = {
            on: vi.fn(),
            listen(port, host, done) {
                calls.listen = [port, host];
                done();
            },
            close: vi.fn(),
        };
        const result = await runMcpHttp({ port: 8080, host: '127.0.0.1' }, { createServer: () => fakeServer });
        expect(calls.listen).toEqual([8080, '127.0.0.1']);
        expect(result).toMatchObject({ ok: true, transport: 'http', port: 8080, host: '127.0.0.1' });
        result.close();
        expect(fakeServer.close).toHaveBeenCalledTimes(1);
    });

    it('surfaces listen failures instead of hanging', async () => {
        const fakeServer = {
            on(event, fn) {
                if (event === 'error') fn(new Error('EADDRINUSE'));
            },
            listen() {},
            close: vi.fn(),
        };
        await expect(runMcpHttp({ port: 3000 }, { createServer: () => fakeServer })).rejects.toThrow('EADDRINUSE');
    });
});

describe('installMcpConfig', () => {
    function makeHome() {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-install-'));
    }

    it('exposes exactly the six supported editors', () => {
        expect(MCP_INSTALL_EDITORS).toEqual(['windsurf', 'zed', 'cursor', 'vscode', 'claude-desktop', 'gemini-cli']);
    });

    it('targets the documented config paths and root keys', () => {
        expect(mcpInstallTarget('windsurf', '/home/test')).toEqual({
            path: path.join('/home/test', '.codeium', 'windsurf', 'mcp_config.json'),
            key: 'mcpServers',
        });
        expect(mcpInstallTarget('zed', '/home/test')).toEqual({
            path: path.join('/home/test', '.config', 'zed', 'settings.json'),
            key: 'context_servers',
        });
        expect(mcpInstallTarget('cursor', '/home/test')).toEqual({
            path: path.join('/home/test', '.cursor', 'mcp.json'),
            key: 'mcpServers',
        });
        expect(mcpInstallTarget('gemini-cli', '/home/test')).toEqual({
            path: path.join('/home/test', '.gemini', 'settings.json'),
            key: 'mcpServers',
        });
        expect(mcpInstallTarget('emacs', '/home/test')).toBeNull();
    });

    it.each([
        ['darwin', ['Library', 'Application Support', 'Claude', 'claude_desktop_config.json']],
        ['linux', ['.config', 'Claude', 'claude_desktop_config.json']],
        ['win32', ['AppData', 'Roaming', 'Claude', 'claude_desktop_config.json']],
    ])('locates claude-desktop config per platform (%s)', (platform, relative) => {
        expect(mcpInstallTarget('claude-desktop', '/home/test', platform)).toEqual({
            path: path.join('/home/test', ...relative),
            key: 'mcpServers',
        });
    });

    it.each([
        ['darwin', ['Library', 'Application Support', 'Code', 'User', 'mcp.json']],
        ['linux', ['.config', 'Code', 'User', 'mcp.json']],
        ['win32', ['AppData', 'Roaming', 'Code', 'User', 'mcp.json']],
    ])('locates vscode user config per platform with the servers key (%s)', (platform, relative) => {
        expect(mcpInstallTarget('vscode', '/home/test', platform)).toEqual({
            path: path.join('/home/test', ...relative),
            key: 'servers',
        });
    });

    it('installs under the servers key for vscode', () => {
        const home = makeHome();
        try {
            const result = installMcpConfig('vscode', { homeDir: home, platform: 'linux' });
            expect(result).toMatchObject({ ok: true, editor: 'vscode' });
            expect(result.path).toBe(path.join(home, '.config', 'Code', 'User', 'mcp.json'));
            expect(JSON.parse(fs.readFileSync(result.path, 'utf-8'))).toEqual({
                servers: { grada: { command: 'npx', args: ['--yes', 'grada-run', 'mcp'] } },
            });
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('creates a fresh windsurf config with the exact server block', () => {
        const home = makeHome();
        try {
            const result = installMcpConfig('windsurf', { homeDir: home });
            expect(result).toMatchObject({ ok: true, alreadyInstalled: false, editor: 'windsurf' });
            expect(JSON.parse(fs.readFileSync(result.path, 'utf-8'))).toEqual({
                mcpServers: { grada: { command: 'npx', args: ['--yes', 'grada-run', 'mcp'] } },
            });
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('merges into zed settings preserving unrelated keys and servers', () => {
        const home = makeHome();
        try {
            const settingsPath = path.join(home, '.config', 'zed', 'settings.json');
            fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
            fs.writeFileSync(settingsPath, JSON.stringify({
                theme: 'One Dark',
                context_servers: { other: { command: 'other-mcp' } },
            }));
            const result = installMcpConfig('zed', { homeDir: home });
            expect(result).toMatchObject({ ok: true, alreadyInstalled: false });
            expect(JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))).toEqual({
                theme: 'One Dark',
                context_servers: {
                    other: { command: 'other-mcp' },
                    grada: { command: 'npx', args: ['--yes', 'grada-run', 'mcp'] },
                },
            });
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('is idempotent when the identical entry already exists', () => {
        const home = makeHome();
        try {
            const first = installMcpConfig('windsurf', { homeDir: home });
            const before = fs.readFileSync(first.path, 'utf-8');
            const second = installMcpConfig('windsurf', { homeDir: home });
            expect(second).toMatchObject({ ok: true, alreadyInstalled: true });
            expect(fs.readFileSync(first.path, 'utf-8')).toBe(before);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('upgrades a legacy entry without --yes to the current block', () => {
        const home = makeHome();
        try {
            const configPath = path.join(home, '.codeium', 'windsurf', 'mcp_config.json');
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { grada: { command: 'npx', args: ['grada-run', 'mcp'] } } }));
            const result = installMcpConfig('windsurf', { homeDir: home });
            expect(result).toMatchObject({ ok: true, alreadyInstalled: false });
            expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).mcpServers.grada).toEqual({
                command: 'npx',
                args: ['--yes', 'grada-run', 'mcp'],
            });
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('overwrites a stale grada entry with the current block', () => {
        const home = makeHome();
        try {
            const configPath = path.join(home, '.codeium', 'windsurf', 'mcp_config.json');
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { grada: { command: 'node', args: ['old.js'] } } }));
            const result = installMcpConfig('windsurf', { homeDir: home });
            expect(result).toMatchObject({ ok: true, alreadyInstalled: false });
            expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).mcpServers.grada).toEqual({
                command: 'npx',
                args: ['--yes', 'grada-run', 'mcp'],
            });
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it.each([
        ['emacs', 'unsupported-editor', 'MCP_INSTALL_UNSUPPORTED_EDITOR'],
        ['', 'missing-editor', 'MCP_INSTALL_USAGE'],
        [undefined, 'missing-editor', 'MCP_INSTALL_USAGE'],
    ])('rejects editor %s as %s without writing', (editor, reason, errorCode) => {
        const home = makeHome();
        try {
            expect(installMcpConfig(editor, { homeDir: home })).toMatchObject({ ok: false, reason, errorCode });
            expect(fs.existsSync(path.join(home, '.codeium'))).toBe(false);
            expect(fs.existsSync(path.join(home, '.config'))).toBe(false);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it.each(['{not json', '["an", "array"]', '"a string"', '42'])(
        'refuses to clobber an unreadable config (%s)',
        (content) => {
            const home = makeHome();
            try {
                const configPath = path.join(home, '.config', 'zed', 'settings.json');
                fs.mkdirSync(path.dirname(configPath), { recursive: true });
                fs.writeFileSync(configPath, content);
                const result = installMcpConfig('zed', { homeDir: home });
                expect(result).toMatchObject({ ok: false, reason: 'unreadable-config' });
                expect(fs.readFileSync(configPath, 'utf-8')).toBe(content);
            } finally {
                fs.rmSync(home, { recursive: true, force: true });
            }
        }
    );

    it('guides JSONC (commented) configs with a paste-ready block instead of misdiagnosing', () => {
        const home = makeHome();
        try {
            const configPath = path.join(home, '.config', 'zed', 'settings.json');
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            const content = '{\n// theme comment\n"theme": "dark",\n"homepage": "https://example.com/docs",\n/* block comment */\n"context_servers": {}\n}\n';
            fs.writeFileSync(configPath, content);
            const result = installMcpConfig('zed', { homeDir: home });
            expect(result).toMatchObject({ ok: false, reason: 'jsonc-config', errorCode: 'MCP_INSTALL_JSONC_CONFIG' });
            expect(result.message).toContain('context_servers');
            expect(result.message).toContain('"grada"');
            expect(result.message).toContain('grada-run');
            expect(fs.readFileSync(configPath, 'utf-8')).toBe(content);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('still refuses commented configs for strict-JSON editors', () => {
        const home = makeHome();
        try {
            const configPath = path.join(home, '.cursor', 'mcp.json');
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            const content = '{\n// comment\n"mcpServers": {}\n}\n';
            fs.writeFileSync(configPath, content);
            const result = installMcpConfig('cursor', { homeDir: home });
            expect(result).toMatchObject({ ok: false, reason: 'unreadable-config' });
            expect(fs.readFileSync(configPath, 'utf-8')).toBe(content);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('resolves no install target without a home directory', () => {
        expect(mcpInstallTarget('vscode', null)).toBeNull();
    });

    it.each([
        ['default home resolution', {}],
        ['explicit null home', { homeDir: null }],
    ])('fails loud with a named error without HOME (%s)', (_, options) => {
        const homeSpy = vi.spyOn(os, 'homedir').mockImplementation(() => {
            throw new Error('uv_os_get_passwd returned ENOENT');
        });
        try {
            const result = installMcpConfig('vscode', options);
            expect(result).toMatchObject({
                ok: false,
                reason: 'home-undeterminable',
                errorCode: 'MCP_INSTALL_HOME_UNDETERMINABLE',
                editor: 'vscode',
            });
            expect(result.message).toContain('home directory');
        } finally {
            homeSpy.mockRestore();
        }
    });

    it('reports usage errors before HOME errors', () => {
        expect(installMcpConfig('emacs', { homeDir: null })).toMatchObject({
            ok: false,
            reason: 'unsupported-editor',
            errorCode: 'MCP_INSTALL_UNSUPPORTED_EDITOR',
        });
    });
});

describe('runMcp --install', () => {
    function silenceConsole() {
        return vi.spyOn(console, 'log').mockImplementation(() => {});
    }

    it('installs windsurf config and tracks the install', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-run-install-'));
        const logSpy = silenceConsole();
        try {
            const result = await runMcp({ install: 'windsurf', homeDir: home });
            expect(result).toMatchObject({ ok: true, editor: 'windsurf' });
            expect(JSON.parse(fs.readFileSync(result.path, 'utf-8')).mcpServers.grada).toEqual({
                command: 'npx',
                args: ['--yes', 'grada-run', 'mcp'],
            });
            expect(trackSuccess).toHaveBeenCalledWith('mcp_install', { editor: 'windsurf', already_installed: false });
        } finally {
            logSpy.mockRestore();
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('exits non-zero with structured telemetry on install failure', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
        const logSpy = silenceConsole();
        try {
            const result = await runMcp({ install: 'emacs' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(result).toMatchObject({ ok: false, reason: 'unsupported-editor' });
        } finally {
            exitSpy.mockRestore();
            logSpy.mockRestore();
        }
    });
});

describe('agent integration files', () => {
    const ROOT = path.join(HERE, '..');

    it('copilot instructions mirror the skill constraints', () => {
        const content = fs.readFileSync(path.join(ROOT, '.github', 'copilot-instructions.md'), 'utf-8');
        expect(content).toContain('--target ecs');
        expect(content).toContain('--target lambda');
        expect(content).toContain('init');
        expect(content).toContain('add_primitive');
        expect(content).toContain('DO NOT');
    });

    it('windsurf rules mirror the cursor rule logic', () => {
        const content = fs.readFileSync(path.join(ROOT, '.windsurfrules'), 'utf-8');
        expect(content).toContain('Grada MCP tools');
        expect(content).toContain('terraform validate');
        expect(content).toContain('grada secrets audit');
        expect(content).toContain('add_primitive');
    });

    it('openapi spec is valid 3.1.0 documenting the five tools', () => {
        const spec = JSON.parse(fs.readFileSync(path.join(ROOT, '.ai', 'openapi.json'), 'utf-8'));
        expect(spec.openapi).toBe('3.1.0');
        const operationIds = Object.values(spec.paths).flatMap((pathItem) =>
            Object.values(pathItem).map((operation) => operation.operationId)
        );
        expect(operationIds.sort()).toEqual(
            ['add_primitive', 'analyze_stack', 'audit_secrets', 'fetch_logs', 'stack_status'].sort()
        );
        expect(spec.paths['/add_primitive'].post.requestBody.content['application/json'].schema.required).toContain('capability');
    });

    it('zed extension scaffold wires the grada context server', () => {
        const manifest = fs.readFileSync(path.join(ROOT, 'extensions', 'zed', 'extension.toml'), 'utf-8');
        expect(manifest).toContain('[context_servers.grada]');
        const cargo = fs.readFileSync(path.join(ROOT, 'extensions', 'zed', 'Cargo.toml'), 'utf-8');
        expect(cargo).toContain('zed_extension_api');
        const lib = fs.readFileSync(path.join(ROOT, 'extensions', 'zed', 'src', 'lib.rs'), 'utf-8');
        expect(lib).toContain('context_server_command');
        expect(lib).toContain('register_extension!(GradaExtension)');
        expect(lib).toContain('"grada-run"');
        expect(lib).toContain('"mcp"');
    });

    it('vscode extension scaffold contributes the install commands', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extensions', 'vscode', 'package.json'), 'utf-8'));
        const commands = manifest.contributes.commands.map((entry) => entry.command).sort();
        expect(commands).toEqual(['grada.installMcpServer', 'grada.openDocs']);
        expect(manifest.main).toBe('./extension.js');
        const entry = fs.readFileSync(path.join(ROOT, 'extensions', 'vscode', 'extension.js'), 'utf-8');
        expect(entry).toContain('grada.installMcpServer');
        expect(entry).toContain('mcp --install vscode');
    });

    it('docker bridge serves the http transport', () => {
        const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8');
        expect(dockerfile).toContain('EXPOSE 3000');
        expect(dockerfile).toContain('--transport');
        expect(dockerfile).toContain('http');
        const ignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf-8');
        expect(ignore).toContain('node_modules');
    });
});
