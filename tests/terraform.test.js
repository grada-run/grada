import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const { mockSpawn } = vi.hoisted(() => ({
    mockSpawn: vi.fn(),
}));

vi.mock('child_process', () => ({
    spawn: mockSpawn,
}));

import { runTerraformCommand, getTerraformOutputs, getTerraformStateBuckets } from '../src/utils/terraform.js';

function makeChild({ code = 0, stdout = '', stderr = '', error = null } = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
        if (error) {
            child.emit('error', error);
            return;
        }
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('close', code);
    });
    return child;
}

beforeEach(() => {
    mockSpawn.mockReset();
});

describe('runTerraformCommand', () => {
    it('resolves on exit 0 and pipes the latest stdout line to the spinner', async () => {
        mockSpawn.mockReturnValue(makeChild({ stdout: 'first\nsecond\n' }));
        const spin = { message: vi.fn() };

        await expect(runTerraformCommand(['apply'], '/tmp', spin, 'Applying', { isTTY: true })).resolves.toBeUndefined();
        expect(mockSpawn).toHaveBeenCalledWith('terraform', ['apply'], { cwd: '/tmp' });
        expect(spin.message).toHaveBeenCalledWith(expect.stringContaining('second'));
    });

    it('dedups consecutive identical lines on a live terminal', async () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        mockSpawn.mockReturnValue(child);
        const spin = { message: vi.fn() };

        const pending = runTerraformCommand(['apply'], '/tmp', spin, 'Applying', { isTTY: true });
        child.stdout.emit('data', Buffer.from('same\n'));
        child.stdout.emit('data', Buffer.from('same\n'));
        child.stdout.emit('data', Buffer.from('different\n'));
        child.emit('close', 0);
        await pending;

        expect(spin.message).toHaveBeenCalledTimes(2);
    });

    it('falls back to deduped plain lines and clears the spinner when not a TTY', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            mockSpawn.mockReturnValue(child);
            const spin = { message: vi.fn(), clear: vi.fn() };

            const pending = runTerraformCommand(['apply'], '/tmp', spin, 'Applying', { isTTY: false });
            child.stdout.emit('data', Buffer.from('same\n'));
            child.stdout.emit('data', Buffer.from('same\n'));
            child.stdout.emit('data', Buffer.from('different\n'));
            child.emit('close', 0);
            await pending;

            expect(spin.clear).toHaveBeenCalledTimes(1);
            expect(spin.message).not.toHaveBeenCalled();
            expect(logSpy).toHaveBeenCalledTimes(2);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('different'));
        } finally {
            logSpy.mockRestore();
        }
    });

    it('stays silent without a spinner even when not a TTY', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            mockSpawn.mockReturnValue(makeChild({ stdout: '{"url":"https://x"}\n' }));

            await expect(runTerraformCommand(['output', '-json'], '/tmp', null, 'Reading', { isTTY: false })).resolves.toBeUndefined();
            expect(logSpy).not.toHaveBeenCalled();
        } finally {
            logSpy.mockRestore();
        }
    });

    it('rejects with the captured stderr on non-zero exit', async () => {
        mockSpawn.mockReturnValue(makeChild({ code: 1, stderr: 'boom\n' }));
        const spin = { message: vi.fn() };

        await expect(runTerraformCommand(['apply'], '/tmp', spin, 'Applying')).rejects.toThrow('boom');
    });

    it('falls back to the exit code when stderr is empty', async () => {
        mockSpawn.mockReturnValue(makeChild({ code: 3 }));
        const spin = { message: vi.fn() };

        await expect(runTerraformCommand(['apply'], '/tmp', spin, 'Applying')).rejects.toThrow('with code 3');
    });

    it('rejects on spawn errors', async () => {
        mockSpawn.mockReturnValue(makeChild({ error: new Error('spawn terraform ENOENT') }));
        const spin = { message: vi.fn() };

        await expect(runTerraformCommand(['apply'], '/tmp', spin, 'Applying')).rejects.toThrow('ENOENT');
    });
});

describe('getTerraformOutputs', () => {
    it('parses JSON output', async () => {
        mockSpawn.mockReturnValue(makeChild({ stdout: '{"url":"https://x"}' }));

        await expect(getTerraformOutputs('/tmp')).resolves.toEqual({ url: 'https://x' });
        expect(mockSpawn).toHaveBeenCalledWith('terraform', ['output', '-json'], { cwd: '/tmp' });
    });

    it('resolves to {} on unparseable output, non-zero exit, and spawn errors', async () => {
        mockSpawn.mockReturnValueOnce(makeChild({ stdout: 'not json' }));
        await expect(getTerraformOutputs('/tmp')).resolves.toEqual({});

        mockSpawn.mockReturnValueOnce(makeChild({ code: 1 }));
        await expect(getTerraformOutputs('/tmp')).resolves.toEqual({});

        mockSpawn.mockReturnValueOnce(makeChild({ error: new Error('ENOENT') }));
        await expect(getTerraformOutputs('/tmp')).resolves.toEqual({});
    });
});

describe('getTerraformStateBuckets', () => {
    function showJson(modules) {
        return JSON.stringify({ values: { root_module: modules } });
    }

    it('walks root and nested child modules for managed buckets', async () => {
        mockSpawn.mockReturnValueOnce(makeChild({
            stdout: showJson({
                resources: [
                    { type: 'aws_ecs_cluster', values: { name: 'x' } },
                    { type: 'aws_s3_bucket', values: { bucket: 'root-bucket-1' } },
                ],
                child_modules: [
                    {
                        resources: [
                            { type: 'aws_s3_bucket', values: { bucket: 'child-bucket-2' } },
                            { type: 'aws_s3_bucket', values: { id: 'id-only-bucket-3' } },
                        ],
                        child_modules: [
                            { resources: [{ type: 'aws_s3_bucket', values: { bucket: 'root-bucket-1' } }] },
                        ],
                    },
                ],
            }),
        }));
        await expect(getTerraformStateBuckets('/tmp')).resolves.toEqual([
            'root-bucket-1', 'child-bucket-2', 'id-only-bucket-3',
        ]);
        expect(mockSpawn).toHaveBeenCalledWith('terraform', ['show', '-json'], { cwd: '/tmp' });
    });

    it('resolves to [] on missing state, bad JSON, non-zero exit, and spawn errors', async () => {
        mockSpawn.mockReturnValueOnce(makeChild({ stdout: JSON.stringify({}) }));
        await expect(getTerraformStateBuckets('/tmp')).resolves.toEqual([]);

        mockSpawn.mockReturnValueOnce(makeChild({ stdout: 'not json' }));
        await expect(getTerraformStateBuckets('/tmp')).resolves.toEqual([]);

        mockSpawn.mockReturnValueOnce(makeChild({ code: 1 }));
        await expect(getTerraformStateBuckets('/tmp')).resolves.toEqual([]);

        mockSpawn.mockReturnValueOnce(makeChild({ error: new Error('ENOENT') }));
        await expect(getTerraformStateBuckets('/tmp')).resolves.toEqual([]);
    });
});
