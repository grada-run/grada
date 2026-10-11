import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackPromptsMockFactory } from './helpers/clack.js';
import { telemetryMockFactory } from './helpers/telemetry.js';
import { mockConsoleTrio } from './helpers/console.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runAdd } from '../src/commands/add.js';
import { runStatus } from '../src/commands/status.js';
import { runDrift } from '../src/commands/drift.js';
import { runDiagnose } from '../src/commands/diagnose.js';
import { runDoctor } from '../src/commands/doctor.js';
import { runDomain } from '../src/commands/domain.js';
import { runExec } from '../src/commands/exec.js';
import { runAlerts } from '../src/commands/alerts.js';
import { runGc } from '../src/commands/gc.js';
import { runLogs } from '../src/commands/logs.js';
import { runRollback } from '../src/commands/rollback.js';
import { runSleep } from '../src/commands/sleep.js';
import { runWake } from '../src/commands/wake.js';
import { applyStack } from '../src/commands/apply.js';
import { destroyStack } from '../src/commands/destroy.js';
import { ejectStack } from '../src/commands/eject.js';
import { mainStack } from '../src/commands/init.js';
import { syncAi } from '../src/commands/sync-ai.js';
import { runDb } from '../src/commands/db.js';
import { runDbBackup } from '../src/commands/db/backup.js';
import { runDbConnect } from '../src/commands/db/connect.js';
import { runDbEnableVector } from '../src/commands/db/enable-vector.js';
import { runDbImport } from '../src/commands/db/import.js';
import { runDbMigrate } from '../src/commands/db/migrate.js';
import { runDbRestore } from '../src/commands/db/restore.js';
import { pushSecrets, pullSecrets, auditSecrets } from '../src/commands/secrets.js';

vi.mock('@clack/prompts', () => clackPromptsMockFactory());

const spies = vi.hoisted(() => ({ setSpy: null, resetSpy: null }));

vi.mock('../src/core/telemetry.js', async (importOriginal) => {
    const base = await telemetryMockFactory(importOriginal);
    spies.setSpy = vi.fn(base.setActiveCommandName);
    spies.resetSpy = vi.fn(base.resetActiveCommandName);
    return { ...base, setActiveCommandName: spies.setSpy, resetActiveCommandName: spies.resetSpy };
});

// runDoctor() probes live AWS credentials plus `<binary> --version` spawns.
// The real SDK hangs on IMDS credential lookup in CI until the 15s auth
// timeout, tripping Vitest's 5s test timeout — fake both so the doctor test
// below returns instantly. Only doctor uses these two functions, so the
// remaining tests in this file are unaffected.
vi.mock('../src/utils/aws.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        checkAwsCredentials: vi.fn(async () => ({ accountId: '123456789012', region: 'us-east-2' })),
    };
});

vi.mock('../src/utils/system.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, checkDependency: vi.fn(async () => true) };
});

describe('programmatic command context', () => {
    let consoleSpies;
    let exitSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        consoleSpies = mockConsoleTrio();
        exitSpy = consoleSpies.exitSpy;
    });

    afterEach(() => {
        consoleSpies.restore();
        vi.restoreAllMocks();
    });

    // Breaking cwd resolution fails every command before any AWS or spawn
    // use, isolating the entry wrapper and the exit behavior.
    function breakCwd() {
        return vi.spyOn(process, 'cwd').mockImplementation(() => { throw new Error('boom'); });
    }

    const cases = [
        ['add', runAdd, {}],
        ['status', runStatus, {}],
        ['drift', runDrift, {}],
        ['diagnose', runDiagnose, {}],
        // Domain dispatches on subcommand before resolving the project.
        ['domain', runDomain, { subcommand: 'status' }],
        ['exec', runExec, {}],
    ];

    it.each(cases)('%s stamps and resets its command name', async (name, fn, args) => {
        const cwdSpy = breakCwd();
        try {
            const result = await fn(args);
            expect(result.reason).toBe('project-not-initialized');
            expect(spies.setSpy).toHaveBeenCalledWith(name);
            expect(spies.resetSpy).toHaveBeenCalled();
        } finally {
            cwdSpy.mockRestore();
        }
    });

    it.each(cases)('%s returns instead of exiting when headless', async (name, fn, args) => {
        const cwdSpy = breakCwd();
        try {
            const result = await fn({ ...args, isHeadless: true });
            expect(exitSpy).not.toHaveBeenCalled();
            expect(result).toEqual({ ok: false, exitCode: 1, reason: 'project-not-initialized' });
        } finally {
            cwdSpy.mockRestore();
        }
    });

    // Stamp-only entries: every remaining command wrapper must pair set
    // with reset. These stay out of `cases` above because their early
    // failure shapes differ (no headless noExit contract, or a throw
    // before project resolution) — the wrapper pairing is what matters
    // here, so outcomes are swallowed and only the pairing is asserted.
    const stampCases = [
        ['alerts', () => runAlerts({})],
        ['gc', () => runGc({})],
        ['logs', () => runLogs({})],
        ['rollback', () => runRollback({})],
        ['sleep', () => runSleep({})],
        ['wake', () => runWake({})],
        ['db_backup', () => runDbBackup({})],
        ['db_connect', () => runDbConnect({})],
        ['db_enable_vector', () => runDbEnableVector({})],
        ['db_import', () => runDbImport({})],
        ['db_migrate', () => runDbMigrate({})],
        ['db_restore', () => runDbRestore({})],
        // Broken cwd throws before these resolve anything (no side effects).
        ['apply', () => applyStack({})],
        ['destroy', () => destroyStack({})],
        ['eject', () => ejectStack({})],
        ['secrets_push', () => pushSecrets('.env', 'myapp', {})],
        ['secrets_pull', () => pullSecrets('.env', 'myapp', {})],
        ['secrets_audit', () => auditSecrets('.env', 'myapp', {})],
    ];

    it.each(stampCases)('%s stamps and resets its command name', async (name, invoke) => {
        const cwdSpy = breakCwd();
        try {
            await invoke().catch(() => {});
        } finally {
            cwdSpy.mockRestore();
        }
        expect(spies.setSpy).toHaveBeenCalledWith(name);
        expect(spies.resetSpy).toHaveBeenCalled();
    });

    it('init stamps its name on the fail-fast validation path', async () => {
        // checkDependency is mocked true above; the bogus capability hits
        // init's validation return before any prompt, AWS call, or write.
        const result = await mainStack({ isHeadless: true, headlessOptions: {}, initOptions: { with: ['bogus-cap'] } });
        expect(result).toMatchObject({ ok: false, reason: 'unsupported-capability' });
        expect(spies.setSpy).toHaveBeenCalledWith('init');
        expect(spies.resetSpy).toHaveBeenCalled();
    });

    it('sync_ai stamps its name without selecting assistants', async () => {
        // The mocked multiselect answers undefined: no assistants match, so
        // no rule files are written; the wrapper pairing still holds.
        await syncAi();
        expect(spies.setSpy).toHaveBeenCalledWith('sync_ai');
        expect(spies.resetSpy).toHaveBeenCalled();
    });

    it('db stamps its name on the unknown-subcommand path', async () => {
        const result = await runDb(['bogus-sub']);
        expect(result).toMatchObject({ ok: false, reason: 'unknown-db-subcommand' });
        expect(spies.setSpy).toHaveBeenCalledWith('db');
        expect(spies.resetSpy).toHaveBeenCalled();
    });

    it('doctor stamps its name without taking options', async () => {
        await runDoctor();
        expect(spies.setSpy).toHaveBeenCalledWith('doctor');
        expect(spies.resetSpy).toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('drift validation failures return stamped errors when headless', async () => {
        const positional = await runDrift({ isHeadless: true, unexpectedPositionals: ['bogus'] });
        expect(exitSpy).not.toHaveBeenCalled();
        expect(positional).toMatchObject({ ok: false, exitCode: 1, reason: 'unexpected-positional-args' });

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-drift-test-'));
        try {
            const missing = await runDrift({ cwd: dir, projectName: 'myapp', region: 'us-east-2', isHeadless: true });
            expect(exitSpy).not.toHaveBeenCalled();
            expect(missing).toMatchObject({ ok: false, exitCode: 1, reason: 'terraform-not-initialized' });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('add failures return stamped errors when headless', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-add-test-'));
        try {
            const result = await runAdd({ cwd: dir, projectName: 'myapp', region: 'us-east-2', capability: 'storage:s3', isHeadless: true });
            expect(exitSpy).not.toHaveBeenCalled();
            expect(result).toMatchObject({ ok: false, exitCode: 1 });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('exec validation failures return stamped errors when headless', async () => {
        const result = await runExec({ isHeadless: true, unexpectedPositionals: ['bogus'] });
        expect(exitSpy).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: false, exitCode: 1, reason: 'unexpected-positional-args' });
    });

    it('domain subcommand failures return stamped errors when headless', async () => {
        const result = await runDomain({ isHeadless: true });
        expect(exitSpy).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: false, exitCode: 1, reason: 'unknown-domain-subcommand' });
    });

    it('lambda diagnose failures return stamped errors when headless', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-diagnose-test-'));
        try {
            fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), 'resource "aws_lambda_function" "app" {}\n');
            const enoent = () => ({ error: Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' }) });
            const result = await runDiagnose({ cwd: dir, region: 'us-east-2', spawnSyncImpl: enoent, isHeadless: true });
            expect(exitSpy).not.toHaveBeenCalled();
            expect(result).toMatchObject({ ok: false, exitCode: 1 });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
