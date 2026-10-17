import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { mockConsoleTrio } from './helpers/console.js';
import { failCommand, failAwsError, failProjectNotInitialized, isProgrammaticCall, refuseIfNonInteractive } from '../src/utils/command.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';


describe('failCommand', () => {
    let exitSpy;
    let logSpy;
    let errorSpy;
    let spies;

    beforeEach(() => {
        vi.clearAllMocks();
        spies = mockConsoleTrio();
        ({ exitSpy, logSpy, errorSpy } = spies);
    });

    afterEach(() => {
        spies.restore();
    });

    it('prints, tracks, flushes, exits, and returns the standard result', async () => {
        const result = await failCommand({
            message: '\n✖ Bad input.',
            hint: '  Fix it.',
            event: 'add_run',
            telemetry: { capability: 'x', error_code: 'BAD' },
            reason: 'bad-input',
            resultExtra: { capability: 'x' },
        });
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Bad input.'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Fix it.'));
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            capability: 'x',
            error_code: 'BAD',
            reason: 'bad-input',
            success: false,
        });
        expect(flushTelemetry).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(result).toEqual({ ok: false, reason: 'bad-input', capability: 'x' });
    });

    it('supports custom printers, error stream, and tones', async () => {
        const print = vi.fn();
        await failCommand({ print, exitCode: 2 });
        expect(print).toHaveBeenCalledTimes(1);
        expect(logSpy).not.toHaveBeenCalled();
        expect(trackEvent).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(2);

        await failCommand({ message: 'warn', tone: 'yellow', useErrorStream: true, exitCode: null });
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('warn'));
        expect(exitSpy).toHaveBeenCalledTimes(1);
    });

    it('skips telemetry, exit, and reason when omitted', async () => {
        const result = await failCommand({ message: 'soft', exitCode: null });
        expect(trackEvent).not.toHaveBeenCalled();
        expect(flushTelemetry).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: false });
    });

    it('stamps errorCode and merges extra into telemetry', async () => {
        await failCommand({
            message: 'failed',
            event: 'db_migrate_run',
            telemetry: { cmd_source: 'explicit' },
            errorCode: 'MIGRATION_TASK_FAILED',
            extra: { exit_code: 3 },
            reason: 'migration-task-failed',
            exitCode: 3,
        });
        expect(trackEvent).toHaveBeenCalledWith('db_migrate_run', {
            cmd_source: 'explicit',
            error_code: 'MIGRATION_TASK_FAILED',
            reason: 'migration-task-failed',
            exit_code: 3,
            success: false,
        });
        expect(exitSpy).toHaveBeenCalledWith(3);
    });

    it('derives the telemetry reason from the error code without touching the result', async () => {
        const result = await failCommand({
            message: 'failed',
            event: 'gc_run',
            errorCode: 'SOME_NEW_FAILURE',
            noExit: true,
        });
        expect(trackEvent).toHaveBeenCalledWith('gc_run', {
            error_code: 'SOME_NEW_FAILURE',
            reason: 'some-new-failure',
            success: false,
        });
        expect(result).toEqual({ ok: false, exitCode: 1 });
    });

    it('lets extra override the stamped reason', async () => {
        await failCommand({
            message: 'failed',
            event: 'gc_run',
            errorCode: 'SOME_FAILURE',
            reason: 'some-failure',
            extra: { reason: 'custom-reason' },
            noExit: true,
        });
        expect(trackEvent).toHaveBeenCalledWith('gc_run', {
            error_code: 'SOME_FAILURE',
            reason: 'custom-reason',
            success: false,
        });
    });

    it('failProjectNotInitialized emits the structured not-initialized failure', async () => {
        const result = await failProjectNotInitialized({ event: 'logs_streamed' });
        expect(result).toEqual({ ok: false, reason: 'project-not-initialized' });
        expect(trackEvent).toHaveBeenCalledWith('logs_streamed', {
            error_code: 'PROJECT_NOT_INITIALIZED',
            reason: 'project-not-initialized',
            success: false,
        });
        expect(flushTelemetry).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Could not determine the project'));
    });

    it('noExit suppresses the exit and stamps the code for the CLI to restore', async () => {
        const result = await failCommand({ message: 'failed', event: 'drift_run', reason: 'drift-failed', noExit: true });
        expect(exitSpy).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: false, exitCode: 1, reason: 'drift-failed' });
        expect(trackEvent).toHaveBeenCalledWith('drift_run', expect.objectContaining({ success: false }));

        const custom = await failCommand({ message: 'failed', exitCode: 2, noExit: true });
        expect(exitSpy).not.toHaveBeenCalled();
        expect(custom).toEqual({ ok: false, exitCode: 2 });
    });

    it('noExit leaves soft failures unstamped', async () => {
        const result = await failCommand({ message: 'soft', exitCode: null, noExit: true });
        expect(exitSpy).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: false });
    });

    it('failProjectNotInitialized honors noExit', async () => {
        const result = await failProjectNotInitialized({ event: 'drift_run', noExit: true });
        expect(exitSpy).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: false, exitCode: 1, reason: 'project-not-initialized' });
    });
});

describe('failAwsError', () => {
    let spies;

    beforeEach(() => {
        vi.clearAllMocks();
        spies = mockConsoleTrio();
    });

    afterEach(() => {
        spies.restore();
    });

    it('stamps error telemetry, prints the message + credentials hint, and exits 1', async () => {
        const error = Object.assign(new Error('socket hang up'), { name: 'NetworkingError' });
        await failAwsError({ event: 'gc_run', error, telemetry: { projectName: 'myapp' } });

        expect(trackEvent).toHaveBeenCalledWith('gc_run', {
            projectName: 'myapp',
            error_code: 'NetworkingError',
            error_message: 'socket hang up',
            success: false,
        });
        expect(spies.logSpy).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
        expect(spies.logSpy).toHaveBeenCalledWith(
            expect.stringContaining('Check your AWS credentials and region, then try again.')
        );
        expect(spies.exitSpy).toHaveBeenCalledWith(1);
    });

    it('passes reason, result extras, and exit code through, honoring noExit', async () => {
        const result = await failAwsError({
            event: 'exec_run',
            error: new Error('boom'),
            noExit: true,
            reason: 'error',
            resultExtra: { region: 'us-east-2' },
            exitCode: 1,
        });

        expect(spies.exitSpy).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: false, exitCode: 1, reason: 'error', region: 'us-east-2' });
    });

    it('falls back to UNKNOWN for nameless errors', async () => {
        await failAwsError({ event: 'logs_streamed', error: new Error('boom'), noExit: true });

        expect(trackEvent).toHaveBeenCalledWith('logs_streamed', expect.objectContaining({
            error_code: 'Error',
        }));
        await failAwsError({ event: 'logs_streamed', error: 'string-thrown', noExit: true });
        expect(trackEvent).toHaveBeenCalledWith('logs_streamed', expect.objectContaining({
            error_code: 'UNKNOWN',
        }));
    });
});

describe('refuseIfNonInteractive', () => {
    let spies;

    beforeEach(() => {
        vi.clearAllMocks();
        spies = mockConsoleTrio();
    });

    afterEach(() => {
        spies.restore();
    });

    const spec = {
        message: '\n✖ gc needs approval.',
        hint: '  Re-run with --yes.',
        event: 'gc_run',
        telemetry: { projectName: 'myapp' },
        errorCode: 'GC_NON_INTERACTIVE',
    };

    it.each([
        [{ isHeadless: false }],
        [{ yes: true }],
        [{ isHeadless: true }],
        [{ autoApprove: true }],
    ])('returns null (proceed) for %j', async (options) => {
        await expect(refuseIfNonInteractive(options, spec)).resolves.toBeNull();
        expect(spies.exitSpy).not.toHaveBeenCalled();
    });

    it('refuses with the named error when headless without approval flags', async () => {
        const result = await refuseIfNonInteractive({}, spec);

        expect(result).toMatchObject({ ok: false, reason: 'non-interactive' });
        expect(spies.logSpy).toHaveBeenCalledWith(expect.stringContaining('needs approval'));
        expect(spies.logSpy).toHaveBeenCalledWith(expect.stringContaining('--yes'));
        expect(trackEvent).toHaveBeenCalledWith('gc_run', expect.objectContaining({
            success: false,
            error_code: 'GC_NON_INTERACTIVE',
        }));
        expect(spies.exitSpy).toHaveBeenCalledWith(1);
    });

    it('refuses under CI=true without flags and restores the env', async () => {
        const saved = process.env.CI;
        process.env.CI = 'true';
        try {
            const result = await refuseIfNonInteractive({}, spec);
            expect(result).toMatchObject({ ok: false, reason: 'non-interactive' });
        } finally {
            if (saved === undefined) delete process.env.CI;
            else process.env.CI = saved;
        }
    });
});

describe('isProgrammaticCall', () => {
    it.each([
        [{ isHeadless: true }, true],
        [{ headless: true }, true],
        [{ json: true }, true],
        [{ isHeadless: 'true' }, true],
        [{ json: 'true' }, true],
        [{}, false],
        [null, false],
        [{ yes: true }, false],
        [{ autoApprove: true }, false],
    ])('classifies %j as %s', (input, expected) => {
        expect(isProgrammaticCall(input)).toBe(expected);
    });
});
