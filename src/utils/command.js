import color from 'picocolors';
import { trackEvent, trackFailure, flushTelemetry } from '../core/telemetry.js';
import { normalizeOptions } from './args.js';
import { resolveHeadless } from './resolvers.js';

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

// Non-interactive prompt gate shared by every command. When the caller is
// headless (explicit flag, CI, or no TTY) but passed no approval flag, an
// upcoming prompt could only abandon — refuse loudly with a named error
// instead of silently skipping. Returns the failure result, or null when
// the command may proceed (approval flags and real TTYs always proceed).
// Callers place one gate after arg validation, before the first prompt:
//
//   const refused = await refuseIfNonInteractive(options, { message, hint, event, telemetry, errorCode });
//   if (refused) return refused;
export async function refuseIfNonInteractive(options = {}, spec = {}) {
    const opts = normalizeOptions(options);
    if (shouldAutoApprove(opts) || !resolveHeadless(opts)) return null;
    const { message, hint, event, telemetry, errorCode, resultExtra } = spec;
    return failCommand({
        noExit: isProgrammaticCall(opts),
        message,
        hint,
        event,
        telemetry,
        errorCode,
        reason: 'non-interactive',
        resultExtra,
        exitCode: 1,
    });
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
//   whole `telemetry` object; `reason` stamps `reason`, defaulting to the
//   kebab-case mirror of the error code so every failure names itself in
//   telemetry even when the call site only passed a code. `extra` merges
//   additional telemetry fields and still wins over both stamps.
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
        // Telemetry-only enrichment: the explicit reason wins, else the
        // kebab-case error code. Result objects below keep only explicit
        // reasons — analytics completeness must never reshape the
        // programmatic API.
        const resolvedReason = reason ?? telemetry.reason
            ?? (errorCode === null ? null : String(errorCode).toLowerCase().replace(/_/g, '-'));
        trackEvent(event, {
            ...telemetry,
            ...(errorCode === null ? {} : { error_code: errorCode }),
            ...(resolvedReason === null ? {} : { reason: resolvedReason }),
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

// Shared AWS-failure stamps: the one-line trackFailure every catch block
// repeats. Used directly on early-return branches (auth expiry, watch
// retries) that record the failure without exiting through failAwsError.
export async function trackAwsFailure(event, error, telemetry = {}) {
    await trackFailure(event, {
        ...telemetry,
        error_code: error?.name || 'UNKNOWN',
        error_message: error?.message,
    });
}

// Shared AWS-failure exit: records the failure event with the error stamps,
// then prints the one-line message + credentials hint and exits (or returns
// `{ ok: false }` for programmatic callers when noExit is set). Collapses
// the trackFailure + failCommand pair every command repeats, so the shape
// can only change in one place. Sites with custom telemetry stamps or
// messages (non error-derived codes, error_type payloads) keep their own
// explicit pair instead of bending this helper with overrides.
export async function failAwsError({
    event,
    error,
    noExit = false,
    telemetry = {},
    reason = null,
    resultExtra = {},
    exitCode = 1,
} = {}) {
    await trackAwsFailure(event, error, telemetry);
    return failCommand({
        noExit,
        message: `✖ ${error?.message || error}`,
        hint: 'Check your AWS credentials and region, then try again.',
        reason,
        resultExtra,
        exitCode,
    });
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
