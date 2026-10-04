import color from 'picocolors';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';
import { normalizeOptions } from './args.js';

// True when a destructive confirm must be skipped: explicit approval flags
// (--auto-approve, --yes) or explicit headless mode. Deliberately checks
// only explicit options — never CI/non-TTY inference — so a bare command
// in automation still prompts (and fails loudly) instead of silently
// approving destruction.
export function shouldAutoApprove(options = {}) {
    const opts = normalizeOptions(options);
    return [opts.autoApprove, opts.yes, opts.isHeadless, opts.headless].some(
        (flag) => flag === true || flag === 'true'
    );
}

// True when the caller is programmatic (MCP, scripts, automation) rather
// than an interactive terminal: failures must return instead of exiting
// so the host process survives. Deliberately narrower than
// shouldAutoApprove — approval flags must never suppress exit codes.
export function isProgrammaticCall(options = {}) {
    const opts = normalizeOptions(options);
    return [opts.isHeadless, opts.headless, opts.json].some(
        (flag) => flag === true || flag === 'true'
    );
}

function paint(tone, fallback) {
    return typeof color[tone] === 'function' ? color[tone] : fallback;
}

// Shared failure path for CLI commands: prints the failure, records
// telemetry (always flushed before exit so failures are never lost),
// exits with the given code, and returns a standard `{ ok: false }`
// result for programmatic callers and unit tests.
//
// - `message`/`hint` cover the common red-message + dim-hint shape;
//   pass `print` for anything custom (guidance printers, Clack cancels).
// - Omit `event` to skip telemetry (early pre-flight guards).
// - Pass `exitCode: null` to return without exiting (soft failures).
// - Pass `noExit: true` (programmatic callers) to skip the exit while
//   stamping the suppressed code onto the result — bin/cli.js restores it
//   so CLI exit codes never change.
// - `errorCode` stamps `error_code` into telemetry without repeating the
//   whole `telemetry` object; `extra` merges additional telemetry fields.
export async function failCommand({
    message = null,
    hint = null,
    tone = 'red',
    hintTone = 'dim',
    print = null,
    useErrorStream = false,
    event = null,
    telemetry = {},
    errorCode = null,
    extra = {},
    reason = null,
    resultExtra = {},
    exitCode = 1,
    noExit = false,
} = {}) {
    if (typeof print === 'function') {
        print();
    } else {
        const write = useErrorStream ? console.error : console.log;
        if (message !== null && message !== undefined) write(paint(tone, color.red)(message));
        if (hint) write(paint(hintTone, color.dim)(hint));
    }
    if (event) {
        trackEvent(event, {
            ...telemetry,
            ...(errorCode === null ? {} : { error_code: errorCode }),
            ...extra,
            success: false,
        });
        await flushTelemetry();
    }
    if (typeof exitCode === 'number') {
        if (noExit) return { ok: false, exitCode, ...(reason === null ? {} : { reason }), ...resultExtra };
        process.exit(exitCode);
    }
    return { ok: false, ...(reason === null ? {} : { reason }), ...resultExtra };
}

// Shared project-resolution failure: when a command cannot determine even
// its working directory or project identity (uninitialized directory,
// deleted cwd, programmatic misuse), fail structured instead of throwing.
export async function failProjectNotInitialized({ event, noExit = false }) {
    return failCommand({
        message: '\n✖ Could not determine the project. Run this command from a directory initialized with grada.',
        hint: 'If the problem persists, re-run npx grada-run.\n',
        event,
        errorCode: 'PROJECT_NOT_INITIALIZED',
        reason: 'project-not-initialized',
        noExit,
    });
}
