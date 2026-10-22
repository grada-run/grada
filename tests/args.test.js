import { describe, it, expect } from 'vitest';
import { parseFlags, normalizeOptions, normalizeArgv } from '../src/utils/args.js';
import { parseAddArgs } from '../src/commands/add.js';
import { parseAlertsArgs } from '../src/commands/alerts.js';
import { parseApplyArgs } from '../src/commands/apply.js';
import { parseDestroyArgs } from '../src/commands/destroy.js';
import { parseDoctorArgs } from '../src/commands/doctor.js';
import { parseDomainArgs } from '../src/commands/domain.js';
import { parseDriftArgs } from '../src/commands/drift.js';
import { parseEjectArgs } from '../src/commands/eject.js';
import { parseExecArgs } from '../src/commands/exec.js';
import { parseGcArgs } from '../src/commands/gc.js';
import { parseLogsArgs } from '../src/commands/logs.js';
import { parseMcpArgs } from '../src/commands/mcp.js';
import { parseRollbackArgs } from '../src/commands/rollback.js';
import { parseSleepArgs } from '../src/commands/sleep.js';
import { parseStatusArgs } from '../src/commands/status.js';
import { parseWakeArgs } from '../src/commands/wake.js';
import { parseDbBackupArgs } from '../src/commands/db/backup.js';
import { parseDbArgs } from '../src/commands/db/connect.js';
import { parseDbEnableVectorArgs } from '../src/commands/db/enable-vector.js';
import { parseDbImportArgs } from '../src/commands/db/import.js';
import { parseDbMigrateArgs } from '../src/commands/db/migrate.js';
import { parseDbRestoreArgs } from '../src/commands/db/restore.js';

describe('parseFlags', () => {
    it('parses string flags in space and = forms with last-wins', () => {
        expect(parseFlags(['--region', 'a', '--region=b'], { string: ['region'] })).toEqual({
            options: { region: 'b' },
            rest: [],
            unknown: [],
        });
        expect(parseFlags(['--project-name=x'], { string: ['project-name'] }).options).toEqual({
            projectName: 'x',
        });
    });

    it('supports explicit key overrides', () => {
        expect(parseFlags(['--headless'], { boolean: [{ name: 'headless', key: 'isHeadless' }] }).options).toEqual({
            isHeadless: true,
        });
    });

    it('drops trailing string flags without a value', () => {
        expect(parseFlags(['--cluster'], { string: ['cluster'] })).toEqual({ options: {}, rest: [], unknown: [] });
    });

    it('never consumes a flag-like token as a space-form value', () => {
        expect(parseFlags(['--cluster', '--service', 'x'], { string: ['cluster', 'service'] })).toEqual({
            options: { service: 'x' },
            rest: [],
            unknown: [],
        });
    });

    it('coerces number flags in both forms', () => {
        expect(parseFlags(['--tail', '50'], { number: ['tail'] }).options).toEqual({ tail: 50 });
        expect(parseFlags(['--tail=25'], { number: ['tail'] }).options).toEqual({ tail: 25 });
    });

    it('parses booleans bare and =true/=false', () => {
        expect(parseFlags(['--force'], { boolean: ['force'] }).options).toEqual({ force: true });
        expect(parseFlags(['--force=false'], { boolean: ['force'] }).options).toEqual({ force: false });
        expect(parseFlags(['--force=yes'], { boolean: ['force'] }).options).toEqual({ force: false });
    });

    it('ignores =forms on bare-only booleans', () => {
        expect(parseFlags(['--error'], { bareBoolean: ['error'] }).options).toEqual({ error: true });
        expect(parseFlags(['--error=false'], { bareBoolean: ['error'] })).toEqual({ options: {}, rest: [], unknown: [] });
    });

    it('expands single-dash aliases to their long flags', () => {
        expect(parseFlags(['-f'], { bareBoolean: ['follow'], alias: { f: 'follow' } }).options).toEqual({
            follow: true,
        });
        expect(parseFlags(['-x'], { bareBoolean: ['follow'], alias: { f: 'follow' } }).rest).toEqual(['-x']);
    });

    it('collects unknown --flags instead of dropping them', () => {
        expect(parseFlags(['a', '--unknown', 'b', '--unknown=x'], { string: ['region'] })).toEqual({
            options: {},
            rest: ['a', 'b'],
            unknown: ['--unknown', '--unknown=x'],
        });
    });
});

describe('normalizeOptions', () => {
    it('passes objects through untouched', () => {
        const options = { region: 'x' };
        expect(normalizeOptions(options)).toBe(options);
        expect(normalizeOptions({})).toEqual({});
    });

    it.each([null, undefined, 'string', 42, true])('coerces %s to {}', (value) => {
        expect(normalizeOptions(value)).toEqual({});
    });
});

describe('normalizeArgv', () => {
    it('copies arrays', () => {
        const argv = ['db', 'migrate'];
        const copy = normalizeArgv(argv);
        expect(copy).toEqual(argv);
        expect(copy).not.toBe(argv);
    });

    it.each([null, undefined, 'string', 42, true, { port: 'string' }])('coerces %s to []', (value) => {
        expect(normalizeArgv(value)).toEqual([]);
    });
});

describe('unknown-flag capture (per-command wiring)', () => {
    it.each([
        ['add', parseAddArgs],
        ['alerts', parseAlertsArgs],
        ['apply', parseApplyArgs],
        ['db backup', parseDbBackupArgs],
        ['db connect', parseDbArgs],
        ['db enable-vector', parseDbEnableVectorArgs],
        ['db import', parseDbImportArgs],
        ['db migrate', parseDbMigrateArgs],
        ['db restore', parseDbRestoreArgs],
        ['destroy', parseDestroyArgs],
        ['doctor', parseDoctorArgs],
        ['domain', parseDomainArgs],
        ['drift', parseDriftArgs],
        ['eject', parseEjectArgs],
        ['exec', parseExecArgs],
        ['gc', parseGcArgs],
        ['logs', parseLogsArgs],
        ['mcp', parseMcpArgs],
        ['rollback', parseRollbackArgs],
        ['sleep', parseSleepArgs],
        ['status', parseStatusArgs],
        ['wake', parseWakeArgs],
    ])('%s captures --bogus-flag for refuseUnknownFlags', (_name, parse) => {
        expect(parse(['--bogus-flag']).unknownFlags).toEqual(['--bogus-flag']);
    });
});
