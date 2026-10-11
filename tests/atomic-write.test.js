import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { atomicWriteFile, atomicWriteFileSync, createFileExclusive } from '../src/utils/atomic-write.js';

function makeTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
}

describe('R7: atomic writes', () => {
    it('atomicWriteFile round-trips content with no temp left behind', async () => {
        const dir = makeTmp();
        const file = path.join(dir, 'main.tf');
        await atomicWriteFile(file, 'hello\n');
        expect(fs.readFileSync(file, 'utf-8')).toBe('hello\n');
        expect(fs.readdirSync(dir)).toEqual(['main.tf']);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('atomicWriteFileSync round-trips content with no temp left behind', () => {
        const dir = makeTmp();
        const file = path.join(dir, 'main.tf');
        atomicWriteFileSync(file, 'hello\n');
        expect(fs.readFileSync(file, 'utf-8')).toBe('hello\n');
        expect(fs.readdirSync(dir)).toEqual(['main.tf']);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('preserves the file mode across the rename', async () => {
        const dir = makeTmp();
        const file = path.join(dir, 'keys.json');
        fs.writeFileSync(file, '[]');
        fs.chmodSync(file, 0o600);
        await atomicWriteFile(file, '["a"]');
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('createFileExclusive creates once and reports EEXIST on reruns', async () => {
        const dir = makeTmp();
        const file = path.join(dir, 'sqs.tf');
        await createFileExclusive(file, 'v1');
        expect(fs.readFileSync(file, 'utf-8')).toBe('v1');
        await expect(createFileExclusive(file, 'v2')).rejects.toMatchObject({ code: 'EEXIST' });
        expect(fs.readFileSync(file, 'utf-8')).toBe('v1');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
