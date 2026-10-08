import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stripVTControlCharacters } from 'node:util';
import { mockConsoleTrio } from './helpers/console.js';
// NOTE: no telemetry mock here — these tests exercise the real suppression
// machinery against a stubbed fetch and a scratch config file.
import { runTelemetry, TELEMETRY_SUBCOMMANDS } from '../src/commands/telemetry.js';
import { resetTelemetryPreferenceCache } from '../src/core/telemetry.js';

describe('runTelemetry', () => {
    let consoleSpies;
    let dir;
    let savedEnv;

    function loggedText() {
        return consoleSpies.logSpy.mock.calls.map((args) => stripVTControlCharacters(args.join(' '))).join('\n');
    }

    beforeEach(() => {
        vi.clearAllMocks();
        consoleSpies = mockConsoleTrio();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
        savedEnv = {
            VITEST: process.env.VITEST,
            DO_NOT_TRACK: process.env.DO_NOT_TRACK,
            GRADA_CONFIG_PATH: process.env.GRADA_CONFIG_PATH,
        };
        // The runner's own VITEST would force every state computation to
        // 'vitest'; drop it so each test pins its own suppressor.
        delete process.env.VITEST;
        delete process.env.DO_NOT_TRACK;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-cmd-'));
        process.env.GRADA_CONFIG_PATH = path.join(dir, 'config.json');
        resetTelemetryPreferenceCache();
    });

    afterEach(() => {
        consoleSpies.restore();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        for (const [key, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        resetTelemetryPreferenceCache();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('exposes the off/on/status subcommands', () => {
        expect([...TELEMETRY_SUBCOMMANDS].sort()).toEqual(['off', 'on', 'status']);
    });

    it('off persists the opt-out and reports it without emitting telemetry', async () => {
        const result = await runTelemetry({ subcommand: 'off', isHeadless: true });
        expect(result).toEqual({ ok: true, enabled: false, source: 'config' });
        expect(JSON.parse(fs.readFileSync(process.env.GRADA_CONFIG_PATH, 'utf-8'))).toEqual({ telemetry: false });
        expect(loggedText()).toContain('Telemetry is disabled.');
        expect(consoleSpies.exitSpy).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('on persists the opt-in without emitting telemetry', async () => {
        fs.writeFileSync(process.env.GRADA_CONFIG_PATH, JSON.stringify({ telemetry: false }));
        const result = await runTelemetry({ subcommand: 'on', isHeadless: true });
        expect(result).toEqual({ ok: true, enabled: true, source: 'default' });
        expect(JSON.parse(fs.readFileSync(process.env.GRADA_CONFIG_PATH, 'utf-8'))).toEqual({ telemetry: true });
        expect(loggedText()).toContain('Telemetry is enabled.');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('status reports each effective state without emitting telemetry', async () => {
        const fresh = await runTelemetry({ subcommand: 'status', isHeadless: true });
        expect(fresh).toEqual({ ok: true, enabled: true, source: 'default' });
        expect(loggedText()).toContain('Telemetry is enabled.');

        fs.writeFileSync(process.env.GRADA_CONFIG_PATH, JSON.stringify({ telemetry: false }));
        resetTelemetryPreferenceCache();
        const optedOut = await runTelemetry({ subcommand: 'status', isHeadless: true });
        expect(optedOut).toEqual({ ok: true, enabled: false, source: 'config' });
        expect(loggedText()).toContain('persistent preference');

        process.env.DO_NOT_TRACK = '1';
        const envOff = await runTelemetry({ subcommand: 'status', isHeadless: true });
        expect(envOff).toEqual({ ok: true, enabled: false, source: 'env' });
        expect(loggedText()).toContain('DO_NOT_TRACK is set');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('on warns instead of claiming success while DO_NOT_TRACK is set', async () => {
        process.env.DO_NOT_TRACK = '1';
        const result = await runTelemetry({ subcommand: 'on', isHeadless: true });
        expect(result).toEqual({ ok: true, enabled: false, source: 'env' });
        expect(JSON.parse(fs.readFileSync(process.env.GRADA_CONFIG_PATH, 'utf-8'))).toEqual({ telemetry: true });
        expect(loggedText()).toContain('stays off in this environment');
    });

    it('unknown and missing subcommands fail structured without emitting telemetry', async () => {
        for (const subcommand of ['bogus', undefined]) {
            const result = await runTelemetry({ subcommand, isHeadless: true });
            expect(result).toEqual({ ok: false, exitCode: 1, reason: 'unknown-telemetry-subcommand' });
        }
        expect(consoleSpies.exitSpy).not.toHaveBeenCalled();
        expect(loggedText()).toContain('Usage: grada telemetry <off|on|status>');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('exits non-zero on unknown subcommands outside headless mode', async () => {
        await runTelemetry({ subcommand: 'bogus' });
        expect(consoleSpies.exitSpy).toHaveBeenCalledWith(1);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('reports unwritable config paths instead of throwing', async () => {
        const blocker = path.join(dir, 'blocker');
        fs.writeFileSync(blocker, 'not-a-dir');
        process.env.GRADA_CONFIG_PATH = path.join(blocker, 'config.json');
        const result = await runTelemetry({ subcommand: 'off', isHeadless: true });
        expect(result).toEqual({ ok: false, exitCode: 1, reason: 'telemetry-config-write-failed' });
        expect(consoleSpies.exitSpy).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
});
