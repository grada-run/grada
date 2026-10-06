import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackPromptsMockFactory } from './helpers/clack.js';
import { telemetryMockFactory } from './helpers/telemetry.js';
import { createTmpDirTracker } from './helpers/tmpdir.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stripVTControlCharacters } from 'node:util';
import {
    runAdd,
    parseAddArgs,
    validateAddonFlags,
    resolveAddonOptions,
    sanitizeCronName,
    injectContainerEnvVars,
    injectLambdaEnvVars,
    ensureLambdaVpcConfig,
    ensureWorkerDesiredCountLifecycle,
    formatCatalogListing,
    ADDON_REGISTRY,
    DEFAULT_PARTITION_KEY,
    DEFAULT_BEDROCK_MODEL,
    CUSTOM_MODEL_VALUE,
    DEFAULT_CRON_SCHEDULE,
    DEFAULT_CRON_COMMAND,
} from '../src/commands/add.js';
import {
    FALLBACK_BEDROCK_MODEL,
    FALLBACK_CATALOG,
    GENERIC_MODEL_HINT,
    cleanDisplayName,
    dedupeProviderModels,
    findCatalogEntry,
    generateHintForModel,
    isValidCatalog,
    loadBedrockCatalog,
    normalizeProviderName,
    parseModelScope,
    refreshBedrockCatalog,
    resolveModelIdForRegion,
    validateCatalogHints,
} from '../src/utils/bedrock-catalog.js';
import { syncDocCostEstimate, estimateMonthlyCost, parseTerraformConfig, COST_ESTIMATE_MARKER, LEGACY_COST_ESTIMATE_MARKER } from '../src/utils/visualizer.js';
import { select, text, log } from '@clack/prompts';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';

const S3_ENV = [
    { name: 'S3_BUCKET_NAME', value: '${aws_s3_bucket.storage.id}' },
    { name: 'S3_CDN_URL', value: 'https://${aws_cloudfront_distribution.storage_cdn.domain_name}' },
];

vi.mock('@clack/prompts', () => clackPromptsMockFactory());

vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));

const tmp = createTmpDirTracker();
let exitSpy;

function makeTmp() {
    return tmp.makeTmp('add-test-');
}

function writeWorkerTf(dir, { lifecycle = false } = {}) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'terraform', 'worker.tf'),
        [
            'resource "aws_ecs_task_definition" "worker" {',
            '  family = "myapp-worker-task"',
            '  container_definitions = jsonencode([',
            '    {',
            '      name      = "myapp-worker-container"',
            '      essential = true',
            '',
            '      environment = [',
            '        { "name": "NODE_ENV", "value": "production" }',
            '      ]',
            '    }',
            '  ])',
            '}',
            '',
            'resource "aws_ecs_service" "worker" {',
            '  name            = "myapp-worker-service"',
            '  cluster         = aws_ecs_cluster.main.id',
            '  task_definition = aws_ecs_task_definition.worker.arn',
            '  desired_count   = 1',
            ...(lifecycle ? ['  lifecycle {', '    ignore_changes = [desired_count]', '  }'] : []),
            '}',
            '',
        ].join('\n')
    );
}

function writeMainTf(dir, environment = '') {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'terraform', 'main.tf'),
        [
            'locals {',
            '  app_name = "myapp${local.env_suffix}"',
            '}',
            '',
            'resource "aws_ecs_task_definition" "app" {',
            '  family = "myapp-task"',
            '  container_definitions = jsonencode([',
            '    {',
            '      name      = "myapp-container"',
            '      essential = true',
            '',
            '      environment = [',
            `        ${environment}`,
            '      ]',
            '    },',
            '    {',
            '      name      = "sidecar"',
            '      essential = true',
            '      environment = [',
            '        { "name": "SIDECAR_VAR", "value": "1" }',
            '      ]',
            '    }',
            '  ])',
            '}',
            '',
        ].join('\n')
    );
}

beforeEach(() => {
    tmp.reset();
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
});

afterEach(() => {
    exitSpy.mockRestore();
    tmp.cleanup();
});

describe('parseAddArgs', () => {
    it('parses the capability positional', () => {
        expect(parseAddArgs(['add', 'storage:s3']).capability).toBe('storage:s3');
        expect(parseAddArgs(['add', 'db:dynamodb']).capability).toBe('db:dynamodb');
    });

    it('defaults the partition key to id and force to false', () => {
        const options = parseAddArgs(['add', 'db:dynamodb']);
        expect(options.partitionKey).toBe(DEFAULT_PARTITION_KEY);
        expect(options.force).toBe(false);
    });

    it('supports --flag value and --flag=value forms', () => {
        const spaced = parseAddArgs(['add', 'db:dynamodb', '--region', 'eu-west-1', '--project-name', 'shop', '--partition-key', 'userId']);
        expect(spaced).toMatchObject({ region: 'eu-west-1', projectName: 'shop', partitionKey: 'userId' });
        const joined = parseAddArgs(['add', 'db:dynamodb', '--region=eu-west-1', '--project-name=shop', '--partition-key=userId']);
        expect(joined).toMatchObject({ region: 'eu-west-1', projectName: 'shop', partitionKey: 'userId' });
    });

    it('supports bare --force as well as --force=true and --force=false', () => {
        expect(parseAddArgs(['add', 'storage:s3', '--force']).force).toBe(true);
        expect(parseAddArgs(['add', 'storage:s3', '--force=true']).force).toBe(true);
        expect(parseAddArgs(['add', 'storage:s3', '--force=false']).force).toBe(false);
    });
});

describe('precondition guards', () => {
    it('fails with TERRAFORM_NOT_INITIALIZED when terraform/main.tf is missing', async () => {
        const result = await runAdd({ cwd: makeTmp(), capability: 'storage:s3' });
        expect(result.ok).toBe(false);
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            capability: 'storage:s3',
            success: false,
            error_code: 'TERRAFORM_NOT_INITIALIZED',
        });
        expect(flushTelemetry).toHaveBeenCalled();
    });

    it('fails with UNSUPPORTED_CAPABILITY for unknown or missing capabilities', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'unknown:foo' });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            capability: 'unknown:foo',
            success: false,
            error_code: 'UNSUPPORTED_CAPABILITY',
        });

        vi.clearAllMocks();
        await runAdd({ cwd: dir });
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            capability: 'none',
            success: false,
            error_code: 'UNSUPPORTED_CAPABILITY',
        });
    });

    it('rejects an invalid --partition-key with INVALID_PARTITION_KEY telemetry', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'db:dynamodb', partitionKey: 'bad key!' });
        expect(result.ok).toBe(false);
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            projectName: 'myapp',
            capability: 'db:dynamodb',
            success: false,
            error_code: 'INVALID_PARTITION_KEY',
        });
        expect(flushTelemetry).toHaveBeenCalled();
        expect(fs.existsSync(path.join(dir, 'terraform', 'dynamodb.tf'))).toBe(false);
    });

    it('refuses to overwrite an existing addon file without --force', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const target = path.join(dir, 'terraform', 's3.tf');
        fs.writeFileSync(target, '# user edits — do not clobber\n');
        const result = await runAdd({ cwd: dir, capability: 'storage:s3' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('addon-already-exists');
        expect(exitSpy).not.toHaveBeenCalled();
        expect(fs.readFileSync(target, 'utf-8')).toBe('# user edits — do not clobber\n');
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            projectName: 'myapp',
            capability: 'storage:s3',
            success: false,
            error_code: 'ADDON_ALREADY_EXISTS',
        });
    });

    it('overwrites the addon file when --force is passed', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const target = path.join(dir, 'terraform', 's3.tf');
        fs.writeFileSync(target, '# stale\n');
        const result = await runAdd({ cwd: dir, capability: 'storage:s3', force: true });
        expect(result.ok).toBe(true);
        expect(fs.readFileSync(target, 'utf-8')).toContain('aws_s3_bucket');
    });
});

describe('injectContainerEnvVars', () => {
    it('injects into the primary container only and stays idempotent', () => {
        const dir = makeTmp();
        writeMainTf(dir, '{ "name": "EXISTING", "value": "1" },');
        const before = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        const once = injectContainerEnvVars(before, S3_ENV);
        expect(once).toContain('S3_BUCKET_NAME');
        expect(once).toContain('S3_CDN_URL');
        // Sidecar block is untouched.
        expect(once.match(/SIDECAR_VAR/g)).toHaveLength(1);
        const twice = injectContainerEnvVars(once, S3_ENV);
        expect(twice).toBe(once);
        expect(once.match(/S3_BUCKET_NAME/g)).toHaveLength(1);
    });

    it('skips keys that already exist in either HCL or JSON form', () => {
        const dir = makeTmp();
        writeMainTf(dir, '{ name = "S3_BUCKET_NAME", value = "custom" },');
        const before = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        const after = injectContainerEnvVars(before, S3_ENV);
        expect(after).toContain('S3_CDN_URL');
        expect(after.match(/S3_BUCKET_NAME/g)).toHaveLength(1);
    });

    it('returns content unchanged when the task definition is missing', () => {
        expect(injectContainerEnvVars('provider "aws" {}\n', [{ name: 'X', value: 'Y' }])).toBe('provider "aws" {}\n');
    });

    it('renders single-expression ${...} values as bare HCL references', () => {
        const dir = makeTmp();
        writeMainTf(dir, '{ "name": "EXISTING", "value": "1" },');
        const before = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        const entries = [
            { name: 'S3_BUCKET_NAME', value: '${aws_s3_bucket.storage.id}' },
            { name: 'DYNAMODB_TABLE_NAME', value: '${aws_dynamodb_table.main.name}' },
            { name: 'SQS_QUEUE_URL', value: '${aws_sqs_queue.main.id}' },
            { name: 'SQS_DLQ_URL', value: '${aws_sqs_queue.dlq.id}' },
        ];
        const after = injectContainerEnvVars(before, entries);
        // Bare references avoid tflint terraform_deprecated_interpolation.
        expect(after).toContain('{ name = "S3_BUCKET_NAME", value = aws_s3_bucket.storage.id }');
        expect(after).toContain('{ name = "DYNAMODB_TABLE_NAME", value = aws_dynamodb_table.main.name }');
        expect(after).toContain('{ name = "SQS_QUEUE_URL", value = aws_sqs_queue.main.id }');
        expect(after).toContain('{ name = "SQS_DLQ_URL", value = aws_sqs_queue.dlq.id }');
        expect(after).not.toContain('"${aws_s3_bucket.storage.id}"');
        // Idempotent reruns.
        expect(injectContainerEnvVars(after, entries)).toBe(after);
    });

    it('keeps literals and multi-part interpolations quoted', () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const before = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        const after = injectContainerEnvVars(before, [
            { name: 'BEDROCK_MODEL_ID', value: 'anthropic.claude-3' },
            { name: 'S3_CDN_URL', value: 'https://${aws_cloudfront_distribution.storage_cdn.domain_name}' },
            { name: 'REDIS_URL', value: 'redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:${aws_elasticache_replication_group.redis.port}' },
        ]);
        expect(after).toContain('{ name = "BEDROCK_MODEL_ID", value = "anthropic.claude-3" }');
        expect(after).toContain('{ name = "S3_CDN_URL", value = "https://${aws_cloudfront_distribution.storage_cdn.domain_name}" }');
        expect(after).toContain('value = "redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:${aws_elasticache_replication_group.redis.port}"');
    });

    it('upserts bare references over legacy quoted interpolations', () => {
        const dir = makeTmp();
        writeMainTf(dir, '{ name = "SQS_QUEUE_URL", value = "${aws_sqs_queue.main.id}" },');
        const before = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        const after = injectContainerEnvVars(
            before,
            [{ name: 'SQS_QUEUE_URL', value: '${aws_sqs_queue.main.id}' }],
            'app',
            { upsertKeys: ['SQS_QUEUE_URL'] }
        );
        expect(after).toContain('{ name = "SQS_QUEUE_URL", value = aws_sqs_queue.main.id }');
        // Identical bare values leave the text untouched.
        expect(injectContainerEnvVars(
            after,
            [{ name: 'SQS_QUEUE_URL', value: '${aws_sqs_queue.main.id}' }],
            'app',
            { upsertKeys: ['SQS_QUEUE_URL'] }
        )).toBe(after);
    });
});

describe('generated terraform', () => {
    it('renders s3.tf with the sanitized bucket expression, OAC, AES256, CORS, and task role wiring', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'storage:s3' });
        expect(result.ok).toBe(true);
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 's3.tf'), 'utf-8');
        expect(rendered).toContain(
            '"${trimsuffix(substr(replace(lower(local.app_name), "_", "-"), 0, 42), "-")}-storage-${data.aws_caller_identity.current.account_id}"'
        );
        expect(rendered).toContain('aws_cloudfront_origin_access_control');
        expect(rendered).toContain('sse_algorithm = "AES256"');
        expect(rendered).toContain('aws_s3_bucket_cors_configuration');
        expect(rendered).toContain('role = aws_iam_role.task_role.id');
        expect(rendered).toContain('output "s3_bucket_name"');
        expect(rendered).toContain('output "s3_cdn_domain"');
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('S3_BUCKET_NAME');
        expect(mainTf).toContain('S3_CDN_URL');
    });

    it('renders dynamodb.tf with PAY_PER_REQUEST, PITR, gateway endpoint, and task role wiring', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'db:dynamodb', region: 'eu-west-1', partitionKey: 'userId' });
        expect(result.ok).toBe(true);
        expect(result.region).toBe('eu-west-1');
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'dynamodb.tf'), 'utf-8');
        expect(rendered).toContain('billing_mode = "PAY_PER_REQUEST"');
        expect(rendered).toContain('point_in_time_recovery');
        expect(rendered).toContain('vpc_endpoint_type = "Gateway"');
        expect(rendered).toContain('com.amazonaws.eu-west-1.dynamodb');
        expect(rendered).toContain('[aws_route_table.public.id]');
        expect(rendered).toContain('role = aws_iam_role.task_role.id');
        expect(rendered).toContain('hash_key     = "userId"');
        expect(rendered).not.toContain('{{PARTITION_KEY}}');
        expect(rendered).not.toContain('{{REGION}}');
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('DYNAMODB_TABLE_NAME');
    });

    it('defaults the partition key to id', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'db:dynamodb' });
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'dynamodb.tf'), 'utf-8');
        expect(rendered).toContain('hash_key     = "id"');
    });

    it('emits a success telemetry event', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'storage:s3' });
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            projectName: 'myapp',
            capability: 'storage:s3',
            success: true,
        });
        expect(flushTelemetry).toHaveBeenCalled();
    });
});

describe('cost transparency', () => {
    let logSpy;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    it('re-exports ADDON_REGISTRY from the shared addons module', async () => {
        const shared = await import('../src/utils/addons.js');
        expect(ADDON_REGISTRY).toBe(shared.ADDON_REGISTRY);
    });

    it('prints the 💰 Cost Impact line with the registry summary', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'storage:s3' });
        const output = logSpy.mock.calls.map((args) => String(args[0])).join('\n');
        expect(output).toContain('💰 Cost Impact:');
        expect(output).toContain(ADDON_REGISTRY['storage:s3'].cost.summary);

        vi.clearAllMocks();
        const dir2 = makeTmp();
        writeMainTf(dir2);
        await runAdd({ cwd: dir2, capability: 'db:dynamodb' });
        const output2 = logSpy.mock.calls.map((args) => String(args[0])).join('\n');
        expect(output2).toContain('💰 Cost Impact:');
        expect(output2).toContain(ADDON_REGISTRY['db:dynamodb'].cost.summary);
    });

    it('syncs the cost baseline into README.md and lists active addons', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        fs.writeFileSync(
            path.join(dir, 'README.md'),
            `# myapp\n\n* **${LEGACY_COST_ESTIMATE_MARKER}** ~$9.99 / month\n\n## Usage\n`
        );
        await runAdd({ cwd: dir, capability: 'storage:s3' });
        const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf-8');
        expect(readme).not.toContain('~$9.99');
        expect(readme).toContain(COST_ESTIMATE_MARKER);
        expect(readme).toContain('### Active Addons (Usage-Based)');
        expect(readme).toContain('`storage:s3`');
    });

    it('prefers DEPLOYMENT.md over README.md and replaces reruns idempotently', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, 'README.md'), `# myapp\n\n* **${LEGACY_COST_ESTIMATE_MARKER}** ~$9.99 / month\n`);
        fs.writeFileSync(path.join(dir, 'DEPLOYMENT.md'), `# deploy\n\n* **${LEGACY_COST_ESTIMATE_MARKER}** ~$9.99 / month\n`);
        await runAdd({ cwd: dir, capability: 'storage:s3', force: true });
        await runAdd({ cwd: dir, capability: 'db:dynamodb', force: true });
        // README.md untouched; DEPLOYMENT.md updated once per addon, no duplicates.
        expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf-8')).toContain('~$9.99');
        const deployment = fs.readFileSync(path.join(dir, 'DEPLOYMENT.md'), 'utf-8');
        expect(deployment).not.toContain('~$9.99');
        expect(deployment.match(/### Active Addons \(Usage-Based\)/g)).toHaveLength(1);
        expect(deployment).toContain('`storage:s3`');
        expect(deployment).toContain('`db:dynamodb`');
    });

    it('syncDocCostEstimate no-ops without a marker or terraform project', () => {
        const dir = makeTmp();
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, 'README.md'), '# myapp\n\nNo cost section here.\n');
        expect(syncDocCostEstimate(dir)).toBeNull();
        expect(syncDocCostEstimate(makeTmp())).toBeNull();
    });
});

describe('--model flag', () => {
    it('defaults to the Bedrock inference profile', () => {
        expect(parseAddArgs(['add', 'ai:bedrock']).model).toBe(DEFAULT_BEDROCK_MODEL);
        expect(DEFAULT_BEDROCK_MODEL).toBe('us.anthropic.claude-sonnet-4-6');
    });

    it('supports --model value and --model=value forms', () => {
        expect(parseAddArgs(['add', 'ai:bedrock', '--model', 'custom.model']).model).toBe('custom.model');
        expect(parseAddArgs(['add', 'ai:bedrock', '--model=custom.model']).model).toBe('custom.model');
    });

    it('rejects an invalid --model with INVALID_MODEL_ID telemetry', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'ai:bedrock', model: 'bad model!' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('invalid-model-id');
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            projectName: 'myapp',
            capability: 'ai:bedrock',
            success: false,
            error_code: 'INVALID_MODEL_ID',
        });
        expect(flushTelemetry).toHaveBeenCalled();
        expect(fs.existsSync(path.join(dir, 'terraform', 'bedrock.tf'))).toBe(false);
    });

    it('silently ignores --model on non-bedrock capabilities', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'storage:s3', model: 'not a model!!!' });
        expect(result.ok).toBe(true);
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('validates --model before the terraform guard, like --partition-key', async () => {
        const result = await runAdd({ cwd: makeTmp(), capability: 'ai:bedrock', model: 'bad model!' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('invalid-model-id');
        expect(trackEvent).toHaveBeenCalledWith('add_run', expect.objectContaining({
            error_code: 'INVALID_MODEL_ID',
        }));
    });
});

describe('db:redis generated terraform', () => {
    it('renders redis.tf with Valkey, t4g.micro, md5-suffixed replication_group_id, and ECS-locked ingress', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'db:redis' });
        expect(result.ok).toBe(true);
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'redis.tf'), 'utf-8');
        expect(rendered).toContain('resource "aws_elasticache_replication_group" "redis"');
        expect(rendered).toContain('engine                     = "valkey"');
        expect(rendered).toContain('engine_version             = "8.0"');
        expect(rendered).toContain('node_type                  = "cache.t4g.micro"');
        expect(rendered).toContain('num_cache_clusters         = 1');
        expect(rendered).toContain('parameter_group_name       = "default.valkey8"');
        expect(rendered).toContain('automatic_failover_enabled = false');
        expect(rendered).not.toContain('resource "aws_elasticache_cluster"');
        expect(rendered).not.toContain('elasticache_cluster.redis');
        expect(rendered).not.toContain('cache_nodes');
        expect(rendered).toContain('subnet_ids = aws_subnet.public[*].id');
        expect(rendered).toContain('from_port       = 6379');
        expect(rendered).toContain('security_groups = [aws_security_group.ecs_tasks.id]');
        expect(rendered).toContain('trivy:ignore:AVD-AWS-0104');
        expect(rendered).toContain('substr(md5(local.app_name), 0, 5)');
        expect(rendered).toContain('output "redis_endpoint"');
        expect(rendered).toContain('output "redis_port"');
        expect(rendered).toContain('primary_endpoint_address');
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('REDIS_URL');
        expect(mainTf).toContain('redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:${aws_elasticache_replication_group.redis.port}');
    });

    it('updates an existing REDIS_URL value in place when --force is passed', async () => {
        const dir = makeTmp();
        writeMainTf(dir, '{ "name": "REDIS_URL", "value": "redis://${aws_elasticache_cluster.redis.cache_nodes[0].address}:6379" }');
        const result = await runAdd({ cwd: dir, capability: 'db:redis', force: true });
        expect(result.ok).toBe(true);
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:${aws_elasticache_replication_group.redis.port}');
        expect(mainTf).not.toContain('aws_elasticache_cluster');
        expect(mainTf.match(/"name": "REDIS_URL"/g)).toHaveLength(1);
    });

    it('bumps the fixed baseline by $9.49/mo in estimate and README', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const before = estimateMonthlyCost(parseTerraformConfig(path.join(dir, 'terraform')));
        fs.writeFileSync(
            path.join(dir, 'README.md'),
            `# myapp\n\n* **${COST_ESTIMATE_MARKER}** ~$${before.totalMonthly}/month\n`
        );
        await runAdd({ cwd: dir, capability: 'db:redis' });
        const after = estimateMonthlyCost(parseTerraformConfig(path.join(dir, 'terraform')));
        expect(Number(after.totalMonthly) - Number(before.totalMonthly)).toBeCloseTo(9.49, 2);
        const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf-8');
        expect(readme).toContain(`~$${after.totalMonthly}/month`);
        expect(readme).toContain('`db:redis`');
    });
});

describe('queue:sqs generated terraform', () => {
    it('renders sqs.tf with long polling, redrive policy, and task role wiring', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'queue:sqs' });
        expect(result.ok).toBe(true);
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'sqs.tf'), 'utf-8');
        expect(rendered).toContain('resource "aws_sqs_queue" "dlq"');
        expect(rendered).toContain('message_retention_seconds = 1209600');
        expect(rendered).toContain('resource "aws_sqs_queue" "main"');
        expect(rendered).toContain('visibility_timeout_seconds = 30');
        expect(rendered).toContain('receive_wait_time_seconds = 20');
        expect(rendered).toContain('sqs_managed_sse_enabled   = true');
        expect(rendered).toContain('deadLetterTargetArn = aws_sqs_queue.dlq.arn');
        expect(rendered).toContain('maxReceiveCount     = 3');
        expect(rendered).toContain('resource "aws_iam_role_policy" "queue_sqs_access"');
        expect(rendered).toContain('name = "${local.app_name}-queue-sqs-access"');
        expect(rendered).toContain('role = aws_iam_role.task_role.id');
        expect(rendered).toContain('"sqs:SendMessage"');
        expect(rendered).not.toContain('{{WORKER_AUTOSCALING_BLOCK}}');
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('SQS_QUEUE_URL');
        expect(mainTf).toContain('SQS_DLQ_URL');
    });

    it('warns on lambda targets and never creates worker.tf', async () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "myapp"\n}\nresource "aws_lambda_function" "app" {}\n'
        );
        const result = await runAdd({ cwd: dir, capability: 'queue:sqs' });
        expect(result.ok).toBe(true);
        expect(fs.existsSync(path.join(dir, 'terraform', 'sqs.tf'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'terraform', 'worker.tf'))).toBe(false);
        expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('long-running workers require ECS'));
    });

    it('renders active auto-scaling when worker.tf exists', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        writeWorkerTf(dir);
        await runAdd({ cwd: dir, capability: 'queue:sqs' });
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'sqs.tf'), 'utf-8');
        expect(rendered).toContain('resource "aws_appautoscaling_target" "worker_scale"');
        expect(rendered).toContain('min_capacity       = 0');
        expect(rendered).toContain('max_capacity       = 5');
        expect(rendered).toContain('resource "aws_appautoscaling_policy" "worker_scale_out"');
        expect(rendered).toContain('resource "aws_appautoscaling_policy" "worker_scale_in"');
        expect(rendered).toContain('resource "aws_cloudwatch_metric_alarm" "sqs_queue_high"');
        expect(rendered).toContain('resource "aws_cloudwatch_metric_alarm" "sqs_queue_empty"');
        expect(rendered).toContain('scaling_adjustment          = 1');
        expect(rendered).toContain('scaling_adjustment          = -5');
        expect(rendered).not.toMatch(/^# resource "aws_appautoscaling_target"/m);
        // Worker container receives the queue URLs.
        const workerTf = fs.readFileSync(path.join(dir, 'terraform', 'worker.tf'), 'utf-8');
        expect(workerTf).toContain('SQS_QUEUE_URL');
        expect(workerTf).toContain('SQS_DLQ_URL');
    });

    it('renders commented auto-scaling when worker.tf is absent', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'queue:sqs' });
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'sqs.tf'), 'utf-8');
        expect(rendered).not.toMatch(/^resource "aws_appautoscaling_target"/m);
        expect(rendered).not.toMatch(/^resource "aws_cloudwatch_metric_alarm" "sqs_queue/m);
        expect(rendered).toContain('# resource "aws_appautoscaling_target" "worker_scale"');
        expect(rendered).toContain('# resource "aws_cloudwatch_metric_alarm" "sqs_queue_high"');
    });
});

describe('ai:bedrock generated terraform', () => {
    it('renders bedrock.tf with the default model', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const savedRegion = process.env.AWS_REGION;
        delete process.env.AWS_REGION;
        let result;
        try {
            result = await runAdd({ cwd: dir, capability: 'ai:bedrock' });
        } finally {
            if (savedRegion !== undefined) process.env.AWS_REGION = savedRegion;
        }
        expect(result.ok).toBe(true);
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'bedrock.tf'), 'utf-8');
        expect(rendered).toContain('resource "aws_iam_role_policy" "ai_bedrock_access"');
        expect(rendered).toContain('name = "${local.app_name}-ai-bedrock-access"');
        expect(rendered).toContain('role = aws_iam_role.task_role.id');
        expect(rendered).toContain('"bedrock:InvokeModel"');
        expect(rendered).toContain('"bedrock:InvokeModelWithResponseStream"');
        expect(rendered).toContain('"arn:aws:bedrock:*::foundation-model/*"');
        expect(rendered).toContain('"arn:aws:bedrock:*:*:inference-profile/*"');
        expect(rendered).toContain(`value = "${DEFAULT_BEDROCK_MODEL}"`);
        expect(rendered).not.toContain('{{BEDROCK_MODEL_ID}}');
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('BEDROCK_MODEL_ID');
        expect(mainTf).toContain(DEFAULT_BEDROCK_MODEL);
    });

    it('honors a custom --model override in both bedrock.tf and container env', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const custom = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
        await runAdd({ cwd: dir, capability: 'ai:bedrock', model: custom });
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'bedrock.tf'), 'utf-8');
        expect(rendered).toContain(`value = "${custom}"`);
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain(custom);
    });

    it('aligns the default model ID to the project region', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'ai:bedrock', region: 'eu-west-1' });
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'bedrock.tf'), 'utf-8');
        const expected = resolveModelIdForRegion(DEFAULT_BEDROCK_MODEL, 'eu-west-1');
        expect(rendered).toContain(`value = "${expected}"`);
    });

    it('keeps an explicit --model verbatim even in non-us regions', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const custom = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
        await runAdd({ cwd: dir, capability: 'ai:bedrock', region: 'eu-west-1', model: custom, modelProvided: true });
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'bedrock.tf'), 'utf-8');
        expect(rendered).toContain(`value = "${custom}"`);
    });
});

describe('worker.tf handling', () => {
    it('injects addon env vars into worker.tf for all capabilities', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        writeWorkerTf(dir);
        await runAdd({ cwd: dir, capability: 'storage:s3', force: true });
        const workerTf = fs.readFileSync(path.join(dir, 'terraform', 'worker.tf'), 'utf-8');
        expect(workerTf).toContain('S3_BUCKET_NAME');
        expect(workerTf).toContain('S3_CDN_URL');
        expect(workerTf.match(/S3_BUCKET_NAME/g)).toHaveLength(1);
    });

    it('targets the worker task definition without touching the app definition', () => {
        const dir = makeTmp();
        writeWorkerTf(dir);
        const before = fs.readFileSync(path.join(dir, 'terraform', 'worker.tf'), 'utf-8');
        // Default 'app' anchor leaves worker.tf untouched.
        expect(injectContainerEnvVars(before, [{ name: 'X', value: 'Y' }])).toBe(before);
        const after = injectContainerEnvVars(before, [{ name: 'X', value: 'Y' }], 'worker');
        expect(after).toContain('{ name = "X", value = "Y" }');
        expect(after.match(/"name": "NODE_ENV"/g)).toHaveLength(1);
        // Idempotent reruns.
        expect(injectContainerEnvVars(after, [{ name: 'X', value: 'Y' }], 'worker')).toBe(after);
    });

    it('injects lifecycle ignore_changes into existing worker.tf on queue:sqs', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        writeWorkerTf(dir);
        await runAdd({ cwd: dir, capability: 'queue:sqs' });
        const workerTf = fs.readFileSync(path.join(dir, 'terraform', 'worker.tf'), 'utf-8');
        expect(workerTf).toContain('ignore_changes = [desired_count]');
    });

    it('leaves worker.tf lifecycle untouched when already present or for other addons', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        writeWorkerTf(dir, { lifecycle: true });
        const before = fs.readFileSync(path.join(dir, 'terraform', 'worker.tf'), 'utf-8');
        await runAdd({ cwd: dir, capability: 'queue:sqs' });
        const afterSqs = fs.readFileSync(path.join(dir, 'terraform', 'worker.tf'), 'utf-8');
        expect(afterSqs.match(/ignore_changes/g)).toHaveLength(1);

        const dir2 = makeTmp();
        writeMainTf(dir2);
        writeWorkerTf(dir2);
        const beforeOther = fs.readFileSync(path.join(dir2, 'terraform', 'worker.tf'), 'utf-8');
        await runAdd({ cwd: dir2, capability: 'db:redis' });
        const afterOther = fs.readFileSync(path.join(dir2, 'terraform', 'worker.tf'), 'utf-8');
        expect(afterOther).not.toContain('ignore_changes');
        expect(afterOther).not.toBe(beforeOther); // env vars still injected
        expect(before).toContain('ignore_changes');
    });

    it('injects into a hasDb:false worker.tf without emitting a double comma', () => {
        // Real template rendered the way the generator leaves it when
        // NEEDS_DATABASE is false: {{DB_ENV_VARS}} expands to empty,
        // leaving a dangling comma + blank line after NODE_ENV.
        const template = fs.readFileSync(
            new URL('../templates/terraform/worker.tf', import.meta.url),
            'utf-8'
        );
        const rendered = template
            .replace('{{DB_ENV_VARS}}', '')
            .replace('{{WORKER_COMMAND}}', 'command = ["npm", "run", "worker"]');
        // Sanity: the fixture really carries the dangling comma.
        expect(rendered).toMatch(/}\s*,\s*\n\s*\n\s*\]/);
        const after = injectContainerEnvVars(rendered, [{ name: 'REDIS_URL', value: 'redis://x' }], 'worker');
        expect(after).toContain('{ name = "REDIS_URL", value = "redis://x" }');
        expect(after).not.toMatch(/}\s*,\s*,/);
        // The worker image must use the count-safe local, matching main.tf.
        expect(after).toContain('${local.ecr_url}');
        expect(after).not.toContain('aws_ecr_repository.app.repository_url');
    });
});

describe('ensureWorkerDesiredCountLifecycle', () => {
    it('adds the lifecycle block inside the worker service resource', () => {
        const dir = makeTmp();
        writeWorkerTf(dir);
        const before = fs.readFileSync(path.join(dir, 'terraform', 'worker.tf'), 'utf-8');
        const after = ensureWorkerDesiredCountLifecycle(before);
        expect(after).toContain('lifecycle {');
        expect(after).toContain('ignore_changes = [desired_count]');
        expect(ensureWorkerDesiredCountLifecycle(after)).toBe(after);
    });

    it('returns content unchanged when the worker service is missing', () => {
        expect(ensureWorkerDesiredCountLifecycle('provider "aws" {}\n')).toBe('provider "aws" {}\n');
    });
});

describe('catalog flag parsing', () => {
    it('parses --list-models, --refresh, and --headless forms', () => {
        const defaults = parseAddArgs(['add', 'ai:bedrock']);
        expect(defaults).toMatchObject({ listModels: false, refresh: false, isHeadless: false, modelProvided: false });
        expect(parseAddArgs(['add', 'ai:bedrock', '--list-models'])).toMatchObject({ listModels: true });
        expect(parseAddArgs(['add', 'ai:bedrock', '--refresh'])).toMatchObject({ refresh: true });
        expect(parseAddArgs(['add', 'ai:bedrock', '--headless'])).toMatchObject({ isHeadless: true });
        expect(parseAddArgs(['add', 'ai:bedrock', '--headless=true'])).toMatchObject({ isHeadless: true });
        expect(parseAddArgs(['add', 'ai:bedrock', '--headless=false'])).toMatchObject({ isHeadless: false });
    });

    it('tracks explicit --model separately from the default', () => {
        expect(parseAddArgs(['add', 'ai:bedrock']).modelProvided).toBe(false);
        expect(parseAddArgs(['add', 'ai:bedrock', '--model', 'x.y']).modelProvided).toBe(true);
        expect(parseAddArgs(['add', 'ai:bedrock', '--model=x.y']).modelProvided).toBe(true);
    });
});

describe('bedrock model catalog', () => {
    it('matches DEFAULT_BEDROCK_MODEL to the bundled catalog default', () => {
        const catalog = loadBedrockCatalog();
        expect(catalog.defaultModelId).toBe('us.anthropic.claude-sonnet-4-6');
        expect(DEFAULT_BEDROCK_MODEL).toBe(catalog.defaultModelId);
        expect(FALLBACK_BEDROCK_MODEL).toBe('us.anthropic.claude-sonnet-4-6');
        expect(isValidCatalog(catalog)).toBe(true);
        expect(isValidCatalog(FALLBACK_CATALOG)).toBe(true);
    });

    it('rejects malformed catalogs', () => {
        expect(isValidCatalog(null)).toBe(false);
        expect(isValidCatalog({})).toBe(false);
        expect(isValidCatalog({ ...FALLBACK_CATALOG, updatedAt: 'yesterday' })).toBe(false);
        expect(isValidCatalog({ ...FALLBACK_CATALOG, providers: [] })).toBe(false);
    });

    it('normalizes provider names from ARNs, profile IDs, and display names', () => {
        expect(normalizeProviderName('Mistral')).toBe('Mistral AI');
        expect(normalizeProviderName('mistral ai')).toBe('Mistral AI');
        expect(normalizeProviderName('us.mistral.pixtral-large')).toBe('Mistral AI');
        expect(normalizeProviderName('arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-x')).toBe('Anthropic');
        expect(normalizeProviderName('us.anthropic.claude-sonnet-4-6')).toBe('Anthropic');
        expect(normalizeProviderName('deepseek.v3.2')).toBe('DeepSeek');
        expect(normalizeProviderName('moonshotai')).toBe('Moonshot AI');
        expect(normalizeProviderName('writer')).toBe('Writer');
        expect(normalizeProviderName('us.stability.stable-image-inpaint-v1:0')).toBe('Stability AI');
        expect(normalizeProviderName('zai.glm-5')).toBe('Zhipu AI');
        expect(normalizeProviderName('Some New Lab')).toBe('Some New Lab');
        expect(normalizeProviderName('')).toBe('Other');
    });

    it('parses cross-region scopes and base model IDs', () => {
        expect(parseModelScope('us.anthropic.claude-x')).toEqual({ scope: 'us', baseId: 'anthropic.claude-x' });
        expect(parseModelScope('global.openai.gpt-x')).toEqual({ scope: 'global', baseId: 'openai.gpt-x' });
        expect(parseModelScope('eu.mistral.pixtral-x')).toEqual({ scope: 'eu', baseId: 'mistral.pixtral-x' });
        expect(parseModelScope('apac.amazon.nova-x')).toEqual({ scope: 'apac', baseId: 'amazon.nova-x' });
        expect(parseModelScope('anthropic.claude-x')).toEqual({ scope: 'regional', baseId: 'anthropic.claude-x' });
        expect(parseModelScope('european.acme-1')).toEqual({ scope: 'regional', baseId: 'european.acme-1' });
    });

    it('strips routing prefixes from display names', () => {
        expect(cleanDisplayName('US OpenAI GPT-5.6 Luna')).toBe('OpenAI GPT-5.6 Luna');
        expect(cleanDisplayName('GLOBAL Anthropic Claude X')).toBe('Anthropic Claude X');
        expect(cleanDisplayName('Global Claude Sonnet 4.5')).toBe('Claude Sonnet 4.5');
        expect(cleanDisplayName('Claude Sonnet 4.6')).toBe('Claude Sonnet 4.6');
    });

    it('prefers an explicit cache path over the bundled catalog', () => {
        const dir = makeTmp();
        const cachePath = path.join(dir, 'cache.json');
        const cached = {
            ...loadBedrockCatalog(),
            updatedAt: '2999-01-01',
            providers: [
                {
                    provider: 'Anthropic',
                    models: [{ id: 'us.anthropic.future-model', name: 'Future Model', hint: 'cached' }],
                },
            ],
        };
        fs.writeFileSync(cachePath, JSON.stringify(cached));
        expect(loadBedrockCatalog({ cachePath }).providers).toHaveLength(1);
        expect(loadBedrockCatalog().providers.length).toBeGreaterThan(1);
    });

    it('migrates pre-dedup caches by collapsing cross-region variants in memory', () => {
        const dir = makeTmp();
        const cachePath = path.join(dir, 'cache.json');
        const cached = {
            ...loadBedrockCatalog(),
            updatedAt: '2999-01-01',
            providers: [
                {
                    provider: 'Anthropic',
                    models: [
                        { id: 'us.anthropic.claude-x', name: 'US Anthropic Claude X', hint: 'h' },
                        { id: 'global.anthropic.claude-x', name: 'GLOBAL Anthropic Claude X', hint: 'h' },
                        { id: 'anthropic.claude-x', name: 'Anthropic Claude X', hint: 'h' },
                    ],
                },
            ],
        };
        fs.writeFileSync(cachePath, JSON.stringify(cached));
        const loaded = loadBedrockCatalog({ cachePath });
        expect(loaded.providers).toHaveLength(1);
        expect(loaded.providers[0].models).toHaveLength(1);
        expect(loaded.providers[0].models[0].id).toBe('us.anthropic.claude-x');
        expect(loaded.providers[0].models[0].scopes).toEqual(['us', 'global']);
        // The cache file itself is untouched; the next --refresh rewrites it.
        expect(JSON.parse(fs.readFileSync(cachePath, 'utf-8')).providers[0].models).toHaveLength(3);
    });
});

describe('--list-models', () => {
    it('lists the catalog without a terraform project', async () => {
        const result = await runAdd({ cwd: makeTmp(), capability: 'ai:bedrock', listModels: true });
        expect(result.ok).toBe(true);
        expect(result.action).toBe('list-models');
        expect(result.models).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'Anthropic' })]));
        const logged = vi.mocked(log.info).mock.calls.map((args) => String(args[0])).join('\n');
        expect(logged).toContain('Anthropic');
        expect(logged).toContain('us.anthropic.claude-sonnet-4-6');
        expect(trackEvent).toHaveBeenCalledWith('add_run', expect.objectContaining({
            capability: 'ai:bedrock',
            action: 'list_models',
            success: true,
        }));
        expect(flushTelemetry).toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('rejects an invalid --model alongside --list-models', async () => {
        const result = await runAdd({ cwd: makeTmp(), capability: 'ai:bedrock', listModels: true, model: 'bad model!' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('invalid-model-id');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('renders one bullet per model under a provider header', async () => {
        await runAdd({ cwd: makeTmp(), capability: 'ai:bedrock', listModels: true });
        const blocks = vi.mocked(log.info).mock.calls.map((args) => stripVTControlCharacters(String(args[0])));
        const anthropic = blocks.find((block) => /Anthropic \(\d+\):/.test(block));
        expect(anthropic).toBeDefined();
        expect(anthropic).toContain('• us.anthropic.claude-sonnet-4-6');
        expect(anthropic).toContain('Recommended default');
    });
});

describe('formatCatalogListing', () => {
    it('merges groups that normalize to the same provider', () => {
        const lines = stripVTControlCharacters(formatCatalogListing({
            providers: [
                { provider: 'writer', models: [{ id: 'us.writer.palmyra-x4-v1:0', hint: 'writing' }] },
                { provider: 'Writer', models: [{ id: 'writer.palmyra-vision-7b', hint: 'vision' }] },
            ],
        }).join('\n'));
        expect(lines).toContain('Writer (2):');
        expect(lines).toContain('• us.writer.palmyra-x4-v1:0');
        expect(lines).toContain('• writer.palmyra-vision-7b');
        expect(lines).not.toContain('writer (1)');
    });

    it('falls back to the generic hint when a model has none', () => {
        const lines = stripVTControlCharacters(formatCatalogListing({
            providers: [{ provider: 'Acme', models: [{ id: 'acme.mystery-1' }] }],
        }).join('\n'));
        expect(lines).toContain('Acme (1):');
        expect(lines).toContain('Live AWS Bedrock model');
    });

    it('tags multi-scope models with brackets and leaves single-scope models bare', () => {
        const lines = stripVTControlCharacters(formatCatalogListing({
            providers: [{
                provider: 'Acme',
                models: [
                    { id: 'us.acme.routed-1', hint: 'fast', scopes: ['us', 'global'] },
                    { id: 'acme.local-1', hint: 'local', scopes: ['regional'] },
                    { id: 'acme.legacy-1', hint: 'legacy' },
                ],
            }],
        }).join('\n'));
        expect(lines).toContain('• us.acme.routed-1 [us, global] —');
        expect(lines).toContain('• acme.local-1 —');
        expect(lines).toContain('• acme.legacy-1 —');
        expect(lines).not.toContain('[regional]');
    });
});

describe('cross-region model dedup', () => {
    it('collapses scope variants into one canonical entry with ordered scopes', () => {
        const models = dedupeProviderModels('Anthropic', [
            { id: 'global.anthropic.claude-x', name: 'GLOBAL Anthropic Claude X', hint: 'h1' },
            { id: 'anthropic.claude-x', name: 'Anthropic Claude X', hint: 'h2' },
            { id: 'us.anthropic.claude-x', name: 'US Anthropic Claude X', hint: 'h3', recommended: true },
        ], { defaultModelId: 'us.anthropic.claude-x' });
        expect(models).toHaveLength(1);
        expect(models[0]).toMatchObject({
            id: 'us.anthropic.claude-x',
            name: 'Anthropic Claude X',
            scopes: ['us', 'global'],
            recommended: true,
        });
        expect(models[0].hint).toMatch(/^Recommended default/);
    });

    it('keeps regional-only models unscoped with their own id', () => {
        const models = dedupeProviderModels('Acme', [
            { id: 'acme.local-1', name: 'Acme Local', hint: 'local' },
        ], {});
        expect(models).toHaveLength(1);
        expect(models[0]).toMatchObject({ id: 'acme.local-1', scopes: ['regional'] });
    });

    it('finds entries by exact id, then by base model', () => {
        const catalog = loadBedrockCatalog();
        expect(findCatalogEntry(catalog, 'us.anthropic.claude-sonnet-4-6')?.id)
            .toBe('us.anthropic.claude-sonnet-4-6');
        expect(findCatalogEntry(catalog, 'anthropic.claude-sonnet-4-6')?.id)
            .toBe('us.anthropic.claude-sonnet-4-6');
        expect(findCatalogEntry(catalog, 'no.such.model')).toBeNull();
    });

    it('resolves the us chain for us regions', () => {
        const entry = { id: 'us.acme.widget-1', scopes: ['us', 'global'] };
        expect(resolveModelIdForRegion(entry, 'us-east-2')).toBe('us.acme.widget-1');
        expect(resolveModelIdForRegion(entry, 'us-west-2')).toBe('us.acme.widget-1');
        expect(resolveModelIdForRegion({ id: 'global.acme.widget-2', scopes: ['global'] }, 'us-east-1'))
            .toBe('global.acme.widget-2');
    });

    it('prefers eu, then global, then us for eu regions', () => {
        expect(resolveModelIdForRegion({ id: 'us.acme.w', scopes: ['us', 'global', 'eu'] }, 'eu-west-1'))
            .toBe('eu.acme.w');
        expect(resolveModelIdForRegion({ id: 'us.acme.w', scopes: ['us', 'global'] }, 'eu-central-1'))
            .toBe('global.acme.w');
        expect(resolveModelIdForRegion({ id: 'us.acme.w', scopes: ['us'] }, 'eu-west-1'))
            .toBe('us.acme.w');
    });

    it('prefers apac, then global, then us for ap regions', () => {
        expect(resolveModelIdForRegion({ id: 'global.acme.w', scopes: ['global', 'apac'] }, 'ap-southeast-2'))
            .toBe('apac.acme.w');
        expect(resolveModelIdForRegion({ id: 'us.acme.w', scopes: ['us', 'global'] }, 'ap-northeast-1'))
            .toBe('global.acme.w');
    });

    it('falls back to the bare base id and to verbatim unknowns', () => {
        expect(resolveModelIdForRegion({ id: 'acme.local-1', scopes: ['regional'] }, 'us-east-2'))
            .toBe('acme.local-1');
        expect(resolveModelIdForRegion({ id: 'us.acme.w4' }, 'eu-west-1')).toBe('us.acme.w4');
        expect(resolveModelIdForRegion('us.anthropic.claude-sonnet-4-6', 'us-east-2'))
            .toBe('us.anthropic.claude-sonnet-4-6');
        expect(resolveModelIdForRegion('no.such.model-1', 'eu-west-1')).toBe('no.such.model-1');
    });
});

describe('--refresh catalog merge', () => {
    function mockBedrockClient({ profilesPages = [[]], foundationModels = [] } = {}) {
        return {
            send: vi.fn(async (command) => {
                if (command.constructor.name === 'ListInferenceProfilesCommand') {
                    const page = command.input.nextToken ? profilesPages[1] || [] : profilesPages[0];
                    return {
                        inferenceProfileSummaries: page,
                        nextToken: !command.input.nextToken && profilesPages.length > 1 ? 'token-1' : undefined,
                    };
                }
                return { modelSummaries: foundationModels };
            }),
        };
    }

    function withCacheEnv(cachePath, fn) {
        const saved = process.env.DEPLOY_STACK_BEDROCK_CACHE_PATH;
        process.env.DEPLOY_STACK_BEDROCK_CACHE_PATH = cachePath;
        try {
            return fn();
        } finally {
            if (saved === undefined) delete process.env.DEPLOY_STACK_BEDROCK_CACHE_PATH;
            else process.env.DEPLOY_STACK_BEDROCK_CACHE_PATH = saved;
        }
    }

    it('merges paginated live models without dropping bundled entries', async () => {
        const dir = makeTmp();
        const cachePath = path.join(dir, 'bedrock-models-cache.json');
        const bedrockClient = mockBedrockClient({
            profilesPages: [
                [
                    {
                        status: 'ACTIVE',
                        inferenceProfileId: 'us.mistral.pixtral-new',
                        inferenceProfileName: 'Pixtral New',
                        models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/mistral.pixtral-new' }],
                    },
                    { status: 'DELETED', inferenceProfileId: 'us.gone.old-model' },
                    { status: 'ACTIVE', inferenceProfileId: 'not a valid id!' },
                ],
                [
                    {
                        status: 'ACTIVE',
                        inferenceProfileId: 'us.amazon.nova-live-1',
                        models: [],
                    },
                ],
            ],
            foundationModels: [
                {
                    modelLifecycle: { status: 'ACTIVE' },
                    modelId: 'live.newco-model-1',
                    modelName: 'NewCo Model',
                    providerName: 'NewCo',
                },
                {
                    modelLifecycle: { status: 'ACTIVE' },
                    modelId: 'acme.unknown-model-v1',
                    modelName: 'Unknown Model',
                    providerName: 'Acme',
                },
            ],
        });
        const merged = await withCacheEnv(cachePath, () =>
            refreshBedrockCatalog({ bedrockClient })
        );
        expect(bedrockClient.send).toHaveBeenCalledTimes(3);
        // Bundled entries survive (additive merge, pruneMissing defaults false).
        expect(JSON.stringify(merged)).toContain('us.anthropic.claude-sonnet-4-6');
        const mistral = merged.providers.find((group) => group.provider === 'Mistral AI');
        expect(mistral.models.map((entry) => entry.id)).toContain('us.mistral.pixtral-new');
        expect(mistral.models.find((entry) => entry.id === 'us.mistral.pixtral-new').hint).toBe(
            'Multimodal vision & document understanding'
        );
        const acme = merged.providers.find((group) => group.provider === 'Acme');
        expect(acme.models.find((entry) => entry.id === 'acme.unknown-model-v1').hint).toBe(GENERIC_MODEL_HINT);
        expect(JSON.stringify(merged)).toContain('us.amazon.nova-live-1');
        expect(merged.providers.find((group) => group.provider === 'NewCo')).toBeDefined();
        expect(JSON.stringify(merged)).not.toContain('us.gone.old-model');
        expect(fs.existsSync(cachePath)).toBe(true);
        expect(loadBedrockCatalog({ cachePath }).updatedAt).toBe(merged.updatedAt);
    });

    it('dedupes us, global, and unprefixed variants into one scoped entry', async () => {
        const dir = makeTmp();
        const cachePath = path.join(dir, 'cache.json');
        const bedrockClient = mockBedrockClient({
            profilesPages: [[
                {
                    status: 'ACTIVE',
                    inferenceProfileId: 'us.zeta.haiku-dedup',
                    inferenceProfileName: 'US Zeta Haiku Dedup',
                    models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/zeta.haiku-dedup' }],
                },
                {
                    status: 'ACTIVE',
                    inferenceProfileId: 'global.zeta.haiku-dedup',
                    inferenceProfileName: 'GLOBAL Zeta Haiku Dedup',
                    models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/zeta.haiku-dedup' }],
                },
            ]],
            foundationModels: [
                {
                    modelLifecycle: { status: 'ACTIVE' },
                    modelId: 'zeta.haiku-dedup',
                    modelName: 'Zeta Haiku Dedup',
                    providerName: 'zeta',
                },
            ],
        });
        const merged = await withCacheEnv(cachePath, () =>
            refreshBedrockCatalog({ bedrockClient })
        );
        const zeta = merged.providers.find((group) => group.provider === 'zeta');
        expect(zeta.models).toHaveLength(1);
        expect(zeta.models[0]).toMatchObject({
            id: 'us.zeta.haiku-dedup',
            name: 'Zeta Haiku Dedup',
            scopes: ['us', 'global'],
        });
    });

    it('prunes absent entries when pruneMissing is true but keeps the default', async () => {
        const dir = makeTmp();
        const cachePath = path.join(dir, 'cache.json');
        const bedrockClient = mockBedrockClient({
            profilesPages: [[
                {
                    status: 'ACTIVE',
                    inferenceProfileId: 'us.live.only-model',
                    inferenceProfileName: 'Only Live',
                    models: [],
                },
            ]],
        });
        const merged = await refreshBedrockCatalog({ bedrockClient, cachePath, pruneMissing: true });
        const ids = merged.providers.flatMap((group) => group.models.map((entry) => entry.id));
        expect(ids).toContain('us.live.only-model');
        expect(ids).toContain('us.anthropic.claude-sonnet-4-6');
        expect(ids).not.toContain('us.amazon.nova-pro-v1:0');
    });

    it('falls back to the bundled catalog when AWS throws', async () => {
        const dir = makeTmp();
        const bedrockClient = { send: vi.fn().mockRejectedValue(new Error('ExpiredToken')) };
        const merged = await refreshBedrockCatalog({ bedrockClient, cachePath: path.join(dir, 'cache.json') });
        expect(merged).toEqual(loadBedrockCatalog());
        expect(vi.mocked(log.warn)).toHaveBeenCalled();
    });

    it('warns when pruning retains the default only via the safety guard', async () => {
        const dir = makeTmp();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const bedrockClient = mockBedrockClient({
                profilesPages: [[
                    {
                        status: 'ACTIVE',
                        inferenceProfileId: 'us.live.only-model',
                        inferenceProfileName: 'Only Live',
                        models: [],
                    },
                ]],
            });
            await refreshBedrockCatalog({
                bedrockClient,
                cachePath: path.join(dir, 'cache.json'),
                pruneMissing: true,
            });
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
                '::warning file=src/data/bedrock-models.json::Default model "us.anthropic.claude-sonnet-4-6"'
            ));
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('family hint generation', () => {
    it('returns durable tier hints without Frontier/Latest buzzwords', () => {
        expect(generateHintForModel('Anthropic', 'us.anthropic.claude-sonnet-4-6')).toBe(
            'Recommended default — standard temperature/top_p SDK compatibility'
        );
        expect(generateHintForModel('Anthropic', 'us.anthropic.claude-sonnet-5')).toBe(
            'Sonnet-tier coding & agents (adaptive thinking on; omit temperature)'
        );
        expect(generateHintForModel('Anthropic', 'us.anthropic.claude-fable-5-1')).toBe(
            'Mythos-tier autonomous workflows & agents (adaptive thinking on; omit temperature)'
        );
        expect(generateHintForModel('OpenAI', 'us.openai.gpt-6-astra')).toBe(
            'Flagship multi-step reasoning & agentic workflows (Converse API)'
        );
        expect(generateHintForModel('OpenAI', 'openai.gpt-5.6-sol')).toBe(
            'High-depth reasoning & coding (Responses API)'
        );
    });

    it('covers the live-sync provider families with specific hints', () => {
        expect(generateHintForModel('OpenAI', 'openai.gpt-oss-120b-1:0')).toBe(
            'Open-weights GPT model for self-hosted or fine-tuned inference'
        );
        expect(generateHintForModel('OpenAI', 'openai.gpt-oss-safeguard-20b')).toBe(
            'Safety moderation & content classification'
        );
        expect(generateHintForModel('Amazon', 'us.amazon.nova-2-lite-v1:0')).toBe(
            'Multimodal reasoning, coding & cost-efficient generation'
        );
        // Known nova tiers keep their specific hints ahead of the catch-all.
        expect(generateHintForModel('Amazon', 'us.amazon.nova-pro-v1:0')).toBe(
            'Multimodal reasoning, coding & agentic workflows (no FTU form required)'
        );
        // Family beats size: voxtral-small is speech, not a small text model.
        expect(generateHintForModel('Mistral AI', 'mistral.voxtral-small-24b-2507')).toBe(
            'Audio & speech-to-text multimodal understanding'
        );
        expect(generateHintForModel('Mistral AI', 'mistral.devstral-2-123b')).toBe(
            'Specialized software engineering & code reasoning'
        );
        expect(generateHintForModel('stability', 'us.stability.stable-image-inpaint-v1:0')).toBe(
            'Image generation, upscaling & editing'
        );
        expect(generateHintForModel('twelvelabs', 'us.twelvelabs.pegasus-1-2-v1:0')).toBe(
            'Video understanding, search & narrative extraction'
        );
        expect(generateHintForModel('writer', 'us.writer.palmyra-x5-v1:0')).toBe(
            'Enterprise-focused writing, document analysis & vision'
        );
        expect(generateHintForModel('NVIDIA', 'nvidia.nemotron-super-3-120b')).toBe(
            'High-performance enterprise reasoning & synthetic data generation'
        );
        expect(generateHintForModel('Qwen', 'qwen.qwen3-coder-480b-a35b-v1:0')).toBe(
            'Multilingual reasoning, coding & vision understanding'
        );
        expect(generateHintForModel('MiniMax', 'minimax.minimax-m2.1')).toBe(
            'Long-context multilingual generation & agentic workflows'
        );
        expect(generateHintForModel('Zhipu AI', 'zai.glm-4.7-flash')).toBe(
            'Bilingual Chinese-English reasoning, coding & tool use'
        );
    });

    it('falls back to the generic hint for unknown families', () => {
        expect(generateHintForModel('Anthropic', 'anthropic.claude-nebula-1')).toBe(GENERIC_MODEL_HINT);
        expect(generateHintForModel('Acme', 'acme.mystery-1')).toBe(GENERIC_MODEL_HINT);
        expect(GENERIC_MODEL_HINT).toBe('Live AWS Bedrock model');
    });

    it('gives every bundled model a specific, buzzword-free hint', () => {
        const catalog = loadBedrockCatalog();
        for (const group of catalog.providers) {
            for (const model of group.models) {
                expect(model.hint).not.toBe(GENERIC_MODEL_HINT);
                expect(model.hint).not.toMatch(/frontier/i);
                expect(model.hint).not.toMatch(/latest/i);
                expect(model.hint).toBe(generateHintForModel(group.provider, model.id));
            }
        }
        expect(validateCatalogHints(catalog).ok).toBe(true);
    });
});

describe('validateCatalogHints', () => {
    function catalogWith(modelsByProvider) {
        const defaultModelId = 'us.anthropic.claude-sonnet-4-6';
        return {
            updatedAt: '2026-09-27',
            defaultModelId,
            providers: Object.entries(modelsByProvider).map(([provider, models]) => ({
                provider,
                models: models.map((id) => ({
                    id,
                    name: id,
                    hint: generateHintForModel(provider, id, { defaultModelId }),
                })),
            })),
        };
    }

    it('fails on any unrecognized flagship Anthropic/OpenAI family', () => {
        const result = validateCatalogHints(catalogWith({
            Anthropic: ['anthropic.claude-nebula-1'],
            Cohere: ['cohere.command-r-plus-v1:0'],
        }));
        expect(result.ok).toBe(false);
        expect(result.unmatchedModels.map((entry) => entry.id)).toContain('anthropic.claude-nebula-1');
    });

    it('fails when generic hints exceed maxGenericRatio', () => {
        const many = Array.from({ length: 10 }, (_, index) => `acme.unknown-${index}`);
        const over = validateCatalogHints(catalogWith({ Acme: many }));
        expect(over.ok).toBe(false);
        expect(over.unmatchedRatio).toBeGreaterThan(0.15);
        const under = validateCatalogHints(
            catalogWith({
                Acme: ['acme.unknown-0'],
                Cohere: Array.from({ length: 9 }, () => 'cohere.command-r-plus-v1:0'),
            })
        );
        expect(under.ok).toBe(true);
    });

    it('flags stale generic hints even when rules now match', () => {
        const catalog = {
            updatedAt: '2026-09-27',
            defaultModelId: 'us.anthropic.claude-sonnet-4-6',
            providers: [{
                provider: 'Cohere',
                models: [{ id: 'cohere.command-r-plus-v1:0', name: 'Command R+', hint: GENERIC_MODEL_HINT }],
            }],
        };
        const result = validateCatalogHints(catalog);
        expect(result.ok).toBe(false);
        expect(result.unmatchedModels).toHaveLength(1);
    });
});

describe('interactive model selector', () => {
    beforeEach(() => {
        vi.mocked(select).mockReset();
        vi.mocked(text).mockReset();
    });

    it('writes the provider -> model selection to bedrock.tf, main.tf, and worker.tf', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        writeWorkerTf(dir);
        vi.mocked(select)
            .mockResolvedValueOnce('Anthropic')
            .mockResolvedValueOnce('us.anthropic.claude-haiku-4-5-20251001-v1:0');
        const result = await runAdd({ cwd: dir, capability: 'ai:bedrock', interactive: true });
        expect(result.ok).toBe(true);
        const chosen = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
        expect(fs.readFileSync(path.join(dir, 'terraform', 'bedrock.tf'), 'utf-8')).toContain(`value = "${chosen}"`);
        expect(fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8')).toContain(chosen);
        expect(fs.readFileSync(path.join(dir, 'terraform', 'worker.tf'), 'utf-8')).toContain(chosen);
    });

    it('accepts a custom model ID and trims whitespace', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        vi.mocked(select).mockResolvedValueOnce(CUSTOM_MODEL_VALUE);
        vi.mocked(text).mockResolvedValueOnce('  us.custom.trimmed-model  ');
        const result = await runAdd({ cwd: dir, capability: 'ai:bedrock', interactive: true });
        expect(result.ok).toBe(true);
        expect(fs.readFileSync(path.join(dir, 'terraform', 'bedrock.tf'), 'utf-8')).toContain('value = "us.custom.trimmed-model"');
    });

    it('rejects an invalid custom model ID with INVALID_MODEL_ID', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        vi.mocked(select).mockResolvedValueOnce('Anthropic').mockResolvedValueOnce(CUSTOM_MODEL_VALUE);
        vi.mocked(text).mockResolvedValueOnce('bad model!');
        const result = await runAdd({ cwd: dir, capability: 'ai:bedrock', interactive: true });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('invalid-model-id');
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(fs.existsSync(path.join(dir, 'terraform', 'bedrock.tf'))).toBe(false);
    });

    it('returns cancelled cleanly when a prompt is dismissed', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        vi.mocked(select).mockResolvedValueOnce(Symbol('clack:cancel'));
        const result = await runAdd({ cwd: dir, capability: 'ai:bedrock', interactive: true });
        expect(result).toEqual({ ok: false, reason: 'cancelled' });
        expect(trackEvent).toHaveBeenCalledWith('add_run', expect.objectContaining({
            capability: 'ai:bedrock',
            success: false,
            reason: 'cancelled',
        }));
        expect(flushTelemetry).toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(dir, 'terraform', 'bedrock.tf'))).toBe(false);
    });
});

describe('Day-2 model switching', () => {
    it('switches models without --force and upserts in place without duplication', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        writeWorkerTf(dir);
        await runAdd({ cwd: dir, capability: 'ai:bedrock', model: 'model.a-first', modelProvided: true });
        const switched = await runAdd({ cwd: dir, capability: 'ai:bedrock', model: 'model.b-second', modelProvided: true });
        expect(switched.ok).toBe(true);
        const bedrockTf = fs.readFileSync(path.join(dir, 'terraform', 'bedrock.tf'), 'utf-8');
        expect(bedrockTf).toContain('value = "model.b-second"');
        expect(bedrockTf).not.toContain('model.a-first');
        for (const file of ['main.tf', 'worker.tf']) {
            const content = fs.readFileSync(path.join(dir, 'terraform', file), 'utf-8');
            expect(content).toContain('model.b-second');
            expect(content).not.toContain('model.a-first');
            expect(content.match(/BEDROCK_MODEL_ID/g)).toHaveLength(1);
        }
    });

    it('still guards non-explicit bedrock reruns with ADDON_ALREADY_EXISTS', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'ai:bedrock', model: 'model.a-first', modelProvided: true });
        const rerun = await runAdd({ cwd: dir, capability: 'ai:bedrock' });
        expect(rerun.ok).toBe(false);
        expect(rerun.reason).toBe('addon-already-exists');
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('upserts BEDROCK_MODEL_ID in place only for opt-in keys', () => {
        const dir = makeTmp();
        writeMainTf(dir, '{ name = "BEDROCK_MODEL_ID", value = "model.a-first" },');
        const before = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        // Default callers keep skip-if-present behavior.
        expect(injectContainerEnvVars(before, [{ name: 'BEDROCK_MODEL_ID', value: 'model.b-second' }])).toBe(before);
        // Opt-in callers replace the value in place.
        const after = injectContainerEnvVars(
            before,
            [{ name: 'BEDROCK_MODEL_ID', value: 'model.b-second' }],
            'app',
            { upsertKeys: ['BEDROCK_MODEL_ID'] }
        );
        expect(after).toContain('model.b-second');
        expect(after).not.toContain('model.a-first');
        expect(after.match(/BEDROCK_MODEL_ID/g)).toHaveLength(1);
        // Identical values leave the text untouched.
        expect(injectContainerEnvVars(
            after,
            [{ name: 'BEDROCK_MODEL_ID', value: 'model.b-second' }],
            'app',
            { upsertKeys: ['BEDROCK_MODEL_ID'] }
        )).toBe(after);
        // JSON spelling and the options-object third argument also work.
        const jsonEnv = before.replace('{ name = "BEDROCK_MODEL_ID", value = "model.a-first" }', '{ "name": "BEDROCK_MODEL_ID", "value": "model.a-first" }');
        const jsonAfter = injectContainerEnvVars(
            jsonEnv,
            [{ name: 'BEDROCK_MODEL_ID', value: 'model.b-second' }],
            { upsertKeys: ['BEDROCK_MODEL_ID'] }
        );
        expect(jsonAfter).toContain('"value": "model.b-second"');
    });

    it('upserts values containing terraform interpolations in place', () => {
        const dir = makeTmp();
        writeMainTf(dir, '{ "name": "REDIS_URL", "value": "redis://${aws_elasticache_cluster.redis.cache_nodes[0].address}:6379" },');
        const before = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        const after = injectContainerEnvVars(
            before,
            [{ name: 'REDIS_URL', value: 'redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:${aws_elasticache_replication_group.redis.port}' }],
            'app',
            { upsertKeys: ['REDIS_URL'] }
        );
        expect(after).toContain('aws_elasticache_replication_group');
        expect(after).not.toContain('aws_elasticache_cluster');
        expect(after.match(/REDIS_URL/g)).toHaveLength(1);
    });
});

describe('add: fuzzer hardening', () => {
    let exitSpy;
    let consoleSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });

    it('routes unresolvable projects through PROJECT_NOT_INITIALIZED', async () => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => { throw new Error('deleted'); });
        try {
            const result = await runAdd(null);
            expect(result).toEqual({ ok: false, reason: 'project-not-initialized' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(trackEvent).toHaveBeenCalledWith('add_run', expect.objectContaining({
                success: false,
                error_code: 'PROJECT_NOT_INITIALIZED',
            }));
        } finally {
            cwdSpy.mockRestore();
        }
    });

    it.each([null, 42, true, { port: 'string' }])('parseAddArgs(%s) returns defaults', (bad) => {
        expect(parseAddArgs(bad)).toEqual({
            partitionKey: DEFAULT_PARTITION_KEY,
            model: DEFAULT_BEDROCK_MODEL,
            modelProvided: false,
            listModels: false,
            refresh: false,
            isHeadless: false,
            force: false,
        });
    });
});

describe('email:ses flag parsing', () => {
    it('parses --domain, --from-email, and --zone-id in both forms', () => {
        const spaced = parseAddArgs(['add', 'email:ses', '--domain', 'example.com', '--from-email', 'hi@example.com', '--zone-id', 'Z1']);
        expect(spaced).toMatchObject({ capability: 'email:ses', domain: 'example.com', fromEmail: 'hi@example.com', zoneId: 'Z1' });
        const joined = parseAddArgs(['add', 'email:ses', '--domain=example.com', '--from-email=hi@example.com', '--zone-id=Z1']);
        expect(joined).toMatchObject({ capability: 'email:ses', domain: 'example.com', fromEmail: 'hi@example.com', zoneId: 'Z1' });
    });

    it('silently ignores SES flags on other capabilities', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'storage:s3', domain: 'not a domain!!!', zoneId: 'bogus' });
        expect(result.ok).toBe(true);
        expect(exitSpy).not.toHaveBeenCalled();
    });
});

describe('email:ses pre-guard validation', () => {
    it('rejects an invalid --domain before the terraform guard', async () => {
        const result = await runAdd({ cwd: makeTmp(), capability: 'email:ses', domain: 'not a domain' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('invalid-domain');
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('add_run', expect.objectContaining({
            error_code: 'INVALID_DOMAIN',
        }));
    });

    it('rejects an invalid --zone-id before the terraform guard', async () => {
        const result = await runAdd({ cwd: makeTmp(), capability: 'email:ses', domain: 'example.com', zoneId: 'bogus' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('invalid-zone-id');
        expect(trackEvent).toHaveBeenCalledWith('add_run', expect.objectContaining({
            error_code: 'INVALID_ZONE_ID',
        }));
    });

    it('rejects a --from-email outside the explicit --domain', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'email:ses', domain: 'example.com', fromEmail: 'hi@other.com' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('invalid-from-email');
        expect(fs.existsSync(path.join(dir, 'terraform', 'ses.tf'))).toBe(false);
    });

    it('defers --from-email validation until the domain resolves', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        // No explicit --domain and no domain.tf: the missing domain (not the
        // sender) is reported in headless mode.
        const result = await runAdd({ cwd: dir, capability: 'email:ses', fromEmail: 'hi@other.com' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('missing-ses-domain');
    });

    it('fails headless without a domain as MISSING_SES_DOMAIN', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'email:ses' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('missing-ses-domain');
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('add_run', expect.objectContaining({
            error_code: 'MISSING_SES_DOMAIN',
        }));
    });

    it('rejects wildcard domains for SES identities', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'email:ses', domain: '*.example.com' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('invalid-domain');
        expect(fs.existsSync(path.join(dir, 'terraform', 'ses.tf'))).toBe(false);
    });
});

describe('email:ses generated terraform', () => {
    it('renders ses.tf with identity, DKIM, MAIL FROM, task role wiring, and outputs', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'email:ses', domain: 'Example.COM', region: 'eu-west-1' });
        expect(result.ok).toBe(true);
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'ses.tf'), 'utf-8');
        expect(rendered).toContain('resource "aws_ses_domain_identity" "ses"');
        expect(rendered).toContain('domain = "example.com"');
        expect(rendered).toContain('resource "aws_ses_domain_dkim" "ses"');
        expect(rendered).toContain('resource "aws_ses_domain_mail_from" "ses"');
        expect(rendered).toContain('mail_from_domain       = "mail.example.com"');
        expect(rendered).toContain('role = aws_iam_role.task_role.id');
        expect(rendered).toContain('"ses:SendEmail"');
        expect(rendered).toContain('"ses:SendRawEmail"');
        expect(rendered).toContain('"ses:FromAddress"');
        expect(rendered).toContain('"*@example.com"');
        expect(rendered).toContain('"noreply@example.com"');
        expect(rendered).toContain('output "ses_domain_identity_arn"');
        expect(rendered).toContain('output "ses_verification_token"');
        expect(rendered).toContain('output "ses_dkim_tokens"');
        expect(rendered).not.toContain('aws_caller_identity');
        expect(rendered).not.toContain('{{SES_DOMAIN}}');
        expect(rendered).not.toContain('{{SES_FROM_EMAIL}}');
        expect(rendered).not.toContain('{{SES_ROUTE53_RECORDS_BLOCK}}');
        expect(rendered).not.toContain('{{REGION}}');
        // External-DNS mode: no Route 53 records.
        expect(rendered).not.toContain('aws_route53_record');
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('SES_FROM_EMAIL');
        expect(mainTf).toContain('noreply@example.com');
        expect(mainTf).toContain('SES_REGION');
        expect(mainTf).toContain('eu-west-1');
    });

    it('renders Route 53 records with --zone-id and honors --from-email', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        writeWorkerTf(dir);
        const result = await runAdd({
            cwd: dir, capability: 'email:ses', domain: 'example.com',
            fromEmail: 'hello@example.com', zoneId: '/hostedzone/Z123', region: 'us-east-2',
        });
        expect(result.ok).toBe(true);
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'ses.tf'), 'utf-8');
        expect(rendered).toContain('resource "aws_route53_record" "ses_verification"');
        expect(rendered).toContain('resource "aws_route53_record" "ses_dkim"');
        expect(rendered).toContain('resource "aws_route53_record" "ses_mail_from_mx"');
        expect(rendered).toContain('resource "aws_route53_record" "ses_mail_from_spf"');
        expect(rendered).toContain('resource "aws_route53_record" "ses_dmarc"');
        expect(rendered).toContain('zone_id = "Z123"');
        expect(rendered).toContain('"10 feedback-smtp.us-east-2.amazonses.com"');
        expect(rendered).toContain('"hello@example.com"');
        const workerTf = fs.readFileSync(path.join(dir, 'terraform', 'worker.tf'), 'utf-8');
        expect(workerTf).toContain('SES_FROM_EMAIL');
        expect(workerTf).toContain('hello@example.com');
        expect(workerTf).toContain('SES_REGION');
    });

    it('auto-detects the domain and zone from terraform/domain.tf', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        fs.writeFileSync(
            path.join(dir, 'terraform', 'domain.tf'),
            [
                '# deploy-stack:domain-mode=route53',
                '# deploy-stack:zone-id=Z999',
                'resource "aws_acm_certificate" "domain" {',
                '  domain_name = "shop.example.com"',
                '}',
                '',
            ].join('\n')
        );
        const result = await runAdd({ cwd: dir, capability: 'email:ses', region: 'us-east-2' });
        expect(result.ok).toBe(true);
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'ses.tf'), 'utf-8');
        expect(rendered).toContain('domain = "shop.example.com"');
        expect(rendered).toContain('zone_id = "Z999"');
        expect(rendered).toContain('resource "aws_route53_record" "ses_dkim"');
        expect(fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8')).toContain('noreply@shop.example.com');
    });

    it('prefers an explicit --zone-id over the domain.tf zone', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        fs.writeFileSync(
            path.join(dir, 'terraform', 'domain.tf'),
            '# deploy-stack:domain-mode=route53\n# deploy-stack:zone-id=Z999\nresource "aws_acm_certificate" "domain" {\n  domain_name = "shop.example.com"\n}\n'
        );
        await runAdd({ cwd: dir, capability: 'email:ses', zoneId: 'Z111', region: 'us-east-2' });
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'ses.tf'), 'utf-8');
        expect(rendered).toContain('domain = "shop.example.com"');
        expect(rendered).toContain('zone_id = "Z111"');
        expect(rendered).not.toContain('Z999');
    });

    it('updates SES env values in place on --force reruns', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'email:ses', domain: 'example.com', fromEmail: 'a@example.com', region: 'us-east-2' });
        const rerun = await runAdd({ cwd: dir, capability: 'email:ses', domain: 'example.com', fromEmail: 'b@example.com', region: 'eu-west-1', force: true });
        expect(rerun.ok).toBe(true);
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('b@example.com');
        expect(mainTf).not.toContain('a@example.com');
        expect(mainTf).toContain('eu-west-1');
        expect(mainTf.match(/SES_FROM_EMAIL/g)).toHaveLength(1);
        expect(mainTf.match(/SES_REGION/g)).toHaveLength(1);
    });

    it('guards SES identity resources to the default workspace', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'email:ses', domain: 'example.com', region: 'us-east-2' });
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'ses.tf'), 'utf-8');
        const guards = rendered.split('= terraform.workspace == "default" ? 1 : 0').length - 1;
        expect(guards).toBe(3);
        expect(rendered).toContain('aws_ses_domain_identity.ses[0].domain');
        expect(rendered).toContain('value = terraform.workspace == "default" ? aws_ses_domain_identity.ses[0].arn : null');
        expect(rendered).toContain('value = terraform.workspace == "default" ? aws_ses_domain_identity.ses[0].verification_token : null');
        expect(rendered).toContain('value = terraform.workspace == "default" ? aws_ses_domain_dkim.ses[0].dkim_tokens : []');
        // IAM policy stays unguarded: per-workspace role over the shared identity.
        const policyStart = rendered.indexOf('resource "aws_iam_role_policy" "ses_send"');
        const policyBlock = rendered.slice(policyStart, rendered.indexOf('\n}\n', policyStart));
        expect(policyBlock).not.toContain('terraform.workspace');
    });

    it('guards SES Route 53 records to the default workspace', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'email:ses', domain: 'example.com', zoneId: 'Z123', region: 'us-east-2' });
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'ses.tf'), 'utf-8');
        expect(rendered).toContain('count   = terraform.workspace == "default" ? 3 : 0');
        expect(rendered).toContain('aws_ses_domain_dkim.ses[0].dkim_tokens[count.index]');
        expect(rendered).toContain('[aws_ses_domain_identity.ses[0].verification_token]');
        const guards = rendered.split('count   = terraform.workspace == "default" ? 1 : 0').length - 1;
        expect(guards).toBe(4);
    });
});

describe('email:ses interactive prompt', () => {
    beforeEach(() => {
        vi.mocked(text).mockReset();
    });

    it('prompts for the domain and honors cancellation with telemetry', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        vi.mocked(text).mockResolvedValueOnce('prompted.example.com');
        const result = await runAdd({ cwd: dir, capability: 'email:ses', interactive: true, region: 'us-east-2' });
        expect(result.ok).toBe(true);
        expect(vi.mocked(text)).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Amazon SES'),
        }));
        expect(fs.readFileSync(path.join(dir, 'terraform', 'ses.tf'), 'utf-8'))
            .toContain('domain = "prompted.example.com"');

        const dir2 = makeTmp();
        writeMainTf(dir2);
        vi.mocked(text).mockResolvedValueOnce(Symbol('clack:cancel'));
        const cancelled = await runAdd({ cwd: dir2, capability: 'email:ses', interactive: true });
        expect(cancelled).toEqual({ ok: false, reason: 'cancelled' });
        expect(trackEvent).toHaveBeenCalledWith('add_run', expect.objectContaining({
            capability: 'email:ses', success: false, reason: 'cancelled',
        }));
        expect(exitSpy).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(dir2, 'terraform', 'ses.tf'))).toBe(false);
    });
});

describe('cron flag parsing', () => {
    it('parses --schedule, --cmd/--cron-command, --name, and --timezone', () => {
        const options = parseAddArgs(['add', 'cron', '--schedule', 'rate(1 hour)', '--cmd', 'node scripts/cleanup.js', '--name', 'nightly', '--timezone', 'America/New_York']);
        expect(options).toMatchObject({
            capability: 'cron',
            schedule: 'rate(1 hour)',
            cronCommand: 'node scripts/cleanup.js',
            name: 'nightly',
            timezone: 'America/New_York',
        });
        expect(parseAddArgs(['add', 'cron', '--cron-command=node job.js']).cronCommand).toBe('node job.js');
    });
});

describe('cron pre-guard validation', () => {
    it('rejects bad schedules, timezones, and empty names', () => {
        expect(validateAddonFlags('cron', { schedule: 'every friday' }).errorCode).toBe('INVALID_CRON_SCHEDULE');
        expect(validateAddonFlags('cron', { schedule: 'cron(0 2 * * ? *)' })).toBeNull();
        expect(validateAddonFlags('cron', { timezone: 'Mars/Olympus?' }).errorCode).toBe('INVALID_TIMEZONE');
        expect(validateAddonFlags('cron', { timezone: 'UTC' })).toBeNull();
        expect(validateAddonFlags('cron', { name: '!!!' }).errorCode).toBe('INVALID_CRON_NAME');
        expect(validateAddonFlags('cron', {})).toBeNull();
    });

    it('sanitizes job slugs to lowercase [a-z0-9-]', () => {
        expect(sanitizeCronName('Nightly_Cleanup!!')).toBe('nightly-cleanup');
        expect(sanitizeCronName('---')).toBe('');
        expect(sanitizeCronName('a'.repeat(40))).toHaveLength(32);
    });
});

describe('cron generated terraform', () => {
    it('renders cron.tf with headless defaults and no placeholders', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'cron', region: 'us-east-2' });
        expect(result.ok).toBe(true);
        expect(result.file).toBe('terraform/cron.tf');
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'cron.tf'), 'utf-8');
        expect(rendered).toMatch(new RegExp(`schedule_expression\\s+= "${DEFAULT_CRON_SCHEDULE.replace(/[()*?]/g, '\\$&')}"`));
        expect(rendered).toContain('schedule_expression_timezone = "UTC"');
        expect(rendered).toMatch(/name\s+= "\$\{local\.app_name\}-cron-daily-job"/);
        expect(rendered).toContain(`["sh", "-c", ${JSON.stringify(DEFAULT_CRON_COMMAND)}]`);
        expect(rendered).toContain('resource "aws_scheduler_schedule" "cron"');
        expect(rendered).toContain('resource "aws_iam_role" "scheduler_cron_role"');
        expect(rendered).not.toContain('{{');
        // Bare single references keep tflint clean (no "${...}" wrappers).
        expect(rendered).toContain('role = aws_iam_role.scheduler_cron_role.id');
        expect(rendered).toContain('arn      = aws_ecs_cluster.main.arn');
        expect(rendered).toContain('task_definition_arn = aws_ecs_task_definition.app.arn');
        // Revision-proof RunTask grant: pinned ARN plus family wildcard.
        expect(rendered).toContain('aws_ecs_task_definition.app.arn,');
        expect(rendered).toContain('"${aws_ecs_task_definition.app.arn_without_revision}:*"');
        expect(trackEvent).toHaveBeenCalledWith('add_run', expect.objectContaining({ capability: 'cron', success: true }));
    });

    it('honors explicit flags and JSON-escapes the command', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({
            cwd: dir,
            capability: 'cron',
            region: 'us-east-2',
            schedule: 'rate(1 hour)',
            cronCommand: 'node -e "console.log(1)"',
            name: 'Hourly_Job',
            timezone: 'America/New_York',
        });
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'cron.tf'), 'utf-8');
        expect(rendered).toMatch(/schedule_expression\s+= "rate\(1 hour\)"/);
        expect(rendered).toContain('"${local.app_name}-cron-hourly-job"');
        expect(rendered).toContain(`["sh", "-c", ${JSON.stringify('node -e "console.log(1)"')}]`);
    });

    it('injects no container env vars and skips the env list in outro', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const { outro } = await import('@clack/prompts');
        const result = await runAdd({ cwd: dir, capability: 'cron', region: 'us-east-2' });
        expect(result.envInjected).toBe(false);
        expect(fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8')).not.toContain('CRON');
        expect(vi.mocked(outro)).toHaveBeenCalledWith(expect.not.stringContaining('Available in your container'));
    });

    it('requires --force to replace the single schedule in place', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'cron', region: 'us-east-2' });
        const second = await runAdd({ cwd: dir, capability: 'cron', region: 'us-east-2', schedule: 'rate(1 hour)' });
        expect(second).toMatchObject({ ok: false, reason: 'addon-already-exists' });
        expect(exitSpy).not.toHaveBeenCalled();
        const forced = await runAdd({ cwd: dir, capability: 'cron', region: 'us-east-2', schedule: 'rate(1 hour)', force: true });
        expect(forced.ok).toBe(true);
        expect(fs.readFileSync(path.join(dir, 'terraform', 'cron.tf'), 'utf-8')).toContain('rate(1 hour)');
    });

    it('rejects schedule names over the 64-char Scheduler limit', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const resolved = await resolveAddonOptions('cron', { projectName: 'a'.repeat(60), name: 'daily-job' }, { cwd: dir, region: 'us-east-2' });
        expect(resolved.ok).toBe(false);
        expect(resolved.errorCode).toBe('INVALID_CRON_NAME');
    });
});

describe('cron interactive prompt', () => {
    beforeEach(() => {
        vi.mocked(select).mockReset();
        vi.mocked(text).mockReset();
    });

    it('offers schedule presets and honors cancellation', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        vi.mocked(select).mockResolvedValueOnce('rate(15 minutes)');
        vi.mocked(text).mockResolvedValueOnce('node scripts/cleanup.js');
        const result = await runAdd({ cwd: dir, capability: 'cron', interactive: true, region: 'us-east-2' });
        expect(result.ok).toBe(true);
        expect(vi.mocked(select)).toHaveBeenCalledWith(expect.objectContaining({ message: 'Choose a schedule:' }));
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'cron.tf'), 'utf-8');
        expect(rendered).toContain('rate(15 minutes)');
        expect(rendered).toContain(JSON.stringify('node scripts/cleanup.js'));

        const dir2 = makeTmp();
        writeMainTf(dir2);
        vi.mocked(select).mockResolvedValueOnce(Symbol('clack:cancel'));
        const cancelled = await runAdd({ cwd: dir2, capability: 'cron', interactive: true });
        expect(cancelled).toEqual({ ok: false, reason: 'cancelled' });
        expect(fs.existsSync(path.join(dir2, 'terraform', 'cron.tf'))).toBe(false);
    });

    it('validates custom expressions from the prompt', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        vi.mocked(select).mockResolvedValueOnce('__custom__');
        vi.mocked(text).mockResolvedValueOnce('whenever');
        const result = await runAdd({ cwd: dir, capability: 'cron', interactive: true, region: 'us-east-2' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('invalid-cron-schedule');
    });
});

const LAMBDA_MAIN_TF = [
    'locals {',
    '  app_name = "myapp${local.env_suffix}"',
    '}',
    '',
    'resource "aws_lambda_function" "app" {',
    '  function_name = "${local.app_name}-fn"',
    '  environment {',
    '    variables = {',
    '      PORT            = "3000"',
    '      AWS_LWA_PORT    = "3000"',
    '      APP_SECRETS_ARN = local.secret_arn',
    '    }',
    '  }',
    '}',
    '',
].join('\n');

function writeLambdaMainTf(dir, mainTf = LAMBDA_MAIN_TF) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), mainTf);
}

describe('injectLambdaEnvVars', () => {
    it('inserts map entries and renders lone interpolations as bare references', () => {
        const updated = injectLambdaEnvVars(LAMBDA_MAIN_TF, S3_ENV);
        expect(updated).toContain('S3_BUCKET_NAME = aws_s3_bucket.storage.id');
        expect(updated).toContain('S3_CDN_URL = "https://${aws_cloudfront_distribution.storage_cdn.domain_name}"');
    });

    it('skips existing keys and replaces upsert keys in place', () => {
        const withVar = injectLambdaEnvVars(LAMBDA_MAIN_TF, [{ name: 'BEDROCK_MODEL_ID', value: 'old.model' }]);
        expect(withVar).toContain('BEDROCK_MODEL_ID = "old.model"');

        const rerun = injectLambdaEnvVars(withVar, [{ name: 'BEDROCK_MODEL_ID', value: 'new.model' }]);
        expect(rerun).toBe(withVar);

        const upserted = injectLambdaEnvVars(
            withVar,
            [{ name: 'BEDROCK_MODEL_ID', value: 'new.model' }],
            { upsertKeys: ['BEDROCK_MODEL_ID'] }
        );
        expect(upserted).toContain('BEDROCK_MODEL_ID = "new.model"');
        expect(upserted).not.toContain('"old.model"');
    });

    it('returns ECS content and empty input unchanged', () => {
        const ecsMainTf = 'resource "aws_ecs_task_definition" "app" {}\n';
        expect(injectLambdaEnvVars(ecsMainTf, S3_ENV)).toBe(ecsMainTf);
        expect(injectLambdaEnvVars(LAMBDA_MAIN_TF, [])).toBe(LAMBDA_MAIN_TF);
    });
});

describe('ensureLambdaVpcConfig', () => {
    it('attaches vpc_config once and leaves ECS projects untouched', () => {
        const once = ensureLambdaVpcConfig(LAMBDA_MAIN_TF);
        expect(once).toContain('vpc_config {');
        expect(once).toContain('security_group_ids = [aws_security_group.ecs_tasks.id]');
        expect(ensureLambdaVpcConfig(once)).toBe(once);
        expect(ensureLambdaVpcConfig('resource "aws_ecs_service" "app" {}')).toBe('resource "aws_ecs_service" "app" {}');
    });
});

describe('lambda generated terraform', () => {
    it('injects addon env vars into the function variables map', async () => {
        const dir = makeTmp();
        writeLambdaMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'storage:s3' });
        expect(result.ok).toBe(true);
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('S3_BUCKET_NAME = aws_s3_bucket.storage.id');
        expect(mainTf).toContain('S3_CDN_URL = "https://${aws_cloudfront_distribution.storage_cdn.domain_name}"');
    });

    it('scaffolds the Lambda-targeted cron schedule', async () => {
        const dir = makeTmp();
        writeLambdaMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'cron', region: 'us-east-2' });
        expect(result.ok).toBe(true);
        expect(result.file).toBe('terraform/cron.tf');
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'cron.tf'), 'utf-8');
        expect(rendered).toContain('arn      = aws_lambda_function.app.arn');
        expect(rendered).toContain('"lambda:InvokeFunction"');
        expect(rendered).toContain(`command = ${JSON.stringify(DEFAULT_CRON_COMMAND)}`);
        expect(rendered).not.toContain('{{');
        expect(rendered).not.toContain('aws_ecs_cluster');
    });

    it('attaches vpc_config when adding redis to a non-VPC function', async () => {
        const dir = makeTmp();
        writeLambdaMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'db:redis' });
        expect(result.ok).toBe(true);
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('vpc_config {');
        expect(mainTf).toContain('REDIS_URL = ');
    });
});
