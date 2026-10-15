import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '@clack/prompts';
import { loadBedrockCatalog, refreshBedrockCatalog, FALLBACK_CATALOG } from '../src/utils/bedrock-catalog.js';

// The catalog loader short-circuits to the bundled catalog under our own
// test runner — that early return is what masked the no-HOME crash from
// the suite. These tests clear the test-env markers (plus any ambient
// cache-path overrides) so the real candidate resolution runs.
const CATALOG_ENV_KEYS = ['VITEST', 'NODE_ENV', 'GRADA_BEDROCK_CACHE_PATH', 'DEPLOY_STACK_BEDROCK_CACHE_PATH'];
const savedCatalogEnv = {};
for (const key of CATALOG_ENV_KEYS) savedCatalogEnv[key] = process.env[key];

function clearCatalogEnv() {
    for (const key of CATALOG_ENV_KEYS) delete process.env[key];
}

function throwHomedir() {
    return vi.spyOn(os, 'homedir').mockImplementation(() => {
        throw new Error('uv_os_get_passwd returned ENOENT');
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(savedCatalogEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    vi.resetModules();
});

describe('bedrock catalog without a home directory', () => {
    it('falls back to the bundled catalog instead of throwing', () => {
        clearCatalogEnv();
        throwHomedir();
        let catalog;
        expect(() => { catalog = loadBedrockCatalog(); }).not.toThrow();
        expect(typeof catalog.defaultModelId).toBe('string');
        expect(catalog.defaultModelId).not.toBe('');
        expect(Array.isArray(catalog.providers)).toBe(true);
        // A cache miss resolves to the same bundled catalog — the
        // homeless load must be byte-identical to it, not a partial.
        expect(catalog).toEqual(loadBedrockCatalog({ cachePath: path.join(os.tmpdir(), 'grada-no-such-cache.json') }));
    });

    it('still honors an explicit cache path without a home directory', () => {
        clearCatalogEnv();
        throwHomedir();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-cache-'));
        try {
            const cachePath = path.join(dir, 'bedrock-models-cache.json');
            const cached = {
                ...FALLBACK_CATALOG,
                updatedAt: '2099-01-01',
                defaultModelId: 'explicit-marker-model',
            };
            fs.writeFileSync(cachePath, JSON.stringify(cached));
            const catalog = loadBedrockCatalog({ cachePath });
            expect(catalog.defaultModelId).toBe('explicit-marker-model');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('skips refresh without an AWS call when HOME is undeterminable', async () => {
        clearCatalogEnv();
        throwHomedir();
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
        try {
            let calls = 0;
            const catalog = await refreshBedrockCatalog({
                bedrockClient: { send: () => { calls += 1; throw new Error('must not call AWS'); } },
            });
            expect(calls).toBe(0);
            expect(catalog).toEqual(loadBedrockCatalog({ cachePath: path.join(os.tmpdir(), 'grada-no-such-cache.json') }));
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(String(warnSpy.mock.calls[0][0])).toContain('home directory');
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('imports add.js without throwing when HOME is undeterminable', async () => {
        clearCatalogEnv();
        throwHomedir();
        vi.resetModules();
        const add = await import('../src/commands/add.js');
        expect(typeof add.DEFAULT_BEDROCK_MODEL).toBe('string');
        expect(add.DEFAULT_BEDROCK_MODEL).not.toBe('');
    });
});
