import fsSync from 'fs';
import path from 'path';
import color from 'picocolors';
import { outro } from '@clack/prompts';
import { normalizeOptions } from './args.js';
import { failCommand } from './command.js';
import { trackSuccess } from '../core/telemetry.js';
import { resolveProjectName, resolveWorkspaceSuffix, resolveCluster, resolveService, resolveCwd } from './resolvers.js';
import { resolveDbIdentifier, resolveDbClusterIdentifier } from './rds.js';

export const SLEEP_STATE_DIRNAME = '.grada';
export const LEGACY_SLEEP_STATE_DIRNAME = '.deploy-stack';
export const SLEEP_STATE_FILENAME = 'sleep-state.json';
export const RDS_AUTO_RESTART_DAYS = 7;
export const RDS_AUTO_RESTART_MS = RDS_AUTO_RESTART_DAYS * 24 * 60 * 60 * 1000;

// Environment aliases that address the default/production environment.
// Returns the canonical env name, or null when no env was requested.
export function normalizeSleepEnv(rawEnv) {
    if (typeof rawEnv !== 'string') return null;
    const trimmed = rawEnv.trim();
    if (trimmed === '') return null;
    const lowered = trimmed.toLowerCase();
    if (lowered === 'default' || lowered === 'prod' || lowered === 'production') return 'default';
    return trimmed;
}

// Shared target resolution for `sleep` / `wake`: an explicit `--workspace`
// wins over the positional `[env]`; either beats the
// `.terraform/environment` auto-detect; otherwise the default environment.
// Explicit `--cluster` / `--service` / `--db-identifier` overrides still win
// inside the resolvers. Returns `{ envKey, envKind, requiresConfirm,
// appPrefix, cluster, appService, workerService, dbIdentifier,
// dbClusterIdentifier }`.
export function resolveSleepTarget(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    const base = resolveCwd(opts, cwd);
    const projectName = resolveProjectName(opts, base);
    const rawEnv = (typeof opts.workspace === 'string' && opts.workspace.trim() !== '')
        ? opts.workspace
        : opts.env;
    const env = normalizeSleepEnv(rawEnv);
    const scoped = { ...opts, workspace: env === null ? opts.workspace : env };
    const suffix = resolveWorkspaceSuffix(scoped, base);
    const appPrefix = `${projectName}${suffix}`;
    const prefixed = { ...scoped, projectName: appPrefix };
    const unprefixed = { ...scoped, projectName };
    return {
        envKey: suffix === '' ? 'default' : suffix.slice(1),
        envKind: suffix === '' ? 'default' : 'named',
        // The production guard fires unless an explicit non-default env was
        // passed — an auto-detected named workspace still prompts, since the
        // user never named it on the command line.
        requiresConfirm: env === null || env === 'default',
        appPrefix,
        cluster: resolveCluster(prefixed, base),
        appService: resolveService(prefixed, base),
        workerService: `${appPrefix}-worker-service`,
        dbIdentifier: resolveDbIdentifier(unprefixed, base),
        dbClusterIdentifier: resolveDbClusterIdentifier(unprefixed, base),
    };
}

export function sleepStatePath(cwd = process.cwd()) {
    return path.join(resolveCwd({}, cwd), SLEEP_STATE_DIRNAME, SLEEP_STATE_FILENAME);
}

export function legacySleepStatePath(cwd = process.cwd()) {
    return path.join(resolveCwd({}, cwd), LEGACY_SLEEP_STATE_DIRNAME, SLEEP_STATE_FILENAME);
}

function readLedgerFile(filePath) {
    try {
        const parsed = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
        // Fall through to null below.
    }
    return null;
}

// Reads the per-env sleep ledger (`{ [env]: entry }`). The new `.grada/`
// path wins; the legacy `.deploy-stack/` path is a read fallback so
// pre-rebrand projects wake cleanly. Missing or corrupt files read as
// empty so a hand-edited file never crashes wake/sleep.
export function readSleepState(cwd = process.cwd()) {
    return readLedgerFile(sleepStatePath(cwd))
        ?? readLedgerFile(legacySleepStatePath(cwd))
        ?? {};
}

export function writeSleepState(cwd = process.cwd(), state = {}) {
    const filePath = sleepStatePath(cwd);
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function removeSleepStateEntry(cwd = process.cwd(), envKey = 'default') {
    const state = readSleepState(cwd);
    if (!Object.prototype.hasOwnProperty.call(state, envKey)) return false;
    delete state[envKey];
    writeSleepState(cwd, state);
    return true;
}

// Shared awake gate for commands that must not run against an asleep
// environment (apply). Pure over the ledger: returns the env's ledger
// entry when asleep, null when awake. Callers own prompting/exit.
export function requireAwakeEnvironment(cwd = process.cwd(), envKey = 'default') {
    const state = readSleepState(cwd);
    const entry = state?.[envKey];
    return entry && typeof entry === 'object' ? entry : null;
}

// Pure target-intercept decision shared by sleep/wake: static targets
// never have anything to do; Lambda short-circuits on --skip-db or when
// the read-only RDS probe found no database. Returns null when the
// command must proceed, otherwise `{ reason }`.
export function resolveTargetIntercept({ computeTarget, skipDb = false, dbTarget = null, dbProbed = false } = {}) {
    if (computeTarget === 'static') return { reason: 'static-target' };
    if (computeTarget === 'lambda') {
        if (skipDb) return { reason: 'lambda-skip-db' };
        if (dbProbed && !dbTarget) return { reason: 'lambda-no-database' };
    }
    return null;
}

// Single skip-message vocabulary. Strings are byte-identical to the
// historical per-command intercepts; `verb` is 'sleep' or 'wake'.
export function formatSkipMessage({ reason, appPrefix, verb }) {
    if (reason === 'static-target') {
        return `\n  ${color.cyan(appPrefix)} is a static target — no compute or database to ${verb}. Nothing to do.\n`;
    }
    if (reason === 'lambda-skip-db') {
        return `\n  Lambda compute is already scale-to-zero and ${color.cyan('--skip-db')} was passed — nothing to ${verb}.\n`;
    }
    if (reason === 'lambda-no-database') {
        const tail = verb === 'wake'
            ? 'and Lambda compute needs no wake-up. Nothing to do.\n'
            : 'and Lambda compute is already scale-to-zero. Nothing to do.\n';
        return `\n  No databases found for ${color.cyan(appPrefix)} — ${tail}`;
    }
    if (reason === 'already-awake') {
        return `\n  ${color.cyan(appPrefix)} is already awake — nothing to restore. Nothing to do.\n`;
    }
    return `\n  Nothing to do.\n`;
}

const SKIP_TELEMETRY_BASE = {
    sleep: { ecs_scaled: 0, db_stopped: false, db_kind: 'none', cron_paused: false, scaling_suspended: false },
    wake: { ecs_restored: 0, db_started: false, waited: false, cron_resumed: false, scaling_resumed: false },
};

const SKIP_RESULT_BASE = {
    sleep: { ecsScaled: 0, dbStopped: false },
    wake: { ecsRestored: 0, dbStarted: false, waited: false, cronResumed: false, scalingResumed: false },
};

// Shared skip reporting for sleep/wake intercepts: prints the standard
// message, records a successful run with the `skipped` reason, and
// returns the standard result. Under `strict`, skips exit 2 (distinct
// from failure's 1) while telemetry still records success —
// strictness is a caller contract, not a command failure.
export async function reportSleepWakeSkip({ command, reason, target, projectName, region, strict = false }) {
    const message = formatSkipMessage({ reason, appPrefix: target.appPrefix, verb: command });
    console.log(message);
    await trackSuccess(`${command}_run`, {
        projectName,
        env_kind: target.envKind,
        ...SKIP_TELEMETRY_BASE[command],
        skipped: reason,
    });
    outro(color.green('Done.'));
    const result = {
        ok: true,
        env: target.envKey,
        cluster: target.cluster,
        region,
        ...SKIP_RESULT_BASE[command],
        skipped: reason,
    };
    if (strict !== true && strict !== 'true') return result;
    return failCommand({
        print: () => {},
        exitCode: 2,
        reason,
        resultExtra: { ...result, ok: false, skipped: reason },
    });
}

// Keeps the advisory sleep ledger out of git. Returns true when the file was
// created or amended, false when the rule already existed or the write failed.
export function ensureSleepGitignore(cwd = process.cwd()) {
    const base = resolveCwd({}, cwd);
    const file = path.join(base, '.gitignore');
    let content = null;
    try {
        if (fsSync.existsSync(file)) content = fsSync.readFileSync(file, 'utf8');
    } catch {
        content = null;
    }
    if (typeof content === 'string' && content.split('\n').some((line) => line.trim() === `${SLEEP_STATE_DIRNAME}/`)) {
        return false;
    }
    const entry = `# Local grada runtime state (sleep/wake)\n${SLEEP_STATE_DIRNAME}/\n`;
    try {
        if (content === null) {
            fsSync.writeFileSync(file, entry, 'utf8');
        } else {
            fsSync.appendFileSync(file, content.endsWith('\n') ? `\n${entry}` : `\n\n${entry}`, 'utf8');
        }
    } catch {
        return false;
    }
    return true;
}

// AWS automatically restarts stopped RDS instances and Aurora clusters after
// 7 consecutive days. Pure over an injectable clock for unit tests.
export function computeAutoRestartAt(nowMs = Date.now()) {
    return new Date(nowMs + RDS_AUTO_RESTART_MS);
}

export function formatUtcTimestamp(date) {
    const d = date instanceof Date ? date : new Date(date);
    const pad = (value) => String(value).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
        + ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
