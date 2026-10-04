import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import color from 'picocolors';
import { intro, outro, confirm, cancel, isCancel } from '@clack/prompts';
import { trackSuccess, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { resolveProjectName, resolveHeadless, resolveCwd } from '../utils/resolvers.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { failCommand, failProjectNotInitialized, isProgrammaticCall } from '../utils/command.js';
import { getTerraformOutputs } from '../utils/terraform.js';
import {
    findResourceBlock,
    findNestedBlock,
    replaceBlock,
    upsertAttribute,
    removeAttribute,
    getAttributeValue,
} from '../utils/hcl.js';
import { normalizeDomain, isValidDomain, normalizeZoneId, parseDomainTf } from '../utils/domains.js';

export const DOMAIN_SUBCOMMANDS = ['add', 'verify', 'activate', 'status', 'remove'];

// --- Pure HCL builders for terraform/domain.tf ---

function acmCertificateBlock(domain) {
    return `resource "aws_acm_certificate" "domain" {
  count             = terraform.workspace == "default" ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = "${domain}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}`;
}

function usEast1ProviderBlock() {
    return `# tflint-ignore: terraform_unused_declarations
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      ManagedBy = "grada"
    }
  }
}`;
}

// Appends the us_east_1 provider alias to main.tf when missing, so projects
// that configured a domain before the provider moved out of domain.tf keep a
// provider configuration Terraform can use to destroy the orphaned
// certificate. No-op when main.tf is absent or already declares the alias.
export function ensureUsEast1Provider(mainTfPath) {
    if (!fsSync.existsSync(mainTfPath)) return false;
    const content = fsSync.readFileSync(mainTfPath, 'utf-8');
    if (/alias\s*=\s*"us_east_1"/.test(content)) return false;
    const suffix = content.endsWith('\n') ? '' : '\n';
    fsSync.writeFileSync(mainTfPath, `${content}${suffix}\n${usEast1ProviderBlock()}\n`);
    return true;
}

// Route 53 1-step mode: validation records, certificate validation, and
// CloudFront alias records are all managed in one apply.
export function renderDomainTfRoute53({ domain, zoneId }) {
    return `# grada:domain-mode=route53
# grada:zone-id=${zoneId}
# Managed by \`grada domain\`. Do not edit by hand — re-running
# \`domain add --force\` overwrites this file.

${acmCertificateBlock(domain)}

resource "aws_route53_record" "domain_validation" {
  for_each = terraform.workspace == "default" ? { for dvo in aws_acm_certificate.domain[0].domain_validation_options : dvo.domain_name => { name = dvo.resource_record_name, record = dvo.resource_record_value, type = dvo.resource_record_type } } : {}

  zone_id         = "${zoneId}"
  allow_overwrite = true
  ttl             = 60
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
}

resource "aws_acm_certificate_validation" "domain" {
  count                   = terraform.workspace == "default" ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.domain[0].arn
  validation_record_fqdns = [for record in aws_route53_record.domain_validation : record.fqdn]
}

resource "aws_route53_record" "cdn_alias_a" {
  count   = terraform.workspace == "default" ? 1 : 0
  zone_id = "${zoneId}"
  name    = "${domain}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.cdn.domain_name
    zone_id                = aws_cloudfront_distribution.cdn.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "cdn_alias_aaaa" {
  count   = terraform.workspace == "default" ? 1 : 0
  zone_id = "${zoneId}"
  name    = "${domain}"
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.cdn.domain_name
    zone_id                = aws_cloudfront_distribution.cdn.hosted_zone_id
    evaluate_target_health = false
  }
}

output "custom_domain_url" {
  value = "https://${domain}"
}

output "acm_certificate_arn" {
  value = terraform.workspace == "default" ? aws_acm_certificate.domain[0].arn : null
}
`;
}

// External-DNS Stage 1: only the certificate is created (in seconds, with
// no DNS dependency). CloudFront stays on the default certificate until
// \`domain verify\` activates the domain.
export function renderDomainTfExternalPending({ domain }) {
    return `# grada:domain-mode=external-pending
# Managed by \`grada domain\`. Do not edit by hand — re-running
# \`domain add --force\` overwrites this file.

${acmCertificateBlock(domain)}

output "acm_validation_records" {
  value = terraform.workspace == "default" ? [for dvo in aws_acm_certificate.domain[0].domain_validation_options : { name = dvo.resource_record_name, type = dvo.resource_record_type, value = dvo.resource_record_value }] : []
}

output "custom_domain_cname_target" {
  value = aws_cloudfront_distribution.cdn.domain_name
}
`;
}

// Idempotently transitions external-pending Stage 1 content to
// external-active by appending the validation resource (which waits for
// the user-created DNS records) and the domain URL output. No-op for
// content that is already active.
export function appendValidationResource(domainTfContent) {
    const content = String(domainTfContent ?? '');
    if (!content.trim()) return content;
    let updated = content;
    if (updated.includes('"aws_acm_certificate_validation"')) {
        if (!updated.includes('output "custom_domain_url"')) {
            if (!updated.endsWith('\n')) updated += '\n';
            updated += `
output "custom_domain_url" {
  value = "https://${parseDomainTf(updated)?.domain || ''}"
}
`;
        }
    } else {
        if (!updated.endsWith('\n')) updated += '\n';
        updated += `
resource "aws_acm_certificate_validation" "domain" {
  count           = terraform.workspace == "default" ? 1 : 0
  provider        = aws.us_east_1
  certificate_arn = aws_acm_certificate.domain[0].arn
}

output "custom_domain_url" {
  value = "https://${parseDomainTf(updated)?.domain || ''}"
}
`;
    }
    return updated.replace(
        /#\s*(?:grada|deploy-stack):domain-mode=external-pending/,
        '# grada:domain-mode=external-active'
    );
}

// --- Pure CloudFront patchers for terraform/cloudfront.tf ---

function parseHclStringList(value) {
    const items = [];
    for (const match of String(value ?? '').matchAll(/"([^"]*)"/g)) {
        if (match[1] !== '') items.push(match[1]);
    }
    return items;
}

// Renders `aliases` in workspace-conditional form so PR preview
// workspaces never claim the production alias (which would fail with
// CNAMEAlreadyExists). An empty list degrades to a plain `[]`.
function renderConditionalAliasesList(domains) {
    const list = `[${domains.map((domain) => `"${domain}"`).join(', ')}]`;
    if (domains.length === 0) return list;
    return `terraform.workspace == "default" ? ${list} : []`;
}

// Extracts alias domains from an `aliases` value, reading only the
// true-branch list in conditional form so `"default"` is never misread
// as an alias domain. Plain lists parse whole (legacy/hand-edited files).
function parseAliasesValue(value) {
    const text = String(value ?? '');
    const match = text.match(/\?\s*\[([\s\S]*)\]\s*:\s*\[\s*\]\s*$/);
    return parseHclStringList(match ? `[${match[1]}]` : text);
}

// Replaces the whole `viewer_certificate { ... }` statement (attributes
// differ per mode and are mutually exclusive, so merging is never
// correct). Inserted before the resource close when absent.
function replaceViewerCertificate(block, innerLines) {
    const replacement = [
        '  viewer_certificate {',
        ...innerLines.map((line) => `    ${line}`),
        '  }',
    ].join('\n');
    const viewer = findNestedBlock(block, 'viewer_certificate');
    if (!viewer) {
        const closeIdx = block.lastIndexOf('}');
        if (closeIdx === -1) return block;
        const glue = closeIdx > 0 && block[closeIdx - 1] === '\n' ? '' : '\n';
        return `${block.slice(0, closeIdx)}${glue}${replacement}\n${block.slice(closeIdx)}`;
    }
    const lineStart = block.lastIndexOf('\n', viewer.startIdx) + 1;
    return block.slice(0, lineStart) + replacement + block.slice(viewer.closeIdx + 1);
}

const ACM_VIEWER_CERTIFICATE = [
    'cloudfront_default_certificate = terraform.workspace != "default"',
    'acm_certificate_arn            = terraform.workspace == "default" ? aws_acm_certificate_validation.domain[0].certificate_arn : null',
    'ssl_support_method             = terraform.workspace == "default" ? "sni-only" : null',
    'minimum_protocol_version       = terraform.workspace == "default" ? "TLSv1.2_2021" : "TLSv1"',
];

const DEFAULT_VIEWER_CERTIFICATE = ['cloudfront_default_certificate = true'];

// Adds `domain` to the workspace-conditional `aliases` of
// `aws_cloudfront_distribution "cdn"` (merging with user-added entries
// in the true-branch list) and switches `viewer_certificate` to the
// validated ACM certificate in production, default certificate in
// previews. Idempotent; returns the content unchanged when the
// distribution is missing.
export function patchCloudFrontDomain(cloudfrontTfContent, domain) {
    const content = String(cloudfrontTfContent ?? '');
    const resource = findResourceBlock(content, 'aws_cloudfront_distribution', 'cdn');
    if (!resource) return content;
    const head = content.slice(0, resource.openIdx);
    const tail = content.slice(resource.closeIdx + 1);
    let block = content.slice(resource.openIdx, resource.closeIdx + 1);
    const current = getAttributeValue(block, 'aliases');
    const aliases = current === null ? [] : parseAliasesValue(current);
    if (!aliases.includes(domain)) {
        block = upsertAttribute(block, 'aliases', renderConditionalAliasesList([...aliases, domain]));
    }
    block = replaceViewerCertificate(block, ACM_VIEWER_CERTIFICATE);
    return head + block + tail;
}

// Removes `domain` from the `aliases` (dropping the attribute when no
// aliases remain) and restores the default CloudFront certificate.
// Idempotent; returns the content unchanged when the distribution or
// the domain wiring is missing.
export function unpatchCloudFrontDomain(cloudfrontTfContent, domain) {
    const content = String(cloudfrontTfContent ?? '');
    const resource = findResourceBlock(content, 'aws_cloudfront_distribution', 'cdn');
    if (!resource) return content;
    const head = content.slice(0, resource.openIdx);
    const tail = content.slice(resource.closeIdx + 1);
    let block = content.slice(resource.openIdx, resource.closeIdx + 1);
    const current = getAttributeValue(block, 'aliases');
    if (current !== null) {
        const remaining = parseAliasesValue(current).filter((entry) => entry !== domain);
        block = remaining.length === 0
            ? removeAttribute(block, 'aliases')
            : upsertAttribute(block, 'aliases', renderConditionalAliasesList(remaining));
    }
    block = replaceViewerCertificate(block, DEFAULT_VIEWER_CERTIFICATE);
    return head + block + tail;
}

// True when `domain` is present in the `aliases` of the CloudFront
// distribution (used by `domain status`).
export function isCloudFrontWired(cloudfrontTfContent, domain) {
    const content = String(cloudfrontTfContent ?? '');
    const resource = findResourceBlock(content, 'aws_cloudfront_distribution', 'cdn');
    if (!resource) return false;
    const block = content.slice(resource.openIdx, resource.closeIdx + 1);
    const current = getAttributeValue(block, 'aliases');
    if (current === null) return false;
    return parseAliasesValue(current).includes(domain);
}

// --- CLI surface ---

export function parseDomainArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'domain') args.shift();
    const { options: parsed, rest } = parseFlags(args, {
        string: ['zone-id'],
        boolean: ['force', 'activate', 'yes', { name: 'headless', key: 'isHeadless' }],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    return {
        subcommand: positionals[0],
        domain: positionals[1],
        zoneId: parsed.zoneId,
        activate: parsed.activate === true,
        force: parsed.force === true,
        yes: parsed.yes === true,
        isHeadless: parsed.isHeadless === true,
    };
}

function printDomainUsage() {
    console.log('Usage:');
    console.log('  grada domain add <domain> [--zone-id <id>] [--activate] [--force]');
    console.log('  grada domain verify [--headless]  (alias: activate)');
    console.log('  grada domain status');
    console.log('  grada domain remove [--yes]');
}

// Unwraps `terraform output -json` values (`{ name: { value } }`),
// tolerating already-unwrapped values from test doubles.
function outputValue(outputs, name) {
    const entry = outputs?.[name];
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && 'value' in entry) {
        return entry.value;
    }
    return entry;
}

// Renders copy-paste DNS rows for external providers. Columns size to
// content and names/values print untouched so records paste verbatim.
function printDnsTable(rows) {
    const typeWidth = Math.max(4, ...rows.map((row) => row.type.length));
    const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
    console.log(`  ${'Type'.padEnd(typeWidth)}  ${'Name'.padEnd(nameWidth)}  Value`);
    for (const row of rows) {
        console.log(`  ${color.cyan(row.type.padEnd(typeWidth))}  ${row.name.padEnd(nameWidth)}  ${color.dim(row.value)}`);
    }
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runDomain(input = {}) {
    setActiveCommandName('domain');
    try {
        return await runDomainMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runDomainMain(input = {}) {
    const options = normalizeOptions(input);
    const noExit = isProgrammaticCall(options);
    const subcommand = typeof options.subcommand === 'string' ? options.subcommand.trim().toLowerCase() : undefined;

    intro(color.bgCyan(color.black(' grada domain 🌐 ')));

    if (!DOMAIN_SUBCOMMANDS.includes(subcommand)) {
        // Closed enum only — never echo the raw user token into telemetry.
        const telemetrySubcommand = typeof options.subcommand === 'string' && options.subcommand.trim() !== ''
            ? 'unknown'
            : 'none';
        return failCommand({
            noExit,
            print: () => {
                if (subcommand === undefined) {
                    console.log(color.yellow('\n⚠ Missing domain subcommand.'));
                } else {
                    console.log(color.red(`\n✖ Unknown domain subcommand "${options.subcommand}".`));
                }
                console.log('');
                printDomainUsage();
                console.log('');
            },
            event: 'domain_run',
            telemetry: { subcommand: telemetrySubcommand },
            errorCode: 'UNKNOWN_DOMAIN_SUBCOMMAND',
            reason: 'unknown-domain-subcommand',
        });
    }

    // Flag validation runs before filesystem guards (matching add.js).
    let domain = null;
    let zoneId = null;
    if (subcommand === 'add') {
        domain = normalizeDomain(options.domain);
        if (!domain || !isValidDomain(domain)) {
            return failCommand({
                noExit,
                message: `\n✖ Invalid domain "${options.domain ?? ''}".`,
                hint: '  Use a fully qualified domain name (e.g. grada domain add example.com).\n',
                event: 'domain_run',
                telemetry: { subcommand, error_code: 'INVALID_DOMAIN' },
                reason: 'invalid-domain',
                resultExtra: { subcommand },
            });
        }
        if (options.zoneId !== undefined && options.zoneId !== null) {
            zoneId = normalizeZoneId(options.zoneId);
            if (zoneId === null) {
                return failCommand({
                    noExit,
                    message: `\n✖ Invalid Route 53 zone ID "${options.zoneId}".`,
                    hint: '  Zone IDs look like Z1234567890ABC (find yours with: aws route53 list-hosted-zones).\n',
                    event: 'domain_run',
                    telemetry: { subcommand, error_code: 'INVALID_ZONE_ID' },
                    reason: 'invalid-zone-id',
                    resultExtra: { subcommand },
                });
            }
        }
    }

    let cwd;
    let projectName;
    try {
        cwd = resolveCwd(options);
        projectName = resolveProjectName(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'domain_run', noExit });
    }

    const terraformDir = path.join(cwd, 'terraform');
    const domainTfPath = path.join(terraformDir, 'domain.tf');
    const cloudfrontTfPath = path.join(terraformDir, 'cloudfront.tf');

    // `remove` tolerates a missing cloudfront.tf (there may be nothing to
    // unpatch); every other subcommand needs the scaffolded file.
    if (subcommand !== 'remove' && !fsSync.existsSync(cloudfrontTfPath)) {
        return failCommand({
            noExit,
            message: '\n✖ No terraform/cloudfront.tf found. Run "grada" first before managing custom domains.\n',
            event: 'domain_run',
            telemetry: { subcommand, error_code: 'TERRAFORM_NOT_INITIALIZED' },
            reason: 'terraform-not-initialized',
            resultExtra: { subcommand },
        });
    }

    if (subcommand === 'add') return runDomainAdd({ options, cwd, projectName, domain, zoneId, domainTfPath, cloudfrontTfPath });
    if (subcommand === 'verify' || subcommand === 'activate') {
        return runDomainVerify({ options, cwd, projectName, domainTfPath, cloudfrontTfPath });
    }
    if (subcommand === 'status') return runDomainStatus({ options, cwd, projectName, domainTfPath, cloudfrontTfPath });
    return runDomainRemove({ options, cwd, projectName, domainTfPath, cloudfrontTfPath });
}

async function runDomainAdd({ options, projectName, domain, zoneId, domainTfPath, cloudfrontTfPath }) {
    const noExit = isProgrammaticCall(options);
    const force = options.force === true;
    const activate = options.activate === true;
    let previousDomain = null;
    if (fsSync.existsSync(domainTfPath)) {
        if (!force) {
            return failCommand({
                noExit,
                message: '\n⚠ A custom domain is already configured (terraform/domain.tf exists).',
                hint: '  Pass --force to replace it, or run "grada domain verify" to activate.\n',
                tone: 'yellow',
                event: 'domain_run',
                telemetry: { projectName, subcommand: 'add', error_code: 'DOMAIN_ALREADY_CONFIGURED' },
                reason: 'domain-already-configured',
                resultExtra: { subcommand: 'add', projectName },
                exitCode: null,
            });
        }
        try {
            previousDomain = parseDomainTf(fsSync.readFileSync(domainTfPath, 'utf-8'))?.domain || null;
        } catch {
            previousDomain = null;
        }
    }

    const mode = zoneId ? 'route53' : (activate ? 'external-active' : 'external-pending');
    let content;
    if (mode === 'route53') {
        content = renderDomainTfRoute53({ domain, zoneId });
    } else if (mode === 'external-active') {
        content = appendValidationResource(renderDomainTfExternalPending({ domain }));
    } else {
        content = renderDomainTfExternalPending({ domain });
    }
    await fs.mkdir(path.dirname(domainTfPath), { recursive: true });
    await fs.writeFile(domainTfPath, content);
    ensureUsEast1Provider(path.join(path.dirname(domainTfPath), 'main.tf'));

    let cloudfrontPatched = false;
    if (mode !== 'external-pending') {
        const patched = await patchCloudFrontFile(cloudfrontTfPath, domain, previousDomain, 'add', noExit);
        if (!patched.ok) return patched.failure;
        cloudfrontPatched = patched.changed;
    }

    if (mode === 'route53') {
        console.log(color.green(`\n✅ Custom domain ${domain} configured with automated Route 53 validation.`));
        console.log(`  Run ${color.green('npx grada-run apply')} to issue the certificate and bind it to CloudFront.`);
    } else if (mode === 'external-active') {
        console.log(color.green(`\n✅ Custom domain ${domain} activated.`));
        console.log('  Ensure your external DNS validation CNAMEs are in place, then run');
        console.log(`  ${color.green('npx grada-run apply')} to bind the certificate to CloudFront.`);
    } else {
        console.log(color.green(`\n✅ Custom domain ${domain} staged for external DNS verification.`));
        console.log(`  1. Run ${color.green('npx grada-run apply')} to generate the ACM validation CNAMEs.`);
        console.log(`  2. Add the CNAMEs at your DNS provider (see ${color.green('npx grada-run domain status')}).`);
        console.log(`  3. Run ${color.green('npx grada-run domain verify')} to activate.`);
    }
    outro(color.green(`Domain ${domain} ready.`));
    await trackSuccess('domain_run', { projectName, subcommand: 'add', mode });
    return { ok: true, subcommand: 'add', mode, domain, file: 'terraform/domain.tf', cloudfrontPatched };
}

// Patches `cloudfront.tf`, replacing a previous managed domain on --force.
// Returns `{ ok: true, changed }` or `{ ok: false, failure }`.
async function patchCloudFrontFile(cloudfrontTfPath, domain, previousDomain, subcommand, noExit = false) {
    let content;
    try {
        content = await fs.readFile(cloudfrontTfPath, 'utf-8');
    } catch {
        content = null;
    }
    if (content === null || !findResourceBlock(content, 'aws_cloudfront_distribution', 'cdn')) {
        return {
            ok: false,
            failure: failCommand({
                noExit,
                message: '\n✖ terraform/cloudfront.tf does not contain aws_cloudfront_distribution "cdn". The domain file was written but CloudFront could not be wired.\n',
                event: 'domain_run',
                telemetry: { subcommand, error_code: 'CLOUDFRONT_RESOURCE_NOT_FOUND' },
                reason: 'cloudfront-resource-not-found',
                resultExtra: { subcommand },
            }),
        };
    }
    let updated = content;
    if (previousDomain && previousDomain !== domain) {
        updated = unpatchCloudFrontDomain(updated, previousDomain);
    }
    updated = patchCloudFrontDomain(updated, domain);
    const changed = updated !== content;
    if (changed) await fs.writeFile(cloudfrontTfPath, updated);
    return { ok: true, changed };
}

async function runDomainVerify({ options, projectName, domainTfPath, cloudfrontTfPath }) {
    const noExit = isProgrammaticCall(options);
    if (!fsSync.existsSync(domainTfPath)) {
        return failCommand({
            noExit,
            message: '\n✖ No custom domain configured. Run "grada domain add <domain>" first.\n',
            event: 'domain_run',
            telemetry: { projectName, subcommand: 'verify', error_code: 'DOMAIN_NOT_CONFIGURED' },
            reason: 'domain-not-configured',
            resultExtra: { subcommand: 'verify', projectName },
        });
    }
    const content = fsSync.readFileSync(domainTfPath, 'utf-8');
    const parsed = parseDomainTf(content);
    const domain = parsed?.domain;
    if (!domain) {
        return failCommand({
            noExit,
            message: '\n✖ terraform/domain.tf exists but no domain_name could be parsed from it.\n',
            event: 'domain_run',
            telemetry: { projectName, subcommand: 'verify', error_code: 'DOMAIN_NOT_CONFIGURED' },
            reason: 'domain-not-configured',
            resultExtra: { subcommand: 'verify', projectName },
        });
    }
    const mode = parsed?.mode;
    if (mode === 'route53' || mode === 'external-active') {
        const patched = await patchCloudFrontFile(cloudfrontTfPath, domain, null, 'verify', noExit);
        if (!patched.ok) return patched.failure;
        console.log(color.green(`\n✅ Custom domain ${domain} is already active (${mode}).`));
        outro(color.green('Nothing to do.'));
        await trackSuccess('domain_run', { projectName, subcommand: 'verify', mode, alreadyActive: true });
        return { ok: true, subcommand: 'verify', mode, domain, alreadyActive: true };
    }
    await fs.writeFile(domainTfPath, appendValidationResource(content));
    const patched = await patchCloudFrontFile(cloudfrontTfPath, domain, null, 'verify', noExit);
    if (!patched.ok) return patched.failure;
    console.log(color.green(`\n✅ Custom domain ${domain} activated.`));
    console.log('  Ensure your external DNS validation CNAMEs are in place before running');
    console.log(`  ${color.green('npx grada-run apply')} (apply waits on DNS propagation).`);
    outro(color.green(`Domain ${domain} ready.`));
    await trackSuccess('domain_run', { projectName, subcommand: 'verify', mode: 'external-active' });
    return { ok: true, subcommand: 'verify', mode: 'external-active', domain };
}

async function runDomainStatus({ options, cwd, projectName, domainTfPath, cloudfrontTfPath }) {
    const noExit = isProgrammaticCall(options);
    if (!fsSync.existsSync(domainTfPath)) {
        console.log('\nNo custom domain configured. Run npx grada-run domain add <domain> to get started.');
        outro(color.green('No custom domain configured.'));
        await trackSuccess('domain_run', { projectName, subcommand: 'status', configured: false });
        return { ok: true, subcommand: 'status', configured: false };
    }
    const parsed = parseDomainTf(fsSync.readFileSync(domainTfPath, 'utf-8'));
    const domain = parsed?.domain || '(unparseable)';
    const mode = parsed?.mode || 'unknown';
    let wired = false;
    try {
        if (fsSync.existsSync(cloudfrontTfPath)) {
            wired = isCloudFrontWired(fsSync.readFileSync(cloudfrontTfPath, 'utf-8'), parsed?.domain);
        }
    } catch {
        wired = false;
    }
    console.log(`\n  ${color.bold('Domain:')} ${color.cyan(domain)}`);
    console.log(`  ${color.bold('Mode:')} ${mode}`);
    console.log(`  ${color.bold('CloudFront:')} ${wired ? color.green('wired') : color.yellow('not wired yet')}`);

    const getOutputs = typeof options.getOutputs === 'function'
        ? options.getOutputs
        : (dir) => getTerraformOutputs(dir);
    let outputs = {};
    try {
        outputs = await getOutputs(path.join(cwd, 'terraform')) || {};
    } catch {
        outputs = {};
    }
    const rows = [];
    const records = outputValue(outputs, 'acm_validation_records');
    if (Array.isArray(records)) {
        for (const record of records) {
            if (record && record.name && record.value) {
                rows.push({ type: record.type || 'CNAME', name: String(record.name), value: String(record.value) });
            }
        }
    }
    const target = outputValue(outputs, 'custom_domain_cname_target') || outputValue(outputs, 'cloudfront_url');
    if (typeof target === 'string' && target) {
        rows.push({ type: 'CNAME', name: domain, value: target.replace(/^https:\/\//, '') });
    }
    if (rows.length > 0) {
        console.log('');
        console.log(`  ${color.dim('Add these records at your DNS provider:')}`);
        printDnsTable(rows);
    } else {
        console.log(`  ${color.dim('No DNS outputs yet — run npx grada-run apply first.')}`);
    }
    outro(color.green(wired ? 'Domain is active on CloudFront.' : 'Run npx grada-run domain verify once DNS records are in place.'));
    await trackSuccess('domain_run', { projectName, subcommand: 'status', configured: true, mode });
    return { ok: true, subcommand: 'status', configured: true, domain: parsed?.domain || null, mode, wired };
}

async function runDomainRemove({ options, projectName, domainTfPath, cloudfrontTfPath }) {
    const noExit = isProgrammaticCall(options);
    if (!fsSync.existsSync(domainTfPath)) {
        return failCommand({
            noExit,
            message: '\n✖ No custom domain configured. Nothing to remove.\n',
            event: 'domain_run',
            telemetry: { projectName, subcommand: 'remove', error_code: 'DOMAIN_NOT_CONFIGURED' },
            reason: 'domain-not-configured',
            resultExtra: { subcommand: 'remove', projectName },
        });
    }
    const parsed = parseDomainTf(fsSync.readFileSync(domainTfPath, 'utf-8'));
    const domain = parsed?.domain;
    const mode = parsed?.mode || 'unknown';
    const yes = options.yes === true;
    if (!yes && resolveHeadless(options)) {
        return failCommand({
            noExit,
            message: '\n✖ Refusing to remove the custom domain without confirmation. Re-run with --yes.\n',
            event: 'domain_run',
            telemetry: { projectName, subcommand: 'remove', error_code: 'CONFIRMATION_REQUIRED' },
            reason: 'confirmation-required',
            resultExtra: { subcommand: 'remove', projectName },
        });
    }
    if (!yes) {
        const answer = await confirm({ message: `Remove custom domain ${domain || '(unparseable)'} and restore the default CloudFront certificate?` });
        if (isCancel(answer) || !answer) {
            return failCommand({
                noExit,
                print: () => cancel('Domain removal cancelled.'),
                event: 'domain_run',
                telemetry: { projectName, subcommand: 'remove', reason: 'cancelled' },
                reason: 'cancelled',
                exitCode: null,
            });
        }
    }
    try {
        if (domain && fsSync.existsSync(cloudfrontTfPath)) {
            const content = fsSync.readFileSync(cloudfrontTfPath, 'utf-8');
            const updated = unpatchCloudFrontDomain(content, domain);
            if (updated !== content) fsSync.writeFileSync(cloudfrontTfPath, updated);
        }
    } catch {
        // A best-effort unpatch never blocks domain.tf removal.
    }
    ensureUsEast1Provider(path.join(path.dirname(domainTfPath), 'main.tf'));
    fsSync.rmSync(domainTfPath, { force: true });
    console.log(color.green(`\n✅ Custom domain ${domain || ''} removed; CloudFront restored to the default certificate.`.replace('  ', ' ')));
    console.log(`  Run ${color.green('npx grada-run apply')} to push the change.`);
    outro(color.green('Done.'));
    await trackSuccess('domain_run', { projectName, subcommand: 'remove', mode });
    return { ok: true, subcommand: 'remove', removed: true, domain: domain || null };
}

export default runDomain;
