import os from 'node:os';

// Null-safe home directory resolution: os.homedir() throws when HOME is
// unset and no passwd entry exists (minimal containers, `env -i`), which
// used to kill the whole CLI at import time via add.js's module-scope
// catalog load. Every HOME-dependent path goes through here; callers
// branch on null with their own fallback (bundled catalog, ephemeral
// salt, fingerprint identity — or a loud failure where HOME is a genuine
// requirement). `homedirFn` is injectable so tests can pin both branches
// without stubbing the os module.
export function safeHomedir(homedirFn = () => os.homedir()) {
    try {
        const home = homedirFn();
        return typeof home === 'string' && home.trim() !== '' ? home : null;
    } catch {
        return null;
    }
}
