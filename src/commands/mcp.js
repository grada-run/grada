import fsSync from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import util from 'util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getCliVersion, trackSuccess, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { failCommand } from '../utils/command.js';
import { runStatus } from './status.js';
import { runLogs } from './logs.js';
import { auditSecrets } from './secrets.js';
import { runAdd } from './add.js';
import { ADDON_REGISTRY } from '../utils/addons.js';
import { detectFramework } from '../utils/detector.js';
import { resolveProjectName, readTerraformComputeTarget } from '../utils/resolvers.js';

// Lightweight API wrapper over the existing programmatic entrypoints.
// ISOLATION: this module never modifies src/commands/* behavior — it only
// routes MCP tool calls to runStatus/runLogs/auditSecrets/runAdd and
// serializes their return values. Two guards keep the STDIO transport
// pure: stdout is captured during tool execution (commands log and Clack
// renders to stdout), and process.exit is intercepted (failure paths
// exit instead of returning).

export const MCP_SERVER_NAME = 'grada';

export const TOOL_NAMES = ['analyze_stack', 'add_primitive', 'stack_status', 'fetch_logs', 'audit_secrets'];

// Cap of captured command output attached to error results, so a chatty
// failure cannot flood the model's context window.
const MAX_ERROR_OUTPUT_CHARS = 4000;

const ANSI_RE = /\x1B\[[0-9;]*m/g;

export function stripAnsi(text) {
    return String(text ?? '').replace(ANSI_RE, '');
}

// Sentinel thrown when a wrapped command calls process.exit instead of
// returning. The exit code is preserved so error results stay honest
// about which path the command took.
export class InterceptedExit extends Error {
    constructor(code) {
        super(`process.exit(${code ?? 'unknown'}) intercepted during MCP tool call`);
        this.name = 'InterceptedExit';
        this.exitCode = code;
        // Filled by withStdioGuards: the command's captured stdout up to
        // the exit, so failure messages survive the interception.
        this.output = '';
    }
}

// True while a guarded tool call owns stdout. The patched write below
// captures only then; at all other times (and for transport sends, via
// excludeTransportFromCapture) it delegates to the original write.
let stdoutCaptureActive = false;

// Runs `fn` with stdout captured and process.exit stubbed: both the
// raw `process.stdout.write` (Clack renders to it directly) and the
// stdout-bound `console` methods are intercepted, so no wrapped output
// can reach the JSON-RPC stream regardless of how the caller writes.
// stderr passes through untouched — diagnostics must never touch
// stdout. Restores everything in `finally`, even when `fn` throws.
export async function withStdioGuards(fn) {
    const stdoutWrite = process.stdout.write;
    const processExit = process.exit;
    const consoleLog = console.log;
    const consoleInfo = console.info;
    const consoleDebug = console.debug;
    const captured = [];
    const wasCapturing = stdoutCaptureActive;
    process.stdout.write = (chunk, encoding, callback) => {
        if (!stdoutCaptureActive) {
            return stdoutWrite.call(process.stdout, chunk, encoding, callback);
        }
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
        captured.push(text);
        const done = typeof encoding === 'function' ? encoding : callback;
        if (typeof done === 'function') queueMicrotask(() => done());
        return true;
    };
    stdoutCaptureActive = true;
    const captureConsole = (...args) => {
        captured.push(`${util.format(...args)}\n`);
    };
    console.log = captureConsole;
    console.info = captureConsole;
    console.debug = captureConsole;
    process.exit = ((code) => {
        throw new InterceptedExit(code);
    });
    try {
        const result = await fn();
        return { result, output: captured.join('') };
    } catch (error) {
        if (error instanceof InterceptedExit) error.output = captured.join('');
        throw error;
    } finally {
        process.stdout.write = stdoutWrite;
        process.exit = processExit;
        console.log = consoleLog;
        console.info = consoleInfo;
        console.debug = consoleDebug;
        stdoutCaptureActive = wasCapturing;
    }
}

// Wraps a transport's `send` so SDK responses and notifications bypass
// stdout capture. Without this, a pipelined request whose response is
// written while another tool call holds the guard would be swallowed
// into that call's buffer and never reach the client. The flag flip is
// synchronous around the (synchronous) write, so no interleaving is
// possible on Node's single thread.
export function excludeTransportFromCapture(transport) {
    const innerSend = transport.send.bind(transport);
    transport.send = (...args) => {
        const wasCapturing = stdoutCaptureActive;
        stdoutCaptureActive = false;
        try {
            return innerSend(...args);
        } finally {
            stdoutCaptureActive = wasCapturing;
        }
    };
    return transport;
}

// Serializes tool execution: the stdio guards above are process-global,
// so concurrent tool calls would otherwise steal each other's output.
// The chain survives rejections — every queued call still runs.
let toolCallQueue = Promise.resolve();

export function runGuardedToolCall(fn) {
    const next = toolCallQueue.then(() => withStdioGuards(fn));
    toolCallQueue = next.catch(() => {});
    return next;
}

// Names the wrapped command for telemetry while `fn` runs, so events
// emitted by programmatic entrypoints carry the real `cli_command`
// instead of 'module_import'. Must wrap the work *inside*
// runGuardedToolCall: the serial queue makes the module-level slot
// safe, while setting it outside would race pipelined tool calls.
export async function withMcpCommand(commandName, fn) {
    setActiveCommandName(commandName);
    try {
        return await fn();
    } finally {
        resetActiveCommandName();
    }
}

function truncateOutput(output) {
    const clean = stripAnsi(output).trim();
    if (clean.length <= MAX_ERROR_OUTPUT_CHARS) return clean;
    return `${clean.slice(0, MAX_ERROR_OUTPUT_CHARS)}\n[…truncated]`;
}

function toolText(data) {
    return {
        content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
    };
}

function toolError(message) {
    return { content: [{ type: 'text', text: message }], isError: true };
}

function exitError(error, output) {
    const detail = truncateOutput(output);
    const message = `The grada command exited with code ${error.exitCode ?? 'unknown'} instead of returning data.`
        + (detail ? `\n\nCommand output:\n${detail}` : '');
    return toolError(message);
}

function failureError(label, output) {
    const detail = truncateOutput(output);
    return toolError(detail ? `${label}\n\nCommand output:\n${detail}` : label);
}

// Pure filesystem reads — no console output, no exits, no guards needed.
export async function handleAnalyzeStack({ cwd } = {}) {
    const dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();
    const framework = detectFramework(dir);
    let computeTarget = 'unknown';
    try {
        computeTarget = readTerraformComputeTarget(dir) || 'unknown';
    } catch {
        computeTarget = 'unknown';
    }
    const terraformDir = path.join(dir, 'terraform');
    const initialized = fsSync.existsSync(path.join(terraformDir, 'main.tf'));
    const installedAddons = Object.entries(ADDON_REGISTRY)
        .filter(([, addon]) => {
            try {
                return fsSync.existsSync(path.join(terraformDir, addon.file));
            } catch {
                return false;
            }
        })
        .map(([capability]) => capability);
    return toolText({
        projectDir: dir,
        framework: framework ? { id: framework.id, name: framework.name } : null,
        computeTarget,
        terraformInitialized: initialized,
        installedAddons,
    });
}

export async function handleAddPrimitive(args = {}) {
    const { capability, cwd, ...rest } = args;
    const options = { ...rest, capability, isHeadless: true };
    if (typeof cwd === 'string' && cwd.trim()) options.cwd = cwd.trim();
    let guarded;
    try {
        guarded = await runGuardedToolCall(() => withMcpCommand('add', () => runAdd(options)));
    } catch (error) {
        if (error instanceof InterceptedExit) return exitError(error, error.output);
        throw error;
    }
    // Exit-guard caveat: failCommand exits before returning, so an
    // intercepted exit above is the common failure shape. The branches
    // below only run for the rare exitCode:null soft failures.
    if (guarded.result && guarded.result.ok === false) {
        const reason = guarded.result.reason || 'unknown';
        return failureError(`grada add ${capability} failed (${reason}).`, guarded.output);
    }
    return toolText(guarded.result);
}

export async function handleStackStatus(args = {}) {
    const options = { ...args, json: true, isHeadless: true };
    let guarded;
    try {
        guarded = await runGuardedToolCall(() => withMcpCommand('status', () => runStatus(options)));
    } catch (error) {
        if (error instanceof InterceptedExit) return exitError(error, error.output);
        throw error;
    }
    return toolText(guarded.result);
}

export async function handleFetchLogs(args = {}) {
    const { hours = 1, cwd, ...rest } = args;
    const options = { ...rest, since: `${hours}h`, follow: false, isHeadless: true };
    if (typeof cwd === 'string' && cwd.trim()) options.cwd = cwd.trim();
    let guarded;
    try {
        guarded = await runGuardedToolCall(() => withMcpCommand('logs', () => runLogs(options)));
    } catch (error) {
        if (error instanceof InterceptedExit) return exitError(error, error.output);
        throw error;
    }
    return toolText(guarded.result);
}

export async function handleAuditSecrets(args = {}) {
    const { envFile = '.env', project, region } = args;
    // auditSecrets resolves paths against process.cwd(), so this tool
    // always audits the server's working directory by design.
    const projectName = typeof project === 'string' && project.trim()
        ? project.trim()
        : resolveProjectName({ region }, process.cwd());
    let guarded;
    try {
        guarded = await runGuardedToolCall(() => withMcpCommand('secrets', () => auditSecrets(envFile, projectName, { region })));
    } catch (error) {
        if (error instanceof InterceptedExit) return exitError(error, error.output);
        throw error;
    }
    return toolText(guarded.result);
}

const CAPABILITY_VALUES = Object.keys(ADDON_REGISTRY);

const cwdArg = z.string().optional().describe('Project directory. Defaults to the MCP server working directory.');
const regionArg = z.string().optional().describe('AWS region. Defaults to the region in terraform/main.tf.');

export function createMcpServer() {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: getCliVersion() });

    server.registerTool(
        'analyze_stack',
        {
            description: 'Inspect a Grada project: detected framework, compute target (ecs, lambda, or static), whether Terraform is initialized, and installed add-on primitives.',
            inputSchema: { cwd: cwdArg },
        },
        async (args) => handleAnalyzeStack(args)
    );

    server.registerTool(
        'add_primitive',
        {
            description: 'Provision a Grada add-on primitive (equivalent to `grada add <capability> --headless`): scaffolds the Terraform module and injects container env vars. ai:bedrock uses the catalog default model unless `model` is given; email:ses requires `domain` (or an existing terraform/domain.tf). Never write raw Terraform blocks for these — always use this tool.',
            inputSchema: {
                capability: z.enum(CAPABILITY_VALUES).describe(`Add-on capability: ${CAPABILITY_VALUES.join(', ')}.`),
                force: z.boolean().optional().describe('Overwrite the Terraform module if it already exists.'),
                region: regionArg,
                model: z.string().optional().describe('Bedrock model ID (ai:bedrock only).'),
                domain: z.string().optional().describe('Domain for SES identities (email:ses only).'),
                zoneId: z.string().optional().describe('Route 53 hosted zone ID for SES DNS records (email:ses only).'),
                fromEmail: z.string().optional().describe('Sender address for SES (email:ses only).'),
                cwd: cwdArg,
            },
        },
        async (args) => handleAddPrimitive(args)
    );

    server.registerTool(
        'stack_status',
        {
            description: 'Live AWS health state of the Grada stack (equivalent to `grada status --json`): ECS service desired/running counts, CloudWatch alarms, and overall health.',
            inputSchema: {
                service: z.string().optional().describe('ECS service name. Defaults to <project>-service.'),
                cluster: z.string().optional().describe('ECS cluster name. Defaults to <project>-cluster.'),
                region: regionArg,
                cwd: cwdArg,
            },
        },
        async (args) => handleStackStatus(args)
    );

    server.registerTool(
        'fetch_logs',
        {
            description: 'Recent CloudWatch application logs for the Grada service (equivalent to `grada logs --since`). Never blocks: follow mode is disabled.',
            inputSchema: {
                hours: z.number().positive().default(1).describe('Lookback window in hours. Defaults to 1.'),
                service: z.string().optional().describe('Service name. Defaults to the project name.'),
                tail: z.number().int().positive().optional().describe('Max log lines. Defaults to 50.'),
                error: z.boolean().optional().describe('Only return lines matching error keywords.'),
                region: regionArg,
                cwd: cwdArg,
            },
        },
        async (args) => handleFetchLogs(args)
    );

    server.registerTool(
        'audit_secrets',
        {
            description: 'Compare local .env keys against AWS Secrets Manager (equivalent to `grada secrets audit`). Returns drifted key names only — never secret values.',
            inputSchema: {
                envFile: z.string().default('.env').describe('Local env file path, relative to the server working directory.'),
                project: z.string().optional().describe('Project name. Defaults to the name in terraform/main.tf.'),
                region: regionArg,
            },
        },
        async (args) => handleAuditSecrets(args)
    );

    return server;
}

export function parseMcpArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'mcp') args.shift();
    const { options } = parseFlags(args, { string: ['install', 'transport', 'host'], number: ['port'] });
    if (options.install === undefined) {
        // parseFlags drops a trailing valueless `--install`; detect the
        // flag's presence so runMcp reports usage instead of starting
        // a server the user never asked for.
        if (args.some((arg) => typeof arg === 'string' && (arg === '--install' || arg.startsWith('--install=')))) {
            options.install = '';
        }
        return options;
    }
    if (typeof options.install === 'string') {
        const editor = options.install.trim().toLowerCase();
        // An `--install` swallowing another flag carries no usable value:
        // normalize to '' so runMcp reports usage.
        options.install = editor && !editor.startsWith('-') ? editor : '';
    }
    return options;
}

export const MCP_TRANSPORTS = ['stdio', 'http'];
export const MCP_DEFAULT_HTTP_PORT = 3000;
export const MCP_DEFAULT_HTTP_HOST = '127.0.0.1';

// Validates transport selection for `grada mcp`. Pure: every outcome is
// a structured result so the dispatch logic is unit-testable without
// opening sockets.
export function resolveMcpTransport(input = {}) {
    const options = normalizeOptions(input);
    const transport = options.transport === undefined ? 'stdio' : String(options.transport).trim().toLowerCase();
    if (!MCP_TRANSPORTS.includes(transport)) {
        return {
            ok: false,
            reason: 'unknown-transport',
            errorCode: 'MCP_TRANSPORT_UNKNOWN',
            message: `\n✖ Unknown transport "${options.transport}". Supported transports: ${MCP_TRANSPORTS.join(', ')}.`,
        };
    }
    const port = options.port === undefined ? MCP_DEFAULT_HTTP_PORT : options.port;
    if (transport === 'http' && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        return {
            ok: false,
            reason: 'bad-port',
            errorCode: 'MCP_TRANSPORT_BAD_PORT',
            message: `\n✖ Invalid --port "${options.port}". Use an integer between 1 and 65535.`,
        };
    }
    const host = options.host === undefined ? MCP_DEFAULT_HTTP_HOST : options.host;
    if (transport === 'http' && (typeof host !== 'string' || host.trim() === '')) {
        return {
            ok: false,
            reason: 'bad-host',
            errorCode: 'MCP_TRANSPORT_BAD_HOST',
            message: '\n✖ Invalid --host. Use an interface address such as 127.0.0.1 or 0.0.0.0.',
        };
    }
    return { ok: true, transport, port, host };
}

// Editors the `--install` flag can write MCP config for. Each target
// names its config file and the root key holding server entries.
// `platform` is injectable (default: os.platform()) so tests can cover
// every OS layout from one machine.
export const MCP_INSTALL_EDITORS = ['windsurf', 'zed', 'cursor', 'vscode', 'claude-desktop', 'gemini-cli'];

export const MCP_SERVER_CONFIG = { command: 'npx', args: ['grada-run', 'mcp'] };

export function mcpInstallTarget(editor, homeDir = os.homedir(), platform = os.platform()) {
    switch (editor) {
        case 'windsurf':
            return { path: path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' };
        case 'zed':
            return { path: path.join(homeDir, '.config', 'zed', 'settings.json'), key: 'context_servers' };
        case 'cursor':
            return { path: path.join(homeDir, '.cursor', 'mcp.json'), key: 'mcpServers' };
        case 'gemini-cli':
            return { path: path.join(homeDir, '.gemini', 'settings.json'), key: 'mcpServers' };
        case 'claude-desktop': {
            // Claude Desktop keeps its config in the OS app-data dir.
            const relative = platform === 'darwin'
                ? ['Library', 'Application Support', 'Claude', 'claude_desktop_config.json']
                : platform === 'win32'
                    ? ['AppData', 'Roaming', 'Claude', 'claude_desktop_config.json']
                    : ['.config', 'Claude', 'claude_desktop_config.json'];
            return { path: path.join(homeDir, ...relative), key: 'mcpServers' };
        }
        case 'vscode': {
            // Default-profile user mcp.json (VS Code profiles relocate
            // it; the command palette's "MCP: Open User Configuration"
            // always opens the right one). Note the `servers` root key —
            // VS Code does not use `mcpServers`.
            const relative = platform === 'darwin'
                ? ['Library', 'Application Support', 'Code', 'User', 'mcp.json']
                : platform === 'win32'
                    ? ['AppData', 'Roaming', 'Code', 'User', 'mcp.json']
                    : ['.config', 'Code', 'User', 'mcp.json'];
            return { path: path.join(homeDir, ...relative), key: 'servers' };
        }
        default:
            return null;
    }
}

function isSameServerConfig(entry) {
    return !!entry
        && entry.command === MCP_SERVER_CONFIG.command
        && Array.isArray(entry.args)
        && entry.args.length === MCP_SERVER_CONFIG.args.length
        && entry.args.every((arg, index) => arg === MCP_SERVER_CONFIG.args[index]);
}

// Writes the Grada MCP server entry into an editor's config file,
// preserving every existing key and server. `homeDir` is injectable so
// tests never touch the real home directory. Never throws and never
// exits: all outcomes are structured `{ ok, ... }` results.
export function installMcpConfig(editor, { homeDir = os.homedir(), platform = os.platform() } = {}) {
    const normalized = typeof editor === 'string' ? editor.trim().toLowerCase() : '';
    const target = normalized ? mcpInstallTarget(normalized, homeDir, platform) : null;
    if (!target) {
        return {
            ok: false,
            reason: normalized ? 'unsupported-editor' : 'missing-editor',
            errorCode: normalized ? 'MCP_INSTALL_UNSUPPORTED_EDITOR' : 'MCP_INSTALL_USAGE',
            message: normalized
                ? `\n✖ Unsupported editor "${editor}". Supported editors: ${MCP_INSTALL_EDITORS.join(', ')}.`
                : '\n✖ Missing editor. Usage: grada mcp --install <editor>.',
        };
    }
    let existing = {};
    try {
        if (fsSync.existsSync(target.path)) {
            existing = JSON.parse(fsSync.readFileSync(target.path, 'utf-8'));
            if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
                throw new Error('config root must be a JSON object');
            }
        }
    } catch {
        return {
            ok: false,
            reason: 'unreadable-config',
            errorCode: 'MCP_INSTALL_CONFIG_UNREADABLE',
            editor: normalized,
            path: target.path,
            message: `\n✖ Could not parse ${target.path} as a JSON object. Fix or remove it, then retry.`,
        };
    }
    const servers = existing[target.key] && typeof existing[target.key] === 'object' && !Array.isArray(existing[target.key])
        ? existing[target.key]
        : {};
    if (isSameServerConfig(servers.grada)) {
        return { ok: true, alreadyInstalled: true, editor: normalized, path: target.path };
    }
    try {
        fsSync.mkdirSync(path.dirname(target.path), { recursive: true });
        fsSync.writeFileSync(
            target.path,
            `${JSON.stringify({ ...existing, [target.key]: { ...servers, grada: { ...MCP_SERVER_CONFIG, args: [...MCP_SERVER_CONFIG.args] } } }, null, 4)}\n`,
            'utf-8'
        );
    } catch (error) {
        return {
            ok: false,
            reason: 'write-failed',
            errorCode: 'MCP_INSTALL_WRITE_FAILED',
            editor: normalized,
            path: target.path,
            message: `\n✖ Could not write ${target.path}: ${error?.message || error}`,
        };
    }
    return { ok: true, alreadyInstalled: false, editor: normalized, path: target.path };
}

// Starts the blocking STDIO server (default), or installs IDE config
// and returns when `--install <editor>` is passed. Resolves once the
// transport is connected; the process stays alive on the stdin listener
// until the client disconnects or receives SIGINT/SIGTERM.
export async function runMcp(input = {}) {
    const options = normalizeOptions(input);
    if (options.install !== undefined) {
        const installed = installMcpConfig(options.install, { homeDir: options.homeDir, platform: options.platform });
        if (!installed.ok) {
            return failCommand({
                message: installed.message,
                hint: `Supported editors: ${MCP_INSTALL_EDITORS.join(', ')}.\n`,
                event: 'mcp_install',
                errorCode: installed.errorCode,
                reason: installed.reason,
            });
        }
        if (installed.alreadyInstalled) {
            console.log(`Grada MCP server is already installed for ${installed.editor} (${installed.path}).`);
        } else {
            console.log(`✅ Grada MCP server installed for ${installed.editor} → ${installed.path}`);
            console.log('   Restart your editor to load the new MCP server.');
        }
        await trackSuccess('mcp_install', { editor: installed.editor, already_installed: installed.alreadyInstalled === true });
        return { ok: true, ...installed };
    }
    const resolved = resolveMcpTransport(options);
    if (!resolved.ok) {
        return failCommand({
            message: resolved.message,
            hint: 'Usage: grada mcp [--transport stdio|http] [--port 3000] [--host 127.0.0.1].\n',
            event: 'mcp_run',
            errorCode: resolved.errorCode,
            reason: resolved.reason,
        });
    }
    if (resolved.transport === 'http') {
        return runMcpHttp({ port: resolved.port, host: resolved.host });
    }
    const server = createMcpServer();
    const transport = excludeTransportFromCapture(new StdioServerTransport());
    const shutdown = async () => {
        try {
            await server.close();
        } catch {
            // Best effort: the transport may already be gone.
        }
        process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await server.connect(transport);
    console.error(`grada MCP server (${getCliVersion()}) listening on stdio with ${TOOL_NAMES.length} tools.`);
}

// Builds the (req, res) handler delegating /mcp traffic to a connected
// streamable-HTTP transport. Exported (and promise-based) so routing is
// unit-testable with fake request/response objects — no sockets needed.
export function createHttpRequestHandler(transport) {
    return async (req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname !== '/mcp') {
            res.writeHead(404, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ error: 'not found, POST JSON-RPC to /mcp' }));
            return;
        }
        if (req.method !== 'POST' && req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ error: 'method not allowed, use POST or GET' }));
            return;
        }
        const rawBody = await new Promise((resolve) => {
            const chunks = [];
            // String chunks occur when the request stream has an
            // encoding set; normalize so concat never throws on them.
            req.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        });
        let parsedBody;
        if (rawBody.trim() !== '') {
            try {
                parsedBody = JSON.parse(rawBody);
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                    .end(JSON.stringify({ error: 'invalid JSON body' }));
                return;
            }
        }
        await transport.handleRequest(req, res, parsedBody);
    };
}

// Starts the blocking Streamable HTTP server (stateless: no session
// affinity, safe behind tunnels and load balancers). `createServer` is
// injectable so wiring is unit-testable without binding a port.
// NOTE: the HTTP transport has no authentication — bind it to
// localhost or expose it only through a trusted tunnel.
export async function runMcpHttp({ port = MCP_DEFAULT_HTTP_PORT, host = MCP_DEFAULT_HTTP_HOST } = {}, deps = {}) {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    const createServer = deps.createServer || http.createServer;
    const httpServer = createServer(createHttpRequestHandler(transport));
    await new Promise((resolve, reject) => {
        httpServer.on('error', reject);
        httpServer.listen(port, host, resolve);
    });
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
        console.error('⚠️  grada MCP HTTP transport has no authentication — expose it only behind a trusted tunnel.');
    }
    console.error(`grada MCP server (${getCliVersion()}) listening on http://${host}:${port}/mcp with ${TOOL_NAMES.length} tools.`);
    const shutdown = async () => {
        try {
            await server.close();
        } catch {
            // Best effort: the transport may already be gone.
        }
        try {
            httpServer.close();
        } catch {
            // Best effort: the socket may already be gone.
        }
        process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return {
        ok: true, transport: 'http', host, port, close: () => httpServer.close(),
    };
}

export default runMcp;
