import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackPromptsMockFactory, clackMocks as clack } from './helpers/clack.js';
import { telemetryMockFactory } from './helpers/telemetry.js';
import { mockConsoleTrio } from './helpers/console.js';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { parseCliArgs } from '../src/core/parser.js';
import { getProjectConfig, getTargetDirectory, sanitizeProjectName } from '../src/utils/prompts.js';
import { trackEvent } from '../src/core/telemetry.js';
import { provisionStateBucket } from '../src/utils/aws.js';
import { mainStack } from '../src/commands/init.js';

// Deep-mock the interactive prompt library. The CLI only uses
// `@clack/prompts` for interactive mode (verified: no `inquirer` or
// `commander` prompt calls exist under src/ or bin/), so mocking every
// `@clack/prompts` export is the correct automation guard. `inquirer` is
// not a dependency, so there is nothing to mock there.
vi.mock('@clack/prompts', () => clackPromptsMockFactory());

// Never touch the real environment: fake terraform presence and AWS.
vi.mock('../src/utils/system.js', () => ({
    checkDependency: vi.fn(async () => true),
}));

vi.mock('../src/utils/aws.js', () => ({
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
}));

// Silence telemetry so tests never hit the network.
vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));

function expectNoInteractivePrompts() {
    expect(clack.mockText).not.toHaveBeenCalled();
    expect(clack.mockSelect).not.toHaveBeenCalled();
    expect(clack.mockMultiselect).not.toHaveBeenCalled();
    expect(clack.mockConfirm).not.toHaveBeenCalled();
    expect(clack.mockGroup).not.toHaveBeenCalled();
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
            expect(workerTf).toContain('ignore_changes = [desired_count]');
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
        await fs.writeFile(
            path.join(tmpDir, 'package.json'),
            JSON.stringify({ scripts: { 'db:migrate': 'prisma migrate deploy' } })
        );
        const parsed = parseCliArgs([
            '--headless', '--framework=node', '--needsDatabase',
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
            expect(deployYml).toContain('db:migrate');
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

    it.each([
        ['mysql', 'engine            = "mysql"', '{ "name": "DB_PORT", "value": "3306" }'],
        ['aurora-postgresql', 'resource "aws_rds_cluster" "postgres"', '{ "name": "DB_ENGINE", "value": "aurora-postgresql" }'],
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
