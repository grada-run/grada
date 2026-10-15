import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { safeHomedir } from '../src/core/homedir.js';

// os.homedir() throws when HOME is unset and no passwd entry exists —
// that used to kill the whole CLI at import time. safeHomedir is the
// single null-on-failure resolver every HOME-dependent path goes
// through; callers branch on null with their own fallback.
describe('safeHomedir', () => {
    it('returns the real home directory by default', () => {
        expect(safeHomedir()).toBe(os.homedir());
    });

    it('returns null when resolution throws', () => {
        expect(safeHomedir(() => {
            throw new Error('uv_os_get_passwd returned ENOENT');
        })).toBeNull();
    });

    it('returns null on empty or blank results', () => {
        expect(safeHomedir(() => '')).toBeNull();
        expect(safeHomedir(() => '   ')).toBeNull();
    });
});
