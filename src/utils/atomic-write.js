import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

// Atomic file writes for grada's generated files: write to a
// process-unique temp file in the same directory, fsync, then rename over
// the target. Readers never observe a torn file, which is what flipped
// target detection (torn main.tf) and collapsed the sleep ledger (torn
// JSON read as {}). Existing file modes survive the rename.

let tmpCounter = 0;

function tmpPathFor(file) {
    tmpCounter += 1;
    return `${file}.${process.pid}.${tmpCounter}.tmp`;
}

async function removeQuietlyAsync(tmpPath) {
    try {
        await fsp.rm(tmpPath, { force: true });
    } catch {
        // Best effort only.
    }
}

function removeQuietlySync(tmpPath) {
    try {
        fs.rmSync(tmpPath, { force: true });
    } catch {
        // Best effort only.
    }
}

export async function atomicWriteFile(file, data, encoding = 'utf8') {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    let mode;
    try {
        mode = (await fsp.stat(file)).mode & 0o777;
    } catch {
        mode = undefined;
    }
    const tmpPath = tmpPathFor(file);
    try {
        await fsp.writeFile(tmpPath, data, encoding);
        const handle = await fsp.open(tmpPath, 'r+');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
        if (mode !== undefined) await fsp.chmod(tmpPath, mode);
        await fsp.rename(tmpPath, file);
    } catch (error) {
        await removeQuietlyAsync(tmpPath);
        throw error;
    }
}

export function atomicWriteFileSync(file, data, encoding = 'utf8') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let mode;
    try {
        mode = fs.statSync(file).mode & 0o777;
    } catch {
        mode = undefined;
    }
    const tmpPath = tmpPathFor(file);
    try {
        fs.writeFileSync(tmpPath, data, encoding);
        const fd = fs.openSync(tmpPath, 'r+');
        try {
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        if (mode !== undefined) fs.chmodSync(tmpPath, mode);
        fs.renameSync(tmpPath, file);
    } catch (error) {
        removeQuietlySync(tmpPath);
        throw error;
    }
}

// Creates a new file, failing when it already exists. The guard check and
// the create are one atomic step (O_EXCL), which is what closes the
// existsSync→writeFile TOCTOU under the project lock. Rejects with the
// native EEXIST error — callers map it to their soft-failure shape.
export async function createFileExclusive(file, data, encoding = 'utf8') {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, data, { encoding, flag: 'wx' });
}
