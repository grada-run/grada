// Single source of truth for `grada add` capabilities.
// Imported by both src/commands/add.js and src/utils/visualizer.js.
// Keep this module dependency-free so neither importer creates a cycle.
export const ADDON_REGISTRY = {
    'storage:s3': {
        file: 's3.tf',
        template: 's3.tf',
        label: 'S3 + CloudFront OAC',
        cost: {
            model: 'usage-based',
            monthlyFixed: 0,
            summary: '$0/mo fixed baseline; billed per GB stored ($0.023/GB-mo), S3 PUT/GET requests, and CloudFront egress',
        },
    },
    'db:dynamodb': {
        file: 'dynamodb.tf',
        template: 'dynamodb.tf',
        label: 'DynamoDB (On-Demand + PITR)',
        cost: {
            model: 'usage-based',
            monthlyFixed: 0,
            summary: '$0/mo fixed instance baseline (VPC Gateway Endpoint is free); billed per read/write request, table storage ($0.25/GB-mo), and PITR continuous backups ($0.20/GB-mo once data is written)',
        },
    },
    'db:redis': {
        file: 'redis.tf',
        template: 'redis.tf',
        label: 'ElastiCache Valkey 8.0',
        cost: {
            model: 'fixed-baseline',
            monthlyFixed: 9.49,
            summary: '~$9.49/mo fixed baseline ($0.013/hr Valkey 8.0 cache.t4g.micro in us-east-2); $0 intra-AZ VPC transfer',
        },
    },
    'queue:sqs': {
        file: 'sqs.tf',
        template: 'sqs.tf',
        label: 'SQS + DLQ',
        cost: {
            model: 'usage-based',
            monthlyFixed: 0,
            summary: '$0/mo fixed baseline; first 1M requests/mo free, then $0.40 per million requests',
        },
    },
    'ai:bedrock': {
        file: 'bedrock.tf',
        template: 'bedrock.tf',
        label: 'Bedrock Runtime IAM',
        cost: {
            model: 'usage-based',
            monthlyFixed: 0,
            summary: '$0/mo fixed baseline; billed per 1K input/output tokens on InvokeModel calls',
        },
    },
    'email:ses': {
        file: 'ses.tf',
        template: 'ses.tf',
        label: 'Amazon SES (Transactional Email & DKIM)',
        cost: {
            model: 'usage-based',
            monthlyFixed: 0,
            summary: '$0/mo fixed baseline; $0.10 per 1,000 emails sent',
        },
    },
    'cron': {
        file: 'cron.tf',
        template: 'cron.tf',
        label: 'EventBridge Scheduler (Cron)',
        cost: {
            model: 'usage-based',
            monthlyFixed: 0,
            summary: '$0/mo fixed baseline (first 14M EventBridge Scheduler invocations/mo free); billed only for Fargate seconds while the cron task runs',
        },
    },
};

// Capability-vs-target policy: what `grada add` may do per compute
// target. Every registry capability plus every relational engine carries
// an explicit row — no capability falls through to an implicit default.
// Dispositions: `allow` (proceed), `warn` (proceed with an unwired
// warning), `refuse` (fail STATIC_TARGET_UNSUPPORTED). Consulted once at
// the top of runAdd/runAddDatabase, before the TOCTOU guards.
export const ADDON_TARGET_POLICY = {
    'storage:s3': { ecs: 'allow', lambda: 'allow', static: 'allow' },
    'db:dynamodb': { ecs: 'allow', lambda: 'allow', static: 'allow' },
    'db:redis': { ecs: 'allow', lambda: 'allow', static: 'allow' },
    'queue:sqs': { ecs: 'allow', lambda: 'warn', static: 'warn' },
    'ai:bedrock': { ecs: 'allow', lambda: 'allow', static: 'allow' },
    'email:ses': { ecs: 'allow', lambda: 'allow', static: 'allow' },
    'cron': { ecs: 'allow', lambda: 'allow', static: 'refuse' },
    'db:postgres': { ecs: 'allow', lambda: 'allow', static: 'refuse' },
    'db:mysql': { ecs: 'allow', lambda: 'allow', static: 'refuse' },
    'db:aurora-postgresql': { ecs: 'allow', lambda: 'allow', static: 'refuse' },
};

// Resolves a capability's disposition for a compute target. Unknown
// capabilities default open — they fail later with UNSUPPORTED_CAPABILITY.
export function addonTargetDisposition(capability, target) {
    const row = ADDON_TARGET_POLICY[capability];
    if (!row) return 'allow';
    return row[target] ?? 'allow';
}

// Targets a capability may be added to (allow + warn rows). Feeds the
// refuse-level guardComputeTarget descriptor.
export function addonSupportedTargets(capability) {
    const row = ADDON_TARGET_POLICY[capability];
    if (!row) return ['ecs', 'lambda', 'static'];
    return ['ecs', 'lambda', 'static'].filter((target) => row[target] !== 'refuse');
}

// Container environment variables injected into the ECS task definitions
// per capability. Values are static HCL expressions or `(ctx) => string`
// resolvers for dynamic values (model IDs, SES sender/region). Lone
// "${...}" values render as bare HCL references via renderEnvValue in
// src/commands/add.js; literals and multi-part interpolations stay quoted.
export const ADDON_ENV_VARS = {
    'storage:s3': [
        { name: 'S3_BUCKET_NAME', value: '${aws_s3_bucket.storage.id}' },
        { name: 'S3_CDN_URL', value: 'https://${aws_cloudfront_distribution.storage_cdn.domain_name}' },
    ],
    'db:dynamodb': [
        { name: 'DYNAMODB_TABLE_NAME', value: '${aws_dynamodb_table.main.name}' },
    ],
    'db:redis': [
        { name: 'REDIS_URL', value: 'redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:${aws_elasticache_replication_group.redis.port}' },
    ],
    'queue:sqs': [
        { name: 'SQS_QUEUE_URL', value: '${aws_sqs_queue.main.id}' },
        { name: 'SQS_DLQ_URL', value: '${aws_sqs_queue.dlq.id}' },
    ],
    'ai:bedrock': [
        { name: 'BEDROCK_MODEL_ID', value: (ctx) => ctx.model },
    ],
    'email:ses': [
        { name: 'SES_FROM_EMAIL', value: (ctx) => ctx.sesFromEmail },
        { name: 'SES_REGION', value: (ctx) => ctx.region },
    ],
};

// Keys whose values are replaced in place on reruns (Day-2 switching)
// instead of the default skip-if-present behavior.
export const ADDON_UPSERT_KEYS = {
    'ai:bedrock': ['BEDROCK_MODEL_ID'],
    'db:redis': ['REDIS_URL'],
    'email:ses': ['SES_FROM_EMAIL', 'SES_REGION'],
};

// Resolves `{ name, value }` entries for `capability`, evaluating
// function values against `ctx` (`{ region, model, sesFromEmail }`).
// Entries resolving to empty values are dropped.
export function resolveAddonEnvVars(capability, ctx = {}) {
    const entries = ADDON_ENV_VARS[capability] || [];
    const resolved = [];
    for (const entry of entries) {
        const value = typeof entry.value === 'function' ? entry.value(ctx) : entry.value;
        if (typeof value !== 'string' || value === '') continue;
        resolved.push({ name: entry.name, value });
    }
    return resolved;
}
