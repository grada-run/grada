import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackMocks as clack } from './helpers/clack.js';
import { mockConsoleTrio } from './helpers/console.js';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { parseCliArgs } from '../src/core/parser.js';
import { getProjectConfig, getTargetDirectory, sanitizeProjectName } from '../src/utils/prompts.js';
import { trackEvent } from '../src/core/telemetry.js';
import { provisionStateBucket } from '../src/utils/aws.js';
import { mainStack, resolveOidcTrust } from '../src/commands/init.js';

// Deep-mock the interactive prompt library. The CLI only uses
// `@clack/prompts` for interactive mode (verified: no `inquirer` or
// `commander` prompt calls exist under src/ or bin/), so mocking every
// `@clack/prompts` export is the correct automation guard. `inquirer` is
// not a dependency, so there is nothing to mock there.

// Never touch the real environment: fake terraform presence and AWS.
vi.mock('../src/utils/system.js', () => ({
    checkDependency: vi.fn(async () => true),
}));

vi.mock('../src/utils/aws.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        checkAwsCredentials: vi.fn(async (region) => ({
            accountId: '123456789012',
            awsAccountId: '123456789012',
            region: region || 'us-east-1',
        })),
        provisionStateBucket: vi.fn(async () => ({
            awsAccountId: '123456789012',
            stateBucketName: 'mock-tf-state-bucket',
        })),
        teardownStateBucket: vi.fn(async () => true),
    };
});

// Silence telemetry so tests never hit the network.

function expectNoInteractivePrompts() {
    expect(clack.mockText).not.toHaveBeenCalled();
    expect(clack.mockSelect).not.toHaveBeenCalled();
    expect(clack.mockMultiselect).not.toHaveBeenCalled();
    expect(clack.mockConfirm).not.toHaveBeenCalled();
    expect(clack.mockGroup).not.toHaveBeenCalled();
}

// Shared headless-init driver: parses argv, runs mainStack in the ambient
// cwd (callers chdir to their tmp dir in beforeEach), and snapshots the
// console/exit history before the spies are restored.
async function runHeadlessInit(argv) {
    const parsed = parseCliArgs(argv);
    const spies = mockConsoleTrio();
    try {
        const result = await mainStack({
            isHeadless: parsed.isHeadless,
            isPreconfigured: parsed.isPreconfigured,
            headlessOptions: { ...parsed.headlessOptions, dir: '.' },
            initOptions: parsed.initOptions,
        });
        // Snapshot before restore: mockRestore clears call history.
        return {
            result,
            exitCalls: spies.exitSpy.mock.calls.map((call) => call[0]),
            logText: spies.logSpy.mock.calls.flat().join('\n'),
            errorText: spies.errorSpy.mock.calls.flat().join('\n'),
        };
    } finally {
        spies.restore();
    }
}

describe('Headless contract (automation-safe)', () => {
    const originalCwd = process.cwd();
    const originalArgv = [...process.argv];
    const originalDoNotTrack = process.env.DO_NOT_TRACK;
    let tmpDir;

    beforeEach(async () => {
        vi.clearAllMocks();
        process.env.DO_NOT_TRACK = '1';
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grada-headless-'));
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        process.argv = [...originalArgv];
        if (originalDoNotTrack === undefined) delete process.env.DO_NOT_TRACK;
        else process.env.DO_NOT_TRACK = originalDoNotTrack;
        if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('parses --headless with flag values for automation wrappers', () => {
        const result = parseCliArgs([
            '--headless',
            '--framework=nestjs',
            '--port=3000',
            '--region=eu-west-1',
        ]);

        expect(result.isHeadless).toBe(true);
        expect(result.headlessOptions.framework).toBe('nestjs');
        expect(result.headlessOptions.port).toBe('3000');
        expect(result.headlessOptions.region).toBe('eu-west-1');
    });

    it('resolves the target directory without prompting in headless mode', async () => {
        const config = await getTargetDirectory(true, { dir: '.' });

        expect(config.targetDir).toBe(process.cwd());
        expectNoInteractivePrompts();
    });

    it('applies flag values instead of interactive defaults in headless mode', async () => {
        const config = await getProjectConfig(
            true,
            { framework: 'nestjs', port: '3000', region: 'eu-west-1' },
            tmpDir,
            null,
        );

        expect(config.framework).toBe('nestjs');
        expect(config.port).toBe('3000');
        expect(config.region).toBe('eu-west-1');
        expect(config.setupType).toBe('headless');
        expectNoInteractivePrompts();
    });

    it('runs mainStack --headless --preconfigured end to end without hanging on prompts', async () => {
        // Simulate: npx grada-run --headless --preconfigured
        //   --framework=nestjs --port=3000 --region=eu-west-1
        // Run inside the temp dir so no Terraform files pollute the repo.
        process.chdir(tmpDir);
        process.argv = [
            process.argv[0],
            'grada',
            '--headless',
            '--preconfigured',
            '--framework=nestjs',
            '--port=3000',
            '--region=eu-west-1',
        ];

        const parsed = parseCliArgs(process.argv.slice(2));
        expect(parsed.isHeadless).toBe(true);

        const spies = mockConsoleTrio();
        const { exitSpy, logSpy, errorSpy } = spies;

        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
            });

            // Automation guarantee: no interactive prompt ever fired.
            expectNoInteractivePrompts();
            expect(exitSpy).not.toHaveBeenCalled();

            // Flag values win over interactive defaults in generated output.
            const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf-8');
            expect(mainTf).toContain('containerPort = 3000');
            expect(mainTf).toContain('region = "eu-west-1"');

            const dockerfile = await fs.readFile(path.join(tmpDir, 'Dockerfile'), 'utf-8');
            expect(dockerfile).toContain('EXPOSE 3000');
        } finally {
            spies.restore();
        }
    });

    it('tolerates null headlessOptions in headless mode', async () => {
        process.chdir(tmpDir);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy, errorSpy } = spies;

        try {
            await mainStack({ isHeadless: true, headlessOptions: null });

            expectNoInteractivePrompts();
            expect(exitSpy).not.toHaveBeenCalled();
            const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf-8');
            expect(mainTf).toContain('region = "us-east-2"');
        } finally {
            spies.restore();
        }
    });

    it('sanitizes dots, underscores, and casing without changing the target dir', async () => {
        expect(sanitizeProjectName('my.app_v2')).toBe('my-app-v2');
        expect(sanitizeProjectName('  My App__Name.. ')).toBe('my-app-name');
        expect(sanitizeProjectName('already-clean-123')).toBe('already-clean-123');
        expect(sanitizeProjectName('...')).toBe('app');
        expect(sanitizeProjectName('')).toBe('app');
        expect(sanitizeProjectName(null)).toBe('app');

        const dotted = path.join(tmpDir, 'my.app_v2');
        await fs.mkdir(dotted, { recursive: true });
        process.chdir(dotted);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const config = await getTargetDirectory(true, { dir: '.' });
            expect(config.actualProjectName).toBe('my-app-v2');
            expect(config.targetDir).toBe(process.cwd());
            expect(path.basename(config.targetDir)).toBe('my.app_v2');
        } finally {
            logSpy.mockRestore();
        }
    });

    it('writes no addon files by default even when dependencies exist', async () => {
        process.chdir(tmpDir);
        await fs.writeFile(
            path.join(tmpDir, 'package.json'),
            JSON.stringify({ dependencies: { ioredis: '^5.0.0', pg: '^8.0.0' } })
        );
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy, errorSpy } = spies;

        try {
            await mainStack({ isHeadless: true, headlessOptions: { dir: '.', framework: 'node' } });

            expectNoInteractivePrompts();
            expect(exitSpy).not.toHaveBeenCalled();
            for (const file of ['s3.tf', 'dynamodb.tf', 'redis.tf', 'sqs.tf', 'bedrock.tf', 'ses.tf']) {
                await expect(fs.stat(path.join(tmpDir, 'terraform', file))).rejects.toThrow();
            }
            expect(trackEvent).toHaveBeenCalledWith(
                'project_provisioned',
                expect.objectContaining({ selected_addons: [], detected_addons: ['db:redis'] })
            );
        } finally {
            spies.restore();
        }
    });

    it('scaffolds --with addons headless with env injection and worker lifecycle', async () => {
        process.chdir(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'Procfile'), 'web: node index.js\nworker: celery -A app worker\n');
        const parsed = parseCliArgs([
            '--headless', '--framework=node', '--with=db:redis,queue:sqs,ai:bedrock',
        ]);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy, errorSpy } = spies;

        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            expectNoInteractivePrompts();
            expect(exitSpy).not.toHaveBeenCalled();
            const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf-8');
            expect(mainTf).toContain('REDIS_URL');
            expect(mainTf).toContain('SQS_QUEUE_URL');
            expect(mainTf).toContain('BEDROCK_MODEL_ID');
            const workerTf = await fs.readFile(path.join(tmpDir, 'terraform', 'worker.tf'), 'utf-8');
            expect(workerTf).toContain('REDIS_URL');
            expect(workerTf).toMatch(/ignore_changes\s*=\s*\[task_definition,\s*desired_count\]/);
            expect(trackEvent).toHaveBeenCalledWith(
                'project_provisioned',
                expect.objectContaining({ selected_addons: ['db:redis', 'queue:sqs', 'ai:bedrock'] })
            );
        } finally {
            spies.restore();
        }
    });

    it('scaffolds email:ses headless with --domain and wires the migration gate', async () => {
        process.chdir(tmpDir);
        // Alembic on python: a non-npm command on a non-stripped runner,
        // so the stripped-runner guard lets the gate through.
        await fs.writeFile(path.join(tmpDir, 'alembic.ini'), '[alembic]\n');
        const parsed = parseCliArgs([
            '--headless', '--framework=python', '--needsDatabase',
            '--with=email:ses', '--domain=example.com', '--setup-ci-migrate',
        ]);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy, errorSpy } = spies;

        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            expectNoInteractivePrompts();
            expect(exitSpy).not.toHaveBeenCalled();
            const sesTf = await fs.readFile(path.join(tmpDir, 'terraform', 'ses.tf'), 'utf-8');
            expect(sesTf).toContain('domain = "example.com"');
            const deployYml = await fs.readFile(path.join(tmpDir, '.github', 'workflows', 'deploy.yml'), 'utf-8');
            expect(deployYml).toContain('# grada:db-migrate-start');
            expect(deployYml).toContain('alembic upgrade head');
            expect(trackEvent).toHaveBeenCalledWith(
                'project_provisioned',
                expect.objectContaining({ selected_addons: ['email:ses'], migration_gate_enabled: true })
            );
        } finally {
            spies.restore();
        }
    });

    it('scaffolds drift.yml headless with --setup-ci-drift and skips it by default', async () => {
        process.chdir(tmpDir);
        const parsed = parseCliArgs(['--headless', '--framework=node', '--setup-ci-drift']);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy, errorSpy } = spies;

        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            expectNoInteractivePrompts();
            expect(exitSpy).not.toHaveBeenCalled();
            const driftYml = await fs.readFile(path.join(tmpDir, '.github', 'workflows', 'drift.yml'), 'utf-8');
            expect(driftYml).toContain('role-to-assume: arn:aws:iam::123456789012:role/');
            expect(driftYml).toContain("cron: '0 6 * * *'");
            expect(trackEvent).toHaveBeenCalledWith(
                'project_provisioned',
                expect.objectContaining({ drift_detection_enabled: true })
            );
        } finally {
            spies.restore();
        }
    });

    it('does not scaffold drift.yml without the flag', async () => {
        process.chdir(tmpDir);
        const parsed = parseCliArgs(['--headless', '--framework=node']);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy, errorSpy } = spies;

        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            await expect(fs.stat(path.join(tmpDir, '.github', 'workflows', 'drift.yml'))).rejects.toThrow();
            expect(trackEvent).toHaveBeenCalledWith(
                'project_provisioned',
                expect.objectContaining({ drift_detection_enabled: false })
            );
        } finally {
            spies.restore();
        }
    });

    it.each([
        [['--headless', '--with=db:nope'], 'unsupported-capability', 'UNSUPPORTED_CAPABILITY'],
        [['--headless', '--with=ai:bedrock', '--model=bad model!'], 'invalid-model-id', 'INVALID_MODEL_ID'],
        [['--headless', '--with=email:ses'], 'missing-ses-domain', 'MISSING_SES_DOMAIN'],
        [['--headless', '--db-engine=sqlite'], 'invalid-db-engine', 'INVALID_DB_ENGINE'],
        [['--headless', '--target=eks'], 'invalid-compute-target', 'INVALID_COMPUTE_TARGET'],
        [['--headless', '--framework=node', '--target=static'], 'static-target-framework-mismatch', 'STATIC_TARGET_FRAMEWORK_MISMATCH'],
        [['--headless', '--framework=express'], 'invalid-framework', 'INVALID_FRAMEWORK'],
        [['--headless', '--framework=rails2'], 'invalid-framework', 'INVALID_FRAMEWORK'],
    ])('fails fast (%s) before AWS provisioning or file backup', async (argv, reason, code) => {
        process.chdir(tmpDir);
        await fs.mkdir(path.join(tmpDir, 'terraform'), { recursive: true });
        await fs.writeFile(path.join(tmpDir, 'terraform', 'keep.tf'), '# user file');
        const parsed = parseCliArgs(argv);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy, errorSpy } = spies;

        try {
            const result = await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            expect(result).toMatchObject({ ok: false, reason });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(provisionStateBucket).not.toHaveBeenCalled();
            expect(trackEvent).toHaveBeenCalledWith(
                'cli-error',
                expect.objectContaining({ step: 'init_validation', error_code: code })
            );
            // No backup was created and the existing dir is untouched.
            expect(await fs.readdir(tmpDir)).toEqual(['terraform']);
            expect(await fs.readFile(path.join(tmpDir, 'terraform', 'keep.tf'), 'utf-8')).toBe('# user file');
        } finally {
            spies.restore();
        }
    });

    it('names supported frameworks and redirects express to node', async () => {
        process.chdir(tmpDir);
        const parsed = parseCliArgs(['--headless', '--framework=express']);
        const spies = mockConsoleTrio();
        try {
            const result = await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });
            expect(result).toMatchObject({ ok: false, reason: 'invalid-framework' });
            const text = spies.logSpy.mock.calls.flat().join('\n') + spies.errorSpy.mock.calls.flat().join('\n');
            expect(text).toContain('node');
            expect(text).toContain('--framework=node');
        } finally {
            spies.restore();
        }
    });

    it('accepts every supported framework id without tripping validation', async () => {
        const { SUPPORTED_FRAMEWORKS } = await import('../src/utils/detector.js');
        expect(SUPPORTED_FRAMEWORKS.length).toBeGreaterThan(0);
        for (const framework of SUPPORTED_FRAMEWORKS) {
            process.chdir(tmpDir);
            const parsed = parseCliArgs(['--headless', `--framework=${framework}`]);
            const spies = mockConsoleTrio();
            try {
                const result = await mainStack({
                    isHeadless: parsed.isHeadless,
                    isPreconfigured: parsed.isPreconfigured,
                    headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                    initOptions: parsed.initOptions,
                });
                expect(result?.reason).not.toBe('invalid-framework');
            } finally {
                spies.restore();
            }
        }
    });

    it('mints a resource suffix on fresh trees and bakes it into names', async () => {
        process.chdir(tmpDir);
        const parsed = parseCliArgs(['--headless', '--framework=node']);
        const spies = mockConsoleTrio();
        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });
            const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf8');
            const match = mainTf.match(/grada_resource_suffix = "(-[a-f0-9]{6})"/);
            expect(match, 'expected a minted -a1b2c3 suffix in main.tf').not.toBeNull();
            // provisionStateBucket is mocked here; pin the wiring (suffixed
            // project in) and let aws.test.js pin the bucket formula.
            expect(provisionStateBucket).toHaveBeenCalledWith(
                expect.anything(),
                expect.stringMatching(/-[a-f0-9]{6}$/)
            );
            const deployYml = await fs.readFile(path.join(tmpDir, '.github', 'workflows', 'deploy.yml'), 'utf8');
            expect(deployYml).toContain(`${match[1]}-cluster`);
            expect(trackEvent).toHaveBeenCalledWith('project_provisioned', expect.objectContaining({
                resource_suffix_present: true,
            }));
        } finally {
            spies.restore();
        }
    });

    it('reuses the rendered suffix on re-init instead of minting', async () => {
        await fs.mkdir(path.join(tmpDir, 'terraform'), { recursive: true });
        await fs.writeFile(
            path.join(tmpDir, 'terraform', 'main.tf'),
            'locals {\n  grada_resource_suffix = "-b2c3d4"\n  app_name = "myapp${local.env_suffix}${local.grada_resource_suffix}"\n}\n'
        );
        process.chdir(tmpDir);
        const parsed = parseCliArgs(['--headless', '--framework=node']);
        const spies = mockConsoleTrio();
        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: { ...parsed.initOptions, force: true },
            });
            const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf8');
            expect(mainTf).toContain('grada_resource_suffix = "-b2c3d4"');
            expect(provisionStateBucket).toHaveBeenCalledWith(
                expect.anything(),
                expect.stringMatching(/-b2c3d4$/)
            );
        } finally {
            spies.restore();
        }
    });

    it('leaves pre-suffix trees unsuffixed on re-init (zero drift)', async () => {
        await fs.mkdir(path.join(tmpDir, 'terraform'), { recursive: true });
        await fs.writeFile(
            path.join(tmpDir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "myapp${local.env_suffix}"\n}\nresource "aws_ecr_repository" "app" {\n  name = "myapp-repo"\n}\n'
        );
        process.chdir(tmpDir);
        const parsed = parseCliArgs(['--headless', '--framework=node']);
        const spies = mockConsoleTrio();
        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: { ...parsed.initOptions, force: true },
            });
            const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf8');
            expect(mainTf).toContain('grada_resource_suffix = ""');
            expect(mainTf).not.toMatch(/-[a-f0-9]{6}-repo/);
            expect(trackEvent).toHaveBeenCalledWith('project_provisioned', expect.objectContaining({
                resource_suffix_present: false,
            }));
        } finally {
            spies.restore();
        }
    });

    it('re-init over a renamed directory keeps the tree project name with a loud warning', async () => {
        await fs.mkdir(path.join(tmpDir, 'terraform'), { recursive: true });
        await fs.writeFile(
            path.join(tmpDir, 'terraform', 'main.tf'),
            'locals {\n  grada_resource_suffix = "-b2c3d4"\n  app_name = "origapp${local.env_suffix}${local.grada_resource_suffix}"\n}\n'
        );
        process.chdir(tmpDir);
        const parsed = parseCliArgs(['--headless', '--framework=node']);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy } = spies;
        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: { ...parsed.initOptions, force: true },
            });
            expect(exitSpy).not.toHaveBeenCalled();
            // The tmp dir basename differs from the tree name: names must
            // follow the tree, not the directory, or apply forks the stack.
            const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf8');
            expect(mainTf).toContain('app_name = "origapp${local.env_suffix}${local.grada_resource_suffix}"');
            expect(mainTf).toContain('origapp-b2c3d4-repo');
            const logged = logSpy.mock.calls.flat().join('\n');
            expect(logged).toContain('keeping "origapp"');
            expect(logged).toContain('--project-name');
            expect(trackEvent).toHaveBeenCalledWith(
                'init_project_name_reused',
                expect.objectContaining({ projectName: 'origapp' })
            );
        } finally {
            spies.restore();
        }
    });

    it('--project-name explicitly renames on re-init with a fork warning', async () => {
        await fs.mkdir(path.join(tmpDir, 'terraform'), { recursive: true });
        await fs.writeFile(
            path.join(tmpDir, 'terraform', 'main.tf'),
            'locals {\n  grada_resource_suffix = "-b2c3d4"\n  app_name = "origapp${local.env_suffix}${local.grada_resource_suffix}"\n}\n'
        );
        process.chdir(tmpDir);
        const parsed = parseCliArgs(['--headless', '--framework=node', '--project-name=newname', '--force']);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy } = spies;
        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });
            expect(exitSpy).not.toHaveBeenCalled();
            const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf8');
            expect(mainTf).toContain('app_name = "newname${local.env_suffix}${local.grada_resource_suffix}"');
            const logged = logSpy.mock.calls.flat().join('\n');
            expect(logged).toContain('--project-name "newname" overrides');
            expect(logged).toContain('"origapp"');
            expect(trackEvent).toHaveBeenCalledWith(
                'init_project_name_override',
                expect.objectContaining({ projectName: 'newname' })
            );
        } finally {
            spies.restore();
        }
    });

    it('getTargetDirectory honors an explicit project name override', async () => {
        process.chdir(tmpDir);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const config = await getTargetDirectory(true, { dir: '.' }, { projectName: 'Custom_Name' });
            expect(config.actualProjectName).toBe('custom-name');
            expect(config.targetDir).toBe(process.cwd());
        } finally {
            logSpy.mockRestore();
        }
    });

    it.each([
        ['mysql', 'engine            = "mysql"', '{ "name" : "DB_PORT", "value" : "3306" }'],
        ['aurora-postgresql', 'resource "aws_rds_cluster" "postgres"', '{ "name" : "DB_ENGINE", "value" : "aurora-postgresql" }'],
    ])('scaffolds --db-engine=%s headless with engine-specific wiring', async (engine, dbMarker, envMarker) => {
        process.chdir(tmpDir);
        const parsed = parseCliArgs([
            '--headless', '--framework=node', '--needsDatabase', `--db-engine=${engine}`,
        ]);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy, errorSpy } = spies;

        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            expectNoInteractivePrompts();
            expect(exitSpy).not.toHaveBeenCalled();
            const databaseTf = await fs.readFile(path.join(tmpDir, 'terraform', 'database.tf'), 'utf-8');
            expect(databaseTf).toContain(dbMarker);
            const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf-8');
            expect(mainTf).toContain(envMarker);
            expect(trackEvent).toHaveBeenCalledWith(
                'project_provisioned',
                expect.objectContaining({ has_database: true, db_engine: engine })
            );
        } finally {
            spies.restore();
        }
    });

    it('skips the compose merge for datastore-only files instead of baking in port 5432', async () => {
        process.chdir(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'compose.yml'), [
            'services:',
            '  postgres:',
            '    image: postgres:16',
            '    ports: ["5432:5432"]',
            '    environment:',
            '      POSTGRES_USER: app',
            '      POSTGRES_PASSWORD: s3cret',
            '  valkey:',
            '    image: valkey/valkey:8',
            '    ports: ["6379:6379"]',
            '',
        ].join('\n'));
        const parsed = parseCliArgs(['--headless', '--framework=nextjs']);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy } = spies;

        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            expect(exitSpy).not.toHaveBeenCalled();
            const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf-8');
            expect(mainTf).toContain('containerPort = 3000');
            expect(mainTf).not.toContain('5432');
            expect(mainTf).not.toContain('POSTGRES_USER');
            expect(mainTf).not.toContain('s3cret');
            expect(logSpy.mock.calls.flat().join('\n')).toContain('No app service detected');
            expect(trackEvent).toHaveBeenCalledWith(
                'compose_merge_skipped',
                expect.objectContaining({ reason: 'all-datastores' })
            );
        } finally {
            spies.restore();
        }
    });

    it('headless --setup-ci-migrate refuses detected npm-shim commands on stripped runners', async () => {
        process.chdir(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { drizzle: '1.0.0' } }));
        await fs.writeFile(path.join(tmpDir, 'drizzle.config.ts'), 'export default {};');
        const parsed = parseCliArgs(['--headless', '--framework=nextjs', '--needsDatabase', '--setup-ci-migrate']);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy } = spies;

        try {
            const result = await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            expect(result).toMatchObject({ ok: false, reason: 'npm-cmd-stripped-runner' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(provisionStateBucket).not.toHaveBeenCalled();
            expect(logSpy.mock.calls.flat().join('\n')).toContain('node ./');
        } finally {
            spies.restore();
        }
    });

    it('headless --setup-ci-migrate=<cmd> wires the explicit node command past the stripped-runner guard', async () => {
        process.chdir(tmpDir);
        // npm-detecting fixture on a stripped runner (the CI validate-addons
        // shape): detection alone would refuse, but the explicit node
        // command wins and wires the gate.
        await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { 'db:migrate': 'prisma migrate deploy' } }));
        const parsed = parseCliArgs(['--headless', '--framework=nestjs', '--needsDatabase', '--setup-ci-migrate=node ./dist/migrate.cjs']);
        const spies = mockConsoleTrio();
        const { exitSpy } = spies;

        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            expectNoInteractivePrompts();
            expect(exitSpy).not.toHaveBeenCalled();
            const deployYml = await fs.readFile(path.join(tmpDir, '.github', 'workflows', 'deploy.yml'), 'utf-8');
            expect(deployYml).toContain('# grada:db-migrate-start');
            expect(deployYml).toContain('node ./dist/migrate.cjs');
            expect(deployYml).not.toContain('npm run db:migrate');
            expect(trackEvent).toHaveBeenCalledWith(
                'project_provisioned',
                expect.objectContaining({ migration_gate_enabled: true })
            );
        } finally {
            spies.restore();
        }
    });

    it('headless init wires the migration gate into preview.yml too', async () => {
        process.chdir(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'alembic.ini'), '[alembic]\n');
        const parsed = parseCliArgs(['--headless', '--framework=python', '--needsDatabase', '--setup-ci-migrate', '--enablePrPreviews']);
        const spies = mockConsoleTrio();
        const { exitSpy } = spies;

        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            expectNoInteractivePrompts();
            expect(exitSpy).not.toHaveBeenCalled();
            const previewYml = await fs.readFile(path.join(tmpDir, '.github', 'workflows', 'preview.yml'), 'utf-8');
            expect(previewYml).toContain('# grada:db-migrate-start');
            expect(previewYml).toContain('--workspace "${{ env.WORKSPACE }}"');
            expect(previewYml.indexOf('# grada:db-migrate-end')).toBeLessThan(previewYml.indexOf('- name: Comment PR'));
        } finally {
            spies.restore();
        }
    });

    it('headless --setup-ci-migrate=<npm cmd> still refuses on stripped runners', async () => {
        process.chdir(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { 'db:migrate': 'prisma migrate deploy' } }));
        const parsed = parseCliArgs(['--headless', '--framework=nestjs', '--needsDatabase', '--setup-ci-migrate=npm run db:migrate']);
        const spies = mockConsoleTrio();
        const { exitSpy } = spies;

        try {
            const result = await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            expect(result).toMatchObject({ ok: false, reason: 'npm-cmd-stripped-runner' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(provisionStateBucket).not.toHaveBeenCalled();
        } finally {
            spies.restore();
        }
    });

    it('--offline scaffolds without AWS calls and prints the reconciliation checklist', async () => {
        process.chdir(tmpDir);
        const parsed = parseCliArgs(['--headless', '--framework=nextjs', '--offline']);
        expect(parsed.initOptions.offline).toBe(true);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy } = spies;

        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            expect(exitSpy).not.toHaveBeenCalled();
            expect(provisionStateBucket).not.toHaveBeenCalled();
            const backendTf = await fs.readFile(path.join(tmpDir, 'terraform', 'backend.tf'), 'utf-8');
            expect(backendTf).toContain('YOUR_AWS_ACCOUNT_ID');
            const logged = logSpy.mock.calls.flat().join('\n');
            expect(logged).toContain('Offline scaffold');
            expect(logged).toContain('YOUR_AWS_ACCOUNT_ID');
            expect(logged).toContain('create-bucket');
            expect(trackEvent).toHaveBeenCalledWith(
                'init_offline_scaffold',
                expect.objectContaining({ projectName: expect.any(String) })
            );
        } finally {
            spies.restore();
        }
    });

    it('compose secrets are filtered with telemetry instead of inlined', async () => {
        process.chdir(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'compose.yml'), [
            'services:',
            '  web:',
            '    build: .',
            '    ports: ["3000:3000"]',
            '    environment:',
            '      APP_KEY: yes',
            '      POSTGRES_PASSWORD: s3cret',
            '',
        ].join('\n'));
        const parsed = parseCliArgs(['--headless', '--framework=nextjs']);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy } = spies;

        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            expect(exitSpy).not.toHaveBeenCalled();
            const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf-8');
            expect(mainTf).toContain('APP_KEY');
            expect(mainTf).not.toContain('s3cret');
            expect(logSpy.mock.calls.flat().join('\n')).toContain('POSTGRES_PASSWORD');
            expect(trackEvent).toHaveBeenCalledWith(
                'compose_secrets_filtered',
                expect.objectContaining({ count: 1, names: ['POSTGRES_PASSWORD'] })
            );
        } finally {
            spies.restore();
        }
    });

    it('--offline composes with database, addons, migrate gate, drift, and previews', async () => {
        process.chdir(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'alembic.ini'), '[alembic]\n');
        const parsed = parseCliArgs([
            '--headless', '--framework=python', '--needsDatabase',
            '--with=db:redis,queue:sqs', '--setup-ci-migrate', '--setup-ci-drift',
            '--enablePrPreviews', '--offline',
        ]);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy } = spies;

        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            expect(exitSpy).not.toHaveBeenCalled();
            expect(provisionStateBucket).not.toHaveBeenCalled();
            const backendTf = await fs.readFile(path.join(tmpDir, 'terraform', 'backend.tf'), 'utf-8');
            expect(backendTf).toContain('YOUR_AWS_ACCOUNT_ID');
            // The checklist must name the exact backend bucket (suffix and
            // placeholder included) — recomputing from the bare project
            // name sends users to create a bucket terraform never uses.
            const backendBucket = backendTf.match(/bucket\s*=\s*"([^"]+)"/)[1];
            expect(backendBucket).toContain('-tfstate-YOUR_AWS_ACCOUNT_ID');
            const loggedEarly = logSpy.mock.calls.flat().join('\n');
            expect(loggedEarly).toContain(`create-bucket --bucket ${backendBucket} --region`);
            expect(loggedEarly).not.toContain('<aws-account-id>');
            for (const workflow of ['deploy.yml', 'drift.yml', 'preview.yml', 'teardown.yml']) {
                const content = await fs.readFile(path.join(tmpDir, '.github', 'workflows', workflow), 'utf-8');
                expect(content).toContain('YOUR_AWS_ACCOUNT_ID');
            }
            const deployYml = await fs.readFile(path.join(tmpDir, '.github', 'workflows', 'deploy.yml'), 'utf-8');
            expect(deployYml).toContain('# grada:db-migrate-start');
            expect(deployYml).toContain('alembic upgrade head');
            expect(await fs.stat(path.join(tmpDir, 'terraform', 'redis.tf'))).toBeTruthy();
            const logged = logSpy.mock.calls.flat().join('\n');
            expect(logged).toContain('put-bucket-tagging');
            expect(logged).toContain('role-to-assume');
        } finally {
            spies.restore();
        }
    });

    it('offline checklist omits LocationConstraint in us-east-1', async () => {
        const { printOfflineChecklist } = await import('../src/commands/init.js');
        const spies = mockConsoleTrio();
        try {
            printOfflineChecklist({ bucket: 'demo-a1b2c3-tfstate-YOUR_AWS_ACCOUNT_ID', region: 'us-east-1' });
            const logged = spies.logSpy.mock.calls.flat().join('\n');
            expect(logged).toContain('create-bucket --bucket demo-a1b2c3-tfstate-YOUR_AWS_ACCOUNT_ID --region us-east-1');
            expect(logged).not.toContain('LocationConstraint');
            expect(logged).toContain('put-bucket-tagging');
            expect(logged).toContain('put-bucket-versioning');
        } finally {
            spies.restore();
        }
    });

    it('datastore selected as web warns loudly instead of silently', async () => {
        process.chdir(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'compose.yml'), [
            'services:',
            '  postgres:',
            '    build: .',
            '    image: postgres:16',
            '    ports: ["5432:5432"]',
            '',
        ].join('\n'));
        const parsed = parseCliArgs(['--headless', '--framework=nextjs']);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy } = spies;

        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });

            expect(exitSpy).not.toHaveBeenCalled();
            expect(logSpy.mock.calls.flat().join('\n')).toContain('looks like a datastore');
            expect(trackEvent).toHaveBeenCalledWith(
                'compose_datastore_web_warned',
                expect.objectContaining({ service: 'postgres' })
            );
        } finally {
            spies.restore();
        }
    });
});

describe('Headless: --target lambda', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grada-headless-lambda-'));
        process.chdir(tmpDir);
    });

    afterEach(async () => {
        process.chdir(path.dirname(tmpDir));
        if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    });

    async function runHeadlessLambda(argv) {
        const parsed = parseCliArgs(argv);
        const spies = mockConsoleTrio();
        const { exitSpy, logSpy, errorSpy } = spies;
        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                isPreconfigured: parsed.isPreconfigured,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
                initOptions: parsed.initOptions,
            });
            return { exitSpy };
        } finally {
            spies.restore();
        }
    }

    it('scaffolds the serverless stack headless with lambda telemetry', async () => {
        const { exitSpy } = await runHeadlessLambda(['--headless', '--framework=node', '--target=lambda']);
        expect(exitSpy).not.toHaveBeenCalled();

        const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('resource "aws_lambda_function" "app"');
        expect(mainTf).not.toContain('aws_ecs_service');

        const dockerfile = await fs.readFile(path.join(tmpDir, 'Dockerfile'), 'utf-8');
        expect(dockerfile).toContain('aws-lambda-adapter');

        expect(trackEvent).toHaveBeenCalledWith(
            'project_provisioned',
            expect.objectContaining({ target: 'lambda' })
        );
    });

    it('accepts --target fargate as an ECS synonym', async () => {
        const { exitSpy } = await runHeadlessLambda(['--headless', '--framework=node', '--target=fargate']);
        expect(exitSpy).not.toHaveBeenCalled();
        const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('resource "aws_ecs_service" "app"');
        expect(trackEvent).toHaveBeenCalledWith(
            'project_provisioned',
            expect.objectContaining({ target: 'ecs' })
        );
    });

    it('defaults to ECS when --target is absent', async () => {
        await runHeadlessLambda(['--headless', '--framework=node']);
        const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('resource "aws_ecs_service" "app"');
    });

    it('scaffolds the static stack headless with zero baseline telemetry', async () => {
        const { exitSpy } = await runHeadlessLambda(['--headless', '--framework=static', '--target=static']);
        expect(exitSpy).not.toHaveBeenCalled();

        const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('resource "aws_cloudfront_distribution" "site"');
        expect(mainTf).not.toContain('aws_ecs_service');
        expect(mainTf).not.toContain('aws_lambda_function');

        await expect(fs.stat(path.join(tmpDir, 'Dockerfile'))).rejects.toThrow();
        const deployYml = await fs.readFile(path.join(tmpDir, '.github', 'workflows', 'deploy.yml'), 'utf-8');
        expect(deployYml).toContain('aws s3 sync');

        expect(trackEvent).toHaveBeenCalledWith(
            'project_provisioned',
            expect.objectContaining({ target: 'static' })
        );
    });

    it('warns about connection bursts for lambda with a database', async () => {
        vi.clearAllMocks();
        await runHeadlessLambda(['--headless', '--framework=node', '--target=lambda', '--needsDatabase']);
        expect(clack.mockLogWarn).toHaveBeenCalledWith(expect.stringContaining('connection per concurrent execution'));
    });

    it('stays quiet without the lambda-plus-database combination', async () => {
        vi.clearAllMocks();
        await runHeadlessLambda(['--headless', '--framework=node', '--target=lambda']);
        await runHeadlessLambda(['--headless', '--framework=node', '--target=ecs', '--needsDatabase']);
        for (const [message] of clack.mockLogWarn.mock.calls) {
            expect(String(message)).not.toContain('connection per concurrent execution');
        }
    });
});

describe('Headless: state adoption gate', () => {
    let tmpDir;

    beforeEach(async () => {
        vi.clearAllMocks();
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grada-headless-adopt-'));
        process.chdir(tmpDir);
    });

    afterEach(async () => {
        process.chdir(path.dirname(tmpDir));
        if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    });

    function keyPresentClient() {
        return { send: vi.fn(async () => ({})) };
    }

    function keyAbsentClient() {
        return {
            send: vi.fn(async () => {
                throw Object.assign(new Error('Not Found'), { name: 'NotFound' });
            }),
        };
    }

    function mockProvisionedBucket(s3Client) {
        provisionStateBucket.mockResolvedValueOnce({
            awsAccountId: '123456789012',
            stateBucketName: 'mock-tf-state-bucket',
            s3Client,
        });
    }

    it('refuses with STATE_ALREADY_EXISTS when remote state already exists', async () => {
        mockProvisionedBucket(keyPresentClient());
        const { result, exitCalls, errorText } = await runHeadlessInit(['--headless', '--framework=node']);

        expect(result).toMatchObject({ ok: false, reason: 'state-already-exists' });
        expect(exitCalls).toEqual([1]);
        expect(errorText).toContain('--adopt-state');
        expect(trackEvent).toHaveBeenCalledWith(
            'cli-error',
            expect.objectContaining({ step: 'state_adoption', error_code: 'STATE_ALREADY_EXISTS' })
        );
        expectNoInteractivePrompts();
        expect(clack.mockSpinnerStop).not.toHaveBeenCalledWith('State bucket ready.');
        await expect(fs.stat(path.join(tmpDir, 'terraform'))).rejects.toThrow();
    });

    it('--adopt-state proceeds over existing state without probing', async () => {
        const s3Client = keyPresentClient();
        mockProvisionedBucket(s3Client);
        const { exitCalls } = await runHeadlessInit(['--headless', '--framework=node', '--adopt-state']);

        expect(exitCalls).toEqual([]);
        expect(s3Client.send).not.toHaveBeenCalled();
        await expect(fs.stat(path.join(tmpDir, 'terraform', 'main.tf'))).resolves.toBeTruthy();
    });

    it('proceeds when the state key is absent', async () => {
        mockProvisionedBucket(keyAbsentClient());
        const { exitCalls } = await runHeadlessInit(['--headless', '--framework=node']);

        expect(exitCalls).toEqual([]);
        await expect(fs.stat(path.join(tmpDir, 'terraform', 'main.tf'))).resolves.toBeTruthy();
    });
});

describe('Headless: OIDC trust scoping', () => {
    let tmpDir;

    let hasGit = true;
    try {
        execSync('git --version', { stdio: 'pipe' });
    } catch {
        hasGit = false;
    }

    beforeEach(async () => {
        vi.clearAllMocks();
        process.env.DO_NOT_TRACK = '1';
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grada-headless-oidc-'));
        process.chdir(tmpDir);
    });

    afterEach(async () => {
        process.chdir(path.dirname(tmpDir));
        if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    });

    async function renderedTrust() {
        const oidc = await fs.readFile(path.join(tmpDir, 'terraform', 'oidc.tf'), 'utf-8');
        return oidc.match(/"token\.actions\.githubusercontent\.com:sub"\s*:\s*"([^"]+)"/)[1];
    }

    function trustTelemetry() {
        return trackEvent.mock.calls.filter(([name]) => name === 'init_oidc_trust');
    }

    it('fails fast on an invalid --github-repo before provisioning', async () => {
        const { result, exitCalls } = await runHeadlessInit(['--headless', '--framework=node', '--github-repo=not-a-slug']);

        expect(result).toMatchObject({ ok: false, reason: 'invalid-github-repo' });
        expect(exitCalls).toEqual([1]);
        expect(provisionStateBucket).not.toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith(
            'cli-error',
            expect.objectContaining({ step: 'init_validation', error_code: 'INVALID_GITHUB_REPO' })
        );
    });

    it('renders scoped trust from --github-repo without prompting', async () => {
        const { exitCalls } = await runHeadlessInit(['--headless', '--framework=node', '--github-repo=acme/widgets']);

        expect(exitCalls).toEqual([]);
        expectNoInteractivePrompts();
        expect(await renderedTrust()).toBe('repo:acme/widgets:*');
        const calls = trustTelemetry();
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toMatchObject({ mode: 'scoped', source: 'flag' });
        expect(JSON.stringify(calls[0][1])).not.toContain('acme/widgets');
    });

    it('falls back to repo:* with a loud warning when nothing identifies the repo', async () => {
        const { exitCalls, logText } = await runHeadlessInit(['--headless', '--framework=node']);

        expect(exitCalls).toEqual([]);
        expect(await renderedTrust()).toBe('repo:*');
        expect(logText).toContain('repo:*');
        expect(logText).toContain('--github-repo');
        const calls = trustTelemetry();
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toMatchObject({ mode: 'fallback', source: 'fallback' });
    });

    it.skipIf(!hasGit)('derives scoped trust from the git remote', async () => {
        execSync('git init -q && git remote add origin git@github.com:acme/widgets.git', { cwd: tmpDir, stdio: 'pipe' });
        const { exitCalls } = await runHeadlessInit(['--headless', '--framework=node']);

        expect(exitCalls).toEqual([]);
        expect(await renderedTrust()).toBe('repo:acme/widgets:*');
        expect(trustTelemetry()[0][1]).toMatchObject({ mode: 'scoped', source: 'remote' });
    });

    it('--github-repo wins over the git remote', async () => {
        if (!hasGit) return;
        execSync('git init -q && git remote add origin git@github.com:acme/other.git', { cwd: tmpDir, stdio: 'pipe' });
        await runHeadlessInit(['--headless', '--framework=node', '--github-repo=acme/widgets']);

        expect(await renderedTrust()).toBe('repo:acme/widgets:*');
        expect(trustTelemetry()[0][1]).toMatchObject({ mode: 'scoped', source: 'flag' });
    });

    it('re-init preserves the tree trust instead of re-deriving it', async () => {
        await runHeadlessInit(['--headless', '--framework=node', '--github-repo=acme/widgets']);
        vi.clearAllMocks();
        const { exitCalls, logText } = await runHeadlessInit(['--headless', '--framework=node']);

        expect(exitCalls).toEqual([]);
        expect(await renderedTrust()).toBe('repo:acme/widgets:*');
        expect(logText).not.toContain('repo:*');
        expect(trustTelemetry()[0][1]).toMatchObject({ mode: 'scoped', source: 'tree' });
    });

    it('re-init keeps an open tree trust verbatim and warns', async () => {
        await runHeadlessInit(['--headless', '--framework=node']);
        vi.clearAllMocks();
        const { logText } = await runHeadlessInit(['--headless', '--framework=node']);

        expect(await renderedTrust()).toBe('repo:*');
        expect(logText).toContain('repo:*');
    });

    async function handEditTrust(subValue) {
        const oidcPath = path.join(tmpDir, 'terraform', 'oidc.tf');
        const oidc = await fs.readFile(oidcPath, 'utf-8');
        await fs.writeFile(
            oidcPath,
            oidc.replace(
                /"token\.actions\.githubusercontent\.com:sub"\s*:\s*"[^"]*"/,
                `"token.actions.githubusercontent.com:sub" : ${subValue}`
            )
        );
    }

    it('refuses headless widening of a multi-entry list trust', async () => {
        await runHeadlessInit(['--headless', '--framework=node']);
        await handEditTrust('["repo:acme/a:*", "repo:acme/b:*"]');
        vi.clearAllMocks();
        const { result, exitCalls } = await runHeadlessInit(['--headless', '--framework=node', '--force']);

        expect(result).toMatchObject({ ok: false, reason: 'oidc-trust-widening-refused' });
        expect(exitCalls).toEqual([1]);
        expect(trackEvent).toHaveBeenCalledWith(
            'cli-error',
            expect.objectContaining({ step: 'init_oidc_trust', error_code: 'OIDC_TRUST_WIDENING_REFUSED' })
        );
        // Refusal precedes backup/regeneration: the hand edit is untouched.
        const oidc = await fs.readFile(path.join(tmpDir, 'terraform', 'oidc.tf'), 'utf-8');
        expect(oidc).toContain('"repo:acme/a:*", "repo:acme/b:*"');
        expect(provisionStateBucket).not.toHaveBeenCalled();
    });

    it('--github-repo proceeds over a multi-entry list, warning about dropped entries', async () => {
        await runHeadlessInit(['--headless', '--framework=node']);
        await handEditTrust('["repo:acme/a:*", "repo:acme/b:*"]');
        vi.clearAllMocks();
        const { exitCalls, logText } = await runHeadlessInit(['--headless', '--framework=node', '--force', '--github-repo=acme/c']);

        expect(exitCalls).toEqual([]);
        expect(await renderedTrust()).toBe('repo:acme/c:*');
        expect(logText).toContain('repo:acme/a:*');
        expect(logText).toContain('repo:acme/b:*');
    });

    it('unwraps single-entry lists silently on re-init', async () => {
        await runHeadlessInit(['--headless', '--framework=node']);
        await handEditTrust('["repo:acme/widgets:*"]');
        vi.clearAllMocks();
        const { exitCalls, logText } = await runHeadlessInit(['--headless', '--framework=node', '--force']);

        expect(exitCalls).toEqual([]);
        expect(await renderedTrust()).toBe('repo:acme/widgets:*');
        expect(logText).not.toContain('repo:*');
        expect(trustTelemetry()[0][1]).toMatchObject({ mode: 'scoped', source: 'tree' });
    });

    it('refuses headless widening of non-literal trusts', async () => {
        await runHeadlessInit(['--headless', '--framework=node']);
        await handEditTrust('var.allowed_repos');
        vi.clearAllMocks();
        const { result, exitCalls } = await runHeadlessInit(['--headless', '--framework=node', '--force']);

        expect(result).toMatchObject({ ok: false, reason: 'oidc-trust-widening-refused' });
        expect(exitCalls).toEqual([1]);
    });
});

describe('resolveOidcTrust', () => {
    let logged;
    const base = { targetDir: '/tmp/oidc-test', log: (...args) => { logged.push(args.join(' ')); } };

    beforeEach(() => {
        logged = [];
    });

    it('flag wins over a scoped tree string, warning about the override', async () => {
        const result = await resolveOidcTrust({
            ...base,
            explicitSlug: 'acme/c',
            treeClaim: { kind: 'string', value: 'repo:acme/a:*' },
        });
        expect(result).toEqual({ sub: 'repo:acme/c:*', source: 'flag' });
        expect(logged.join('\n')).toContain('repo:acme/a:*');
    });

    it('flag matching the tree stays silent', async () => {
        const result = await resolveOidcTrust({
            ...base,
            explicitSlug: 'acme/a',
            treeClaim: { kind: 'string', value: 'repo:acme/a:*' },
        });
        expect(result).toEqual({ sub: 'repo:acme/a:*', source: 'flag' });
        expect(logged).toEqual([]);
    });

    it('flag over a multi-entry list warns naming the dropped entries', async () => {
        const result = await resolveOidcTrust({
            ...base,
            explicitSlug: 'acme/c',
            treeClaim: { kind: 'list', entries: ['repo:acme/a:*', 'repo:acme/b:*'] },
        });
        expect(result).toEqual({ sub: 'repo:acme/c:*', source: 'flag' });
        const text = logged.join('\n');
        expect(text).toContain('repo:acme/a:*');
        expect(text).toContain('repo:acme/b:*');
    });

    it('flag over a non-literal claim warns', async () => {
        const result = await resolveOidcTrust({
            ...base,
            explicitSlug: 'acme/c',
            treeClaim: { kind: 'unparseable' },
        });
        expect(result).toEqual({ sub: 'repo:acme/c:*', source: 'flag' });
        expect(logged.join('\n')).toMatch(/non-literal/);
    });

    it('keeps scoped tree strings silently', async () => {
        const result = await resolveOidcTrust({
            ...base,
            treeClaim: { kind: 'string', value: 'repo:acme/a:*' },
        });
        expect(result).toEqual({ sub: 'repo:acme/a:*', source: 'tree' });
        expect(logged).toEqual([]);
    });

    it('keeps open tree strings with a warning', async () => {
        const result = await resolveOidcTrust({
            ...base,
            treeClaim: { kind: 'string', value: 'repo:*' },
        });
        expect(result).toEqual({ sub: 'repo:*', source: 'tree' });
        expect(logged.join('\n')).toContain('repo:*');
    });

    it('unwraps single-entry lists like their bare string', async () => {
        const scoped = await resolveOidcTrust({
            ...base,
            treeClaim: { kind: 'list', entries: ['repo:acme/a:*'] },
        });
        expect(scoped).toEqual({ sub: 'repo:acme/a:*', source: 'tree' });
        expect(logged).toEqual([]);
        const open = await resolveOidcTrust({
            ...base,
            treeClaim: { kind: 'list', entries: ['repo:*'] },
        });
        expect(open).toEqual({ sub: 'repo:*', source: 'tree' });
        expect(logged.join('\n')).toContain('repo:*');
    });

    it('derives from the remote, warning when replacing a complex claim', async () => {
        const result = await resolveOidcTrust({
            ...base,
            treeClaim: { kind: 'list', entries: ['repo:acme/a:*', 'repo:acme/b:*'] },
            readRemote: () => 'acme/c',
        });
        expect(result).toEqual({ sub: 'repo:acme/c:*', source: 'remote' });
        expect(logged.join('\n')).toContain('repo:acme/a:*');
    });

    it('prompts interactively and proceeds scoped with a warning', async () => {
        const result = await resolveOidcTrust({
            ...base,
            isInteractive: true,
            treeClaim: { kind: 'unparseable' },
            readRemote: () => null,
            promptRepo: async () => 'acme/c',
        });
        expect(result).toEqual({ sub: 'repo:acme/c:*', source: 'prompt' });
        expect(logged.join('\n')).toMatch(/non-literal/);
    });

    it('falls back with a warning when nothing identifies the repo', async () => {
        const result = await resolveOidcTrust({ ...base, readRemote: () => null });
        expect(result).toEqual({ sub: 'repo:*', source: 'fallback' });
        const text = logged.join('\n');
        expect(text).toContain('repo:*');
        expect(text).toContain('--github-repo');
    });

    it('refuses headless widening of multi-entry lists', async () => {
        const result = await resolveOidcTrust({
            ...base,
            treeClaim: { kind: 'list', entries: ['repo:acme/a:*', 'repo:acme/b:*'] },
            readRemote: () => null,
        });
        expect(result.refusal).toMatchObject({
            errorCode: 'OIDC_TRUST_WIDENING_REFUSED',
            reason: 'oidc-trust-widening-refused',
        });
        expect(result.refusal.hint).toContain('--github-repo');
    });

    it('refuses headless widening of non-literal claims', async () => {
        const result = await resolveOidcTrust({
            ...base,
            treeClaim: { kind: 'unparseable' },
            readRemote: () => null,
        });
        expect(result.refusal).toMatchObject({ reason: 'oidc-trust-widening-refused' });
    });

    it('confirms interactively before widening on a skipped prompt', async () => {
        let confirmedMessage = '';
        const result = await resolveOidcTrust({
            ...base,
            isInteractive: true,
            treeClaim: { kind: 'list', entries: ['repo:acme/a:*', 'repo:acme/b:*'] },
            readRemote: () => null,
            promptRepo: async () => null,
            confirmWiden: async (message) => { confirmedMessage = message; return true; },
        });
        expect(result).toEqual({ sub: 'repo:*', source: 'fallback' });
        expect(confirmedMessage).toContain('repo:acme/a:*');
    });

    it('cancels when the widening confirm is declined', async () => {
        const result = await resolveOidcTrust({
            ...base,
            isInteractive: true,
            treeClaim: { kind: 'unparseable' },
            readRemote: () => null,
            promptRepo: async () => null,
            confirmWiden: async () => false,
        });
        expect(result).toEqual({ cancelled: true });
    });
});
