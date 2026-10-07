import fsSync from 'fs';
import path from 'path';
import color from 'picocolors';
import { intro, outro, select, text, cancel, isCancel } from '@clack/prompts';
import { trackSuccess } from '../core/telemetry.js';
import { failCommand, failProjectNotInitialized } from '../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { resolveRegion, resolveProjectName, resolveCwd, resolveHeadless, readFileSafe, readTerraformComputeTarget } from '../utils/resolvers.js';
import { findNestedBlock } from '../utils/hcl.js';
import { ensureUsEast1Provider } from './domain.js';

export const ALERTS_TF_FILE = path.join('terraform', 'alerts.tf');

// Per-target alarm defaults: { threshold, evaluationPeriods, period }.
// ECS mirrors the dashboard alarm in templates/terraform/main.tf
// (`alb_5xx_errors`: more than 10 5xx in 2 minutes); the alarm name
// differs (`-5xx-notify`) so the notifying alarm is distinguishable.
// Static thresholds are a *percentage* (CloudFront 5xxErrorRate).
export const ALERT_TARGET_DEFAULTS = {
    ecs: { threshold: 10, evaluationPeriods: 2, period: 60, unit: 'count' },
    lambda: { threshold: 5, evaluationPeriods: 5, period: 60, unit: 'count' },
    static: { threshold: 5, evaluationPeriods: 5, period: 60, unit: 'percent' },
};

// Anchor resource each target's notify alarm attaches to. Detection reads
// main.tf only, matching detectComputeTargetFromMainTf.
const TARGET_ANCHORS = {
    ecs: { resource: 'resource "aws_lb" "main"', errorCode: 'ALB_NOT_FOUND', reason: 'alb-not-found' },
    lambda: { resource: 'resource "aws_lambda_function" "app"', errorCode: 'LAMBDA_NOT_FOUND', reason: 'lambda-not-found' },
    static: { resource: 'resource "aws_cloudfront_distribution" "site"', errorCode: 'DISTRIBUTION_NOT_FOUND', reason: 'distribution-not-found' },
};

export function parseAlertsArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'alerts') args.shift();
    const { options, rest } = parseFlags(args, {
        string: ['region', 'project-name', 'email', 'webhook', 'threshold'],
        boolean: ['force'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0) options.unexpectedPositionals = positionals;
    return options;
}

export function isValidEmail(value) {
    return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

// Chat webhooks must be https:// — alarm payloads travel over the public
// internet to Slack/Discord, and plain http would leak them.
export function isValidWebhookUrl(value) {
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value.trim());
        return url.protocol === 'https:' && Boolean(url.hostname);
    } catch {
        return false;
    }
}

// Payload dialect for CLI messaging. The forwarder itself sniffs the URL
// again at runtime (so a rotated TF_VAR URL keeps working), mirroring
// these rules — keep the two in sync.
export function detectWebhookKind(url) {
    const value = String(url || '');
    if (value.includes('hooks.slack.com')) return 'slack';
    if (value.includes('discord.com/api/webhooks')) return 'discord';
    return 'generic';
}

// Validates a --threshold override. Static is a percentage (0, 100];
// counts must simply be positive.
export function parseThreshold(raw, target) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        return { ok: false, error: `Invalid --threshold "${raw}": expected a positive number.` };
    }
    if (target === 'static' && value > 100) {
        return { ok: false, error: `Invalid --threshold "${raw}": the static 5xx error rate is a percentage (0-100).` };
    }
    return { ok: true, value };
}

// Inline forwarder source (index.js). Runs on the Lambda nodejs22.x
// runtime with zero dependencies. IMPORTANT: this string is embedded in
// an HCL heredoc, so it must never contain `${` (Terraform would try to
// interpolate it) — string concatenation only. A unit test pins this.
export function buildForwarderJs() {
    return `'use strict';
// Grada alerts forwarder: SNS alarm notifications -> chat webhook.
// Zero dependencies; WEBHOOK_URL comes from the Lambda environment.
const https = require('node:https');

function postJson(webhookUrl, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const request = https.request(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 10000,
        }, (response) => {
            response.resume();
            response.on('end', () => {
                if (response.statusCode >= 200 && response.statusCode < 300) resolve();
                else reject(new Error('webhook returned HTTP ' + response.statusCode));
            });
        });
        request.on('error', reject);
        request.on('timeout', () => request.destroy(new Error('webhook request timed out')));
        request.write(body);
        request.end();
    });
}

function formatPayload(webhookUrl, subject, alarm, state, reason) {
    const summary = subject + (alarm ? ' - ' + alarm : '') + (state ? ' [' + state + ']' : '');
    const body = reason ? summary + '\\n' + reason : summary;
    if (webhookUrl.includes('hooks.slack.com')) return { text: body };
    if (webhookUrl.includes('discord.com/api/webhooks')) return { content: body };
    return {
        alarm: alarm,
        state: state,
        subject: subject,
        reason: reason,
        timestamp: new Date().toISOString(),
    };
}

exports.handler = async (event) => {
    const webhookUrl = process.env.WEBHOOK_URL || '';
    if (!webhookUrl) throw new Error('WEBHOOK_URL is not configured');
    const records = (event && event.Records) || [];
    for (const record of records) {
        const sns = record.Sns || {};
        let subject = sns.Subject || 'Grada alarm';
        let alarm = '';
        let state = '';
        let reason = '';
        try {
            const message = JSON.parse(sns.Message || '{}');
            alarm = message.AlarmName || '';
            state = message.NewStateValue || '';
            reason = message.AlarmDescription || message.NewStateReason || '';
        } catch {
            reason = sns.Message || '';
        }
        await postJson(webhookUrl, formatPayload(webhookUrl, subject, alarm, state, reason));
    }
    return { ok: true };
};
`;
}

// SNS topic + notifying alarm, plus an email subscription when `email`
// is set and a scale-to-zero forwarding Lambda when `webhook` is set.
// `threshold` is the resolved alarm threshold (already validated).
//
// Provider pinning: CloudWatch alarms on CloudFront metrics must live in
// us-east-1, and an alarm's SNS actions must be in the alarm's region —
// so every static alert resource is pinned to the aws.us_east_1 alias
// (runAlerts ensures main.tf declares it). IAM and archive_file are
// region-independent and stay unpinned.
export function buildAlertsTf({ projectName, target = 'ecs', email, webhook, threshold }) {
    const defaults = ALERT_TARGET_DEFAULTS[target] || ALERT_TARGET_DEFAULTS.ecs;
    const limit = threshold ?? defaults.threshold;
    // ECS keeps the historical flat naming (existing topic/alarm names
    // are unchanged); lambda/static use the workspace-aware local for
    // preview isolation.
    const namePrefix = target === 'ecs' ? projectName : '${local.app_name}';
    const aliasLine = target === 'static' ? '  provider = aws.us_east_1\n' : '';

    const destinations = [];
    if (email) destinations.push(`email (${email})`);
    if (webhook) destinations.push(`${detectWebhookKind(webhook)} webhook via forwarding Lambda`);
    const destComment = destinations.length > 0
        ? `# Destinations: ${destinations.join(' + ')}.`
        : `# No destinations baked in — subscribe an email address after apply:`;

    const header = `# Grada alert notifications (generated by \`grada alerts\`).
${destComment}
${email || webhook ? '' : `#   aws sns subscribe --topic-arn <topic-arn> --protocol email \\
#     --notification-endpoint you@example.com
# then click the confirmation link.
`}# Re-run \`grada alerts --force\` with --email / --webhook to change destinations.
`;

    const topic = `resource "aws_sns_topic" "alerts" {
${aliasLine}  name = "${namePrefix}-alerts"
}
`;

    const alarm = target === 'lambda' ? `resource "aws_cloudwatch_metric_alarm" "notify_errors" {
  alarm_name          = "${namePrefix}-errors-notify"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "${defaults.evaluationPeriods}"
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = "${defaults.period}"
  statistic           = "Sum"
  threshold           = "${limit}"
  alarm_description   = "Notifies ${namePrefix}-alerts when ${projectName} reports more than ${limit} Lambda errors in ${defaults.evaluationPeriods} minutes."

  alarm_actions = [aws_sns_topic.alerts.arn]

  dimensions = {
    FunctionName = aws_lambda_function.app.function_name
  }
}
` : target === 'static' ? `resource "aws_cloudwatch_metric_alarm" "notify_5xx_rate" {
${aliasLine}  alarm_name          = "${namePrefix}-5xx-rate-notify"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "${defaults.evaluationPeriods}"
  metric_name         = "5xxErrorRate"
  namespace           = "AWS/CloudFront"
  period              = "${defaults.period}"
  statistic           = "Average"
  threshold           = "${limit}"
  alarm_description   = "Notifies ${namePrefix}-alerts when ${projectName} serves more than a ${limit}% 5xx error rate over ${defaults.evaluationPeriods} minutes."

  alarm_actions = [aws_sns_topic.alerts.arn]

  dimensions = {
    DistributionId = aws_cloudfront_distribution.site.id
  }
}
` : `resource "aws_cloudwatch_metric_alarm" "notify_5xx" {
  alarm_name          = "${namePrefix}-5xx-notify"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "${defaults.evaluationPeriods}"
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = "${defaults.period}"
  statistic           = "Sum"
  threshold           = "${limit}"
  alarm_description   = "Notifies ${namePrefix}-alerts when the ALB serves more than ${limit} 5XX errors in ${defaults.evaluationPeriods} minutes."

  alarm_actions = [aws_sns_topic.alerts.arn]

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
  }
}
`;

    // NOTE: the email endpoint lands in git by design (the operator passed
    // it explicitly); delivery still needs the recipient's confirmation
    // click, preserving the ADR-0016 explicit-consent property.
    const emailSubscription = email ? `
resource "aws_sns_topic_subscription" "email" {
${aliasLine}  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = "${email}"
}
` : '';

    const forwarder = webhook ? `
# Chat webhook delivery: SNS cannot confirm raw webhook URLs, so a
# scale-to-zero Lambda adapts alarm notifications to Slack/Discord
# payloads. No requests, no bill — the 1M-request free tier covers it.
# (The archive provider constraint lives in backend.tf next to the aws
# one — a module may declare required_providers only once.)

variable "alerts_webhook_url" {
  description = "Incoming chat webhook URL for alarm notifications. Export TF_VAR_alerts_webhook_url before apply — never commit the URL to git."
  type        = string
  sensitive   = true
  default     = ""
}

data "archive_file" "forwarder" {
  type        = "zip"
  output_path = "\${path.module}/.grada-alerts-forwarder.zip"

  source {
    content  = <<-EOT
${buildForwarderJs()}    EOT
    filename = "index.js"
  }
}

resource "aws_iam_role" "forwarder" {
  name = "${namePrefix}-alerts-forwarder"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "forwarder_logs" {
  role       = aws_iam_role.forwarder.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "forwarder" {
${aliasLine}  function_name    = "${namePrefix}-alerts-forwarder"
  role             = aws_iam_role.forwarder.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.forwarder.output_path
  source_code_hash = data.archive_file.forwarder.output_base64sha256
  timeout          = 30
  memory_size      = 128

  environment {
    variables = {
      WEBHOOK_URL = var.alerts_webhook_url
    }
  }
}

resource "aws_lambda_permission" "forwarder_sns" {
${aliasLine}  statement_id  = "AllowSNSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.forwarder.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.alerts.arn
}

resource "aws_sns_topic_subscription" "forwarder" {
${aliasLine}  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.forwarder.arn
}
` : '';

    return `${header}
${topic}
${alarm}${emailSubscription}${forwarder}`;
}

// Adds the archive provider (used by the forwarder's data.archive_file)
// to backend.tf's required_providers block. No-op when backend.tf is
// absent, declares no required_providers, or already pins archive.
// Returns true when the file changed.
export function ensureArchiveProvider(backendTfPath) {
    if (!fsSync.existsSync(backendTfPath)) return false;
    const content = fsSync.readFileSync(backendTfPath, 'utf-8');
    const bounds = findNestedBlock(content, 'required_providers');
    if (!bounds) return false;
    const inner = content.slice(bounds.openIdx, bounds.closeIdx);
    if (/^\s*archive\s*=/m.test(inner)) return false;
    const head = content.slice(0, bounds.closeIdx);
    const closingIndent = /(\n[ \t]*)$/.exec(head)?.[1] ?? '\n';
    const entry = '    archive = {\n      source  = "hashicorp/archive"\n      version = "~> 2.0"\n    }\n';
    const updated = `${head.replace(/\s+$/, '\n')}${entry}${closingIndent.slice(1)}${content.slice(bounds.closeIdx)}`;
    fsSync.writeFileSync(backendTfPath, updated);
    return true;
}

async function promptDestinations() {
    const choice = await select({
        message: 'Where should alarm notifications go?',
        options: [
            { value: 'email', label: 'Email', hint: 'SNS subscription (confirmation click required)' },
            { value: 'webhook', label: 'Slack/Discord webhook', hint: 'via a scale-to-zero forwarding Lambda' },
            { value: 'both', label: 'Both', hint: 'email subscription + chat webhook' },
        ],
    });
    if (isCancel(choice)) return { cancelled: true };
    const destinations = { email: undefined, webhook: undefined };
    if (choice === 'email' || choice === 'both') {
        const answer = await text({
            message: 'Email address for alarm notifications:',
            validate: (value) => (isValidEmail(value) ? undefined : 'Enter a valid email address.'),
        });
        if (isCancel(answer)) return { cancelled: true };
        destinations.email = answer.trim();
    }
    if (choice === 'webhook' || choice === 'both') {
        const answer = await text({
            message: 'Incoming webhook URL (Slack/Discord/generic HTTPS):',
            validate: (value) => (isValidWebhookUrl(value) ? undefined : 'Enter a valid https:// webhook URL.'),
        });
        if (isCancel(answer)) return { cancelled: true };
        destinations.webhook = answer.trim();
    }
    return destinations;
}

export async function runAlerts(input = {}) {
    const options = normalizeOptions(input);
    let cwd;
    let region;
    let projectName;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'alerts_run' });
    }
    const force = options.force === true || options.force === 'true';

    intro(color.bgCyan(color.black(' grada alerts 🔔 ')));

    if (Array.isArray(options.unexpectedPositionals) && options.unexpectedPositionals.length > 0) {
        return failCommand({
            message: `\n✖ Unexpected argument "${options.unexpectedPositionals[0]}". Run "grada alerts" to scaffold notifications.\n`,
            event: 'alerts_run',
            telemetry: { projectName },
            errorCode: 'UNEXPECTED_POSITIONAL_ARGS',
            reason: 'unexpected-positional-args',
            resultExtra: { region },
        });
    }

    const target = readTerraformComputeTarget(cwd);
    const mainTf = readFileSafe(path.join(cwd, 'terraform', 'main.tf'));
    if (!mainTf) {
        return failCommand({
            message: '\n✖ No terraform/main.tf found. Run "grada" first before scaffolding alerts.\n',
            event: 'alerts_run',
            telemetry: { projectName },
            errorCode: 'TERRAFORM_NOT_INITIALIZED',
            reason: 'terraform-not-initialized',
            resultExtra: { region },
        });
    }
    const anchor = TARGET_ANCHORS[target] || TARGET_ANCHORS.ecs;
    if (!mainTf.includes(anchor.resource)) {
        const anchorName = target === 'lambda' ? 'aws_lambda_function.app'
            : target === 'static' ? 'aws_cloudfront_distribution.site' : 'aws_lb.main';
        return failCommand({
            message: `\n✖ No ${anchorName} resource found in terraform/main.tf — the alarm has nothing to attach to.\n`,
            hint: '  If you ejected or heavily customized the stack, wire aws_sns_topic manually.\n',
            event: 'alerts_run',
            telemetry: { projectName },
            errorCode: anchor.errorCode,
            reason: anchor.reason,
            resultExtra: { region },
        });
    }

    let email = typeof options.email === 'string' && options.email.trim() ? options.email.trim() : undefined;
    let webhook = typeof options.webhook === 'string' && options.webhook.trim() ? options.webhook.trim() : undefined;

    if (email !== undefined && !isValidEmail(email)) {
        return failCommand({
            message: `\n✖ Invalid --email "${email}": expected an address like you@example.com.\n`,
            event: 'alerts_run',
            telemetry: { projectName },
            errorCode: 'INVALID_EMAIL',
            reason: 'invalid-email',
            resultExtra: { region },
        });
    }
    if (webhook !== undefined && !isValidWebhookUrl(webhook)) {
        return failCommand({
            message: `\n✖ Invalid --webhook "${webhook}": expected an https:// incoming webhook URL.\n`,
            event: 'alerts_run',
            telemetry: { projectName },
            errorCode: 'INVALID_WEBHOOK_URL',
            reason: 'invalid-webhook-url',
            resultExtra: { region },
        });
    }

    const rawThreshold = options.threshold;
    let threshold;
    if (rawThreshold !== undefined && rawThreshold !== null && String(rawThreshold).trim() !== '') {
        const parsed = parseThreshold(String(rawThreshold).trim(), target);
        if (!parsed.ok) {
            return failCommand({
                message: `\n✖ ${parsed.error}\n`,
                event: 'alerts_run',
                telemetry: { projectName },
                errorCode: 'INVALID_THRESHOLD',
                reason: 'invalid-threshold',
                resultExtra: { region },
            });
        }
        threshold = parsed.value;
    }

    const headless = resolveHeadless(options);
    if (email === undefined && webhook === undefined && !headless) {
        const prompted = await promptDestinations();
        if (prompted.cancelled) {
            cancel('Alerts scaffolding cancelled.');
            return { ok: false, cancelled: true };
        }
        email = prompted.email;
        webhook = prompted.webhook;
    }

    const alertsPath = path.join(cwd, ALERTS_TF_FILE);
    if (fsSync.existsSync(alertsPath) && !force) {
        return failCommand({
            message: `\n⚠ ${ALERTS_TF_FILE} already exists. Pass --force to overwrite.\n`,
            tone: 'yellow',
            event: 'alerts_run',
            telemetry: { projectName, error_code: 'ALERTS_FILE_EXISTS' },
            reason: 'alerts-file-exists',
            resultExtra: { projectName, region },
            exitCode: null,
        });
    }

    // Static alarms + topics must live in us-east-1 (CloudFront metrics
    // are only visible there); ensure main.tf declares the alias the
    // generated file references. No-op when already present.
    let aliasAdded = false;
    if (target === 'static') {
        aliasAdded = ensureUsEast1Provider(path.join(cwd, 'terraform', 'main.tf'));
    }
    // The forwarder's data.archive_file needs its provider pinned next
    // to the aws one (required_providers may only appear once).
    let archiveAdded = false;
    if (webhook) {
        archiveAdded = ensureArchiveProvider(path.join(cwd, 'terraform', 'backend.tf'));
    }

    fsSync.writeFileSync(alertsPath, buildAlertsTf({ projectName, target, email, webhook, threshold }));
    const destinations = email && webhook ? 'both' : webhook ? 'webhook' : email ? 'email' : 'manual';
    const kind = webhook ? detectWebhookKind(webhook) : undefined;
    console.log(color.green(`\n✅ Created ${ALERTS_TF_FILE} (SNS topic + ${target} notify alarm${webhook ? ' + chat forwarder' : ''}).`));
    if (aliasAdded) console.log(color.dim('  Added the aws.us_east_1 provider alias to terraform/main.tf (CloudFront alarms only exist there).'));
    if (archiveAdded) console.log(color.dim('  Pinned the archive provider in terraform/backend.tf (forwarder packaging).'));
    console.log(color.dim('  Next steps:'));
    if (webhook) {
        console.log(color.dim(`    1. export TF_VAR_alerts_webhook_url='${webhook}'   # ${kind} webhook; never commit it`));
        console.log(color.dim('    2. npx grada-run apply'));
        if (email) console.log(color.dim('    3. Click the confirmation link in the email.'));
        console.log('');
    } else if (email) {
        console.log(color.dim('    1. npx grada-run apply'));
        console.log(color.dim(`    2. Click the confirmation link sent to ${email}.`));
        console.log('');
    } else {
        console.log(color.dim('    1. npx grada-run apply'));
        console.log(color.dim(`    2. aws sns subscribe --topic-arn <topic-arn> --protocol email --notification-endpoint you@example.com --region ${region}`));
        console.log(color.dim('    3. Click the confirmation link in the email.\n'));
    }
    // Telemetry carries destination *kinds* only — never the email
    // address or webhook URL (PII / bearer secret).
    await trackSuccess('alerts_run', { projectName, action: 'scaffold', target, destinations, thresholdCustom: threshold !== undefined });
    outro(color.green('Done.'));
    return { ok: true, action: 'scaffold', projectName, region, target, destinations, file: ALERTS_TF_FILE };
}
