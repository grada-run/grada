import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { withProjectLock } from '../src/utils/file-lock.js';
import { trackEvent } from '../src/core/telemetry.js';


function makeTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-'));
}

describe('R13: project file lock', () => {
    it('serializes concurrent critical sections', async () => {
        const dir = makeTmp();
        const order = [];
        const slow = withProjectLock(dir, async () => {
            order.push('slow-start');
            await new Promise((resolve) => setTimeout(resolve, 50));
            order.push('slow-end');
        });
        const fast = withProjectLock(dir, async () => {
            order.push('fast');
        });
        await Promise.all([slow, fast]);
        expect(order).toEqual(['slow-start', 'slow-end', 'fast']);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('fail-fast mode rejects while the lock is held', async () => {
        const dir = makeTmp();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const held = withProjectLock(dir, () => gate);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await expect(withProjectLock(dir, async () => {}, { timeoutMs: 0 })).rejects.toMatchObject({
            code: 'FILE_LOCK_TIMEOUT',
        });
        release();
        await held;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('a stale lock is taken over', async () => {
        const dir = makeTmp();
        const lockDir = path.join(dir, '.grada', 'locks', 'project');
        fs.mkdirSync(lockDir, { recursive: true });
        fs.writeFileSync(path.join(lockDir, 'meta.json'), JSON.stringify({ pid: 99999999, createdAt: Date.now() - 600000 }));
        const old = new Date(Date.now() - 600000);
        fs.utimesSync(path.join(lockDir, 'meta.json'), old, old);
        await withProjectLock(dir, async () => {}, { staleMs: 60000 });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('releases the lock when the section throws', async () => {
        const dir = makeTmp();
        await expect(withProjectLock(dir, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        await withProjectLock(dir, async () => {}, { timeoutMs: 0 });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('records file_lock_waited when acquisition contends', async () => {
        const dir = makeTmp();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const held = withProjectLock(dir, () => gate);
        await new Promise((resolve) => setTimeout(resolve, 20));
        vi.clearAllMocks();
        const waiter = withProjectLock(dir, async () => 'done');
        release();
        await waiter;
        await held;
        expect(trackEvent).toHaveBeenCalledWith('file_lock_waited', expect.objectContaining({
            scope: 'project',
            mode: 'waited',
        }));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('different scopes do not block each other', async () => {
        const dir = makeTmp();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const held = withProjectLock(dir, () => gate, { scope: 'terraform' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await withProjectLock(dir, async () => {}, { scope: 'ledger', timeoutMs: 0 });
        release();
        await held;
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
