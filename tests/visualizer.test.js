import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackPromptsMockFactory, mockNote } from './helpers/clack.js';
import { telemetryMockFactory } from './helpers/telemetry.js';
import { createTmpDirTracker } from './helpers/tmpdir.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    parseTerraformConfig,
    estimateMonthlyCost,
    renderDryRunPreview,
    syncDocCostEstimate,
    buildCostTelemetryProps,
    buildBaselineLine,
    COST_ESTIMATE_MARKER,
} from '../src/utils/visualizer.js';
import { ADDON_REGISTRY } from '../src/utils/addons.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';
import { confirm } from '@clack/prompts';

vi.mock('@clack/prompts', () => clackPromptsMockFactory());

vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));

const tmp = createTmpDirTracker();

function makeTmp() {
    return tmp.makeTmp('visualizer-test-');
}

function writeTf(dir, files = {}) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, 'terraform', name), content);
    }
}

const MAIN_TF_MICRO = [
    'resource "aws_ecs_task_definition" "app" {',
    '  cpu                      = "256"',
    '  memory                   = "512"',
    '}',
    '',
].join('\n');

const MAIN_TF_SMALL = [
    'resource "aws_ecs_task_definition" "app" {',
    '  cpu                      = "512"',
    '  memory                   = "1024"',
    '}',
    '',
].join('\n');

// picocolors wraps words in ANSI escapes; strip them before asserting text.
function stripAnsi(text) {
    return String(text).replace(/\[[0-9;]*m/g, '');
}

beforeEach(() => {
    tmp.reset();
    vi.clearAllMocks();
});

afterEach(() => {
    tmp.cleanup();
});

describe('parseTerraformConfig', () => {
    it('extracts rendered cpu and memory from main.tf', () => {
        const dir = makeTmp();
        writeTf(dir, { 'main.tf': MAIN_TF_SMALL });
        const config = parseTerraformConfig(path.join(dir, 'terraform'));
        expect(config.cpu).toBe(512);
        expect(config.memory).toBe(1024);
    });

    it('lets terraform.tfvars override rendered values', () => {
        const dir = makeTmp();
        writeTf(dir, {
            'main.tf': MAIN_TF_SMALL,
            'terraform.tfvars': 'container_cpu = 1024\ncontainer_memory = 2048\n',
        });
        const config = parseTerraformConfig(path.join(dir, 'terraform'));
        expect(config.cpu).toBe(1024);
        expect(config.memory).toBe(2048);
    });

    it('falls back to micro defaults when neither source specifies sizes', () => {
        const dir = makeTmp();
        writeTf(dir, { 'main.tf': 'provider "aws" {}\n' });
        const config = parseTerraformConfig(path.join(dir, 'terraform'));
        expect(config.cpu).toBe(256);
        expect(config.memory).toBe(512);
    });

    it('detects secrets.tf existence and registry addons', () => {
        const dir = makeTmp();
        writeTf(dir, { 'main.tf': MAIN_TF_MICRO, 'secrets.tf': '# secrets\n', 's3.tf': '# s3\n', 'dynamodb.tf': '# dynamodb\n' });
        const config = parseTerraformConfig(path.join(dir, 'terraform'));
        expect(config.hasSecrets).toBe(true);
        expect(config.addons).toEqual(['storage:s3', 'db:dynamodb']);
    });

    it('reports hasSecrets false and empty addons when files are absent', () => {
        const dir = makeTmp();
        writeTf(dir, { 'main.tf': MAIN_TF_MICRO });
        const config = parseTerraformConfig(path.join(dir, 'terraform'));
        expect(config.hasSecrets).toBe(false);
        expect(config.addons).toEqual([]);
    });

    it.each([
        ['postgres instance', 'resource "aws_db_instance" "postgres" {\n  engine = "postgres"\n}\n', 'postgres'],
        ['mysql instance', 'resource "aws_db_instance" "postgres" {\n  engine = "mysql"\n}\n', 'mysql'],
        ['aurora cluster', 'resource "aws_rds_cluster" "postgres" {\n  engine = "aurora-postgresql"\n}\n', 'aurora-postgresql'],
    ])('detects dbEngine for %s', (_, databaseTf, expected) => {
        const dir = makeTmp();
        writeTf(dir, { 'main.tf': MAIN_TF_MICRO, 'database.tf': databaseTf });
        const config = parseTerraformConfig(path.join(dir, 'terraform'));
        expect(config.hasDb).toBe(true);
        expect(config.dbEngine).toBe(expected);
    });

    it('defaults dbEngine to postgres without a database', () => {
        const dir = makeTmp();
        writeTf(dir, { 'main.tf': MAIN_TF_MICRO });
        const config = parseTerraformConfig(path.join(dir, 'terraform'));
        expect(config.hasDb).toBe(false);
        expect(config.dbEngine).toBe('postgres');
    });
});

describe('estimateMonthlyCost database engines', () => {
    it.each([
        ['postgres', '13.98'],
        ['mysql', '13.98'],
    ])('bills the managed-instance rate for %s', (dbEngine, expected) => {
        const cost = estimateMonthlyCost({ hasDb: true, dbEngine });
        expect(cost.dbMonthly).toBe(expected);
    });

    it('bills $0/mo idle compute for aurora-postgresql', () => {
        const cost = estimateMonthlyCost({ hasDb: true, dbEngine: 'aurora-postgresql' });
        expect(cost.dbMonthly).toBe('0.00');
    });
});

describe('estimateMonthlyCost', () => {
    it('adds $0.40 for the base app secret', () => {
        const cost = estimateMonthlyCost({ hasSecrets: true, hasDb: false });
        expect(cost.secretsMonthly).toBe('0.40');
    });

    it('adds $0.80 when the RDS master password secret also exists', () => {
        const cost = estimateMonthlyCost({ hasSecrets: true, hasDb: true });
        expect(cost.secretsMonthly).toBe('0.80');
    });

    it('charges $0.00 secrets with no secrets file and no database', () => {
        const cost = estimateMonthlyCost({ hasSecrets: false, hasDb: false });
        expect(cost.secretsMonthly).toBe('0.00');
    });

    it('keeps the object return shape with two-decimal strings', () => {
        const cost = estimateMonthlyCost({});
        for (const key of ['fargateMonthly', 'albMonthly', 'dbMonthly', 'secretsMonthly', 'totalMonthly']) {
            expect(cost[key]).toMatch(/^\d+\.\d{2}$/);
        }
    });

    it('ignores unknown addon keys instead of throwing', () => {
        expect(() => estimateMonthlyCost({ addons: ['unknown:foo'] })).not.toThrow();
    });
});

describe('renderDryRunPreview', () => {
    it('labels the fixed baseline with the us-east-2 caveat and secrets breakdown', async () => {
        await renderDryRunPreview({ hasSecrets: true, hasDb: true }, true);
        const output = stripAnsi(mockNote.mock.calls[0][0]);
        expect(output).toContain('Fixed Baseline:');
        expect(output).not.toContain('Est. Fixed Baseline:');
        expect(output).toContain('(Fargate: $');
        expect(output).toContain('[Secrets Manager (2 secrets)]');
        expect(output).toContain(', Secrets: $0.80');
        expect(output).toContain('(us-east-2 rates)');
        expect(output).not.toContain('Est. Monthly Cost:');
    });

    it('omits the Secrets Manager node when there are no secrets', async () => {
        await renderDryRunPreview({ hasSecrets: false, hasDb: false }, true);
        const output = stripAnsi(mockNote.mock.calls[0][0]);
        expect(output).not.toContain('Secrets Manager');
        expect(output).not.toContain('Secrets: $');
    });

    it('renders addon tree nodes with a compact counted usage line', async () => {
        await renderDryRunPreview({ hasSecrets: true, addons: ['storage:s3', 'db:dynamodb'] }, true);
        const output = stripAnsi(mockNote.mock.calls[0][0]);
        expect(output).toContain('[S3 + CloudFront OAC]');
        expect(output).toContain('[DynamoDB (On-Demand + PITR)]');
        expect(output).toContain('+ Usage-based (2 addons): $0/mo fixed');
        // Verbose per-addon summaries stay out of the box (no repeated lists).
        expect(output).not.toContain('Usage-Based Addons:');
        expect(output).not.toContain(ADDON_REGISTRY['storage:s3'].cost.summary);
        expect(output).not.toContain(ADDON_REGISTRY['db:dynamodb'].cost.summary);
    });

    it('uses the singular form for a single addon', async () => {
        await renderDryRunPreview({ addons: ['storage:s3'] }, true);
        const output = stripAnsi(mockNote.mock.calls[0][0]);
        expect(output).toContain('+ Usage-based (1 addon):');
    });

    it.each([
        ['postgres', '🐘 Amazon RDS (PostgreSQL managed instance)', 'RDS: $13.98'],
        ['mysql', '🐬 Amazon RDS (MySQL managed instance)', 'RDS: $13.98'],
        ['aurora-postgresql', '✨ Amazon Aurora PostgreSQL (Serverless v2 · 0–2 ACU scale-to-zero)', 'RDS: $0.00'],
    ])('renders the %s database node and cost part', async (dbEngine, label, part) => {
        await renderDryRunPreview({ hasDb: true, dbEngine }, true);
        const output = stripAnsi(mockNote.mock.calls[0][0]);
        expect(output).toContain(label);
        expect(output).toContain(part);
    });

    it('fits the maximal box inside the IDE viewport budget', async () => {
        await renderDryRunPreview(
            { hasDb: true, hasWorker: true, hasSecrets: true, addons: ['storage:s3', 'db:dynamodb'] },
            true
        );
        const lines = stripAnsi(mockNote.mock.calls[0][0]).split('\n');
        expect(lines.length).toBeLessThanOrEqual(14);
        for (const line of lines) {
            expect(line.length).toBeLessThanOrEqual(90);
        }
    });

    it('skips unknown addon keys instead of throwing', async () => {
        await expect(renderDryRunPreview({ addons: ['unknown:foo'] }, true)).resolves.toBe(true);
    });

    it('suppresses the usage line when only fixed-baseline addons are active', async () => {
        await renderDryRunPreview({ addons: ['db:redis'] }, true);
        const output = stripAnsi(mockNote.mock.calls[0][0]);
        expect(output).toContain('[ElastiCache Valkey 8.0]');
        expect(output).toContain('Addons: $9.49');
        expect(output).not.toContain('+ Usage-based');
    });

    it('counts only usage-based addons in the usage line', async () => {
        await renderDryRunPreview({ addons: ['db:redis', 'storage:s3'] }, true);
        const output = stripAnsi(mockNote.mock.calls[0][0]);
        expect(output).toContain('+ Usage-based (1 addon):');
        expect(output).toContain('Addons: $9.49');
    });

    it('collapses three or more addons into a single tree line', async () => {
        await renderDryRunPreview({ addons: ['storage:s3', 'db:dynamodb', 'db:redis'] }, true);
        const output = stripAnsi(mockNote.mock.calls[0][0]);
        expect(output).toContain('[Addons (3): storage:s3, db:dynamodb, db:redis]');
        expect(output).not.toContain('[S3 + CloudFront OAC]');
        expect(output).not.toContain('[ElastiCache Valkey 8.0]');
    });

    it('fits the full five-addon maximal box inside the viewport budget', async () => {
        await renderDryRunPreview(
            {
                hasDb: true,
                hasWorker: true,
                hasSecrets: true,
                addons: ['storage:s3', 'db:dynamodb', 'db:redis', 'queue:sqs', 'ai:bedrock'],
            },
            true
        );
        const lines = stripAnsi(mockNote.mock.calls[0][0]).split('\n');
        expect(lines.length).toBeLessThanOrEqual(14);
        for (const line of lines) {
            expect(line.length).toBeLessThanOrEqual(90);
        }
        const output = lines.join('\n');
        expect(output).toContain('[Addons (5):');
        expect(output).toContain('+ Usage-based (4 addons):');
    });
});

describe('buildBaselineLine', () => {
    it('keeps the full breakdown when it fits in 90 columns', () => {
        const line = stripAnsi(buildBaselineLine('31.28', ['Fargate: $9.01', 'ALB: $22.27'], 0, 0));
        expect(line).toBe('Fixed Baseline: ~$31.28/mo (Fargate: $9.01, ALB: $22.27)');
    });

    it('folds Secrets and Addons into +$X other when over budget', () => {
        const line = stripAnsi(buildBaselineLine(
            '50.66',
            ['Fargate: $9.01', 'ALB: $22.27', 'RDS: $13.98', 'Secrets: $0.80', 'Addons: $9.49'],
            0.8,
            9.49
        ));
        expect(line.length).toBeLessThanOrEqual(90);
        expect(line).toContain('Fargate: $9.01');
        expect(line).toContain('+$10.29 other');
        expect(line).not.toContain('Secrets: $0.80');
    });

    it('appends a usage suffix without a comma separator', () => {
        const line = stripAnsi(buildBaselineLine('0.80', ['RDS: $0.00', 'Secrets: $0.80'], 0.8, 0, '+ API GW & Lambda usage'));
        expect(line).toBe('Fixed Baseline: ~$0.80/mo (RDS: $0.00, Secrets: $0.80 + API GW & Lambda usage)');
    });

    it('renders a bare breakdown as just the suffix', () => {
        const line = stripAnsi(buildBaselineLine('0.00', [], 0, 0, '+ API GW & Lambda usage'));
        expect(line).toBe('Fixed Baseline: ~$0.00/mo (+ API GW & Lambda usage)');
    });
});

describe('fixed-baseline addon costs', () => {
    it('adds monthlyFixed to the total while preserving the return shape', () => {
        const cost = estimateMonthlyCost({ addons: ['db:redis'] });
        for (const key of ['fargateMonthly', 'albMonthly', 'dbMonthly', 'secretsMonthly', 'totalMonthly']) {
            expect(cost[key]).toMatch(/^\d+\.\d{2}$/);
        }
        const base = estimateMonthlyCost({ addons: [] });
        expect(Number(cost.totalMonthly) - Number(base.totalMonthly)).toBeCloseTo(9.49, 2);
    });

    it('detects the new addon files from the registry', () => {
        const dir = makeTmp();
        writeTf(dir, { 'main.tf': MAIN_TF_MICRO, 'redis.tf': '# redis\n', 'sqs.tf': '# sqs\n', 'bedrock.tf': '# bedrock\n' });
        const config = parseTerraformConfig(path.join(dir, 'terraform'));
        expect(config.addons).toEqual(['db:redis', 'queue:sqs', 'ai:bedrock']);
    });
});

describe('buildCostTelemetryProps', () => {
    it('returns the shared numeric cost/shape payload', () => {
        const props = buildCostTelemetryProps(
            { projectName: 'myapp', cpu: 512, memory: 1024, hasDb: true, hasWorker: true, addons: ['storage:s3'] },
            { totalMonthly: '58.07' }
        );
        expect(props).toEqual({
            projectName: 'myapp',
            estimated_monthly_usd: 58.07,
            compute_target: 'ecs',
            cpu: 512,
            memory: 1024,
            has_db: true,
            db_engine: 'postgres',
            has_worker: true,
            addons: ['storage:s3'],
            addon_count: 1,
        });
    });

    it('falls back to basename, micro defaults, and empty addons', () => {
        const props = buildCostTelemetryProps({}, { totalMonthly: '31.28' });
        expect(props.projectName).toBe(path.basename(process.cwd()));
        expect(props.cpu).toBe(256);
        expect(props.memory).toBe(512);
        expect(props.addons).toEqual([]);
        expect(props.addon_count).toBe(0);
    });
});

describe('preview cancel telemetry (real decline path)', () => {
    let exitSpy;

    beforeEach(() => {
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    });

    afterEach(() => {
        exitSpy.mockRestore();
    });

    it('emits cancelled_at_preview with cost props when confirm is declined', async () => {
        vi.mocked(confirm).mockResolvedValue(false);
        await renderDryRunPreview({ projectName: 'myapp', hasSecrets: true }, false);
        expect(trackEvent).toHaveBeenCalledWith(
            'infrastructure_applied',
            expect.objectContaining({
                success: false,
                status: 'cancelled_at_preview',
                projectName: 'myapp',
                estimated_monthly_usd: expect.any(Number),
            })
        );
        expect(flushTelemetry).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('emits the same event when the prompt is cancelled via symbol', async () => {
        vi.mocked(confirm).mockResolvedValue(Symbol('clack:cancel'));
        await renderDryRunPreview({ projectName: 'myapp' }, false);
        expect(trackEvent).toHaveBeenCalledWith(
            'infrastructure_applied',
            expect.objectContaining({ success: false, status: 'cancelled_at_preview' })
        );
        expect(exitSpy).toHaveBeenCalledWith(0);
    });
});

describe('templates/README.md marker', () => {
    it('literally contains COST_ESTIMATE_MARKER so template and constant cannot drift', () => {
        const template = fs.readFileSync(
            path.join(process.cwd(), 'templates', 'README.md'),
            'utf-8'
        );
        expect(template).toContain(COST_ESTIMATE_MARKER);
    });
});

describe('syncDocCostEstimate', () => {
    it('preserves non-default CPU/memory from main.tf in the synced baseline', () => {
        const dir = makeTmp();
        writeTf(dir, { 'main.tf': MAIN_TF_SMALL, 'secrets.tf': '# secrets\n' });
        fs.writeFileSync(path.join(dir, 'README.md'), `# myapp\n\n* **${COST_ESTIMATE_MARKER}** ~$0.00/month\n`);
        const target = syncDocCostEstimate(dir);
        expect(target).toBe(path.join(dir, 'README.md'));
        const expected = estimateMonthlyCost(parseTerraformConfig(path.join(dir, 'terraform')));
        expect(fs.readFileSync(target, 'utf-8')).toContain(`~$${expected.totalMonthly}/month`);
    });
});

const MAIN_TF_LAMBDA = [
    'resource "aws_lambda_function" "app" {',
    '  function_name = "myapp-fn"',
    '  memory_size   = 512',
    '}',
    '',
].join('\n');

describe('lambda compute target', () => {
    it('detects computeTarget from main.tf content', () => {
        const lambdaDir = makeTmp();
        writeTf(lambdaDir, { 'main.tf': MAIN_TF_LAMBDA });
        expect(parseTerraformConfig(path.join(lambdaDir, 'terraform')).computeTarget).toBe('lambda');

        const ecsDir = makeTmp();
        writeTf(ecsDir, { 'main.tf': MAIN_TF_MICRO });
        expect(parseTerraformConfig(path.join(ecsDir, 'terraform')).computeTarget).toBe('ecs');

        expect(parseTerraformConfig(path.join(makeTmp(), 'terraform')).computeTarget).toBe('ecs');
    });

    it('prices static targets at a $0 fixed baseline', () => {
        const bare = estimateMonthlyCost({ hasSecrets: false, computeTarget: 'static' });
        expect(bare.fargateMonthly).toBe('0.00');
        expect(bare.albMonthly).toBe('0.00');
        expect(bare.totalMonthly).toBe('0.00');
    });

    it('detects the static target from a CloudFront distribution in main.tf', () => {
        const staticDir = makeTmp();
        writeTf(staticDir, { 'main.tf': 'resource "aws_cloudfront_distribution" "site" {\n}\n' });
        expect(parseTerraformConfig(path.join(staticDir, 'terraform')).computeTarget).toBe('static');
    });

    it('prices lambda compute and API Gateway at $0 fixed baseline', () => {
        const bare = estimateMonthlyCost({ hasSecrets: true, computeTarget: 'lambda' });
        expect(bare.fargateMonthly).toBe('0.00');
        expect(bare.albMonthly).toBe('0.00');
        expect(bare.totalMonthly).toBe('0.40');

        const aurora = estimateMonthlyCost({ hasDb: true, dbEngine: 'aurora-postgresql', hasSecrets: true, computeTarget: 'lambda' });
        expect(aurora.dbMonthly).toBe('0.00');
        expect(aurora.totalMonthly).toBe('0.80');

        // ECS pricing is unchanged by the new parameter default.
        const ecs = estimateMonthlyCost({ hasSecrets: true });
        expect(ecs.fargateMonthly).not.toBe('0.00');
        expect(ecs.albMonthly).not.toBe('0.00');
    });

    it('renders the serverless topology and secrets-only baseline', async () => {
        await renderDryRunPreview(
            { framework: 'Node.js', hasSecrets: true, hasDb: true, dbEngine: 'aurora-postgresql', computeTarget: 'lambda' },
            true
        );
        const output = stripAnsi(mockNote.mock.calls[0][0]);
        expect(output).toContain('API Gateway HTTP API v2');
        expect(output).toContain('AWS Lambda Web Service');
        expect(output).toContain('512 MB · Scale-to-zero');
        expect(output).not.toContain('ALB');
        expect(output).not.toContain('ECS Web Service');
        expect(output).toContain('Fixed Baseline: ~$0.80/mo (RDS: $0.00, Secrets: $0.80 + API GW & Lambda usage)');
    });

    it('reports compute_target in cost telemetry', () => {
        const props = buildCostTelemetryProps({ projectName: 'myapp', computeTarget: 'lambda' }, { totalMonthly: '0.40' });
        expect(props.compute_target).toBe('lambda');
    });

    it('renders the static topology and usage-only baseline', async () => {
        await renderDryRunPreview(
            { framework: 'static', computeTarget: 'static' },
            true
        );
        const output = stripAnsi(mockNote.mock.calls[0][0]);
        expect(output).toContain('🌐 CloudFront (Global CDN)');
        expect(output).toContain('🔒 IAM OIDC (GitHub Auth)');
        expect(output).toContain('📦 S3 Private Origin (Static Assets)');
        expect(output).not.toContain('ALB');
        expect(output).not.toContain('ECR');
        expect(output).not.toContain('ECS Web Service');
        expect(output).toContain('Fixed Baseline: $0.00/mo (Usage-based only via S3/CloudFront)');
    });
});
