import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { trackEvent, trackSuccess, trackFailure, detectCiProvider, resetTelemetryIdentityCache, migrateLegacyTelemetryId, getCliVersion, resolveCliVersion, setActiveCommandName, resetActiveCommandName } from '../src/core/telemetry.js';

const SHA256_UNKNOWN_PREFIX = crypto.createHash('sha256').update('unknown').digest('hex').substring(0, 16);

describe('trackEvent capture', () => {
    beforeEach(() => {
        resetTelemetryIdentityCache();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.DO_NOT_TRACK;
        delete process.env.GRADA_TELEMETRY_ID_PATH;
        delete process.env.DEPLOY_STACK_TELEMETRY_ID_PATH;
    });

    function mockFetch() {
        const fn = vi.fn().mockResolvedValue({});
        vi.stubGlobal('fetch', fn);
        return fn;
    }

    function lastPayload(fetchMock) {
        const [, { body }] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
        return JSON.parse(body);
    }

    it.each([
        'exec_run',
        'diagnose_run',
        'status_run',
        'gc_run',
        'doctor_run',
        'rollback_run',
        'secrets_pushed',
        'secrets_pull',
        'secrets_audit',
        'logs_streamed',
        'sync_ai_executed',
        'project_provisioned',
        'project_ejected',
        'infrastructure_applied',
        'infrastructure_destroyed',
        'recovery_prompted',
        'recovery_failed',
        'cli-error',
    ])('sends legitimate event %s', (eventName) => {
        const fetchMock = mockFetch();
        trackEvent(eventName, { projectName: 'test' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(['message', 'data', 'true', true, 1])('captures unexpected event %s without dropping it', (eventName) => {
        const fetchMock = mockFetch();
        trackEvent(eventName, { projectName: 'test' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(lastPayload(fetchMock).event).toBe(String(eventName));
    });

    it.each([undefined, null, '', '   '])('drops missing or blank event %s', (eventName) => {
        const fetchMock = mockFetch();
        trackEvent(eventName, { projectName: 'test' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([[{}], [['a', 'b']], [() => {}]])(
        'drops object, array, or function eventName without sending',
        (eventName) => {
            const fetchMock = mockFetch();
            trackEvent(eventName, { projectName: 'test' });
            expect(fetchMock).not.toHaveBeenCalled();
        }
    );

    // The array case exercises properties-wrapping, so its eventName is a
    // plain string: array eventNames are dropped as non-serializable.
    it.each([['test', 'test'], ['test', ['a', 'b']]])(
        'wraps non-object properties without spreading indexed keys',
        (eventName, properties) => {
            const fetchMock = mockFetch();
            trackEvent(eventName, properties);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const payload = lastPayload(fetchMock);
            expect(payload.properties.raw_properties).toEqual(properties);
            expect(payload.properties).not.toHaveProperty('0');
        }
    );

    it('hashes a non-string projectName into project_id without throwing', () => {
        const fetchMock = mockFetch();
        expect(() => trackEvent('test', { projectName: 42 })).not.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const payload = lastPayload(fetchMock);
        const expectedId = crypto.createHash('sha256').update('42').digest('hex').substring(0, 16);
        expect(payload.properties.project_id).toBe(expectedId);
        expect(payload.properties).not.toHaveProperty('projectName');
        expect(payload.distinct_id).toMatch(/^[0-9a-f]{16}$/);
        expect(payload.distinct_id).not.toBe(SHA256_UNKNOWN_PREFIX);
    });

    it('keeps one stable machine distinct_id with and without projectName', () => {
        const fetchMock = mockFetch();
        trackEvent('with_name', { projectName: 'myapp' });
        trackEvent('without_name');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [first, second] = fetchMock.mock.calls.map(([, { body }]) => JSON.parse(body));
        expect(first.distinct_id).toMatch(/^[0-9a-f]{16}$/);
        expect(second.distinct_id).toBe(first.distinct_id);
        expect(first.distinct_id).not.toBe(SHA256_UNKNOWN_PREFIX);
        expect(first.properties.project_id).toBe(
            crypto.createHash('sha256').update('myapp').digest('hex').substring(0, 16)
        );
        expect(second.properties.project_id).toBe(
            crypto.createHash('sha256').update(path.basename(process.cwd())).digest('hex').substring(0, 16)
        );
    });

    it('persists file identity across cache resets, even when CI=true', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-id-'));
        try {
            const idPath = path.join(dir, 'nested', 'telemetry-id');
            process.env.DEPLOY_STACK_TELEMETRY_ID_PATH = idPath;
            const savedCI = process.env.CI;
            process.env.CI = 'true';
            try {
                const fetchMock = mockFetch();
                trackEvent('first_run', { projectName: 'test' });
                expect(fs.existsSync(idPath)).toBe(true);
                const firstId = lastPayload(fetchMock).distinct_id;
                expect(firstId).toMatch(/^[0-9a-f]{16}$/);
                resetTelemetryIdentityCache();
                trackEvent('second_run', { projectName: 'test' });
                expect(lastPayload(fetchMock).distinct_id).toBe(firstId);
            } finally {
                if (savedCI === undefined) delete process.env.CI;
                else process.env.CI = savedCI;
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('tags automated test runs without blocking them', () => {
        const fetchMock = mockFetch();
        trackEvent('exec_run', { projectName: 'test' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const payload = lastPayload(fetchMock);
        // VITEST is set by the runner itself, so this must be true here.
        expect(payload.properties.is_test_env).toBe(true);
        expect(typeof payload.properties.is_tty).toBe('boolean');
        expect(typeof payload.properties.is_cli_entry).toBe('boolean');
    });

    it.each([
        ['/repo/bin/cli.js', true],
        ['/opt/tools/deploy-stack', true],
        ['/opt/tools/grada', true],
        ['/opt/tools/grada-run', true],
        ['/repo/node_modules/vitest/vitest.mjs', false],
    ])('detects CLI entry from argv[1] %s as %s', (entry, expected) => {
        const savedArgv = process.argv;
        process.argv = ['node', entry];
        try {
            const fetchMock = mockFetch();
            trackEvent('exec_run', { projectName: 'test' });
            expect(lastPayload(fetchMock).properties.is_cli_entry).toBe(expected);
        } finally {
            process.argv = savedArgv;
        }
    });

    describe('telemetry identity migration', () => {
        it('copies a legacy identity to the new path exactly once', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-migrate-'));
            try {
                const legacyPath = path.join(dir, '.deploy-stack', 'telemetry-id');
                const newPath = path.join(dir, '.grada', 'telemetry-id');
                fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
                fs.writeFileSync(legacyPath, 'legacy-uuid\n');
                expect(migrateLegacyTelemetryId(newPath, legacyPath)).toBe(true);
                expect(fs.readFileSync(newPath, 'utf-8')).toBe('legacy-uuid\n');
                expect(migrateLegacyTelemetryId(newPath, legacyPath)).toBe(false);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('does nothing when no legacy identity exists', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-migrate-'));
            try {
                const newPath = path.join(dir, '.grada', 'telemetry-id');
                expect(migrateLegacyTelemetryId(newPath, path.join(dir, '.deploy-stack', 'telemetry-id'))).toBe(false);
                expect(fs.existsSync(newPath)).toBe(false);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('prefers GRADA_TELEMETRY_ID_PATH over the legacy override', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-id-'));
            try {
                const gradaPath = path.join(dir, 'grada', 'telemetry-id');
                const legacyPath = path.join(dir, 'legacy', 'telemetry-id');
                process.env.GRADA_TELEMETRY_ID_PATH = gradaPath;
                process.env.DEPLOY_STACK_TELEMETRY_ID_PATH = legacyPath;
                const fetchMock = mockFetch();
                trackEvent('override_run', { projectName: 'test' });
                expect(fs.existsSync(gradaPath)).toBe(true);
                expect(fs.existsSync(legacyPath)).toBe(false);
                expect(lastPayload(fetchMock).distinct_id).toMatch(/^[0-9a-f]{16}$/);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('prefers GRADA_FRAMEWORK over the legacy framework var', () => {
            process.env.GRADA_FRAMEWORK = 'grada-nextjs';
            process.env.DEPLOY_STACK_FRAMEWORK = 'legacy-nextjs';
            try {
                const fetchMock = mockFetch();
                trackEvent('framework_run', { projectName: 'test' });
                expect(lastPayload(fetchMock).properties.framework).toBe('grada-nextjs');
            } finally {
                delete process.env.GRADA_FRAMEWORK;
                delete process.env.DEPLOY_STACK_FRAMEWORK;
            }
        });

        it('still honors the legacy framework var alone', () => {
            process.env.DEPLOY_STACK_FRAMEWORK = 'legacy-nextjs';
            try {
                const fetchMock = mockFetch();
                trackEvent('framework_run', { projectName: 'test' });
                expect(lastPayload(fetchMock).properties.framework).toBe('legacy-nextjs');
            } finally {
                delete process.env.DEPLOY_STACK_FRAMEWORK;
            }
        });
    });

    describe('detectCiProvider', () => {
        const CI_KEYS = ['GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'JENKINS_URL', 'CI', 'CONTINUOUS_INTEGRATION'];

        const withEnv = (vars, fn) => {
            const saved = {};
            for (const key of CI_KEYS) {
                saved[key] = process.env[key];
                delete process.env[key];
            }
            Object.assign(process.env, vars);
            try {
                fn();
            } finally {
                for (const key of CI_KEYS) {
                    if (saved[key] === undefined) delete process.env[key];
                    else process.env[key] = saved[key];
                }
            }
        };

        it.each([
            [{ GITHUB_ACTIONS: 'true', CI: 'true' }, 'github_actions'],
            [{ GITLAB_CI: 'true' }, 'gitlab_ci'],
            [{ CIRCLECI: 'true' }, 'circleci'],
            [{ JENKINS_URL: 'http://jenkins:8080/' }, 'jenkins'],
            [{ CI: 'true' }, 'generic_ci'],
            [{ CONTINUOUS_INTEGRATION: 'true' }, 'generic_ci'],
            [{}, 'none'],
        ])('maps %s to %s', (vars, expected) => {
            withEnv(vars, () => {
                expect(detectCiProvider()).toBe(expected);
            });
        });

        it('prefers specific providers over generic CI flags', () => {
            withEnv({ CI: 'true', GITLAB_CI: 'true', GITHUB_ACTIONS: 'true' }, () => {
                expect(detectCiProvider()).toBe('github_actions');
            });
        });

        it('includes ci_provider in the base payload', () => {
            withEnv({ GITHUB_ACTIONS: 'true', CI: 'true' }, () => {
                const fetchMock = mockFetch();
                trackEvent('exec_run', { projectName: 'test' });
                const payload = lastPayload(fetchMock);
                expect(payload.properties.is_ci).toBe(true);
                expect(payload.properties.ci_provider).toBe('github_actions');
            });
        });
    });

    describe('is_ci consistency', () => {
        const CI_KEYS = ['GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'JENKINS_URL', 'CI', 'CONTINUOUS_INTEGRATION'];

        const withEnv = (vars, fn) => {
            const saved = {};
            for (const key of CI_KEYS) {
                saved[key] = process.env[key];
                delete process.env[key];
            }
            Object.assign(process.env, vars);
            try {
                fn();
            } finally {
                for (const key of CI_KEYS) {
                    if (saved[key] === undefined) delete process.env[key];
                    else process.env[key] = saved[key];
                }
            }
        };

        it('reports is_ci true when CI is unset but a provider is detected', () => {
            withEnv({ GITHUB_ACTIONS: 'true' }, () => {
                const fetchMock = mockFetch();
                trackEvent('exec_run', { projectName: 'test' });
                const payload = lastPayload(fetchMock);
                expect(payload.properties.ci_provider).toBe('github_actions');
                expect(payload.properties.is_ci).toBe(true);
            });
        });

        it("treats 'false' and '0' as inactive", () => {
            withEnv({ CI: 'false', GITHUB_ACTIONS: 'false' }, () => {
                const fetchMock = mockFetch();
                trackEvent('exec_run', { projectName: 'test' });
                const payload = lastPayload(fetchMock);
                expect(payload.properties.ci_provider).toBe('none');
                expect(payload.properties.is_ci).toBe(false);
            });
            withEnv({ CI: '0' }, () => {
                expect(detectCiProvider()).toBe('none');
            });
        });
    });

    describe('cli_command gating', () => {
        const savedArgv = process.argv;
        const savedCliCommand = process.env.CLI_COMMAND;

        afterEach(() => {
            process.argv = savedArgv;
            if (savedCliCommand === undefined) delete process.env.CLI_COMMAND;
            else process.env.CLI_COMMAND = savedCliCommand;
        });

        it("reports 'module_import' for programmatic imports regardless of argv[2]", () => {
            process.argv = ['node', '/repo/scripts/runner.mjs', 'deploy-stack'];
            delete process.env.CLI_COMMAND;
            const fetchMock = mockFetch();
            trackEvent('exec_run', { projectName: 'test' });
            const payload = lastPayload(fetchMock);
            expect(payload.properties.is_cli_entry).toBe(false);
            expect(payload.properties.cli_command).toBe('module_import');
        });

        it('infers the active command name for programmatic entries when set', () => {
            process.argv = ['node', '/repo/scripts/runner.mjs'];
            delete process.env.CLI_COMMAND;
            const fetchMock = mockFetch();
            setActiveCommandName('add');
            try {
                trackEvent('add_run', { projectName: 'test' });
            } finally {
                resetActiveCommandName();
            }
            const payload = lastPayload(fetchMock);
            expect(payload.properties.is_cli_entry).toBe(false);
            expect(payload.properties.cli_command).toBe('add');
        });

        it('falls back to module_import again after reset', () => {
            process.argv = ['node', '/repo/scripts/runner.mjs'];
            delete process.env.CLI_COMMAND;
            const fetchMock = mockFetch();
            setActiveCommandName('status');
            resetActiveCommandName();
            trackEvent('status_run', { projectName: 'test' });
            expect(lastPayload(fetchMock).properties.cli_command).toBe('module_import');
        });

        it('ignores blank names and prefers real CLI invocations over stale context', () => {
            process.argv = ['node', '/repo/scripts/runner.mjs'];
            delete process.env.CLI_COMMAND;
            const fetchMock = mockFetch();
            setActiveCommandName('   ');
            trackEvent('status_run', { projectName: 'test' });
            expect(lastPayload(fetchMock).properties.cli_command).toBe('module_import');

            setActiveCommandName('stale');
            process.argv = ['node', '/repo/bin/cli.js', 'status'];
            trackEvent('status_run', { projectName: 'test' });
            expect(lastPayload(fetchMock).properties.cli_command).toBe('status');
            resetActiveCommandName();
        });

        it('preserves CLI_COMMAND and subcommand args on real CLI invocations', () => {
            process.argv = ['node', '/repo/bin/cli.js', 'db', 'connect'];
            process.env.CLI_COMMAND = 'db connect';
            const fetchMock = mockFetch();
            trackEvent('db_connect_run', { projectName: 'test' });
            expect(lastPayload(fetchMock).properties.cli_command).toBe('db connect');

            delete process.env.CLI_COMMAND;
            process.argv = ['node', '/repo/bin/cli.js', 'status', '--json'];
            trackEvent('status_run', { projectName: 'test' });
            expect(lastPayload(fetchMock).properties.cli_command).toBe('status --json');
        });
    });

    describe('cli_version tracking', () => {
        const expectedVersion = JSON.parse(
            fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
        ).version;

        it('reads the version from package.json', () => {
            expect(getCliVersion()).toBe(expectedVersion);
        });

        it('stamps cli_version on every event', () => {
            const fetchMock = mockFetch();
            trackEvent('exec_run', { projectName: 'test' });
            trackEvent('doctor_run');
            trackEvent('custom_event', 'primitive-props');
            expect(fetchMock).toHaveBeenCalledTimes(3);
            for (const [, { body }] of fetchMock.mock.calls) {
                expect(JSON.parse(body).properties.cli_version).toBe(expectedVersion);
            }
        });

        it('lets an explicit per-event cli_version override the base value', () => {
            const fetchMock = mockFetch();
            trackEvent('exec_run', { cli_version: '9.9.9-override' });
            expect(lastPayload(fetchMock).properties.cli_version).toBe('9.9.9-override');
        });

        it('ignores undefined reserved props instead of erasing base values', () => {
            const fetchMock = mockFetch();
            trackEvent('exec_run', { cli_version: undefined, os: undefined, success: true });
            const props = lastPayload(fetchMock).properties;
            // An explicit undefined used to survive the ...eventProps spread
            // and vanish in JSON.stringify — reading as "missing" in PostHog.
            expect(props.cli_version).toBe(expectedVersion);
            expect(props.os).toBe(process.platform);
            expect(props.success).toBe(true);
        });
    });

    describe('resolveCliVersion', () => {
        function writeManifest(dir, name, version) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
        }

        function withTmpDir(fn) {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-version-'));
            try {
                return fn(dir);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }

        it('climbs from a nested module dir to the name-matched manifest', () => {
            withTmpDir((base) => {
                writeManifest(base, 'grada-run', '1.2.3-fixture');
                const deep = path.join(base, 'a', 'b');
                fs.mkdirSync(deep, { recursive: true });
                expect(resolveCliVersion({ startDir: deep })).toBe('1.2.3-fixture');
            });
        });

        it('skips wrong-named and malformed manifests while climbing', () => {
            withTmpDir((base) => {
                writeManifest(base, 'grada-run', '9.9.9-top');
                writeManifest(path.join(base, 'nested'), 'some-other-project', '0.0.0');
                fs.mkdirSync(path.join(base, 'nested', 'deep'), { recursive: true });
                fs.writeFileSync(path.join(base, 'nested', 'deep', 'package.json'), '{oops');
                // Nearest manifest is malformed, next is wrong-named: the
                // walk must pass both and return the real version above.
                expect(resolveCliVersion({ startDir: path.join(base, 'nested', 'deep') })).toBe('9.9.9-top');
            });
        });

        it('falls back to GRADA_CLI_VERSION when no manifest matches', () => {
            const readFile = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
            expect(resolveCliVersion({
                startDir: path.join(os.tmpdir(), 'cli-version-bare'),
                readFile,
                env: { GRADA_CLI_VERSION: '7.7.7-env' },
            })).toBe('7.7.7-env');
        });

        it('returns unknown when neither manifest nor env yields a version', () => {
            const readFile = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
            expect(resolveCliVersion({ startDir: path.join(os.tmpdir(), 'cli-version-bare'), readFile, env: {} })).toBe('unknown');
            expect(resolveCliVersion({ startDir: path.join(os.tmpdir(), 'cli-version-bare'), readFile, env: { GRADA_CLI_VERSION: '  ' } })).toBe('unknown');
            expect(resolveCliVersion({ startDir: null, readFile, env: null })).toBe('unknown');
        });
    });

    it('marks interactive runs as non-test environments', () => {
        const savedVitest = process.env.VITEST;
        const savedNodeEnv = process.env.NODE_ENV;
        delete process.env.VITEST;
        process.env.NODE_ENV = 'production';
        try {
            const fetchMock = mockFetch();
            trackEvent('exec_run', { projectName: 'test' });
            const [, { body }] = fetchMock.mock.calls[0];
            expect(JSON.parse(body).properties.is_test_env).toBe(false);
        } finally {
            if (savedVitest === undefined) delete process.env.VITEST;
            else process.env.VITEST = savedVitest;
            if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = savedNodeEnv;
        }
    });
});

describe('trackSuccess', () => {
    beforeEach(() => {
        resetTelemetryIdentityCache();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.DO_NOT_TRACK;
    });

    it('stamps success:true and flushes before returning', async () => {
        const fetchMock = vi.fn().mockResolvedValue({});
        vi.stubGlobal('fetch', fetchMock);
        await trackSuccess('exec_run', { projectName: 'test' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, { body }] = fetchMock.mock.calls[0];
        expect(JSON.parse(body).properties).toMatchObject({ success: true });
    });

    it('forces success:true even when the payload says otherwise', async () => {
        const fetchMock = vi.fn().mockResolvedValue({});
        vi.stubGlobal('fetch', fetchMock);
        await trackSuccess('exec_run', { success: false });
        const [, { body }] = fetchMock.mock.calls[0];
        expect(JSON.parse(body).properties.success).toBe(true);
    });

    it.each(['test', 42, true])(
        'wraps primitive properties %s as raw_properties without spreading',
        async (properties) => {
            const fetchMock = vi.fn().mockResolvedValue({});
            vi.stubGlobal('fetch', fetchMock);
            await trackSuccess('exec_run', properties);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [, { body }] = fetchMock.mock.calls[0];
            const payload = JSON.parse(body).properties;
            expect(payload).toMatchObject({ raw_properties: properties, success: true });
            expect(payload).not.toHaveProperty('0');
        }
    );

    it('wraps array properties as raw_properties without spreading indices', async () => {
        const fetchMock = vi.fn().mockResolvedValue({});
        vi.stubGlobal('fetch', fetchMock);
        await trackSuccess('exec_run', ['a', 'b']);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, { body }] = fetchMock.mock.calls[0];
        const payload = JSON.parse(body).properties;
        expect(payload).toMatchObject({ raw_properties: ['a', 'b'], success: true });
        expect(payload).not.toHaveProperty('0');
    });

    it('sends only the success flag when properties are null', async () => {
        const fetchMock = vi.fn().mockResolvedValue({});
        vi.stubGlobal('fetch', fetchMock);
        await trackSuccess('exec_run', null);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, { body }] = fetchMock.mock.calls[0];
        const payload = JSON.parse(body).properties;
        expect(payload.success).toBe(true);
        expect(payload).not.toHaveProperty('raw_properties');
    });
});

describe('trackFailure', () => {
    beforeEach(() => {
        resetTelemetryIdentityCache();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.DO_NOT_TRACK;
    });

    it('stamps success:false and flushes before returning', async () => {
        const fetchMock = vi.fn().mockResolvedValue({});
        vi.stubGlobal('fetch', fetchMock);
        await trackFailure('exec_run', { projectName: 'test', error_code: 'BOOM' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, { body }] = fetchMock.mock.calls[0];
        expect(JSON.parse(body).properties).toMatchObject({ success: false, error_code: 'BOOM' });
    });

    it('forces success:false even when the payload says otherwise', async () => {
        const fetchMock = vi.fn().mockResolvedValue({});
        vi.stubGlobal('fetch', fetchMock);
        await trackFailure('exec_run', { success: true });
        const [, { body }] = fetchMock.mock.calls[0];
        expect(JSON.parse(body).properties.success).toBe(false);
    });

    it.each(['test', 42, true])(
        'wraps primitive properties %s as raw_properties without spreading',
        async (properties) => {
            const fetchMock = vi.fn().mockResolvedValue({});
            vi.stubGlobal('fetch', fetchMock);
            await trackFailure('exec_run', properties);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [, { body }] = fetchMock.mock.calls[0];
            const payload = JSON.parse(body).properties;
            expect(payload).toMatchObject({ raw_properties: properties, success: false });
            expect(payload).not.toHaveProperty('0');
        }
    );

    it('wraps array properties as raw_properties without spreading indices', async () => {
        const fetchMock = vi.fn().mockResolvedValue({});
        vi.stubGlobal('fetch', fetchMock);
        await trackFailure('exec_run', ['a', 'b']);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, { body }] = fetchMock.mock.calls[0];
        const payload = JSON.parse(body).properties;
        expect(payload).toMatchObject({ raw_properties: ['a', 'b'], success: false });
        expect(payload).not.toHaveProperty('0');
    });

    it('sends only the success flag when properties are null', async () => {
        const fetchMock = vi.fn().mockResolvedValue({});
        vi.stubGlobal('fetch', fetchMock);
        await trackFailure('exec_run', null);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, { body }] = fetchMock.mock.calls[0];
        const payload = JSON.parse(body).properties;
        expect(payload.success).toBe(false);
        expect(payload).not.toHaveProperty('raw_properties');
    });
});
