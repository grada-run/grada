import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const TELEMETRY_ENDPOINT = 'https://eu.i.posthog.com/capture/';
const POSTHOG_API_KEY = 'phc_o2wgA3jVT9rVDiGSDzFAR42zZeiVGhhCY53HXVHUcYGT';
const pendingRequests = [];

const CLI_ENTRY_BASENAMES = ['cli.js', 'grada', 'grada-run', 'deploy-stack'];

// Base props trackEvent stamps on every payload. Callers may override them
// with real values, but never with `undefined` (see step 3b below).
const RESERVED_BASE_PROPS = [
    'os',
    'node_version',
    'cli_version',
    'is_ci',
    'ci_provider',
    'is_test_env',
    'is_tty',
    'is_cli_entry',
    'cli_command',
    'project_id',
    'framework',
];

let cachedDistinctId = null;

export function resetTelemetryIdentityCache() {
    cachedDistinctId = null;
}

// Active command for programmatic (non-CLI) entrypoints. Wrappers such as
// the MCP server set this around the command they invoke so `cli_command`
// names the real command instead of falling back to 'module_import'.
// Always paired with resetActiveCommandName in a finally block.
let activeCommandName = null;

export function setActiveCommandName(name) {
    activeCommandName = typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
}

export function resetActiveCommandName() {
    activeCommandName = null;
}

// The installed package's own name. The version resolver matches it so an
// upward manifest search never mistakes a parent project's package.json
// (monorepo root, npx cache parent, global node_modules scope) for ours.
const CLI_PACKAGE_NAME = 'grada-run';

// Operator escape hatch for distributions that cannot ship package.json
// next to the code (single-binary bundlers). Only consulted when no
// name-matched manifest is found — the manifest is authoritative.
const CLI_VERSION_ENV_VAR = 'GRADA_CLI_VERSION';

// Resolves the CLI version stamped onto every event's base properties:
// climbs from the telemetry module's own directory (NOT the cwd, which is
// the user's project) to the nearest package.json whose `name` is ours,
// then GRADA_CLI_VERSION, then 'unknown'. Never throws: every filesystem
// or parse failure at one level just continues the climb. `startDir`,
// `readFile`, and `env` are injectable so tests can pin each fallback
// without touching the real filesystem or process env.
export function resolveCliVersion({ startDir, readFile = fs.readFileSync, env = process.env } = {}) {
    let dir;
    try {
        dir = startDir ?? path.dirname(fileURLToPath(import.meta.url));
    } catch {
        dir = null;
    }
    while (typeof dir === 'string' && dir !== '') {
        try {
            const pkg = JSON.parse(readFile(path.join(dir, 'package.json'), 'utf-8'));
            if (pkg && pkg.name === CLI_PACKAGE_NAME && typeof pkg.version === 'string' && pkg.version.trim() !== '') {
                return pkg.version;
            }
        } catch {
            // Missing/unreadable/malformed manifest — keep climbing.
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    try {
        const fromEnv = env?.[CLI_VERSION_ENV_VAR];
        if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
    } catch {
        // Fall through to the 'unknown' default below.
    }
    return 'unknown';
}

function readCliVersion() {
    try {
        return resolveCliVersion();
    } catch {
        return 'unknown';
    }
}

const CLI_VERSION = readCliVersion();

export function getCliVersion() {
    return CLI_VERSION;
}

function sha16(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex').substring(0, 16);
}

// An env var counts as active only when defined with a meaningful value.
// This keeps CI='false', CI='0', and CI='' from masquerading as CI.
export function isActiveEnvValue(value) {
    if (value === undefined || value === null) return false;
    const normalized = String(value).trim().toLowerCase();
    return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

// Distinguishes real CI pipelines from local shells/agents that set CI=true.
// Precedence: specific providers first, then generic CI, then none.
export function detectCiProvider(env = process.env) {
    if (isActiveEnvValue(env.GITHUB_ACTIONS)) return 'github_actions';
    if (isActiveEnvValue(env.GITLAB_CI)) return 'gitlab_ci';
    if (isActiveEnvValue(env.CIRCLECI)) return 'circleci';
    if (isActiveEnvValue(env.JENKINS_URL)) return 'jenkins';
    if (isActiveEnvValue(env.CI) || isActiveEnvValue(env.CONTINUOUS_INTEGRATION)) return 'generic_ci';
    return 'none';
}

export function isTestEnv(env = process.env) {
    return Boolean(env.VITEST || env.NODE_ENV === 'test');
}

export function defaultTelemetryIdPath() {
    return path.join(os.homedir(), '.grada', 'telemetry-id');
}

export function legacyTelemetryIdPath() {
    return path.join(os.homedir(), '.deploy-stack', 'telemetry-id');
}

// Migrates a legacy telemetry identity forward: when the new path is
// missing but the legacy one holds an identity, its contents seed the
// new file so the stable distinct ID survives the rebrand. Returns true
// when a migration happened. Never throws.
export function migrateLegacyTelemetryId(newPath, legacyPath) {
    try {
        if (fs.existsSync(newPath)) return false;
        const raw = fs.readFileSync(legacyPath, 'utf-8').trim();
        if (!raw) return false;
        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        fs.writeFileSync(newPath, `${raw}\n`, 'utf-8');
        return true;
    } catch {
        return false;
    }
}

// Branch A: deterministic machine/CI fingerprint for ephemeral runners.
// Cwd is deliberately excluded so commands from different directories on
// the same runner share one Person within a run.
function fingerprintDistinctId() {
    return sha16([
        os.hostname(),
        os.platform(),
        os.arch(),
        process.env.GITHUB_REPOSITORY || '',
        process.env.GITHUB_RUN_ID || '',
        process.env.GITLAB_PROJECT_PATH || '',
    ].join(':'));
}

// Branch B: persistent random UUID, created on first use. Any filesystem
// failure falls back to the Branch A fingerprint so telemetry never throws.
function persistentDistinctId(idPath) {
    try {
        let raw = '';
        try {
            raw = fs.readFileSync(idPath, 'utf-8').trim();
        } catch {
            raw = '';
        }
        if (!raw) {
            raw = crypto.randomUUID();
            fs.mkdirSync(path.dirname(idPath), { recursive: true });
            fs.writeFileSync(idPath, `${raw}\n`, 'utf-8');
        }
        return sha16(raw);
    } catch {
        return fingerprintDistinctId();
    }
}

export function resolveDistinctId({ ciProvider = detectCiProvider(), testEnv = isTestEnv() } = {}) {
    if (cachedDistinctId) return cachedDistinctId;
    const overridePath = process.env.GRADA_TELEMETRY_ID_PATH || process.env.DEPLOY_STACK_TELEMETRY_ID_PATH;
    let resolved;
    if (typeof overridePath === 'string' && overridePath.trim() !== '') {
        resolved = persistentDistinctId(overridePath);
    } else if (ciProvider !== 'none' || testEnv) {
        resolved = fingerprintDistinctId();
    } else {
        const idPath = defaultTelemetryIdPath();
        migrateLegacyTelemetryId(idPath, legacyTelemetryIdPath());
        resolved = persistentDistinctId(idPath);
    }
    cachedDistinctId = resolved;
    return resolved;
}

export function trackEvent(eventName, properties) {
    // 1. Respect privacy standards
    if (process.env.DO_NOT_TRACK === '1' || process.env.DO_NOT_TRACK === 'true') {
        return;
    }

    // 2. Keep all events: drop only missing, blank, or non-serializable
    // (object/function) names; normalize the rest so strings like
    // 'cli-error' plus booleans and numbers serialize safely.
    if (
        eventName === undefined ||
        eventName === null ||
        typeof eventName === 'object' ||
        typeof eventName === 'function' ||
        String(eventName).trim() === ''
    ) {
        return;
    }
    const normalizedEvent = String(eventName);

    // 3. Protect the PostHog column schema: only spread plain objects.
    // Primitives and arrays are wrapped so e.g. a string never spreads its
    // character indices (0, 1, 2, ...) as top-level columns.
    let eventProps;
    if (properties === undefined || properties === null) {
        eventProps = {};
    } else if (typeof properties === 'object' && !Array.isArray(properties)) {
        eventProps = { ...properties };
    } else {
        eventProps = { raw_properties: properties };
    }

    // 3b. Callers may override base props with real values (pinned
    // contract), but an explicit `undefined` must never erase them: the
    // `...eventProps` spread below runs after the base props, and
    // JSON.stringify drops undefined — which reads as "missing" in
    // PostHog. Capture the framework fallback first; it is the one base
    // prop callers legitimately feed.
    const frameworkOverride = eventProps.framework;
    for (const key of RESERVED_BASE_PROPS) {
        if (eventProps[key] === undefined) delete eventProps[key];
    }

    // 4. Resolve context first: provider before is_ci, entry before command.
    const ciProvider = detectCiProvider();
    const testEnv = isTestEnv();
    const isCi = isActiveEnvValue(process.env.CI) || ciProvider !== 'none';
    const isCliEntry = CLI_ENTRY_BASENAMES.includes(path.basename(process.argv?.[1] || ''));

    // 5. Machine-scoped Person identity, stable across commands in this env.
    const distinctId = resolveDistinctId({ ciProvider, testEnv });

    // 6. Project-scoped grouping stays in the payload as a hash. Coerce
    // first so non-string projectName values can never throw inside
    // createHash; fall back to the working directory name when omitted.
    let rawProjectName = eventProps.projectName;
    if (rawProjectName === undefined || rawProjectName === null || rawProjectName === '') {
        rawProjectName = path.basename(process.cwd()) || 'unknown';
    }
    const projectId = sha16(rawProjectName);

    // 7. Strip the raw name out of the payload
    delete eventProps.projectName;

    const payload = {
        api_key: POSTHOG_API_KEY,
        event: normalizedEvent,
        distinct_id: distinctId,
        properties: {
            os: process.platform,
            node_version: process.version,
            cli_version: CLI_VERSION,
            is_ci: isCi,
            ci_provider: ciProvider,
            is_test_env: testEnv,
            is_tty: Boolean(process.stdout && process.stdout.isTTY),
            is_cli_entry: isCliEntry,
            cli_command: isCliEntry
                ? (process.env.CLI_COMMAND || process.argv.slice(2).join(' ') || 'unknown')
                : (activeCommandName || 'module_import'),
            project_id: projectId,
            framework: process.env.GRADA_FRAMEWORK || process.env.DEPLOY_STACK_FRAMEWORK || frameworkOverride || undefined,
            ...eventProps
        }
    };

    // 6. Fire and forget (No 'await' so we don't block the user's terminal)
    const request = fetch(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    }).catch(() => {
        // Silently swallow network errors (e.g., user is offline)
    });

    pendingRequests.push(request);
}

export async function flushTelemetry() {
    if (pendingRequests.length > 0) {
        await Promise.all(pendingRequests);
    }
}

// Stamps the success flag onto wrapper properties using trackEvent's own
// normalization: plain objects merge, missing values send the flag alone,
// and anything else (strings, numbers, arrays) wraps as raw_properties so
// a primitive can never spread its indices as top-level columns.
function withSuccessFlag(properties, success) {
    if (properties === undefined || properties === null) {
        return { success };
    }
    if (typeof properties === 'object' && !Array.isArray(properties)) {
        return { ...properties, success };
    }
    return { raw_properties: properties, success };
}

// Reports a successful command outcome: tracks the event stamped
// `success: true` and flushes immediately, so a subsequent exit or
// long-lived process never loses it. Single definition for the
// track+flush pair every command repeats on its happy path.
export async function trackSuccess(eventName, properties = {}) {
    trackEvent(eventName, withSuccessFlag(properties, true));
    await flushTelemetry();
}

// Reports a failed command outcome without terminating: tracks the event
// stamped `success: false` and flushes immediately. Companion to
// trackSuccess for catch blocks that must keep branching (auth recovery,
// not-found guidance) after reporting — failCommand covers terminal failures.
export async function trackFailure(eventName, properties = {}) {
    trackEvent(eventName, withSuccessFlag(properties, false));
    await flushTelemetry();
}
