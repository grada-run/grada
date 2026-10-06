// Pins the E2E plugin-cache isolation: parallel Vitest workers must never
// share one TF_PLUGIN_CACHE_DIR, or concurrent `terraform init` corrupts
// it and fails `validate` in whichever test loses the race (checksum
// mismatches, dead plugin binaries). Regression coverage for the Tier 0
// parallel-run failures.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';

const REAL_WORKER_ID = process.env.VITEST_WORKER_ID;
const createdDirs = [];

async function cacheDirFor(workerId) {
    vi.resetModules();
    if (workerId === undefined) delete process.env.VITEST_WORKER_ID;
    else process.env.VITEST_WORKER_ID = workerId;
    const helpers = await import('./e2e/helpers.js');
    const dir = helpers.e2eEnv({ mockAws: true }).TF_PLUGIN_CACHE_DIR;
    createdDirs.push(dir);
    return dir;
}

afterEach(() => {
    vi.resetModules();
    if (REAL_WORKER_ID === undefined) delete process.env.VITEST_WORKER_ID;
    else process.env.VITEST_WORKER_ID = REAL_WORKER_ID;
    for (const dir of createdDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('e2e helpers plugin-cache isolation', () => {
    it('namespaces TF_PLUGIN_CACHE_DIR per Vitest worker', async () => {
        const first = await cacheDirFor('1');
        const second = await cacheDirFor('2');
        expect(first).toContain('grada-e2e-plugin-cache-1');
        expect(second).toContain('grada-e2e-plugin-cache-2');
        expect(first).not.toBe(second);
    });

    it('falls back to a main cache dir without VITEST_WORKER_ID', async () => {
        expect(await cacheDirFor(undefined)).toContain('grada-e2e-plugin-cache-main');
    });
});
