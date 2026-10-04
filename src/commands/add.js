import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import color from 'picocolors';
import { intro, outro, select, text, spinner, log, cancel, isCancel } from '@clack/prompts';
import { trackEvent, flushTelemetry, trackSuccess, isActiveEnvValue, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { resolveRegion, resolveProjectName, resolveCwd, readFileSafe, detectComputeTargetFromMainTf } from '../utils/resolvers.js';
import { ADDON_REGISTRY, ADDON_UPSERT_KEYS, resolveAddonEnvVars } from '../utils/addons.js';
import { normalizeDomain, isValidDomain, normalizeZoneId, isValidFromEmail, parseDomainTf } from '../utils/domains.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { failCommand, failProjectNotInitialized, isProgrammaticCall } from '../utils/command.js';
import { findArrayBounds, findMapBounds, findNestedBlock, findResourceBlock, enclosingBraceBounds } from '../utils/hcl.js';
import { syncDocCostEstimate } from '../utils/visualizer.js';
import {
    FALLBACK_BEDROCK_MODEL,
    GENERIC_MODEL_HINT,
    findCatalogEntry,
    loadBedrockCatalog,
    normalizeProviderName,
    refreshBedrockCatalog,
    resolveModelIdForRegion,
} from '../utils/bedrock-catalog.js';

export { ADDON_REGISTRY };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_PARTITION_KEY = 'id';
export const PARTITION_KEY_RE = /^[a-zA-Z0-9_.-]+$/;
export const DEFAULT_BEDROCK_MODEL = loadBedrockCatalog().defaultModelId || FALLBACK_BEDROCK_MODEL;
export const MODEL_ID_RE = /^[a-zA-Z0-9_.:-]+$/;
export const CUSTOM_MODEL_VALUE = '__custom__';

// EventBridge Scheduler expressions (`cron(...)`, `rate(...)`, `at(...)`)
// plus safe IANA timezone characters. Single schedule per project: `--name`
// customizes it, `--force` replaces it in place.
export const CRON_SCHEDULE_RE = /^(cron|rate|at)\(.+\)$/;
export const CRON_TIMEZONE_RE = /^[A-Za-z0-9/_+-]{1,64}$/;
export const CRON_CUSTOM_VALUE = '__custom__';
export const DEFAULT_CRON_SCHEDULE = 'cron(0 0 * * ? *)';
export const DEFAULT_CRON_COMMAND = 'npm run cron';
export const DEFAULT_CRON_NAME = 'daily-job';
export const MAX_SCHEDULE_NAME_LENGTH = 64;

// Normalizes a `--name` job slug to lowercase `[a-z0-9-]` (runs of other
// characters collapse to one hyphen, edges trimmed, capped at 32 chars so
// `${app}-cron-${name}` stays within the 64-char Scheduler limit).
export function sanitizeCronName(raw) {
    return String(raw ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
}

const TEMPLATES_DIR = path.join(__dirname, '../../templates/terraform/addons');

export function parseAddArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'add') args.shift();
    const { options: parsed, rest } = parseFlags(args, {
        string: ['region', 'project-name', 'partition-key', 'model', 'domain', 'from-email', 'zone-id', 'schedule', { name: 'cmd', key: 'cronCommand' }, { name: 'cron-command', key: 'cronCommand' }, 'name', 'timezone'],
        boolean: ['force', { name: 'headless', key: 'isHeadless' }],
        bareBoolean: ['list-models', 'refresh'],
    });
    const options = {
        partitionKey: DEFAULT_PARTITION_KEY,
        model: DEFAULT_BEDROCK_MODEL,
        modelProvided: false,
        listModels: false,
        refresh: false,
        isHeadless: false,
        force: false,
        ...parsed,
    };
    if (parsed.model !== undefined) options.modelProvided = true;
    for (const arg of rest) {
        if (typeof arg === 'string' && !arg.startsWith('-') && options.capability === undefined) {
            options.capability = arg;
        }
    }
    return options;
}

// Locates the first `environment = [...]` array of the primary container in
// `aws_ecs_task_definition."<taskDefinitionName>"`. Returns the bracket
// bounds or null when the resource or array cannot be found.
function findEnvBlockBounds(content, taskDefinitionName) {
    const resource = findResourceBlock(content, 'aws_ecs_task_definition', taskDefinitionName);
    if (!resource) return null;
    const block = content.slice(resource.openIdx, resource.closeIdx + 1);
    const array = findArrayBounds(block, 'environment');
    if (!array) return null;
    return { openIdx: resource.openIdx + array.openIdx, closeIdx: resource.openIdx + array.closeIdx };
}

function envNameExists(block, name) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) return false;
    const exists = new RegExp(`"name"\\s*[:=]\\s*"${name}"|\\bname\\s*=\\s*"${name}"`);
    return exists.test(block);
}

function escapeRegExp(raw) {
    return String(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Renders an env `value` for HCL: a lone "${...}" interpolation becomes a
// bare reference (tflint terraform_deprecated_interpolation), while literal
// strings and multi-part interpolations ("https://${...}") stay quoted.
function renderEnvValue(value) {
    const single = /^\$\{([^{}]+)\}$/.exec(String(value));
    return single ? single[1] : `"${value}"`;
}

// Replaces the `value` of the `{ name = "<name>", value = ... }` object
// inside an environment block, in either HCL or JSON spelling and with a
// quoted or bare current value. Returns the block unchanged when the entry
// is missing or already holds newValue.
function upsertEnvValueInBlock(block, name, newValue) {
    const namePattern = new RegExp(`(?:"name"|name)\\s*[:=]\\s*"${escapeRegExp(name)}"`);
    const nameMatch = namePattern.exec(block);
    if (!nameMatch) return block;
    const bounds = enclosingBraceBounds(block, nameMatch.index);
    if (!bounds) return block;
    const objText = block.slice(bounds.openIdx, bounds.closeIdx + 1);
    const rendered = renderEnvValue(newValue);
    const valuePattern = /((?:"value"|value)\s*[:=]\s*)("[^"]*"|[^\s,}]+)/;
    const valueMatch = objText.match(valuePattern);
    if (!valueMatch || valueMatch[2] === rendered) return block;
    const replacement = objText.replace(valuePattern, () => `${valueMatch[1]}${rendered}`);
    return block.slice(0, bounds.openIdx) + replacement + block.slice(bounds.closeIdx + 1);
}

// Inserts { name, value } entries into the first `environment = [...]` array
// of the primary container in `aws_ecs_task_definition."<taskDefinitionName>"`
// (`"app"` for main.tf, `"worker"` for worker.tf), skipping keys that already
// exist so reruns (e.g. with --force) stay idempotent — except keys listed in
// `options.upsertKeys`, whose values are replaced in place (Day-2 switching
// for `BEDROCK_MODEL_ID`, migration refreshes like `REDIS_URL`). Returns the
// content unchanged when the resource or array cannot be found.
export function injectContainerEnvVars(tfContent, envEntries = [], taskDefinitionName = 'app', options = {}) {
    if (typeof taskDefinitionName === 'object' && taskDefinitionName !== null) {
        options = taskDefinitionName;
        taskDefinitionName = options.taskDefinitionName || 'app';
    }
    if (!Array.isArray(envEntries) || envEntries.length === 0) return tfContent;
    const content = String(tfContent ?? '');
    const upsertKeys = new Set(options.upsertKeys || []);

    const bounds = findEnvBlockBounds(content, taskDefinitionName);
    if (!bounds) return content;
    const { openIdx, closeIdx } = bounds;

    const block = content.slice(openIdx, closeIdx + 1);
    const missing = envEntries.filter(({ name }) => !envNameExists(block, name));
    let updated = content;
    if (missing.length > 0) {
        const inner = content.slice(openIdx + 1, closeIdx);
        const glue = inner.trim() === '' ? '\n        ' : ',\n        ';
        const insertion = missing
            .map(({ name, value }) => `{ name = "${name}", value = ${renderEnvValue(value)} }`)
            .join(',\n        ');
        // Strip a dangling comma so files rendered with one (e.g. worker.tf
        // without a database, or hand-edited arrays) never produce `, ,`.
        const prefix = content.slice(0, closeIdx).replace(/,\s*$/, '');
        updated = `${prefix}${glue}${insertion}\n      ${content.slice(closeIdx)}`;
    }

    const upserts = envEntries.filter(({ name }) => upsertKeys.has(name));
    if (upserts.length === 0) return updated;
    const upsertBounds = findEnvBlockBounds(updated, taskDefinitionName);
    if (!upsertBounds) return updated;
    let upsertBlock = updated.slice(upsertBounds.openIdx, upsertBounds.closeIdx + 1);
    for (const { name, value } of upserts) {
        upsertBlock = upsertEnvValueInBlock(upsertBlock, name, value);
    }
    return updated.slice(0, upsertBounds.openIdx) + upsertBlock + updated.slice(upsertBounds.closeIdx + 1);
}

// Locates the `variables = {...}` map inside the `environment` block of
// `aws_lambda_function."app"`. Returns the brace bounds or null when the
// resource, block, or map cannot be found.
function findLambdaVariablesBounds(content) {
    const resource = findResourceBlock(content, 'aws_lambda_function', 'app');
    if (!resource) return null;
    const resourceBlock = content.slice(resource.openIdx, resource.closeIdx + 1);
    const environment = findNestedBlock(resourceBlock, 'environment');
    if (!environment) return null;
    const environmentBlock = resourceBlock.slice(environment.openIdx, environment.closeIdx + 1);
    const variables = findMapBounds(environmentBlock, 'variables');
    if (!variables) return null;
    const base = resource.openIdx + environment.openIdx;
    return { openIdx: base + variables.openIdx, closeIdx: base + variables.closeIdx };
}

function lambdaVarExists(mapBlock, name) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) return false;
    return new RegExp(`(?:^|[^A-Za-z0-9_])${name}\\s*=`).test(mapBlock);
}

// Replaces the value of the `NAME = ...` entry inside a Lambda variables
// map, with a quoted or bare current value. Returns the block unchanged
// when the entry is missing or already holds newValue.
function upsertLambdaVarInBlock(mapBlock, name, newValue) {
    const pattern = new RegExp(`((?:^|[^A-Za-z0-9_])${escapeRegExp(name)}\\s*=\\s*)("[^"]*"|[^\\s}]+)`, 'm');
    const match = mapBlock.match(pattern);
    if (!match) return mapBlock;
    const rendered = renderEnvValue(newValue);
    if (match[2] === rendered) return mapBlock;
    return mapBlock.replace(pattern, () => `${match[1]}${rendered}`);
}

// Inserts { name, value } entries into the `environment { variables = {...} }`
// map of `aws_lambda_function."app"`, skipping keys that already exist so
// reruns stay idempotent — except keys listed in `options.upsertKeys`, whose
// values are replaced in place (mirroring injectContainerEnvVars). Returns
// the content unchanged when the resource or map cannot be found.
export function injectLambdaEnvVars(tfContent, envEntries = [], options = {}) {
    if (!Array.isArray(envEntries) || envEntries.length === 0) return tfContent;
    const content = String(tfContent ?? '');
    const upsertKeys = new Set(options.upsertKeys || []);

    const bounds = findLambdaVariablesBounds(content);
    if (!bounds) return content;
    const { openIdx, closeIdx } = bounds;

    const block = content.slice(openIdx, closeIdx + 1);
    const missing = envEntries.filter(({ name }) => !lambdaVarExists(block, name));
    let updated = content;
    if (missing.length > 0) {
        const prefix = content.slice(0, closeIdx).replace(/[ \t]+$/, '');
        const insertion = missing
            .map(({ name, value }) => `      ${name} = ${renderEnvValue(value)}`)
            .join('\n');
        updated = `${prefix.endsWith('\n') ? prefix : `${prefix}\n`}${insertion}\n    ${content.slice(closeIdx)}`;
    }

    const upserts = envEntries.filter(({ name }) => upsertKeys.has(name));
    if (upserts.length === 0) return updated;
    const upsertBounds = findLambdaVariablesBounds(updated);
    if (!upsertBounds) return updated;
    let upsertBlock = updated.slice(upsertBounds.openIdx, upsertBounds.closeIdx + 1);
    for (const { name, value } of upserts) {
        upsertBlock = upsertLambdaVarInBlock(upsertBlock, name, value);
    }
    return updated.slice(0, upsertBounds.openIdx) + upsertBlock + updated.slice(upsertBounds.closeIdx + 1);
}

// `vpc_config` attaching the Lambda function to the VPC subnets so it can
// reach RDS and ElastiCache without a NAT gateway.
export const LAMBDA_VPC_CONFIG_BLOCK = `  vpc_config {
    subnet_ids         = aws_subnet.public[*].id
    security_group_ids = [aws_security_group.ecs_tasks.id]
  }`;

// Idempotently attaches `vpc_config` to `aws_lambda_function."app"` (used
// when `add db:redis` runs on a Lambda project generated without a
// database). Returns the content unchanged for ECS projects or when the
// function is already VPC-attached.
export function ensureLambdaVpcConfig(mainTfContent) {
    const content = String(mainTfContent ?? '');
    const resource = findResourceBlock(content, 'aws_lambda_function', 'app');
    if (!resource) return content;
    const block = content.slice(resource.openIdx, resource.closeIdx + 1);
    const uncommented = block.split('\n').map((line) => {
        const hash = line.indexOf('#');
        return hash === -1 ? line : line.slice(0, hash);
    }).join('\n');
    if (/vpc_config\s*\{/.test(uncommented)) return content;
    const prefix = content.slice(0, resource.closeIdx);
    const glue = prefix.endsWith('\n') ? '' : '\n';
    return `${prefix}${glue}${LAMBDA_VPC_CONFIG_BLOCK}\n${content.slice(resource.closeIdx)}`;
}

// Queue-depth auto-scaling for the dedicated ECS worker service. Rendered
// active when terraform/worker.tf exists, otherwise commented out so users
// can uncomment it after adding a worker. Application Auto Scaling creates
// the AWSServiceRoleForApplicationAutoScaling_ECSService service-linked
// role automatically upon target registration.
export const WORKER_AUTOSCALING_HCL = `# --- SQS Queue-Depth Auto-Scaling (worker service only) ---
# Scales aws_ecs_service.worker between 0 and 5 tasks. Never attach
# min_capacity = 0 scaling to aws_ecs_service.app (it serves HTTP traffic).
resource "aws_appautoscaling_target" "worker_scale" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/\${aws_ecs_cluster.main.name}/\${aws_ecs_service.worker.name}"
  min_capacity       = 0
  max_capacity       = 5
}

resource "aws_appautoscaling_policy" "worker_scale_out" {
  name               = "\${local.app_name}-worker-scale-out"
  service_namespace  = aws_appautoscaling_target.worker_scale.service_namespace
  scalable_dimension = aws_appautoscaling_target.worker_scale.scalable_dimension
  resource_id        = aws_appautoscaling_target.worker_scale.resource_id
  policy_type        = "StepScaling"

  step_scaling_policy_configuration {
    adjustment_type = "ChangeInCapacity"
    cooldown        = 60

    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment          = 1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "sqs_queue_high" {
  alarm_name          = "\${local.app_name}-sqs-queue-high"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Average"
  threshold           = 1

  dimensions = {
    QueueName = aws_sqs_queue.main.name
  }

  alarm_actions = [aws_appautoscaling_policy.worker_scale_out.arn]
}

resource "aws_appautoscaling_policy" "worker_scale_in" {
  name               = "\${local.app_name}-worker-scale-in"
  service_namespace  = aws_appautoscaling_target.worker_scale.service_namespace
  scalable_dimension = aws_appautoscaling_target.worker_scale.scalable_dimension
  resource_id        = aws_appautoscaling_target.worker_scale.resource_id
  policy_type        = "StepScaling"

  step_scaling_policy_configuration {
    adjustment_type = "ChangeInCapacity"
    cooldown        = 300

    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = -5
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "sqs_queue_empty" {
  alarm_name          = "\${local.app_name}-sqs-queue-empty"
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods  = 5
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0

  dimensions = {
    QueueName = aws_sqs_queue.main.name
  }

  alarm_actions = [aws_appautoscaling_policy.worker_scale_in.arn]
}`;

export function renderWorkerAutoscalingBlock(hasWorker) {
    if (hasWorker) return WORKER_AUTOSCALING_HCL;
    return WORKER_AUTOSCALING_HCL.split('\n')
        .map((line) => (line === '' ? '#' : `# ${line}`))
        .join('\n');
}

// Renders an addon template by substituting `{{PLACEHOLDER}}` variables
// and named conditional blocks. Placeholders absent from a template are
// no-ops, so callers pass the full maps unconditionally.
function renderAddonTemplate(templateContent, templateVars = {}, conditionalBlocks = {}) {
    let rendered = String(templateContent ?? '');
    for (const [key, value] of Object.entries(templateVars)) {
        rendered = rendered.replaceAll(`{{${key}}}`, value ?? '');
    }
    for (const [key, value] of Object.entries(conditionalBlocks)) {
        rendered = rendered.replaceAll(`{{${key}}}`, value ?? '');
    }
    return rendered;
}

// Renders the optional Route 53 verification/DKIM/SPF/DMARC records for
// `add email:ses --zone-id`. Returns '' in external-DNS mode (records
// are then created by hand from the `ses_*` outputs).
export function renderSesRoute53RecordsBlock({ domain, zoneId, region }) {
    if (!domain || !zoneId || !region) return '';
    return `# --- Route 53 DNS Records for SES (auto-managed) ---
# Scoped to the default workspace: these FQDNs are singletons and must
# not be duplicated (or destroyed) by PR preview workspaces.
resource "aws_route53_record" "ses_verification" {
  count   = terraform.workspace == "default" ? 1 : 0
  zone_id = "${zoneId}"
  name    = "_amazonses.${domain}"
  type    = "TXT"
  ttl     = 600
  records = [aws_ses_domain_identity.ses[0].verification_token]
}

resource "aws_route53_record" "ses_dkim" {
  count   = terraform.workspace == "default" ? 3 : 0
  zone_id = "${zoneId}"
  name    = "\${aws_ses_domain_dkim.ses[0].dkim_tokens[count.index]}._domainkey.${domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["\${aws_ses_domain_dkim.ses[0].dkim_tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_mx" {
  count   = terraform.workspace == "default" ? 1 : 0
  zone_id = "${zoneId}"
  name    = "mail.${domain}"
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.${region}.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_spf" {
  count   = terraform.workspace == "default" ? 1 : 0
  zone_id = "${zoneId}"
  name    = "mail.${domain}"
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "ses_dmarc" {
  count   = terraform.workspace == "default" ? 1 : 0
  zone_id = "${zoneId}"
  name    = "_dmarc.${domain}"
  type    = "TXT"
  ttl     = 600
  records = ["v=DMARC1; p=none;"]
}
`;
}

// Idempotently adds `lifecycle { ignore_changes = [desired_count] }` to
// `aws_ecs_service.worker` so queue-depth auto-scaling does not cause
// Terraform drift on existing projects. Returns the content unchanged when
// the resource is missing or already ignores changes.
export function ensureWorkerDesiredCountLifecycle(workerTfContent) {
    const content = String(workerTfContent ?? '');
    const resource = findResourceBlock(content, 'aws_ecs_service', 'worker');
    if (!resource) return content;
    const { openIdx, closeIdx } = resource;

    const block = content.slice(openIdx, closeIdx + 1);
    if (block.includes('ignore_changes')) return content;

    const insertion = '\n  lifecycle {\n    ignore_changes = [desired_count]\n  }\n';
    return `${content.slice(0, closeIdx)}${insertion}${content.slice(closeIdx)}`;
}

async function promptBedrockProvider(catalog) {
    const providerOptions = catalog.providers.map((group) => ({
        value: group.provider,
        label: group.provider,
        hint: group.models.map((entry) => entry.name).slice(0, 3).join(', '),
    }));
    providerOptions.push({ value: CUSTOM_MODEL_VALUE, label: 'Custom model ID...' });
    return select({ message: 'Choose a Bedrock provider:', options: providerOptions });
}

async function promptBedrockModel(group) {
    const modelOptions = group.models.map((entry) => ({
        value: entry.id,
        label: `${entry.name} (${entry.id})`,
        hint: entry.hint,
    }));
    modelOptions.push({ value: CUSTOM_MODEL_VALUE, label: 'Custom model ID...' });
    return select({ message: `Choose a ${group.provider} model:`, options: modelOptions });
}

async function promptCustomModelId() {
    return text({ message: 'Enter a Bedrock model ID:', placeholder: DEFAULT_BEDROCK_MODEL });
}

async function promptCronSchedule() {
    return select({
        message: 'Choose a schedule:',
        options: [
            { value: 'rate(1 hour)', label: 'Hourly', hint: 'rate(1 hour)' },
            { value: 'cron(0 0 * * ? *)', label: 'Daily at 00:00 UTC', hint: 'cron(0 0 * * ? *)' },
            { value: 'rate(15 minutes)', label: 'Every 15 minutes', hint: 'rate(15 minutes)' },
            { value: CRON_CUSTOM_VALUE, label: 'Custom expression...' },
        ],
    });
}

async function promptCustomSchedule() {
    return text({ message: 'Enter a schedule expression:', placeholder: 'cron(0 2 * * ? *)' });
}

async function promptCronCommand() {
    return text({ message: 'Command to run inside the container:', placeholder: DEFAULT_CRON_COMMAND });
}

// An explicitly passed option: anything but undefined/null/blank-string.
// Non-string values count as explicit so they fail validation instead of
// silently falling through to auto-detection.
function explicitStringOption(options, key) {
    const raw = options[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'string' && raw.trim() === '') return undefined;
    return raw;
}

// Pre-guard flag validation shared by every capability: explicit flags
// fail fast with structured errors before the terraform/overwrite guards
// (matching the historical `--model` / `--partition-key` order).
// Returns null when valid, or `{ errorCode, reason, message, hint }`.
export function validateAddonFlags(capability, options = {}) {
    const opts = normalizeOptions(options);
    if (capability === 'db:dynamodb') {
        const partitionKey = opts.partitionKey ?? DEFAULT_PARTITION_KEY;
        if (!PARTITION_KEY_RE.test(String(partitionKey))) {
            return {
                errorCode: 'INVALID_PARTITION_KEY',
                reason: 'invalid-partition-key',
                message: `\n✖ Invalid partition key "${partitionKey}".`,
                hint: '  Use only letters, numbers, underscore, hyphen, and dot (e.g. --partition-key userId).\n',
            };
        }
    }
    if (capability === 'ai:bedrock') {
        const model = opts.model ?? DEFAULT_BEDROCK_MODEL;
        if (!MODEL_ID_RE.test(String(model))) {
            return {
                errorCode: 'INVALID_MODEL_ID',
                reason: 'invalid-model-id',
                message: `\n✖ Invalid model ID "${model}".`,
                hint: `  Use only letters, numbers, underscore, dot, colon, and hyphen (e.g. --model ${DEFAULT_BEDROCK_MODEL}).\n`,
            };
        }
    }
    if (capability === 'cron') {
        const schedule = explicitStringOption(opts, 'schedule');
        if (schedule !== undefined && !CRON_SCHEDULE_RE.test(String(schedule).trim())) {
            return {
                errorCode: 'INVALID_CRON_SCHEDULE',
                reason: 'invalid-cron-schedule',
                message: `\n✖ Invalid schedule expression "${schedule}".`,
                hint: '  Use an EventBridge Scheduler expression like "cron(0 2 * * ? *)" or "rate(1 hour)".\n',
            };
        }
        const timezone = explicitStringOption(opts, 'timezone');
        if (timezone !== undefined && !CRON_TIMEZONE_RE.test(String(timezone).trim())) {
            return {
                errorCode: 'INVALID_TIMEZONE',
                reason: 'invalid-timezone',
                message: `\n✖ Invalid timezone "${timezone}".`,
                hint: '  Use an IANA timezone like UTC or America/New_York.\n',
            };
        }
        const name = explicitStringOption(opts, 'name');
        if (name !== undefined && sanitizeCronName(name) === '') {
            return {
                errorCode: 'INVALID_CRON_NAME',
                reason: 'invalid-cron-name',
                message: `\n✖ Invalid job name "${name}".`,
                hint: '  Use a lowercase slug with letters, numbers, and hyphens (e.g. --name nightly-cleanup).\n',
            };
        }
    }
    if (capability === 'email:ses') {
        const domain = explicitStringOption(opts, 'domain');
        if (domain !== undefined && !isValidDomain(domain)) {
            return {
                errorCode: 'INVALID_DOMAIN',
                reason: 'invalid-domain',
                message: `\n✖ Invalid domain "${domain}".`,
                hint: '  Use a fully qualified domain name (e.g. --domain example.com).\n',
            };
        }
        const zoneId = explicitStringOption(opts, 'zoneId');
        if (zoneId !== undefined && normalizeZoneId(zoneId) === null) {
            return {
                errorCode: 'INVALID_ZONE_ID',
                reason: 'invalid-zone-id',
                message: `\n✖ Invalid Route 53 zone ID "${zoneId}".`,
                hint: '  Zone IDs look like Z1234567890ABC (find yours with: aws route53 list-hosted-zones).\n',
            };
        }
        const fromEmail = explicitStringOption(opts, 'fromEmail');
        if (fromEmail !== undefined && domain !== undefined && !isValidFromEmail(fromEmail, domain)) {
            return {
                errorCode: 'INVALID_FROM_EMAIL',
                reason: 'invalid-from-email',
                message: `\n✖ Invalid --from-email "${fromEmail}".`,
                hint: `  Use an address on your SES domain (e.g. noreply@${normalizeDomain(domain)}).\n`,
            };
        }
    }
    return null;
}

function invalidModelFailure(model) {
    return {
        errorCode: 'INVALID_MODEL_ID',
        reason: 'invalid-model-id',
        message: `\n✖ Invalid model ID "${model}".`,
        hint: `  Use only letters, numbers, underscore, dot, colon, and hyphen (e.g. --model ${DEFAULT_BEDROCK_MODEL}).\n`,
    };
}

// Post-guard option resolution per capability: interactive prompts,
// auto-detection, and template/env assembly. `ctx` carries
// `{ cwd, region, isInteractive, heldCatalog }`. Returns
// `{ ok: true, templateVars, conditionalBlocks, envVars, upsertKeys, meta }`,
// `{ ok: false, cancelled: true }`, or a structured validation failure.
export async function resolveAddonOptions(capability, options = {}, ctx = {}) {
    const opts = normalizeOptions(options);
    const context = normalizeOptions(ctx);
    const cwd = context.cwd || process.cwd();
    const region = context.region || resolveRegion(opts, cwd);
    const isInteractive = context.isInteractive === true;
    const heldCatalog = context.heldCatalog || null;
    const upsertKeys = [...(ADDON_UPSERT_KEYS[capability] || [])];

    const flagError = validateAddonFlags(capability, opts);
    if (flagError) return { ok: false, ...flagError };

    if (capability === 'db:dynamodb') {
        return {
            ok: true,
            templateVars: { REGION: region, PARTITION_KEY: opts.partitionKey ?? DEFAULT_PARTITION_KEY },
            conditionalBlocks: {},
            envVars: resolveAddonEnvVars(capability, { region }),
            upsertKeys,
            meta: {},
        };
    }

    if (capability === 'ai:bedrock') {
        const explicitModel = opts.modelProvided === true || (opts.model !== undefined && opts.modelProvided !== false);
        let model = opts.model ?? DEFAULT_BEDROCK_MODEL;
        let selectedInteractively = false;
        let customTypedModel = false;
        if (isInteractive && !explicitModel) {
            const catalog = heldCatalog || loadBedrockCatalog({ cachePath: opts.cachePath });
            const providerChoice = await promptBedrockProvider(catalog);
            if (isCancel(providerChoice)) return { ok: false, cancelled: true };
            if (providerChoice === CUSTOM_MODEL_VALUE) {
                const custom = await promptCustomModelId();
                if (isCancel(custom)) return { ok: false, cancelled: true };
                model = String(custom).trim();
                if (!MODEL_ID_RE.test(model)) return { ok: false, ...invalidModelFailure(model) };
                customTypedModel = true;
            } else {
                const group = catalog.providers.find((candidate) => candidate.provider === providerChoice);
                const modelChoice = await promptBedrockModel(group);
                if (isCancel(modelChoice)) return { ok: false, cancelled: true };
                if (modelChoice === CUSTOM_MODEL_VALUE) {
                    const custom = await promptCustomModelId();
                    if (isCancel(custom)) return { ok: false, cancelled: true };
                    model = String(custom).trim();
                    if (!MODEL_ID_RE.test(model)) return { ok: false, ...invalidModelFailure(model) };
                    customTypedModel = true;
                } else {
                    model = modelChoice;
                }
            }
            selectedInteractively = true;
        }
        if (!explicitModel && !customTypedModel) {
            // Catalog-derived IDs (default or picker choice) align to the
            // project's region; user-typed IDs stay verbatim.
            const catalog = heldCatalog || loadBedrockCatalog({ cachePath: opts.cachePath });
            model = resolveModelIdForRegion(findCatalogEntry(catalog, model) || model, region);
        }
        return {
            ok: true,
            templateVars: { REGION: region, BEDROCK_MODEL_ID: model },
            conditionalBlocks: {},
            envVars: resolveAddonEnvVars(capability, { region, model }),
            upsertKeys,
            meta: { model, explicitModel, selectedInteractively },
        };
    }

    if (capability === 'email:ses') {
        const explicitDomain = explicitStringOption(opts, 'domain');
        const explicitZoneId = explicitStringOption(opts, 'zoneId');
        const explicitFromEmail = explicitStringOption(opts, 'fromEmail');
        let domain = explicitDomain !== undefined ? normalizeDomain(explicitDomain) : null;
        let zoneId = null;
        if (explicitZoneId !== undefined) {
            zoneId = normalizeZoneId(explicitZoneId);
            if (zoneId === null) {
                return {
                    ok: false,
                    errorCode: 'INVALID_ZONE_ID',
                    reason: 'invalid-zone-id',
                    message: `\n✖ Invalid Route 53 zone ID "${explicitZoneId}".`,
                    hint: '  Zone IDs look like Z1234567890ABC (find yours with: aws route53 list-hosted-zones).\n',
                };
            }
        }
        if (domain === null) {
            const domainTf = readFileSafe(path.join(cwd, 'terraform', 'domain.tf'));
            if (domainTf) {
                const parsed = parseDomainTf(domainTf);
                if (parsed && parsed.domain) {
                    domain = parsed.domain;
                    if (zoneId === null && parsed.zoneId) zoneId = parsed.zoneId;
                }
            }
        }
        if (domain === null) {
            if (!isInteractive) {
                return {
                    ok: false,
                    errorCode: 'MISSING_SES_DOMAIN',
                    reason: 'missing-ses-domain',
                    message: '\n✖ No domain for Amazon SES. Pass --domain <domain> or run from a project with terraform/domain.tf.\n',
                    hint: null,
                };
            }
            const answer = await text({ message: 'Enter the domain for Amazon SES (e.g. example.com):' });
            if (isCancel(answer)) return { ok: false, cancelled: true };
            if (typeof answer !== 'string' || !answer.trim()) {
                return {
                    ok: false,
                    errorCode: 'MISSING_SES_DOMAIN',
                    reason: 'missing-ses-domain',
                    message: '\n✖ No domain for Amazon SES. Pass --domain <domain> or run from a project with terraform/domain.tf.\n',
                    hint: null,
                };
            }
            domain = normalizeDomain(answer);
        }
        if (!isValidDomain(domain)) {
            return {
                ok: false,
                errorCode: 'INVALID_DOMAIN',
                reason: 'invalid-domain',
                message: `\n✖ Invalid domain "${domain}".`,
                hint: '  Use a fully qualified domain name (e.g. --domain example.com).\n',
            };
        }
        if (domain.startsWith('*.')) {
            return {
                ok: false,
                errorCode: 'INVALID_DOMAIN',
                reason: 'invalid-domain',
                message: `\n✖ Invalid domain "${domain}" for Amazon SES: SES domain identities do not support wildcards.`,
                hint: '  Use the apex domain (e.g. --domain example.com).\n',
            };
        }
        const fromEmail = explicitFromEmail !== undefined ? String(explicitFromEmail).trim() : `noreply@${domain}`;
        if (!isValidFromEmail(fromEmail, domain)) {
            return {
                ok: false,
                errorCode: 'INVALID_FROM_EMAIL',
                reason: 'invalid-from-email',
                message: `\n✖ Invalid --from-email "${explicitFromEmail !== undefined ? explicitFromEmail : fromEmail}".`,
                hint: `  Use an address on your SES domain (e.g. noreply@${domain}).\n`,
            };
        }
        return {
            ok: true,
            templateVars: { REGION: region, SES_DOMAIN: domain, SES_FROM_EMAIL: fromEmail },
            conditionalBlocks: {
                SES_ROUTE53_RECORDS_BLOCK: zoneId ? renderSesRoute53RecordsBlock({ domain, zoneId, region }) : '',
            },
            envVars: resolveAddonEnvVars(capability, { region, sesFromEmail: fromEmail }),
            upsertKeys,
            meta: { domain, zoneId, fromEmail },
        };
    }

    if (capability === 'cron') {
        let schedule = explicitStringOption(opts, 'schedule');
        if (typeof schedule === 'string') schedule = schedule.trim();
        let cronCommand = explicitStringOption(opts, 'cronCommand');
        if (typeof cronCommand === 'string') cronCommand = cronCommand.trim();
        const explicitName = explicitStringOption(opts, 'name');
        const name = explicitName === undefined ? DEFAULT_CRON_NAME : sanitizeCronName(explicitName);
        let timezone = explicitStringOption(opts, 'timezone');
        timezone = typeof timezone === 'string' ? timezone.trim() : 'UTC';

        if (!schedule && isInteractive) {
            const choice = await promptCronSchedule();
            if (isCancel(choice)) return { ok: false, cancelled: true };
            if (choice === CRON_CUSTOM_VALUE) {
                const custom = await promptCustomSchedule();
                if (isCancel(custom)) return { ok: false, cancelled: true };
                schedule = String(custom).trim();
            } else {
                schedule = choice;
            }
        }
        schedule = schedule || DEFAULT_CRON_SCHEDULE;
        if (!CRON_SCHEDULE_RE.test(schedule)) {
            return {
                ok: false,
                errorCode: 'INVALID_CRON_SCHEDULE',
                reason: 'invalid-cron-schedule',
                message: `\n✖ Invalid schedule expression "${schedule}".`,
                hint: '  Use an EventBridge Scheduler expression like "cron(0 2 * * ? *)" or "rate(1 hour)".\n',
            };
        }

        if (!cronCommand && isInteractive) {
            const answer = await promptCronCommand();
            if (isCancel(answer)) return { ok: false, cancelled: true };
            cronCommand = String(answer).trim();
        }
        cronCommand = cronCommand || DEFAULT_CRON_COMMAND;

        if (!CRON_TIMEZONE_RE.test(timezone)) {
            return {
                ok: false,
                errorCode: 'INVALID_TIMEZONE',
                reason: 'invalid-timezone',
                message: `\n✖ Invalid timezone "${timezone}".`,
                hint: '  Use an IANA timezone like UTC or America/New_York.\n',
            };
        }
        if (!name) {
            return {
                ok: false,
                errorCode: 'INVALID_CRON_NAME',
                reason: 'invalid-cron-name',
                message: '\n✖ Invalid job name: it sanitizes to an empty slug.',
                hint: '  Use a lowercase slug with letters, numbers, and hyphens (e.g. --name nightly-cleanup).\n',
            };
        }
        const scheduleName = `${resolveProjectName(opts, cwd)}-cron-${name}`;
        if (scheduleName.length > MAX_SCHEDULE_NAME_LENGTH) {
            return {
                ok: false,
                errorCode: 'INVALID_CRON_NAME',
                reason: 'invalid-cron-name',
                message: `\n✖ Schedule name "${scheduleName}" exceeds the ${MAX_SCHEDULE_NAME_LENGTH}-character EventBridge Scheduler limit.`,
                hint: '  Use a shorter --name (PR-preview workspaces add a suffix on top).\n',
            };
        }

        return {
            ok: true,
            templateVars: {
                REGION: region,
                CRON_NAME: name,
                SCHEDULE_EXPRESSION: schedule,
                SCHEDULE_TIMEZONE: timezone,
                CRON_COMMAND_JSON: JSON.stringify(cronCommand),
            },
            conditionalBlocks: {},
            envVars: resolveAddonEnvVars(capability, { region }),
            upsertKeys,
            meta: { schedule, cronCommand, name, timezone },
        };
    }

    return {
        ok: true,
        templateVars: { REGION: region },
        conditionalBlocks: {},
        envVars: resolveAddonEnvVars(capability, { region }),
        upsertKeys,
        meta: {},
    };
}

// Renders the model catalog as scannable provider sections: one header line
// per provider plus a `• id — hint` bullet per model. Returns one block per
// provider (callers log each block once, keeping bullets contiguous instead
// of separated by logger chrome). Groups that normalize to the same provider
// (live data spells some two ways: writer/Writer, moonshotai/Moonshot AI)
// merge into a single section.
export function formatCatalogListing(catalog) {
    const grouped = new Map();
    for (const group of catalog?.providers || []) {
        const name = normalizeProviderName(group?.provider);
        if (!grouped.has(name)) grouped.set(name, []);
        grouped.get(name).push(...(group?.models || []));
    }
    const blocks = [];
    for (const [name, models] of grouped) {
        const lines = [`${color.bold(name)} (${models.length}):`];
        for (const model of models) {
            const scopeTag = Array.isArray(model.scopes) && model.scopes.length > 1
                ? ` [${model.scopes.join(', ')}]`
                : '';
            lines.push(`  ${color.cyan(`• ${model.id}`)}${scopeTag} — ${color.dim(model.hint || GENERIC_MODEL_HINT)}`);
        }
        blocks.push(lines.join('\n'));
    }
    return blocks;
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runAdd(input = {}) {
    setActiveCommandName('add');
    try {
        return await runAddMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runAddMain(input = {}) {
    const options = normalizeOptions(input);
    const noExit = isProgrammaticCall(options);
    let cwd;
    let projectName;
    try {
        cwd = resolveCwd(options);
        projectName = resolveProjectName(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'add_run', noExit });
    }
    const capability = typeof options.capability === 'string' ? options.capability.trim() : '';
    const force = options.force === true || options.force === 'true';
    const addon = ADDON_REGISTRY[capability];

    intro(color.bgCyan(color.black(' grada add 🧩 ')));

    if (!addon) {
        return failCommand({
            noExit,
            print: () => {
                console.log(color.red(`\n✖ Unknown capability "${capability || 'none'}".`));
                console.log(`  Supported capabilities: ${color.cyan(Object.keys(ADDON_REGISTRY).join(', '))}\n`);
            },
            event: 'add_run',
            telemetry: { capability: capability || 'none', error_code: 'UNSUPPORTED_CAPABILITY' },
            reason: 'unsupported-capability',
            resultExtra: { capability: capability || 'none' },
        });
    }

    const cancelSelection = () => failCommand({
        noExit,
        print: () => cancel(capability === 'email:ses' ? 'SES setup cancelled.' : 'Model selection cancelled.'),
        event: 'add_run',
        telemetry: { projectName, capability, reason: 'cancelled' },
        reason: 'cancelled',
        exitCode: null,
    });

    const failResolved = (failure) => failCommand({
        noExit,
        message: failure.message,
        hint: failure.hint ?? null,
        event: 'add_run',
        telemetry: { projectName, capability, error_code: failure.errorCode },
        reason: failure.reason,
        resultExtra: { capability, projectName },
    });

    // Explicit flags fail fast here, before the terraform/overwrite guards.
    const flagError = validateAddonFlags(capability, options);
    if (flagError) return failResolved(flagError);

    // --refresh fetches live models before listing or provisioning.
    let heldCatalog = null;
    if (capability === 'ai:bedrock' && options.refresh) {
        const s = spinner();
        s.start('Refreshing Bedrock model catalog from AWS...');
        heldCatalog = await refreshBedrockCatalog({
            bedrockClient: options.bedrockClient,
            cachePath: options.cachePath,
            region: options.region,
        });
        s.stop('Bedrock model catalog refreshed.');
    }

    // --list-models works anywhere, even outside a Terraform project.
    if (capability === 'ai:bedrock' && options.listModels) {
        const catalog = heldCatalog || loadBedrockCatalog({ cachePath: options.cachePath });
        for (const block of formatCatalogListing(catalog)) {
            log.info(block);
        }
        outro(`Bedrock catalog ready — ${catalog.providers.length} providers (updated ${catalog.updatedAt}).`);
        await trackSuccess('add_run', { projectName, capability, action: 'list_models' });
        return { ok: true, action: 'list-models', models: catalog.providers };
    }

    const mainTfPath = path.join(cwd, 'terraform', 'main.tf');
    if (!fsSync.existsSync(mainTfPath)) {
        return failCommand({
            noExit,
            message: '\n✖ No terraform/main.tf found. Run "grada" first before adding services.\n',
            event: 'add_run',
            telemetry: { capability, error_code: 'TERRAFORM_NOT_INITIALIZED' },
            reason: 'terraform-not-initialized',
            resultExtra: { capability },
        });
    }

    // Interactive selection runs only on real TTYs without explicit
    // options, so headless runs, CI, and unit tests never block on prompts.
    const isInteractive = options.interactive ?? (
        !options.isHeadless &&
        !isActiveEnvValue(process.env.CI) &&
        !isActiveEnvValue(process.env.VITEST) &&
        process.env.NODE_ENV !== 'test' &&
        Boolean(process.stdout?.isTTY)
    );

    const region = resolveRegion(options, cwd);
    const resolved = await resolveAddonOptions(capability, options, { cwd, region, isInteractive, heldCatalog });
    if (!resolved.ok && resolved.cancelled) return cancelSelection();
    if (!resolved.ok) return failResolved(resolved);

    const targetPath = path.join(cwd, 'terraform', addon.file);
    if (fsSync.existsSync(targetPath) && !force) {
        const canSwitchBedrock = capability === 'ai:bedrock' && (resolved.meta.explicitModel || resolved.meta.selectedInteractively);
        if (!canSwitchBedrock) {
            return failCommand({
                noExit,
                message: `\n⚠ terraform/${addon.file} already exists. Pass --force to overwrite.\n`,
                tone: 'yellow',
                event: 'add_run',
                telemetry: { projectName, capability, error_code: 'ADDON_ALREADY_EXISTS' },
                reason: 'addon-already-exists',
                resultExtra: { capability, projectName, region },
                exitCode: null,
            });
        }
    }

    const scaffolded = await scaffoldAddon(capability, resolved, { cwd, region });
    const envVars = scaffolded.envVars;
    const envInjected = scaffolded.envInjected;

    console.log(color.green(`\n✅ Created terraform/${addon.file}${envInjected ? ' and injected container environment variables' : ''}.`));
    if (scaffolded.workerEnvInjected) {
        console.log(`  ${color.dim('worker:')} injected container environment variables into terraform/worker.tf`);
    }
    if (scaffolded.vpcInjected) {
        console.log(`  ${color.dim('vpc:')} attached vpc_config to the Lambda function so it can reach ElastiCache`);
    }
    for (const { name } of envVars) {
        console.log(`  ${color.dim('env:')} ${color.cyan(name)}`);
    }
    console.log(color.yellow(`\n💰 Cost Impact: ${scaffolded.costImpact}`));

    // Env-less addons (cron carries its command in the schedule input, not
    // in container environment) skip the variable list instead of printing
    // an empty "Available in your container as .".
    const envSuffix = envVars.length > 0
        ? ` Available in your container as ${envVars.map((e) => e.name).join(', ')}.`
        : '';
    outro(
        `Run ${color.green('grada apply')} (or commit and push to trigger CI) to provision ${capability}.${envSuffix}`
    );
    await trackSuccess('add_run', { projectName, capability });
    return { ok: true, capability, projectName, region, file: `terraform/${addon.file}`, envInjected };
}

// Quiet addon scaffolding pipeline shared by `runAdd` and `mainStack`
// (dependency-aware `init`): renders the addon `.tf` file, injects
// container environment variables into `main.tf` and `worker.tf` (when
// present), applies the `queue:sqs` worker lifecycle rule, and refreshes
// the README cost estimate. Takes a `resolveAddonOptions` result as
// `resolvedOpts`. Prints nothing, emits no telemetry, and never exits —
// callers own banners, telemetry, and failure handling.
export async function scaffoldAddon(capability, resolvedOpts, { cwd, region } = {}) {
    void region;
    const addon = ADDON_REGISTRY[capability];
    if (!addon) throw new Error(`Unknown addon capability: ${capability}`);
    const opts = normalizeOptions(resolvedOpts);
    const projectDir = cwd || process.cwd();
    const targetPath = path.join(projectDir, 'terraform', addon.file);
    const mainTfPath = path.join(projectDir, 'terraform', 'main.tf');
    const workerTfPath = path.join(projectDir, 'terraform', 'worker.tf');
    const hasWorker = fsSync.existsSync(workerTfPath);

    const mainTfContent = await fs.readFile(mainTfPath, 'utf-8');
    const isLambda = detectComputeTargetFromMainTf(mainTfContent) === 'lambda';
    const templateName = capability === 'cron' && isLambda ? 'cron-lambda.tf' : addon.template;
    const templateRaw = fsSync.readFileSync(path.join(TEMPLATES_DIR, templateName), 'utf-8');
    const rendered = renderAddonTemplate(templateRaw, opts.templateVars || {}, {
        WORKER_AUTOSCALING_BLOCK: renderWorkerAutoscalingBlock(hasWorker === true),
        ...(opts.conditionalBlocks || {}),
    });
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, rendered);

    const envVars = Array.isArray(opts.envVars) ? opts.envVars : [];
    const upsertKeys = Array.isArray(opts.upsertKeys) ? opts.upsertKeys : [];
    const injectOptions = upsertKeys.length > 0 ? { upsertKeys } : {};
    const updated = isLambda
        ? injectLambdaEnvVars(mainTfContent, envVars, injectOptions)
        : injectContainerEnvVars(mainTfContent, envVars, 'app', injectOptions);
    // ElastiCache lives inside the VPC: attach the function on first Redis
    // provisioning when the project was generated without a database.
    const withVpc = capability === 'db:redis' ? ensureLambdaVpcConfig(updated) : updated;
    const envInjected = withVpc !== mainTfContent;
    const vpcInjected = withVpc !== updated;
    if (envInjected) {
        await fs.writeFile(mainTfPath, withVpc);
    }

    let workerEnvInjected = false;
    if (hasWorker) {
        const workerTfContent = await fs.readFile(workerTfPath, 'utf-8');
        const updatedWorker = injectContainerEnvVars(workerTfContent, envVars, 'worker', injectOptions);
        workerEnvInjected = updatedWorker !== workerTfContent;
        let finalWorker = updatedWorker;
        if (capability === 'queue:sqs') {
            finalWorker = ensureWorkerDesiredCountLifecycle(updatedWorker);
        }
        if (finalWorker !== workerTfContent) {
            await fs.writeFile(workerTfPath, finalWorker);
        }
    }

    await syncDocCostEstimate(projectDir);

    return {
        file: addon.file,
        envVars,
        costImpact: addon.cost.summary,
        envInjected,
        workerEnvInjected,
        vpcInjected,
    };
}

export default runAdd;
