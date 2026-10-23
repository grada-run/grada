import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { trackEvent } from '../core/telemetry.js';

// Inter-process mutual exclusion for grada's read→modify→write file
// sections (add/domain/eject scaffolding, cost docs, ledger). The lock is
// an exclusive directory: `mkdir` is atomic across processes, so exactly
// one holder wins and the rest wait or fail fast.
//
// Same-process nesting (runAdd holding the lock while scaffoldAddon takes
// it again) bypasses acquisition via AsyncLocalStorage: only the same
// async call chain is exempt — concurrent same-process callers still
// block on the lockdir, which is what serializes Promise.all-style adds.

export const DEFAULT_LOCK_TIMEOUT_MS = 30000;
export const DEFAULT_LOCK_STALE_MS = 120000;
export const DEFAULT_LOCK_POLL_MS = 25;

const lockContext = new AsyncLocalStorage();

function heldScopes() {
    return lockContext.getStore() || null;
}

export function lockDirFor(cwd, scope = 'project') {
    return path.join(cwd, '.grada', 'locks', scope);
}

function lockAgeMs(lockDir) {
    // The metadata timestamp is authoritative; the directory mtime is only
    // a fallback for locks whose holder crashed before writing meta.json.
    try {
        const meta = JSON.parse(fs.readFileSync(path.join(lockDir, 'meta.json'), 'utf8'));
        if (meta && typeof meta.createdAt === 'number') {
            return Math.max(0, Date.now() - meta.createdAt);
        }
    } catch {
        // Fall through to the mtime probe below.
    }
    try {
        return Math.max(0, Date.now() - fs.statSync(lockDir).mtimeMs);
    } catch {
        return 0;
    }
}

function tryAcquire(lockDir) {
    try {
        fs.mkdirSync(lockDir);
    } catch (error) {
        if (error && error.code === 'EEXIST') return false;
        throw error;
    }
    try {
        fs.writeFileSync(
            path.join(lockDir, 'meta.json'),
            JSON.stringify({ pid: process.pid, createdAt: Date.now() })
        );
    } catch {
        // A lock without metadata is still a lock; staleness falls back
        // to the directory mtime.
    }
    return true;
}

function releaseLock(lockDir) {
    try {
        fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
        // Best effort: a stale remnant expires via the stale check.
    }
}

function timeoutError(scope, timeoutMs) {
    const error = new Error(
        `Timed out waiting for the grada file lock (${scope}) after ${timeoutMs}ms. ` +
        'Another grada command is modifying project files — re-run when it finishes.'
    );
    error.code = 'FILE_LOCK_TIMEOUT';
    return error;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs `fn` holding the exclusive `scope` lock for `cwd`. `timeoutMs: 0`
// fails fast instead of waiting; `staleMs` takes over locks older than
// the budget (crashed holders). Resolves with `fn`'s result.
export async function withProjectLock(cwd, fn, options = {}) {
    const {
        scope = 'project',
        timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
        staleMs = DEFAULT_LOCK_STALE_MS,
        pollMs = DEFAULT_LOCK_POLL_MS,
    } = options || {};
    const key = `${path.resolve(cwd)}::${scope}`;
    const held = heldScopes();
    if (held && held.has(key)) return fn();

    const lockDir = lockDirFor(cwd, scope);
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });

    const deadline = Date.now() + timeoutMs;
    const waitStart = Date.now();
    let contended = false;
    let takeover = false;
    for (;;) {
        if (tryAcquire(lockDir)) break;
        contended = true;
        if (lockAgeMs(lockDir) > staleMs) {
            releaseLock(lockDir);
            takeover = true;
            continue;
        }
        if (Date.now() >= deadline) throw timeoutError(scope, timeoutMs);
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
    if (contended) {
        trackEvent('file_lock_waited', { scope, mode: takeover ? 'stale-takeover' : 'waited', waited_ms: Date.now() - waitStart });
    }

    const next = new Set(held || []);
    next.add(key);
    try {
        return await lockContext.run(next, fn);
    } finally {
        releaseLock(lockDir);
    }
}
