import fs from 'node:fs';

export const ISSUES_URL = 'https://github.com/grada-run/grada/issues';

// Last-resort crash backstop: unhandled rejections (e.g. the SDK
// credential chain exploding without a HOME) and uncaught exceptions
// (e.g. a future import-time throw) render one formatted report and
// exit 1 instead of dumping a raw stack — or printing nothing at all
// in --json mode. Registered via a side-effect import as the first
// line of bin/cli.js so it precedes every other listener (clack
// spinners register their own print-only rejection listener at
// start(); exiting first keeps their banner from double-surfacing).
//
// Dependency-free by design (node:* only): the crash backstop must
// never import the application modules that might be mid-failure.
// Output rule: a known environmental cause (the smithy no-HOME
// shape) prints guidance without a stack; everything else prints a
// one-liner, the stack (or String(reason) when there is none), and
// the report pointer. JSON mode puts the envelope on stdout and the
// human text on stderr so parsers stay safe.

function firstLine(text) {
    return String(text).split('\n')[0];
}

function reasonMessage(reason) {
    if (reason instanceof Error) return reason.message || String(reason);
    return String(reason);
}

function reasonDetail(reason) {
    if (reason instanceof Error && typeof reason.stack === 'string') return reason.stack;
    return String(reason);
}

// Matches smithy's shared-config loader failing on an undeterminable
// home directory (both observed uv variants). Deliberately tight:
// near-misses fail open to the stack-bearing path below.
function isSmithyHomelessRejection(reason) {
    if (!reason || typeof reason !== 'object') return false;
    const codeMatch = reason.code === 'ERR_SYSTEM_ERROR' || reason.code === 'ENOENT';
    if (!codeMatch) return false;
    return /homedir|passwd/i.test(`${reason.syscall || ''} ${reason.message || ''}`);
}

const HOMELESS_GUIDANCE = 'AWS credentials unavailable: the home directory is undeterminable, so credential files cannot be loaded.';

export function formatLastResortOutput({ kind, reason, isJson }) {
    const first = firstLine(reasonMessage(reason));
    const detail = reasonDetail(reason);
    let oneLiner;
    let stderrText;
    if (kind === 'unhandledRejection' && isSmithyHomelessRejection(reason)) {
        oneLiner = HOMELESS_GUIDANCE;
        stderrText = `✖ ${HOMELESS_GUIDANCE}\n`
            + '  Set the HOME environment variable, or provide credentials via AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.\n';
    } else if (kind === 'uncaughtException') {
        oneLiner = `Grada crashed unexpectedly: ${first}`;
        stderrText = `✖ ${oneLiner}\n${detail}\n  Please report this: ${ISSUES_URL}\n`;
    } else {
        oneLiner = `Unexpected failure: ${first}`;
        stderrText = `✖ ${oneLiner}\n${detail}\n  Please report this: ${ISSUES_URL}\n`;
    }
    if (!isJson) return { stdoutText: null, stderrText };
    const envelope = {
        ok: false,
        exitCode: 1,
        error: oneLiner,
        reason: kind === 'uncaughtException' ? 'uncaught-exception' : 'unhandled-rejection',
    };
    return { stdoutText: `${JSON.stringify(envelope)}\n`, stderrText };
}

export function createLastResortHandlers({
    argv = process.argv,
    exitFn = (code) => process.exit(code),
    writeStdout = (text) => fs.writeSync(1, text),
    writeStderr = (text) => fs.writeSync(2, text),
    isTestEnv = () => Boolean(process.env.VITEST),
} = {}) {
    const isJson = argv.includes('--json');
    const handle = (kind) => (reason) => {
        // Test workers keep native rejection behavior: a process.exit
        // here would kill the worker mid-suite.
        if (isTestEnv()) return;
        try {
            const { stdoutText, stderrText } = formatLastResortOutput({ kind, reason, isJson });
            if (stdoutText !== null) {
                try {
                    writeStdout(stdoutText);
                } catch {
                    // A broken stdout must not swallow the stderr report.
                }
            }
            writeStderr(stderrText);
        } catch {
            try {
                writeStderr('✖ Grada crashed unexpectedly.\n');
            } catch {
                // A crash handler that crashes is the worst outcome;
                // fall through to the exit below no matter what.
            }
        }
        exitFn(1);
    };
    return {
        unhandledRejection: handle('unhandledRejection'),
        uncaughtException: handle('uncaughtException'),
    };
}

export function registerLastResortHandlers(options = {}) {
    const handlers = createLastResortHandlers(options);
    process.on('unhandledRejection', handlers.unhandledRejection);
    process.on('uncaughtException', handlers.uncaughtException);
    return handlers;
}

registerLastResortHandlers();
