import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

// Real runner under test; only the process spawn is faked.
const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, spawn: mockSpawn };
});

vi.mock('@clack/prompts', () => ({
    spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

import { runTerraformCommand, checkOutputsContract, EXPECTED_OUTPUT_KEYS } from '../src/utils/terraform.js';

function makeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    child.pid = 4242;
    return child;
}

function spin() {
    return { start: vi.fn(), stop: vi.fn(), message: vi.fn() };
}

const originalCwd = process.cwd();
let tmpDir;
let sigintBaseline;
let sigtermBaseline;

beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-lifecycle-'));
    sigintBaseline = process.listenerCount('SIGINT');
    sigtermBaseline = process.listenerCount('SIGTERM');
});

afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBaseline);
});

function markerPath() {
    return path.join(tmpDir, '.grada', 'last-run.json');
}

describe('S13 mechanics: lifecycle wrapper (R6)', () => {
    it('writes a running marker at start and completes it on success', async () => {
        const child = makeChild();
        mockSpawn.mockReturnValueOnce(child);
        const pending = runTerraformCommand(['apply', '-auto-approve'], tmpDir, spin(), 'Provisioning', { markerDir: tmpDir });
        const marker = JSON.parse(fs.readFileSync(markerPath(), 'utf-8'));
        expect(marker).toMatchObject({ status: 'running', command: 'terraform', pid: 4242 });
        expect(marker.args).toEqual(['apply', '-auto-approve']);
        child.emit('close', 0);
        await pending;
        expect(JSON.parse(fs.readFileSync(markerPath(), 'utf-8'))).toMatchObject({ status: 'completed' });
    });

    it('forwards SIGINT to the child and marks the run interrupted', async () => {
        const child = makeChild();
        mockSpawn.mockReturnValueOnce(child);
        const pending = runTerraformCommand(['apply'], tmpDir, spin(), 'P', { markerDir: tmpDir });
        process.emit('SIGINT');
        await new Promise((resolve) => setImmediate(resolve));
        expect(child.kill).toHaveBeenCalledWith('SIGINT');
        expect(JSON.parse(fs.readFileSync(markerPath(), 'utf-8'))).toMatchObject({ status: 'interrupted' });
        child.emit('close', 130);
        await expect(pending).rejects.toThrow();
    });

    it('a second SIGINT escalates to SIGKILL', async () => {
        const child = makeChild();
        mockSpawn.mockReturnValueOnce(child);
        const pending = runTerraformCommand(['apply'], tmpDir, spin(), 'P', { markerDir: tmpDir });
        process.emit('SIGINT');
        await new Promise((resolve) => setImmediate(resolve));
        process.emit('SIGINT');
        await new Promise((resolve) => setImmediate(resolve));
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
        child.emit('close', 130);
        await expect(pending).rejects.toThrow();
    });

    it('forwards SIGTERM to the child', async () => {
        const child = makeChild();
        mockSpawn.mockReturnValueOnce(child);
        const pending = runTerraformCommand(['apply'], tmpDir, spin(), 'P', { markerDir: tmpDir });
        process.emit('SIGTERM');
        await new Promise((resolve) => setImmediate(resolve));
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        child.emit('close', 143);
        await expect(pending).rejects.toThrow();
    });

    it('a phase timeout kills the child and rejects with a code', async () => {
        const child = makeChild();
        mockSpawn.mockReturnValueOnce(child);
        const pending = runTerraformCommand(['apply'], tmpDir, spin(), 'P', { markerDir: tmpDir, timeoutMs: 20 });
        await expect(pending).rejects.toMatchObject({ code: 'TERRAFORM_TIMEOUT' });
        expect(child.kill).toHaveBeenCalled();
    });

    it('streams plan/apply summary lines into the spinner', async () => {
        const child = makeChild();
        mockSpawn.mockReturnValueOnce(child);
        const s = spin();
        const pending = runTerraformCommand(['apply'], tmpDir, s, 'P', { markerDir: tmpDir });
        child.stdout.emit('data', Buffer.from('some noise\nPlan: 3 to add, 0 to change, 1 to destroy.\nmore noise\n'));
        child.emit('close', 0);
        await pending;
        const messages = s.message.mock.calls.map(([text]) => String(text));
        expect(messages.some((text) => text.includes('Plan: 3 to add'))).toBe(true);
    });

    it('rejects with a structured error carrying code, stderr, and lock id', async () => {
        const child = makeChild();
        mockSpawn.mockReturnValueOnce(child);
        const pending = runTerraformCommand(['apply'], tmpDir, spin(), 'P', { markerDir: tmpDir });
        child.stderr.emit('data', Buffer.from('Error: Error acquiring the state lock:\nLock Info:\n  ID:        lock-9\n'));
        child.emit('close', 1);
        const error = await pending.catch((err) => err);
        expect(error).toMatchObject({ code: 'STATE_LOCK_HELD', lockId: 'lock-9' });
        expect(String(error.stderr)).toContain('acquiring the state lock');
    });

    it('marks the run failed on non-zero exit', async () => {
        const child = makeChild();
        mockSpawn.mockReturnValueOnce(child);
        const pending = runTerraformCommand(['apply'], tmpDir, spin(), 'P', { markerDir: tmpDir });
        child.emit('close', 1);
        await expect(pending).rejects.toThrow();
        expect(JSON.parse(fs.readFileSync(markerPath(), 'utf-8'))).toMatchObject({ status: 'failed' });
    });
});

describe('R22: outputs contract per-target keys', () => {
    it('pins the expected keys per target', () => {
        expect(EXPECTED_OUTPUT_KEYS.ecs).toEqual(['alb_direct_url', 'ecr_repository_url']);
        expect(EXPECTED_OUTPUT_KEYS.lambda).toEqual(['api_gateway_url', 'ecr_repository_url']);
        expect(EXPECTED_OUTPUT_KEYS.static).toEqual(['site_url']);
    });

    it('flags fully-empty maps regardless of target', () => {
        for (const target of ['ecs', 'lambda', 'static']) {
            const check = checkOutputsContract({}, target);
            expect(check.empty).toBe(true);
            expect(check.missing).toEqual(EXPECTED_OUTPUT_KEYS[target]);
        }
    });

    it('flags missing keys on non-empty maps', () => {
        const check = checkOutputsContract({ cloudfront_url: { value: 'https://x' } }, 'ecs');
        expect(check.empty).toBe(false);
        expect(check.missing).toEqual(['alb_direct_url', 'ecr_repository_url']);
    });

    it('passes healthy maps and vacuous unknown targets', () => {
        const check = checkOutputsContract(
            { alb_direct_url: { value: 'a' }, ecr_repository_url: { value: 'b' } },
            'ecs'
        );
        expect(check.empty).toBe(false);
        expect(check.missing).toEqual([]);
        expect(checkOutputsContract({}, 'unknown-target').missing).toEqual([]);
    });
});
