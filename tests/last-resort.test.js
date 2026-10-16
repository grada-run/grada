import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
    formatLastResortOutput,
    createLastResortHandlers,
    registerLastResortHandlers,
    ISSUES_URL,
} from '../src/core/last-resort.js';

// Last-resort crash backstop: unhandled rejections (e.g. the SDK
// credential chain exploding without a HOME) and uncaught exceptions
// (e.g. a future import-time throw) render one formatted report and
// exit 1 instead of dumping a raw stack — or printing nothing at all
// in --json mode.
function smithyError({ code, syscall }) {
    const error = new Error(`${syscall} returned ENOENT`);
    error.code = code;
    error.syscall = syscall;
    return error;
}

describe('formatLastResortOutput', () => {
    it('reports exceptions with stack and report pointer', () => {
        const error = new Error('boom\nsecond line');
        const { stdoutText, stderrText } = formatLastResortOutput({ kind: 'uncaughtException', reason: error, isJson: false });
        expect(stdoutText).toBeNull();
        expect(stderrText).toContain('Grada crashed unexpectedly: boom');
        expect(stderrText).toContain(error.stack);
        expect(stderrText).toContain(ISSUES_URL);
    });

    it('emits a parseable envelope plus stderr stack for exceptions in json mode', () => {
        const error = new Error('boom');
        const { stdoutText, stderrText } = formatLastResortOutput({ kind: 'uncaughtException', reason: error, isJson: true });
        expect(JSON.parse(stdoutText)).toEqual({
            ok: false,
            exitCode: 1,
            error: 'Grada crashed unexpectedly: boom',
            reason: 'uncaught-exception',
        });
        expect(stderrText).toContain(error.stack);
    });

    it.each([
        ['uv_os_homedir system error', { code: 'ERR_SYSTEM_ERROR', syscall: 'uv_os_homedir' }],
        ['uv_os_get_passwd lookup failure', { code: 'ENOENT', syscall: 'uv_os_get_passwd' }],
    ])('renders matched-smithy rejections as guidance without a stack (%s)', (_, shape) => {
        const error = smithyError(shape);
        const { stdoutText, stderrText } = formatLastResortOutput({ kind: 'unhandledRejection', reason: error, isJson: false });
        expect(stdoutText).toBeNull();
        expect(stderrText).toContain('AWS credentials unavailable');
        expect(stderrText).toContain('HOME');
        // Env credentials do NOT avoid the crash (smithy loads shared
        // config regardless of credential source), so the guidance must
        // not offer them — any HOME value is the only remedy.
        expect(stderrText).toContain('any directory');
        expect(stderrText).not.toContain('AWS_ACCESS_KEY_ID');
        expect(stderrText).not.toContain(error.stack.split('\n')[1]);
        expect(stderrText).not.toContain('github.com');
    });

    it('keeps the matched-smithy envelope stack-free in json mode', () => {
        const error = smithyError({ code: 'ERR_SYSTEM_ERROR', syscall: 'uv_os_homedir' });
        const { stdoutText, stderrText } = formatLastResortOutput({ kind: 'unhandledRejection', reason: error, isJson: true });
        expect(JSON.parse(stdoutText)).toMatchObject({ ok: false, exitCode: 1, reason: 'unhandled-rejection' });
        expect(stderrText).not.toContain(error.stack.split('\n')[1]);
    });

    it('reports unmatched rejections with stack and report pointer', () => {
        const error = new Error('weird sdk state');
        const { stdoutText, stderrText } = formatLastResortOutput({ kind: 'unhandledRejection', reason: error, isJson: false });
        expect(stdoutText).toBeNull();
        expect(stderrText).toContain('Unexpected failure: weird sdk state');
        expect(stderrText).toContain(error.stack);
        expect(stderrText).toContain(ISSUES_URL);
    });

    it.each([
        ['homedir mention without system code', Object.assign(new Error('cannot find homedir config'), { code: 'EACCES' })],
        ['ENOENT without homedir token', Object.assign(new Error('no such file or directory'), { code: 'ENOENT' })],
    ])('fails open to stack for near-miss shapes (%s)', (_, error) => {
        const { stderrText } = formatLastResortOutput({ kind: 'unhandledRejection', reason: error, isJson: false });
        expect(stderrText).toContain(error.stack);
    });

    it.each([['oops'], [undefined], [42], [null]])(
        'survives non-Error rejection reasons (%s)',
        (reason) => {
            let output;
            expect(() => {
                output = formatLastResortOutput({ kind: 'unhandledRejection', reason, isJson: true });
            }).not.toThrow();
            expect(output.stderrText).toContain(String(reason));
            expect(JSON.parse(output.stdoutText).error).toContain(String(reason));
        }
    );
});

describe('createLastResortHandlers', () => {
    function stubbedDeps(overrides = {}) {
        const writes = { out: [], err: [] };
        let exitCode = null;
        return {
            writes,
            getExitCode: () => exitCode,
            deps: {
                argv: ['node', 'cli.js'],
                exitFn: (code) => { exitCode = code; },
                writeStdout: (text) => { writes.out.push(text); },
                writeStderr: (text) => { writes.err.push(text); },
                isTestEnv: () => false,
                ...overrides,
            },
        };
    }

    it('writes the report to stderr and exits 1', () => {
        const { writes, getExitCode, deps } = stubbedDeps();
        createLastResortHandlers(deps).unhandledRejection(new Error('kaboom'));
        expect(writes.out).toHaveLength(0);
        expect(writes.err).toHaveLength(1);
        expect(writes.err[0]).toContain('kaboom');
        expect(getExitCode()).toBe(1);
    });

    it('detects --json from argv and writes the envelope to stdout', () => {
        const { writes, getExitCode, deps } = stubbedDeps({ argv: ['node', 'cli.js', 'status', '--json'] });
        createLastResortHandlers(deps).uncaughtException(new Error('kaboom'));
        expect(writes.out).toHaveLength(1);
        expect(JSON.parse(writes.out[0])).toMatchObject({ ok: false, reason: 'uncaught-exception' });
        expect(getExitCode()).toBe(1);
    });

    it('stays silent under the test runner', () => {
        const { writes, getExitCode, deps } = stubbedDeps({ isTestEnv: () => true });
        const handlers = createLastResortHandlers(deps);
        handlers.unhandledRejection(new Error('kaboom'));
        handlers.uncaughtException(new Error('kaboom'));
        expect(writes.out).toHaveLength(0);
        expect(writes.err).toHaveLength(0);
        expect(getExitCode()).toBeNull();
    });

    it.each(['unhandledRejection', 'uncaughtException'])(
        'returns quietly when the exit is intercepted (%s)',
        (kind) => {
            const { writes, getExitCode, deps } = stubbedDeps({
                exitFn: () => {
                    throw Object.assign(new Error('process.exit(1) intercepted during MCP tool call'), { name: 'InterceptedExit' });
                },
            });
            expect(() => createLastResortHandlers(deps)[kind](new Error('kaboom'))).not.toThrow();
            expect(writes.err).toHaveLength(1);
            expect(getExitCode()).toBeNull();
        }
    );

    it('rethrows non-interception exit failures', () => {
        const { deps } = stubbedDeps({
            exitFn: () => { throw new Error('exit exploded'); },
        });
        expect(() => createLastResortHandlers(deps).unhandledRejection(new Error('kaboom'))).toThrow('exit exploded');
    });

    it('still exits 1 when the writers throw', () => {
        const { getExitCode, deps } = stubbedDeps({
            argv: ['node', 'cli.js', '--json'],
            writeStdout: () => { throw new Error('EPIPE'); },
            writeStderr: () => { throw new Error('EPIPE'); },
        });
        expect(() => createLastResortHandlers(deps).unhandledRejection(new Error('kaboom'))).not.toThrow();
        expect(getExitCode()).toBe(1);
    });
});

describe('last-resort wiring', () => {
    it('registers both crash backstops', () => {
        const beforeRejection = process.listenerCount('unhandledRejection');
        const beforeException = process.listenerCount('uncaughtException');
        const handlers = registerLastResortHandlers();
        try {
            expect(process.listenerCount('unhandledRejection')).toBe(beforeRejection + 1);
            expect(process.listenerCount('uncaughtException')).toBe(beforeException + 1);
        } finally {
            process.removeListener('unhandledRejection', handlers.unhandledRejection);
            process.removeListener('uncaughtException', handlers.uncaughtException);
        }
    });

    it('imports node builtins only', () => {
        const source = fs.readFileSync(new URL('../src/core/last-resort.js', import.meta.url), 'utf-8');
        const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
        expect(specifiers.length).toBeGreaterThan(0);
        for (const specifier of specifiers) {
            expect(specifier.startsWith('node:')).toBe(true);
        }
    });

    it('is the first import in bin/cli.js', () => {
        const lines = fs.readFileSync(new URL('../bin/cli.js', import.meta.url), 'utf-8').split('\n');
        const firstImport = lines.find((line) => line.startsWith('import '));
        expect(firstImport).toBe("import '../src/core/last-resort.js';");
    });
});
