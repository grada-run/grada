import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseCliArgs, stripGlobalOnlyFlags } from '../src/core/parser.js';

describe('CLI Argument Parser', () => {
    it('safely extracts telemetry variations and prevents positional hijacking', () => {
        // Simulating: npx deploy-stack secrets push .env --no-telemetry=true
        const args = ['secrets', 'push', '.env', '--no-telemetry=true'];
        const result = parseCliArgs(args);

        expect(result.hasNoTelemetry).toBe(true);
        expect(result.positionalArgs).toEqual(['secrets', 'push', '.env']);
        expect(result.baseCommand).toBe('secrets push');
    });

    it('treats =false as telemetry-on and =garbage as not-a-global', () => {
        expect(parseCliArgs(['status', '--no-telemetry=false']).hasNoTelemetry).toBe(false);
        expect(parseCliArgs(['status', '--no-telemetry=yes']).hasNoTelemetry).toBe(false);
    });

    it('correctly parses headless boolean flags without assignments', () => {
        // Simulating: npx deploy-stack --headless --needsDatabase
        const args = ['--headless', '--needsDatabase'];
        const result = parseCliArgs(args);

        expect(result.isHeadless).toBe(true);
        expect(result.headlessOptions.needsDatabase).toBe(true);
    });

    it('honors =true on execution flags (bare, =false, and absent unchanged)', () => {
        expect(parseCliArgs(['apply', '--dry-run=true']).isDryRun).toBe(true);
        expect(parseCliArgs(['apply', '--dry-run']).isDryRun).toBe(true);
        expect(parseCliArgs(['apply', '--dry-run=false']).isDryRun).toBe(false);
        expect(parseCliArgs(['apply']).isDryRun).toBe(false);
        expect(parseCliArgs(['--headless=true']).isHeadless).toBe(true);
        expect(parseCliArgs(['--headless=false']).isHeadless).toBe(false);
        expect(parseCliArgs(['--preconfigured=true']).isPreconfigured).toBe(true);
        expect(parseCliArgs(['init', '--setup-ci-drift=true']).initOptions.setupCiDrift).toBe(true);
        expect(parseCliArgs(['init', '--setup-ci-drift=false']).initOptions.setupCiDrift).toBe(false);
    });

    it('correctly maps headless assignment flags', () => {
        // Simulating: npx deploy-stack --headless --framework=django --region=us-east-2
        const args = ['--headless', '--framework=django', '--region=us-east-2'];
        const result = parseCliArgs(args);

        expect(result.headlessOptions.framework).toBe('django');
        expect(result.headlessOptions.region).toBe('us-east-2');
    });

    it('survives non-array and mixed-element inputs without throwing', () => {
        for (const bad of [null, undefined, 'string', 42, true, { port: 'string' }]) {
            const result = parseCliArgs(bad);
            expect(result.positionalArgs).toEqual([]);
            expect(result.baseCommand).toBe('init');
            expect(result.isHeadless).toBe(false);
        }
        const mixed = parseCliArgs(['--headless', 42, null, 'status']);
        expect(mixed.isHeadless).toBe(true);
        expect(mixed.positionalArgs).toEqual([42, null, 'status']);
    });

    it('extracts isPreconfigured and always populates initOptions', () => {
        const headless = parseCliArgs(['--headless', '--preconfigured']);
        expect(headless.isPreconfigured).toBe(true);
        expect(headless.initOptions).toEqual({
            with: [],
            force: false,
            offline: false,
            adoptState: false,
            model: null,
            domain: null,
            zoneId: null,
            fromEmail: null,
            dbEngine: null,
            target: null,
            projectName: null,
            githubRepo: null,
            setupCiMigrate: false,
            setupCiDrift: false,
        });
        expect(parseCliArgs(['--force']).initOptions.force).toBe(true);
        expect(parseCliArgs(['--offline']).initOptions.offline).toBe(true);
        expect(parseCliArgs(['--adopt-state']).initOptions.adoptState).toBe(true);

        const interactive = parseCliArgs(['init', '--with', 'db:redis']);
        expect(interactive.isPreconfigured).toBe(false);
        expect(interactive.initOptions.with).toEqual(['db:redis']);
    });

    it('accumulates repeatable and comma-separated --with with dedupe', () => {
        const result = parseCliArgs([
            '--headless',
            '--with', 'db:redis, queue:sqs',
            '--with=db:redis',
            '--with=ai:bedrock,',
            '--with', '--headless',
        ]);
        expect(result.initOptions.with).toEqual(['db:redis', 'queue:sqs', 'ai:bedrock']);
    });

    it('parses addon value flags in space and equals forms', () => {
        const spaced = parseCliArgs(['--headless', '--model', 'claude-x', '--domain', 'example.com']);
        expect(spaced.initOptions.model).toBe('claude-x');
        expect(spaced.initOptions.domain).toBe('example.com');

        const joined = parseCliArgs(['--zone-id=Z1', '--from-email=hi@example.com', '--setup-ci-migrate']);
        expect(joined.initOptions.zoneId).toBe('Z1');
        expect(joined.initOptions.fromEmail).toBe('hi@example.com');
        expect(joined.initOptions.setupCiMigrate).toBe(true);
        expect(parseCliArgs(['--setup-ci-drift']).initOptions.setupCiDrift).toBe(true);
    });

    it('parses --project-name in space and equals forms', () => {
        expect(parseCliArgs(['--project-name=newname']).initOptions.projectName).toBe('newname');
        const spaced = parseCliArgs(['--headless', '--project-name', 'newname']);
        expect(spaced.initOptions.projectName).toBe('newname');
        expect(spaced.baseCommand).toBe('init');
        expect(parseCliArgs(['--headless']).initOptions.projectName).toBeNull();
    });

    it('parses --github-repo in space and equals forms', () => {
        expect(parseCliArgs(['--github-repo=acme/widgets']).initOptions.githubRepo).toBe('acme/widgets');
        const spaced = parseCliArgs(['--headless', '--github-repo', 'acme/widgets']);
        expect(spaced.initOptions.githubRepo).toBe('acme/widgets');
        expect(spaced.baseCommand).toBe('init');
        expect(parseCliArgs(['--headless']).initOptions.githubRepo).toBeNull();
    });

    it('parses --setup-ci-migrate with an optional explicit command', () => {
        expect(parseCliArgs(['--setup-ci-migrate=node ./dist/migrate.cjs']).initOptions.setupCiMigrate)
            .toBe('node ./dist/migrate.cjs');
        const spaced = parseCliArgs(['--headless', '--setup-ci-migrate', 'node ./dist/migrate.cjs']);
        expect(spaced.initOptions.setupCiMigrate).toBe('node ./dist/migrate.cjs');
        expect(spaced.baseCommand).toBe('init');
        expect(parseCliArgs(['--setup-ci-migrate']).initOptions.setupCiMigrate).toBe(true);
        expect(parseCliArgs([]).initOptions.setupCiMigrate).toBe(false);
    });

    it('treats valueless addon flags as absent', () => {
        const result = parseCliArgs(['--headless', '--model', '--domain=', '--with']);
        expect(result.initOptions.model).toBeNull();
        expect(result.initOptions.domain).toBeNull();
        expect(result.initOptions.with).toEqual([]);
    });

    it('parses --db-engine in space and equals forms', () => {
        const spaced = parseCliArgs(['--headless', '--db-engine', 'mysql']);
        expect(spaced.initOptions.dbEngine).toBe('mysql');

        const joined = parseCliArgs(['--db-engine=aurora-postgresql']);
        expect(joined.initOptions.dbEngine).toBe('aurora-postgresql');

        const absent = parseCliArgs(['--headless']);
        expect(absent.initOptions.dbEngine).toBeNull();
    });

    it('parses --target in space and equals forms', () => {
        const spaced = parseCliArgs(['--headless', '--target', 'lambda']);
        expect(spaced.initOptions.target).toBe('lambda');

        const joined = parseCliArgs(['--target=ecs']);
        expect(joined.initOptions.target).toBe('ecs');

        const absent = parseCliArgs(['--headless']);
        expect(absent.initOptions.target).toBeNull();
    });

    it('treats a valueless --target as absent', () => {
        expect(parseCliArgs(['--headless', '--target']).initOptions.target).toBeNull();
        expect(parseCliArgs(['--target=']).initOptions.target).toBeNull();
    });

    it('parses headless value flags in space and equals forms', () => {
        const spaced = parseCliArgs(['--headless', '--target', 'lambda', '--framework', 'node', '--region', 'eu-west-1']);
        expect(spaced.headlessOptions.framework).toBe('node');
        expect(spaced.headlessOptions.region).toBe('eu-west-1');
        expect(spaced.initOptions.target).toBe('lambda');

        const joined = parseCliArgs(['--headless', '--framework=django', '--port=3000']);
        expect(joined.headlessOptions.framework).toBe('django');
        expect(joined.headlessOptions.port).toBe('3000');

        const missing = parseCliArgs(['--headless']);
        expect(missing.headlessOptions.framework).toBeNull();
        expect(missing.headlessOptions.needsDatabase).toBeNull();
    });

    it('preserves bare-boolean headless flags without consuming neighbors', () => {
        const bare = parseCliArgs(['--headless', '--needsDatabase', '--framework', 'node']);
        expect(bare.headlessOptions.needsDatabase).toBe(true);
        expect(bare.headlessOptions.framework).toBe('node');

        expect(parseCliArgs(['--headless', '--needsDatabase=true']).headlessOptions.needsDatabase).toBe(true);
        expect(parseCliArgs(['--headless', '--enablePrPreviews=false']).headlessOptions.enablePrPreviews).toBe(false);
    });

    it('filters consumed flag values out of positionalArgs and baseCommand', () => {
        const init = parseCliArgs(['--headless', '--target', 'lambda', '--framework', 'node']);
        expect(init.positionalArgs).toEqual([]);
        expect(init.baseCommand).toBe('init');

        const routed = parseCliArgs(['status', '--region', 'us-east-1']);
        expect(routed.positionalArgs).toEqual(['status']);
        expect(routed.baseCommand).toBe('status');

        // Genuine positionals (mixed with flags) are untouched.
        const secrets = parseCliArgs(['secrets', 'push', '.env', '--region', 'us-east-2']);
        expect(secrets.positionalArgs).toEqual(['secrets', 'push', '.env']);
        expect(secrets.baseCommand).toBe('secrets push');
    });
});

describe('stripGlobalOnlyFlags', () => {
    it('removes --no-telemetry in bare and =forms, keeping everything else', () => {
        expect(stripGlobalOnlyFlags(['apply', '--no-telemetry', '--auto-approve'])).toEqual(['apply', '--auto-approve']);
        expect(stripGlobalOnlyFlags(['status', '--no-telemetry=true'])).toEqual(['status']);
        expect(stripGlobalOnlyFlags(['status', '--no-telemetry=false'])).toEqual(['status']);
        expect(stripGlobalOnlyFlags(['db', 'migrate', '--cmd', 'x'])).toEqual(['db', 'migrate', '--cmd', 'x']);
    });

    it('passes flag-like values through instead of eating them', () => {
        expect(stripGlobalOnlyFlags(['db', 'migrate', '--cmd', '--no-telemetry=x'])).toEqual(['db', 'migrate', '--cmd', '--no-telemetry=x']);
    });

    it('coerces non-array input to []', () => {
        expect(stripGlobalOnlyFlags(null)).toEqual([]);
        expect(stripGlobalOnlyFlags(undefined)).toEqual([]);
    });
});

describe('bin/cli.js dispatch contract', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const cliSource = fs.readFileSync(path.resolve(__dirname, '../bin/cli.js'), 'utf8');
    const lines = cliSource.split('\n');

    it('routes per-command parsers through stripGlobalOnlyFlags, never rawArgs', () => {
        expect(cliSource).toContain('stripGlobalOnlyFlags(rawArgs)');
        expect(cliSource).not.toMatch(/parse(?!CliArgs)\w+Args\(rawArgs/);
        expect(cliSource).not.toContain('runDb(rawArgs');
    });

    it('documents the = form for dash-leading values in global help', () => {
        expect(cliSource).toContain('--flag=value');
        expect(cliSource).toContain('--cmd=--dry-run');
    });

    it.each([
        ['Doctor', 'parseDoctorArgs'],
        ['Logs', 'parseLogsArgs'],
        ['Status', 'parseStatusArgs'],
        ['Exec', 'parseExecArgs'],
        ['Gc', 'parseGcArgs'],
        ['Mcp', 'parseMcpArgs'],
    ])('merges explicit --headless into run%s', (_name, parseFn) => {
        const line = lines.find((l) => l.includes(`${parseFn}(commandArgs)`));
        expect(line).toBeDefined();
        expect(line).toContain('isHeadless');
    });
});