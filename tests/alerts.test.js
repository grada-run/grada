import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { mockSelect, mockText } from './helpers/clack.js';
import { createTmpDirTracker } from './helpers/tmpdir.js';
import fs from 'fs';
import path from 'path';

vi.mock('../src/utils/file-lock.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        withProjectLock: vi.fn((...args) => actual.withProjectLock(...args)),
    };
});

import {
    runAlerts,
    parseAlertsArgs,
    buildAlertsTf,
    buildForwarderJs,
    isValidEmail,
    isValidWebhookUrl,
    detectWebhookKind,
    parseThreshold,
    ensureArchiveProvider,
    detectAlertAddonFeatures,
    ALERTS_TF_FILE,
} from '../src/commands/alerts.js';
import { withProjectLock } from '../src/utils/file-lock.js';
import { trackEvent } from '../src/core/telemetry.js';



const tmp = createTmpDirTracker();
let exitSpy;
let logSpy;

const SLACK_URL = 'https://hooks.slack.com/services/T123/B456/xyz';
const DISCORD_URL = 'https://discord.com/api/webhooks/123/abc';

function writeMainTf(dir, { lambda = false, staticSite = false, alb = true } = {}) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    const resources = [];
    if (lambda) resources.push('resource "aws_lambda_function" "app" {}');
    if (staticSite) resources.push('resource "aws_cloudfront_distribution" "site" {}');
    if (alb) resources.push('resource "aws_lb" "main" {}');
    fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), `${resources.join('\n')}\n`);
}

beforeEach(() => {
    tmp.reset();
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
});

afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    tmp.cleanup();
});

describe('parseAlertsArgs', () => {
    it('parses region, project-name, and force', () => {
        expect(parseAlertsArgs(['alerts', '--region', 'eu-west-1', '--force'])).toMatchObject({
            region: 'eu-west-1',
            force: true,
        });
        expect(parseAlertsArgs(['alerts'])).toEqual({});
    });

    it('parses email, webhook, and threshold flags', () => {
        expect(parseAlertsArgs(['alerts', '--email', 'a@b.com', '--webhook', SLACK_URL, '--threshold', '7']))
            .toMatchObject({ email: 'a@b.com', webhook: SLACK_URL, threshold: '7' });
    });

    it('collects unexpected positionals', () => {
        expect(parseAlertsArgs(['alerts', 'bogus']).unexpectedPositionals).toEqual(['bogus']);
    });
});

describe('destination validation', () => {
    it('accepts plain email addresses and rejects junk', () => {
        expect(isValidEmail('you@example.com')).toBe(true);
        expect(isValidEmail('  you@example.com  ')).toBe(true);
        expect(isValidEmail('not-an-email')).toBe(false);
        expect(isValidEmail('missing@tld')).toBe(false);
        expect(isValidEmail('')).toBe(false);
        expect(isValidEmail(undefined)).toBe(false);
    });

    it('requires https webhook URLs', () => {
        expect(isValidWebhookUrl(SLACK_URL)).toBe(true);
        expect(isValidWebhookUrl(DISCORD_URL)).toBe(true);
        expect(isValidWebhookUrl('https://example.com/hook')).toBe(true);
        expect(isValidWebhookUrl('http://example.com/hook')).toBe(false);
        expect(isValidWebhookUrl('not-a-url')).toBe(false);
        expect(isValidWebhookUrl('')).toBe(false);
    });

    it('detects slack, discord, and generic webhook kinds', () => {
        expect(detectWebhookKind(SLACK_URL)).toBe('slack');
        expect(detectWebhookKind(DISCORD_URL)).toBe('discord');
        expect(detectWebhookKind('https://example.com/hook')).toBe('generic');
    });

    it('parses positive thresholds and bounds static percentages', () => {
        expect(parseThreshold('7', 'ecs')).toEqual({ ok: true, value: 7 });
        expect(parseThreshold('2.5', 'static')).toEqual({ ok: true, value: 2.5 });
        expect(parseThreshold('0', 'ecs').ok).toBe(false);
        expect(parseThreshold('-3', 'lambda').ok).toBe(false);
        expect(parseThreshold('junk', 'ecs').ok).toBe(false);
        expect(parseThreshold('101', 'static').ok).toBe(false);
    });
});

describe('buildAlertsTf', () => {
    it('wires a distinct notify alarm to the SNS topic', () => {
        const tf = buildAlertsTf({ projectName: 'myapp' });
        expect(tf).toContain('resource "aws_sns_topic" "alerts"');
        expect(tf).toContain('name = "${local.app_name}-alerts"');
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_5xx"');
        expect(tf).toContain('alarm_name          = "${local.app_name}-5xx-notify"');
        expect(tf).toContain('metric_name         = "HTTPCode_Target_5XX_Count"');
        expect(tf).toContain('alarm_actions = [aws_sns_topic.alerts.arn]');
        expect(tf).toContain('LoadBalancer = aws_lb.main.arn_suffix');
    });

    it('keeps the ECS dashboard mirror (10 5xx in 2 minutes)', () => {
        const tf = buildAlertsTf({ projectName: 'myapp', target: 'ecs' });
        expect(tf).toContain('evaluation_periods  = "2"');
        expect(tf).toContain('threshold           = "10"');
    });

    it('honors --threshold overrides', () => {
        const tf = buildAlertsTf({ projectName: 'myapp', target: 'ecs', threshold: 25 });
        expect(tf).toContain('threshold           = "25"');
        expect(tf).toContain('more than 25 5XX errors in 2 minutes');
    });

    // Flat ECS names let a preview apply clobber the prod
    // alarm — ECS uses the workspace-aware local like lambda/static.
    it('uses workspace-aware names on ECS targets', () => {
        const tf = buildAlertsTf({ projectName: 'myapp', target: 'ecs' });
        expect(tf).toContain('name = "${local.app_name}-alerts"');
        expect(tf).toContain('alarm_name          = "${local.app_name}-5xx-notify"');
        expect(tf).not.toContain('"myapp-alerts"');
        expect(tf).not.toContain('"myapp-5xx-notify"');
    });

    it('builds a Lambda Errors alarm for lambda targets', () => {
        const tf = buildAlertsTf({ projectName: 'myapp', target: 'lambda' });
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_errors"');
        expect(tf).toContain('metric_name         = "Errors"');
        expect(tf).toContain('namespace           = "AWS/Lambda"');
        expect(tf).toContain('FunctionName = aws_lambda_function.app.function_name');
        expect(tf).toContain('threshold           = "5"');
        expect(tf).toContain('name = "${local.app_name}-alerts"');
        expect(tf).not.toContain('aws.us_east_1');
    });

    it('builds a CloudFront 5xx-rate alarm pinned to us-east-1 for static', () => {
        const tf = buildAlertsTf({ projectName: 'myapp', target: 'static' });
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_5xx_rate"');
        expect(tf).toContain('metric_name         = "5xxErrorRate"');
        expect(tf).toContain('namespace           = "AWS/CloudFront"');
        expect(tf).toContain('DistributionId = aws_cloudfront_distribution.site.id');
        expect(tf).toContain('threshold           = "5"');
        expect(tf).toContain('provider = aws.us_east_1');
    });

    it('adds an email subscription only when --email is set', () => {
        expect(buildAlertsTf({ projectName: 'myapp' })).not.toContain('aws_sns_topic_subscription');
        const tf = buildAlertsTf({ projectName: 'myapp', email: 'you@example.com' });
        expect(tf).toContain('resource "aws_sns_topic_subscription" "email"');
        expect(tf).toContain('protocol  = "email"');
        expect(tf).toContain('endpoint  = "you@example.com"');
    });

    it('adds a DLQ-depth alarm only for trees with the queue addon', () => {
        expect(buildAlertsTf({ projectName: 'myapp' })).not.toContain('notify_dlq_depth');
        const tf = buildAlertsTf({ projectName: 'myapp', addons: { 'queue:sqs': true } });
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_dlq_depth"');
        expect(tf).toContain('metric_name         = "ApproximateNumberOfMessagesVisible"');
        expect(tf).toContain('namespace           = "AWS/SQS"');
        expect(tf).toContain('QueueName = aws_sqs_queue.dlq.name');
        expect(tf).toContain('threshold           = "1"');
        expect(tf).toContain('alarm_actions = [aws_sns_topic.alerts.arn]');
        // The paged engineer gets the runbook, not just the symptom.
        expect(tf).toContain('alert-notifications.md#redriving-the-dlq');
    });

    it('keeps --threshold on the primary alarm (addon alarms use baked defaults)', () => {
        const tf = buildAlertsTf({ projectName: 'myapp', target: 'ecs', threshold: 25, addons: { 'queue:sqs': true } });
        expect(tf).toContain('threshold           = "25"');
        expect(tf).toContain('threshold           = "1"');
    });

    it('adds scheduler failure alarms only for trees with the cron addon', () => {
        expect(buildAlertsTf({ projectName: 'myapp' })).not.toContain('notify_cron_target_errors');
        const tf = buildAlertsTf({ projectName: 'myapp', addons: { cron: true } });
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_cron_target_errors"');
        expect(tf).toContain('metric_name         = "TargetErrorCount"');
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_cron_dropped"');
        expect(tf).toContain('metric_name         = "InvocationDroppedCount"');
        expect(tf).toContain('namespace           = "AWS/Scheduler"');
        expect(tf).toContain('ScheduleGroup = aws_scheduler_schedule_group.crons.name');
    });

    it('adds storage/CPU/connections alarms for RDS instance trees', () => {
        expect(buildAlertsTf({ projectName: 'myapp' })).not.toContain('notify_rds_storage_low');
        const tf = buildAlertsTf({ projectName: 'myapp', addons: { 'db:instance': true } });
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_rds_storage_low"');
        expect(tf).toContain('metric_name         = "FreeStorageSpace"');
        expect(tf).toContain('comparison_operator = "LessThanThreshold"');
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_rds_cpu_high"');
        expect(tf).toContain('metric_name         = "CPUUtilization"');
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_rds_connections_high"');
        expect(tf).toContain('metric_name         = "DatabaseConnections"');
        expect(tf).toContain('namespace           = "AWS/RDS"');
        expect(tf).toContain('DBInstanceIdentifier = aws_db_instance.postgres.identifier');
    });

    it('adds cluster alarms (no storage alarm — serverless storage autoscales) for aurora trees', () => {
        const tf = buildAlertsTf({ projectName: 'myapp', addons: { 'db:aurora': true } });
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_rds_cpu_high"');
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_rds_connections_high"');
        expect(tf).not.toContain('notify_rds_storage_low');
        expect(tf).toContain('DBClusterIdentifier = aws_rds_cluster.postgres.id');
    });

    it('adds eviction/CPU alarms for valkey trees', () => {
        expect(buildAlertsTf({ projectName: 'myapp' })).not.toContain('notify_valkey_evictions');
        const tf = buildAlertsTf({ projectName: 'myapp', addons: { 'db:redis': true } });
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_valkey_evictions"');
        expect(tf).toContain('metric_name         = "Evictions"');
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_valkey_cpu_high"');
        expect(tf).toContain('metric_name         = "EngineCPUUtilization"');
        expect(tf).toContain('namespace           = "AWS/ElastiCache"');
        expect(tf).toContain('ReplicationGroupId = aws_elasticache_replication_group.redis.id');
    });

    it('adds account-level bounce/complaint alarms for SES trees', () => {
        expect(buildAlertsTf({ projectName: 'myapp' })).not.toContain('notify_ses_bounce_rate');
        const tf = buildAlertsTf({ projectName: 'myapp', addons: { 'email:ses': true } });
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_ses_bounce_rate"');
        expect(tf).toContain('metric_name         = "Reputation.BounceRate"');
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_ses_complaint_rate"');
        expect(tf).toContain('metric_name         = "Reputation.ComplaintRate"');
        expect(tf).toContain('namespace           = "AWS/SES"');
    });

    it('adds the forwarding Lambda only when --webhook is set', () => {
        expect(buildAlertsTf({ projectName: 'myapp' })).not.toContain('aws_lambda_function');
        const tf = buildAlertsTf({ projectName: 'myapp', webhook: SLACK_URL });
        expect(tf).toContain('resource "aws_lambda_function" "forwarder"');
        expect(tf).toContain('runtime          = "nodejs22.x"');
        expect(tf).toContain('data "archive_file" "forwarder"');
        // required_providers may only appear once per module — the
        // archive pin goes to backend.tf (see ensureArchiveProvider).
        expect(tf).not.toContain('required_providers {');
        expect(tf).toContain('resource "aws_lambda_permission" "forwarder_sns"');
        expect(tf).toContain('resource "aws_sns_topic_subscription" "forwarder"');
        expect(tf).toContain('variable "alerts_webhook_url"');
        expect(tf).toContain('WEBHOOK_URL = var.alerts_webhook_url');
        // The bearer URL itself must never be baked into the file.
        expect(tf).not.toContain(SLACK_URL);
    });

    it('hash-suffixes the forwarder function name past the 64-char cap', () => {
        const tf = buildAlertsTf({ projectName: 'myapp', webhook: SLACK_URL });
        expect(tf).toMatch(/forwarder_safe_name\s*=\s*length\(/);
        expect(tf).toMatch(/function_name\s*=\s*local\.forwarder_safe_name/);
        // Short names render byte-identically: the plain form survives
        // as the under-cap branch.
        expect(tf).toContain('"${local.app_name}-alerts-forwarder"');
        expect(tf).toContain('replace(substr(');
        expect(tf).toContain('"/-+$/", ""');
    });

    it('pins the static forwarder to us-east-1 alongside the alarm', () => {
        const tf = buildAlertsTf({ projectName: 'myapp', target: 'static', webhook: SLACK_URL });
        expect(tf).toContain('resource "aws_lambda_function" "forwarder"');
        const pins = tf.split('\n').filter((line) => line.includes('provider = aws.us_east_1'));
        // topic + alarm + function + permission + subscription
        expect(pins.length).toBe(5);
    });
});

describe('buildForwarderJs', () => {
    it('adapts payloads to slack, discord, and generic dialects', () => {
        const js = buildForwarderJs();
        expect(js).toContain("hooks.slack.com')) return { text: body }");
        expect(js).toContain("discord.com/api/webhooks')) return { content: body }");
        expect(js).toContain('new Date().toISOString()');
        expect(js).toContain('exports.handler');
    });

    it('contains no ${ interpolation that would break the HCL heredoc', () => {
        expect(buildForwarderJs()).not.toContain('${');
    });

    it('parses as valid JavaScript', async () => {
        const module = { exports: {} };
        const factory = new Function('module', 'exports', 'require', buildForwarderJs());
        factory(module, module.exports, (name) => {
            if (name === 'node:https') return {};
            throw new Error(`unexpected require ${name}`);
        });
        expect(typeof module.exports.handler).toBe('function');
    });
});

describe('ensureArchiveProvider', () => {
    const BACKEND = 'terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 5.0"\n    }\n  }\n}\n';

    function writeBackend(dir, content = BACKEND) {
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        const backendPath = path.join(dir, 'terraform', 'backend.tf');
        fs.writeFileSync(backendPath, content);
        return backendPath;
    }

    it('pins archive inside the existing required_providers block', () => {
        const dir = tmp.makeTmp('alerts-test-');
        const backendPath = writeBackend(dir);
        expect(ensureArchiveProvider(backendPath)).toBe(true);
        const updated = fs.readFileSync(backendPath, 'utf8');
        expect(updated).toContain('archive = {');
        expect(updated).toContain('source  = "hashicorp/archive"');
        expect(updated).toContain('version = "~> 2.0"');
        expect(updated).toContain('source  = "hashicorp/aws"');
        // Still exactly one required_providers block.
        expect(updated.match(/required_providers\s*{/g).length).toBe(1);
    });

    it('is a no-op when archive is already pinned', () => {
        const dir = tmp.makeTmp('alerts-test-');
        const backendPath = writeBackend(dir);
        expect(ensureArchiveProvider(backendPath)).toBe(true);
        expect(ensureArchiveProvider(backendPath)).toBe(false);
        const updated = fs.readFileSync(backendPath, 'utf8');
        expect(updated.match(/archive\s*=/g).length).toBe(1);
    });

    it('is a no-op without backend.tf or without required_providers', () => {
        const dir = tmp.makeTmp('alerts-test-');
        expect(ensureArchiveProvider(path.join(dir, 'terraform', 'backend.tf'))).toBe(false);
        const backendPath = writeBackend(dir, '# no terraform block here\n');
        expect(ensureArchiveProvider(backendPath)).toBe(false);
        expect(fs.readFileSync(backendPath, 'utf8')).toBe('# no terraform block here\n');
    });
});

describe('detectAlertAddonFeatures', () => {
    const NONE = { 'queue:sqs': false, cron: false, 'db:instance': false, 'db:aurora': false, 'db:redis': false, 'email:ses': false };

    it('detects the queue addon from the dlq resource, not file presence', () => {
        const dir = tmp.makeTmp('alerts-test-');
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        expect(detectAlertAddonFeatures(path.join(dir, 'terraform'))).toEqual(NONE);
        fs.writeFileSync(path.join(dir, 'terraform', 'sqs.tf'), '# no queues here\n');
        expect(detectAlertAddonFeatures(path.join(dir, 'terraform'))).toEqual(NONE);
        fs.writeFileSync(path.join(dir, 'terraform', 'sqs.tf'), 'resource "aws_sqs_queue" "dlq" {}\n');
        expect(detectAlertAddonFeatures(path.join(dir, 'terraform'))).toEqual({ ...NONE, 'queue:sqs': true });
    });

    it('detects the cron addon from the schedule resource, not file presence', () => {
        const dir = tmp.makeTmp('alerts-test-');
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'terraform', 'cron.tf'), '# no schedules here\n');
        expect(detectAlertAddonFeatures(path.join(dir, 'terraform'))).toEqual(NONE);
        fs.writeFileSync(path.join(dir, 'terraform', 'cron.tf'), 'resource "aws_scheduler_schedule" "cron" {}\n');
        expect(detectAlertAddonFeatures(path.join(dir, 'terraform'))).toEqual({ ...NONE, cron: true });
    });

    it('detects the database engine from its resource file', () => {
        const dir = tmp.makeTmp('alerts-test-');
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'terraform', 'database.tf'), 'resource "aws_db_instance" "postgres" {}\n');
        expect(detectAlertAddonFeatures(path.join(dir, 'terraform'))).toEqual({ ...NONE, 'db:instance': true });
        fs.writeFileSync(path.join(dir, 'terraform', 'database-aurora-postgresql.tf'), 'resource "aws_rds_cluster" "postgres" {}\n');
        expect(detectAlertAddonFeatures(path.join(dir, 'terraform'))['db:aurora']).toBe(true);
    });

    it('detects valkey from the replication group resource', () => {
        const dir = tmp.makeTmp('alerts-test-');
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'terraform', 'redis.tf'), 'resource "aws_elasticache_replication_group" "redis" {}\n');
        expect(detectAlertAddonFeatures(path.join(dir, 'terraform'))).toEqual({ ...NONE, 'db:redis': true });
    });

    it('detects SES from the domain identity resource', () => {
        const dir = tmp.makeTmp('alerts-test-');
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'terraform', 'ses.tf'), 'resource "aws_ses_domain_identity" "ses" {}\n');
        expect(detectAlertAddonFeatures(path.join(dir, 'terraform'))).toEqual({ ...NONE, 'email:ses': true });
    });
});

describe('Command: alerts (scaffold SNS + alarm)', () => {
    function alertOptions(dir, overrides = {}) {
        return { cwd: dir, projectName: 'myapp', region: 'us-east-2', ...overrides };
    }

    it('scaffolds alerts.tf and prints manual subscribe steps', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        const result = await runAlerts(alertOptions(dir, { isHeadless: true }));

        expect(result).toMatchObject({ ok: true, action: 'scaffold', file: ALERTS_TF_FILE });
        const written = fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8');
        expect(written).toContain('aws_sns_topic');
        expect(written).toContain('${local.app_name}-5xx-notify');
        const text = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
        expect(text).toContain('aws sns subscribe');
        expect(text).toContain('--protocol email');
        expect(exitSpy).not.toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith('alerts_run', expect.objectContaining({ success: true }));
    });

    it('scaffolds a Lambda Errors alarm on lambda targets', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir, { lambda: true, alb: false });
        const result = await runAlerts(alertOptions(dir, { isHeadless: true }));

        expect(result).toMatchObject({ ok: true, target: 'lambda' });
        const written = fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8');
        expect(written).toContain('aws_cloudwatch_metric_alarm" "notify_errors"');
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('scaffolds the DLQ alarm when the tree carries the queue addon', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, 'terraform', 'sqs.tf'), 'resource "aws_sqs_queue" "dlq" {}\n');
        const result = await runAlerts(alertOptions(dir, { isHeadless: true }));

        expect(result).toMatchObject({ ok: true });
        const written = fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8');
        expect(written).toContain('aws_cloudwatch_metric_alarm" "notify_dlq_depth"');
        expect(written).toContain('QueueName = aws_sqs_queue.dlq.name');
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('skips the DLQ alarm when the queue file lacks the dlq resource', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, 'terraform', 'sqs.tf'), '# hand-edited: queue removed\n');
        const result = await runAlerts(alertOptions(dir, { isHeadless: true }));

        expect(result).toMatchObject({ ok: true });
        const written = fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8');
        expect(written).not.toContain('notify_dlq_depth');
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('scaffolds scheduler alarms when the tree carries the cron addon', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, 'terraform', 'cron.tf'), 'resource "aws_scheduler_schedule" "cron" {}\n');
        const result = await runAlerts(alertOptions(dir, { isHeadless: true }));

        expect(result).toMatchObject({ ok: true });
        const written = fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8');
        expect(written).toContain('aws_cloudwatch_metric_alarm" "notify_cron_target_errors"');
        expect(written).toContain('aws_cloudwatch_metric_alarm" "notify_cron_dropped"');
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('scaffolds reputation alarms for trees that carry SES', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, 'terraform', 'ses.tf'), 'resource "aws_ses_domain_identity" "ses" {}\n');
        const result = await runAlerts(alertOptions(dir, { isHeadless: true }));

        expect(result).toMatchObject({ ok: true });
        const written = fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8');
        expect(written).toContain('aws_cloudwatch_metric_alarm" "notify_ses_bounce_rate"');
        expect(written).toContain('aws_cloudwatch_metric_alarm" "notify_ses_complaint_rate"');
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('scaffolds database and cache alarms for trees that carry them', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, 'terraform', 'database.tf'), 'resource "aws_db_instance" "postgres" {}\n');
        fs.writeFileSync(path.join(dir, 'terraform', 'redis.tf'), 'resource "aws_elasticache_replication_group" "redis" {}\n');
        const result = await runAlerts(alertOptions(dir, { isHeadless: true }));

        expect(result).toMatchObject({ ok: true });
        const written = fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8');
        expect(written).toContain('aws_cloudwatch_metric_alarm" "notify_rds_storage_low"');
        expect(written).toContain('aws_cloudwatch_metric_alarm" "notify_valkey_evictions"');
        expect(written).not.toContain('DBClusterIdentifier');
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('scaffolds a CloudFront alarm on static and ensures the us-east-1 alias', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir, { staticSite: true, alb: false });
        const result = await runAlerts(alertOptions(dir, { isHeadless: true }));

        expect(result).toMatchObject({ ok: true, target: 'static' });
        const written = fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8');
        expect(written).toContain('aws_cloudwatch_metric_alarm" "notify_5xx_rate"');
        expect(written).toContain('provider = aws.us_east_1');
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf8');
        expect(mainTf).toContain('alias  = "us_east_1"');
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('scaffolds email + webhook destinations without leaking secrets to telemetry', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        const result = await runAlerts(alertOptions(dir, { email: 'you@example.com', webhook: SLACK_URL }));

        expect(result).toMatchObject({ ok: true, destinations: 'both' });
        const written = fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8');
        expect(written).toContain('aws_sns_topic_subscription" "email"');
        expect(written).toContain('aws_lambda_function" "forwarder"');
        const text = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
        expect(text).toContain('TF_VAR_alerts_webhook_url');
        expect(trackEvent).toHaveBeenCalledWith('alerts_run', expect.objectContaining({
            success: true,
            destinations: 'both',
        }));
        const payload = JSON.stringify(trackEvent.mock.calls.map((call) => call[1]));
        expect(payload).not.toContain('you@example.com');
        expect(payload).not.toContain(SLACK_URL);
    });

    it('gitignores the forwarder zip when scaffolding a webhook (idempotent)', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
        const result = await runAlerts(alertOptions(dir, { webhook: SLACK_URL }));

        expect(result).toMatchObject({ ok: true, destinations: 'webhook' });
        const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
        expect(gitignore).toContain('terraform/.grada-alerts-forwarder.zip');

        // Rerun with --force: the entry is not duplicated.
        await runAlerts(alertOptions(dir, { webhook: SLACK_URL, force: true }));
        const again = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
        expect(again.match(/terraform\/\.grada-alerts-forwarder\.zip/g)).toHaveLength(1);
    });

    it('serializes scaffolding under the terraform project lock', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        vi.mocked(withProjectLock).mockClear();
        const result = await runAlerts(alertOptions(dir, { webhook: SLACK_URL }));

        expect(result).toMatchObject({ ok: true });
        expect(vi.mocked(withProjectLock)).toHaveBeenCalledWith(dir, expect.any(Function), { scope: 'terraform' });
    });

    it('leaves .gitignore alone when no webhook forwarder is scaffolded', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        const result = await runAlerts(alertOptions(dir, { isHeadless: true }));

        expect(result).toMatchObject({ ok: true });
        expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
    });

    it('redacts the webhook URL from stdout when scaffolding', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        const result = await runAlerts(alertOptions(dir, { webhook: SLACK_URL }));

        expect(result).toMatchObject({ ok: true, destinations: 'webhook' });
        const text = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
        expect(text).toContain('TF_VAR_alerts_webhook_url');
        expect(text).not.toContain(SLACK_URL);
    });

    it('pins the archive provider in backend.tf when scaffolding a webhook', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, 'terraform', 'backend.tf'), 'terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 5.0"\n    }\n  }\n}\n');
        const result = await runAlerts(alertOptions(dir, { webhook: SLACK_URL }));

        expect(result).toMatchObject({ ok: true, destinations: 'webhook' });
        const backend = fs.readFileSync(path.join(dir, 'terraform', 'backend.tf'), 'utf8');
        expect(backend).toContain('hashicorp/archive');
        const text = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
        expect(text).toContain('Pinned the archive provider');
    });

    it('prompts for destinations when run interactively without flags', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        mockSelect.mockResolvedValue('both');
        mockText.mockResolvedValueOnce('you@example.com').mockResolvedValueOnce(SLACK_URL);
        const result = await runAlerts(alertOptions(dir, { headless: false }));

        expect(result).toMatchObject({ ok: true, destinations: 'both' });
        expect(mockSelect).toHaveBeenCalled();
        expect(mockText).toHaveBeenCalledTimes(2);
        const written = fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8');
        expect(written).toContain('endpoint  = "you@example.com"');
    });

    it('refuses inferred-headless scaffolding without destination flags', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        const result = await runAlerts(alertOptions(dir));

        expect(result).toMatchObject({ ok: false, reason: 'non-interactive' });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('alerts_run', expect.objectContaining({
            error_code: 'ALERTS_NON_INTERACTIVE',
            reason: 'non-interactive',
        }));
        expect(mockSelect).not.toHaveBeenCalled();
        expect(mockText).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(dir, ALERTS_TF_FILE))).toBe(false);
    });

    it('rejects invalid email, webhook, and threshold flags', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        expect((await runAlerts(alertOptions(dir, { email: 'junk' }))).reason).toBe('invalid-email');
        expect((await runAlerts(alertOptions(dir, { webhook: 'http://plain.com/hook' }))).reason).toBe('invalid-webhook-url');
        expect((await runAlerts(alertOptions(dir, { threshold: 'junk' }))).reason).toBe('invalid-threshold');
        expect(fs.existsSync(path.join(dir, ALERTS_TF_FILE))).toBe(false);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('refuses to overwrite without --force', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, ALERTS_TF_FILE), '# custom\n');
        const result = await runAlerts(alertOptions(dir, { isHeadless: true }));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('alerts-file-exists');
        expect(fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8')).toBe('# custom\n');
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('overwrites with --force', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, ALERTS_TF_FILE), '# custom\n');
        const result = await runAlerts(alertOptions(dir, { force: true, isHeadless: true }));

        expect(result.ok).toBe(true);
        expect(fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8')).toContain('aws_sns_topic');
    });

    it('errors when the ALB resource is missing', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir, { alb: false });
        const result = await runAlerts(alertOptions(dir));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('alb-not-found');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('errors when the lambda anchor is missing', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        // Detection keys off aws_lambda_function anywhere in main.tf, so a
        // project that lost its app function reads as a broken lambda
        // project only when the anchor string itself is gone.
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), 'resource "aws_lambda_function" "renamed" {}\n');
        const result = await runAlerts(alertOptions(dir));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('lambda-not-found');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('errors when the cloudfront anchor is missing', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), 'resource "aws_cloudfront_distribution" "renamed" {}\n');
        const result = await runAlerts(alertOptions(dir));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('distribution-not-found');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('errors when terraform is not initialized', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        const result = await runAlerts(alertOptions(dir));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('terraform-not-initialized');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects unexpected positionals', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        const result = await runAlerts(alertOptions(dir, { unexpectedPositionals: ['bogus'] }));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('unexpected-positional-args');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});
