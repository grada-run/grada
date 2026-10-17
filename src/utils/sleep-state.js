import fsSync from 'fs';
import path from 'path';
import color from 'picocolors';
import { confirm, outro, log, cancel } from '@clack/prompts';
import { normalizeOptions } from './args.js';
import { failCommand, shouldAutoApprove } from './command.js';
import { atomicWriteFileSync } from './atomic-write.js';
import { withProjectLock } from './file-lock.js';
import { ensureGitignoreRules, GITIGNORE_RULE_GRADA_DIR } from './gitignore.js';
import { trackEvent, trackSuccess, flushTelemetry } from '../core/telemetry.js';
import { resolveProjectName, resolveWorkspaceSuffix, resolveCluster, resolveService, resolveCwd, readResourceSuffix, resolveHeadless } from './resolvers.js';
import { resolveDbIdentifier, resolveDbClusterIdentifier } from './rds.js';

export const SLEEP_STATE_DIRNAME = '.grada';
export const LEGACY_SLEEP_STATE_DIRNAME = '.deploy-stack';
export const SLEEP_STATE_FILENAME = 'sleep-state.json';
// Terraform-visible sleep marker: committed (never gitignored) so raw
// `terraform apply` on an ejected-but-asleep tree keeps desired counts at
// 0 and schedulers disabled instead of half-waking the stack.
export const SLEEP_AUTO_TFVARS_FILENAME = 'sleep.auto.tfvars';
export const SLEEP_AUTO_TFVARS_CONTENT = '# Managed by grada sleep/wake — deleted automatically on wake.\nasleep = true\n';
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
        workerService: `${appPrefix}${readResourceSuffix(base)}-worker-service`,
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

// Quarantines a corrupt ledger file aside (`<name>.corrupt.<ts>`) instead
// of reading it as `{}` and discarding the bytes on the next write. Prints
// a one-line notice naming the backup: a silent quarantine left successful
// runs never telling the user their ledger was dropped. Exactly-once per
// corruption — after the rename, later reads find no file and stay quiet.
// Telemetry is best-effort: reads must never throw.
function quarantineLedgerFile(filePath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${filePath}.corrupt.${stamp}`;
    try {
        fsSync.renameSync(filePath, backupPath);
    } catch {
        return;
    }
    console.log(color.yellow(`⚠ Sleep ledger was corrupt — quarantined to ${backupPath}, starting fresh.`));
    try {
        trackEvent('sleep_ledger_quarantined', {
            projectName: path.basename(path.resolve(filePath, '..', '..')),
        });
    } catch {
        // Telemetry never breaks reads.
    }
}

function readLedgerFile(filePath) {
    let raw;
    try {
        raw = fsSync.readFileSync(filePath, 'utf8');
    } catch {
        // Missing or unreadable: fall through to the next source below.
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
        // Unparseable: fall through to quarantine below.
    }
    quarantineLedgerFile(filePath);
    return null;
}

// Reads the per-env sleep ledger (`{ [env]: entry }`). The new `.grada/`
// path wins; the legacy `.deploy-stack/` path is a read fallback so
// pre-rebrand projects wake cleanly. Missing files read as empty;
// corrupt bytes quarantine aside so a hand-edited file never crashes
// wake/sleep and is never silently discarded.
export function readSleepState(cwd = process.cwd()) {
    return readLedgerFile(sleepStatePath(cwd))
        ?? readLedgerFile(legacySleepStatePath(cwd))
        ?? {};
}

export function writeSleepState(cwd = process.cwd(), state = {}) {
    const filePath = sleepStatePath(cwd);
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function removeSleepStateEntry(cwd = process.cwd(), envKey = 'default') {
    const state = readSleepState(cwd);
    if (!Object.prototype.hasOwnProperty.call(state, envKey)) return false;
    delete state[envKey];
    writeSleepState(cwd, state);
    return true;
}

export function sleepAutoTfvarsPath(cwd = process.cwd()) {
    return path.join(resolveCwd({}, cwd), 'terraform', SLEEP_AUTO_TFVARS_FILENAME);
}

// Records the asleep state for Terraform. Idempotent: re-writing an
// existing marker is a no-op byte-wise.
export function writeSleepAutoTfvars(cwd = process.cwd()) {
    const filePath = sleepAutoTfvarsPath(cwd);
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, SLEEP_AUTO_TFVARS_CONTENT, 'utf8');
}

// Deletes the marker before a restore apply so wake never fights its own
// auto-vars. Returns true when a marker existed. Never throws: an absent
// marker is the common case (awake trees, legacy sleeps).
export function clearSleepAutoTfvars(cwd = process.cwd()) {
    try {
        if (!fsSync.existsSync(sleepAutoTfvarsPath(cwd))) return false;
        fsSync.rmSync(sleepAutoTfvarsPath(cwd), { force: true });
        return true;
    } catch {
        return false;
    }
}

// Shared awake gate for commands that must not run against an asleep
// environment (apply). Pure over the ledger: returns the env's ledger
// entry when asleep, null when awake. Callers own prompting/exit.
export function requireAwakeEnvironment(cwd = process.cwd(), envKey = 'default') {
    const state = readSleepState(cwd);
    const entry = state?.[envKey];
    return entry && typeof entry === 'object' ? entry : null;
}

// Lock scope serializing every ledger read→modify→write (sleep's
// record, wake/destroy clears, eject's migrate). A dedicated scope (not
// `project`) avoids false contention with addon scaffolds; an in-band
// version field is unnecessary because every writer holds this lock.
export const LEDGER_LOCK_SCOPE = 'ledger';

// Central asleep-environment gate, extracted from apply's preflight.
// Ownership: sleep=writer, wake=clearer, apply=refuser, add/rollback=
// warners, destroy=clearer-on-success, eject=preflighter (eject hand-rolls
// its preflight in eject.js, mirroring the refuse shape below).
//
// Modes:
// - `refuse`: apply's exact behavior — --force overrides with telemetry,
//   headless fails SLEEPING_ENVIRONMENT, interactive offers wake-first via
//   the `wakeImpl` seam (defaulting to the caller's own wake function).
// - `warn`: prints "asleep, apply will block until wake" and proceeds.
//   `warnEvent`/`warnTelemetry` are optional per-command extras.
// - `clear-on-success`: post-action hook removing exactly `envKey` under
//   the ledger lock; `clearedBy` names the clearer in telemetry.
//
// Returns `{ proceed, entry, cleared?, result? }`: `result` is the
// command's return value when `proceed` is false.
export async function guardSleepingEnv({
    cwd = process.cwd(),
    envKey = 'default',
    options = {},
    command,
    mode,
    event = null,
    projectName = null,
    wakeImpl = null,
    warnEvent = null,
    warnTelemetry = {},
    clearedBy = null,
} = {}) {
    const opts = normalizeOptions(options);
    const project = projectName ?? path.basename(resolveCwd({}, cwd));
    const entry = requireAwakeEnvironment(cwd, envKey);
    if (!entry) return { proceed: true, entry: null };

    if (mode === 'warn') {
        console.log(color.yellow(`⚠ Environment "${envKey}" is asleep — ${command} continues, but apply will block until you run npx grada-run wake.`));
        if (warnEvent) trackEvent(warnEvent, { projectName: project, ...warnTelemetry });
        return { proceed: true, entry };
    }

    if (mode === 'clear-on-success') {
        const cleared = await withProjectLock(cwd, async () => removeSleepStateEntry(cwd, envKey), { scope: LEDGER_LOCK_SCOPE });
        if (cleared) trackEvent('sleep_entry_cleared', { projectName: project, by: clearedBy ?? command });
        return { proceed: true, entry: null, cleared };
    }

    // Refuse mode. Only apply uses it; the strings below are apply's
    // historical preflight text, kept byte-identical.
    if (opts.force === true || opts.force === 'true') {
        log.warn(color.yellow(`⚠ Environment "${envKey}" is asleep and --force was passed. Tasks will start against a stopped database until you run ${color.green('npx grada-run wake')}.`));
        trackEvent(`forced_${command}_while_asleep`, { projectName: project, env: envKey });
        await flushTelemetry();
        return { proceed: true, entry };
    }
    if (shouldAutoApprove(opts) || resolveHeadless(opts)) {
        return {
            proceed: false,
            result: await failCommand({
                message: `\n✖ Environment "${envKey}" is asleep. Apply would start tasks against a stopped database.`,
                hint: '  Run npx grada-run wake first, or re-run with --force to proceed anyway.\n',
                event,
                telemetry: { projectName: project },
                errorCode: 'SLEEPING_ENVIRONMENT',
                reason: 'sleeping-environment',
                resultExtra: { env: envKey },
            }),
        };
    }
    const wakeFirst = await confirm({
        message: `Environment "${envKey}" is asleep. Wake it now and continue with apply?`,
        initialValue: true,
    });
    if (wakeFirst !== true) {
        cancel('Apply aborted. The environment is still asleep.');
        return { proceed: false, result: { ok: false, reason: 'cancelled', env: envKey } };
    }
    const woken = await wakeImpl({ cwd, env: envKey });
    if (!woken || woken.ok !== true) {
        return {
            proceed: false,
            result: await failCommand({
                message: '\n✖ Wake did not complete — apply aborted.',
                hint: '  Resolve the wake failure, then re-run apply.\n',
                event,
                telemetry: { projectName: project },
                errorCode: 'WAKE_FAILED',
                reason: 'wake-failed',
                resultExtra: { env: envKey, wakeReason: woken?.reason ?? null },
            }),
        };
    }
    return { proceed: true, entry };
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
    return ensureGitignoreRules(resolveCwd({}, cwd), [GITIGNORE_RULE_GRADA_DIR]);
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
