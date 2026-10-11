import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as backup from '../src/utils/backup.js';

const originalCwd = process.cwd();
let tmpDir;

beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-manifest-'));
});

afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTree() {
    fs.mkdirSync(path.join(tmpDir, 'terraform'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'terraform', 'main.tf'), 'locals {}\n');
}

describe('R5: manifest v2 (intended vs applied)', () => {
    it('writeInitManifest records the intended target as version 2', () => {
        writeTree();
        backup.writeInitManifest(tmpDir, { target: 'ecs' });
        const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, '.grada', 'manifest.json'), 'utf-8'));
        expect(manifest.version).toBe(2);
        expect(manifest.target).toBe('ecs');
        expect(manifest.files['terraform/main.tf']).toBeTruthy();
    });

    it('recordAppliedTarget merges the applied target without touching hashes', async () => {
        writeTree();
        backup.writeInitManifest(tmpDir, { target: 'ecs' });
        await backup.recordAppliedTarget(tmpDir, { target: 'ecs', revision: 'r1' });
        const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, '.grada', 'manifest.json'), 'utf-8'));
        expect(manifest.appliedTarget).toBe('ecs');
        expect(manifest.appliedRevision).toBe('r1');
        expect(manifest.target).toBe('ecs');
        expect(manifest.files['terraform/main.tf']).toBeTruthy();
    });

    it('re-init carries the applied target forward', async () => {
        writeTree();
        backup.writeInitManifest(tmpDir, { target: 'static' });
        await backup.recordAppliedTarget(tmpDir, { target: 'static' });
        backup.writeInitManifest(tmpDir, { target: 'ecs' });
        const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, '.grada', 'manifest.json'), 'utf-8'));
        expect(manifest.target).toBe('ecs');
        expect(manifest.appliedTarget).toBe('static');
    });

    it('detectModifiedTree tolerates v2 manifests', () => {
        writeTree();
        backup.writeInitManifest(tmpDir, { target: 'ecs' });
        expect(backup.detectModifiedTree(tmpDir)).toEqual({ modified: [], missing: [] });
        fs.writeFileSync(path.join(tmpDir, 'terraform', 'main.tf'), 'locals { edited = true }\n');
        expect(backup.detectModifiedTree(tmpDir).modified).toEqual(['terraform/main.tf']);
    });
});

describe('R15: preserved files across regenerate', () => {
    it('PRESERVED_FILES carries terraform/secret_keys.json', () => {
        expect(backup.PRESERVED_FILES).toContain('terraform/secret_keys.json');
    });

    it('preserve/restore round-trips managed files across a backup', async () => {
        writeTree();
        fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:20\n');
        fs.writeFileSync(path.join(tmpDir, 'terraform', 'secret_keys.json'), JSON.stringify(['API_KEY']));
        const stash = backup.preserveManagedFiles(tmpDir);
        await backup.handleExistingFiles(tmpDir, true, { force: true });
        expect(fs.existsSync(path.join(tmpDir, 'terraform'))).toBe(false);
        fs.mkdirSync(path.join(tmpDir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'terraform', 'main.tf'), 'locals {}\n');
        backup.restoreManagedFiles(tmpDir, stash);
        expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'terraform', 'secret_keys.json'), 'utf-8'))).toEqual(['API_KEY']);
    });

    it('init wires preserve/restore around backup-and-regenerate', () => {
        const content = fs.readFileSync(path.resolve(originalCwd, 'src/commands/init.js'), 'utf8');
        expect(content).toContain('preserveManagedFiles');
        expect(content).toContain('restoreManagedFiles');
    });
});

describe('R20: plan/execute split for existing files', () => {
    it('planExistingFiles classifies clean, dirty, and ejected trees without touching them', async () => {
        writeTree();
        expect(await backup.planExistingFiles(tmpDir, { isHeadless: true })).toMatchObject({ decision: 'clean' });
        expect(fs.existsSync(path.join(tmpDir, 'terraform', 'main.tf'))).toBe(true);

        backup.writeInitManifest(tmpDir);
        fs.writeFileSync(path.join(tmpDir, 'terraform', 'main.tf'), 'locals { edited = true }\n');
        const dirty = await backup.planExistingFiles(tmpDir, { isHeadless: true });
        expect(dirty.decision).toBe('refuse-dirty');
        expect(dirty.dirty).toContain('terraform/main.tf');
        expect(fs.existsSync(path.join(tmpDir, 'terraform', 'main.tf'))).toBe(true);
    });

    it('executeBackup performs the renames from a backup plan', async () => {
        writeTree();
        fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:20\n');
        const plan = await backup.planExistingFiles(tmpDir, { isHeadless: true, force: true });
        expect(plan.decision).toBe('backup');
        await backup.executeBackup(tmpDir, plan);
        expect(fs.existsSync(path.join(tmpDir, 'terraform'))).toBe(false);
        expect(fs.readdirSync(tmpDir).some((e) => e.startsWith('terraform.bak.'))).toBe(true);
    });

    it('init plans before provisioning and executes after', () => {
        const content = fs.readFileSync(path.resolve(originalCwd, 'src/commands/init.js'), 'utf8');
        const planAt = content.indexOf('planExistingFiles');
        const provisionAt = content.indexOf('provisionStateBucket(');
        const executeAt = content.indexOf('executeBackup(');
        expect(planAt).toBeGreaterThan(-1);
        expect(provisionAt).toBeGreaterThan(-1);
        expect(executeAt).toBeGreaterThan(-1);
        expect(planAt).toBeLessThan(provisionAt);
        expect(provisionAt).toBeLessThan(executeAt);
    });
});
