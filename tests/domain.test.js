import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { createTmpDirTracker } from './helpers/tmpdir.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stripVTControlCharacters } from 'node:util';
import {
    findResourceBlock,
    findNestedBlock,
    replaceBlock,
    upsertAttribute,
    removeAttribute,
    getAttributeValue,
    findArrayBounds,
    enclosingBraceBounds,
} from '../src/utils/hcl.js';
import {
    normalizeDomain,
    isValidDomain,
    normalizeZoneId,
    isValidFromEmail,
    parseDomainTf,
} from '../src/utils/domains.js';
import {
    parseDomainArgs,
    runDomain,
    renderDomainTfRoute53,
    renderDomainTfExternalPending,
    appendValidationResource,
    patchCloudFrontDomain,
    unpatchCloudFrontDomain,
    isCloudFrontWired,
    ensureUsEast1Provider,
} from '../src/commands/domain.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';
import { confirm, outro } from '@clack/prompts';



const tmp = createTmpDirTracker();
let exitSpy;
let logSpy;

function makeTmp() {
    return tmp.makeTmp('domain-test-');
}

const CLOUDFRONT_TF = [
    'resource "aws_cloudfront_distribution" "cdn" {',
    '  enabled             = true',
    '  is_ipv6_enabled     = true',
    '  wait_for_deployment = false',
    '',
    '  origin {',
    '    domain_name = aws_lb.main.dns_name',
    '    origin_id   = "ALBOrigin"',
    '',
    '    custom_origin_config {',
    '      http_port              = 80',
    '      origin_protocol_policy = "http-only"',
    '    }',
    '  }',
    '',
    '  default_cache_behavior {',
    '    allowed_methods        = ["GET", "HEAD"]',
    '    cached_methods         = ["GET", "HEAD"]',
    '    target_origin_id       = "ALBOrigin"',
    '    viewer_protocol_policy = "redirect-to-https"',
    '  }',
    '',
    '  restrictions {',
    '    geo_restriction {',
    '      restriction_type = "none"',
    '    }',
    '  }',
    '',
    '  viewer_certificate {',
    '    # Gives the user a free HTTPS *.cloudfront.net domain out of the box',
    '    cloudfront_default_certificate = true',
    '  }',
    '}',
    '',
    'output "cloudfront_url" {',
    '  value = "https://${aws_cloudfront_distribution.cdn.domain_name}"',
    '}',
    '',
].join('\n');

function writeCloudfrontTf(dir, content = CLOUDFRONT_TF) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'terraform', 'cloudfront.tf'), content);
}

const MAIN_TF_NO_ALIAS = [
    'provider "aws" {',
    '  region = "us-west-2"',
    '}',
    '',
].join('\n');

function writeMainTf(dir, content = MAIN_TF_NO_ALIAS) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), content);
}

function capturedOutput() {
    return stripVTControlCharacters(logSpy.mock.calls.map((args) => String(args[0])).join('\n'));
}

beforeEach(() => {
    tmp.reset();
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    tmp.cleanup();
});

describe('hcl: findResourceBlock', () => {
    it('finds resource bounds and slices the exact block', () => {
        const bounds = findResourceBlock(CLOUDFRONT_TF, 'aws_cloudfront_distribution', 'cdn');
        expect(bounds).not.toBeNull();
        const block = CLOUDFRONT_TF.slice(bounds.openIdx, bounds.closeIdx + 1);
        expect(block.startsWith('{')).toBe(true);
        expect(block).toContain('viewer_certificate');
        expect(block.endsWith('}')).toBe(true);
    });

    it('returns null for missing resources and unterminated blocks', () => {
        expect(findResourceBlock(CLOUDFRONT_TF, 'aws_cloudfront_distribution', 'nope')).toBeNull();
        expect(findResourceBlock('resource "aws_x" "y" {', 'aws_x', 'y')).toBeNull();
        expect(findResourceBlock('', 'aws_x', 'y')).toBeNull();
    });

    it('ignores braces inside strings and comments', () => {
        const content = [
            'resource "aws_x" "y" {',
            '  # a comment with { brace',
            '  value = "not a { block } end"',
            '  /* block comment } { */',
            '  real = true',
            '}',
            'trailing = "{"',
            '',
        ].join('\n');
        const bounds = findResourceBlock(content, 'aws_x', 'y');
        expect(content.slice(bounds.openIdx, bounds.closeIdx + 1)).toContain('real = true');
        expect(content[bounds.closeIdx + 1]).toBe('\n');
    });
});

describe('hcl: findNestedBlock / replaceBlock', () => {
    const block = CLOUDFRONT_TF.slice(
        findResourceBlock(CLOUDFRONT_TF, 'aws_cloudfront_distribution', 'cdn').openIdx,
        findResourceBlock(CLOUDFRONT_TF, 'aws_cloudfront_distribution', 'cdn').closeIdx + 1
    );

    it('finds a nested block by keyword', () => {
        const viewer = findNestedBlock(block, 'viewer_certificate');
        expect(viewer).not.toBeNull();
        expect(block.slice(viewer.startIdx, viewer.openIdx + 1)).toContain('viewer_certificate {');
        expect(block.slice(viewer.openIdx, viewer.closeIdx + 1)).toContain('cloudfront_default_certificate');
        expect(findNestedBlock(block, 'aliases')).toBeNull();
    });

    it('skips same-named identifiers inside deeper blocks and strings', () => {
        const tricky = '{\n  note = "viewer_certificate { fake"\n  viewer_certificate {\n    ok = true\n  }\n}\n';
        const viewer = findNestedBlock(tricky, 'viewer_certificate');
        expect(tricky.slice(viewer.openIdx, viewer.closeIdx + 1)).toContain('ok = true');
    });

    it('replaceBlock splices over the given bounds', () => {
        const viewer = findNestedBlock(block, 'viewer_certificate');
        const replaced = replaceBlock(block, viewer, '  viewer_certificate {\n    x = 1\n  }');
        expect(replaced).toContain('x = 1');
        expect(replaced).not.toContain('cloudfront_default_certificate');
        expect(replaceBlock(block, null, 'x')).toBe(block);
    });
});

describe('hcl: upsert/remove/get attribute', () => {
    const block = '{\n  enabled = true\n  tags = {\n    Name = "x"\n  }\n}\n';

    it('reads top-level attribute values including multi-line lists', () => {
        expect(getAttributeValue(block, 'enabled')).toBe('true');
        expect(getAttributeValue(block, 'Name')).toBeNull();
        expect(getAttributeValue('{\n  aliases = [\n    "a.com",\n    "b.com",\n  ]\n}\n', 'aliases'))
            .toContain('"a.com"');
    });

    it('upserts in place and returns identical content when unchanged', () => {
        const updated = upsertAttribute(block, 'enabled', 'false');
        expect(updated).toContain('enabled = false');
        expect(updated).not.toContain('enabled = true');
        expect(upsertAttribute(block, 'enabled', 'true')).toBe(block);
    });

    it('inserts missing attributes before the closing brace', () => {
        const updated = upsertAttribute(block, 'aliases', '["a.com"]');
        expect(updated).toContain('  aliases = ["a.com"]\n}');
        expect(upsertAttribute('no braces here', 'a', 'b')).toBe('no braces here');
    });

    it('removes attributes with their full multi-line values', () => {
        const withAliases = '{\n  enabled = true\n  aliases = [\n    "a.com",\n  ]\n}\n';
        const updated = removeAttribute(withAliases, 'aliases');
        expect(updated).toBe('{\n  enabled = true\n}\n');
        expect(removeAttribute(block, 'missing')).toBe(block);
    });
});

describe('hcl: findArrayBounds / enclosingBraceBounds', () => {
    it('finds environment arrays inside task definitions', () => {
        const content = [
            'resource "aws_ecs_task_definition" "app" {',
            '  container_definitions = jsonencode([',
            '    {',
            '      environment = [',
            '        { "name": "A", "value": "1" }',
            '      ]',
            '    }',
            '  ])',
            '}',
            '',
        ].join('\n');
        const bounds = findArrayBounds(content, 'environment');
        expect(content.slice(bounds.openIdx, bounds.closeIdx + 1)).toContain('"name": "A"');
        expect(findArrayBounds(content, 'missing')).toBeNull();
    });

    it('finds the enclosing object for interpolation-heavy values', () => {
        const text = '[{ name = "X", value = "redis://${aws_rg.redis.port}" }]';
        const idx = text.indexOf('"X"');
        const bounds = enclosingBraceBounds(text, idx);
        expect(text.slice(bounds.openIdx, bounds.closeIdx + 1)).toContain('redis://');
        expect(enclosingBraceBounds('[]', 1)).toBeNull();
    });
});

describe('domains: normalization and validation', () => {
    it('normalizes domains (trim, trailing dot, lowercase)', () => {
        expect(normalizeDomain('  Example.COM. ')).toBe('example.com');
        expect(normalizeDomain('a.B-c.io')).toBe('a.b-c.io');
        expect(normalizeDomain(null)).toBe('');
        expect(normalizeDomain(42)).toBe('');
    });

    it('validates standard and wildcard domains', () => {
        expect(isValidDomain('example.com')).toBe(true);
        expect(isValidDomain('*.example.com')).toBe(true);
        expect(isValidDomain('a.b-c.io')).toBe(true);
        expect(isValidDomain('Example.COM.')).toBe(true);
        expect(isValidDomain('not a domain')).toBe(false);
        expect(isValidDomain('no-tld')).toBe(false);
        expect(isValidDomain('*.com')).toBe(false);
        expect(isValidDomain('*.*.example.com')).toBe(false);
        expect(isValidDomain('')).toBe(false);
        expect(isValidDomain('a'.repeat(250) + '.com')).toBe(false);
    });

    it('normalizes zone IDs with optional /hostedzone/ prefix', () => {
        expect(normalizeZoneId('Z1234567890ABC')).toBe('Z1234567890ABC');
        expect(normalizeZoneId('/hostedzone/Z1234567890ABC')).toBe('Z1234567890ABC');
        expect(normalizeZoneId('  Z1  ')).toBe('Z1');
        expect(normalizeZoneId('z-lowercase')).toBeNull();
        expect(normalizeZoneId('ABC')).toBeNull();
        expect(normalizeZoneId('')).toBeNull();
        expect(normalizeZoneId(null)).toBeNull();
    });

    it('validates sender addresses against the SES domain', () => {
        expect(isValidFromEmail('noreply@example.com', 'example.com')).toBe(true);
        expect(isValidFromEmail('News@Mail.Example.com', 'example.com')).toBe(true);
        expect(isValidFromEmail('a@sub.example.com', 'example.com')).toBe(true);
        expect(isValidFromEmail('a@other.com', 'example.com')).toBe(false);
        expect(isValidFromEmail('a@notexample.com', 'example.com')).toBe(false);
        expect(isValidFromEmail('not-an-email', 'example.com')).toBe(false);
        expect(isValidFromEmail('noreply@*.example.com', 'example.com')).toBe(false);
        expect(isValidFromEmail('noreply@example.com', '*.example.com')).toBe(false);
    });

    it('parses domain.tf into structured data', () => {
        const route53 = renderDomainTfRoute53({ domain: 'example.com', zoneId: 'Z123' });
        expect(parseDomainTf(route53)).toEqual({ domain: 'example.com', mode: 'route53', zoneId: 'Z123' });
        const pending = renderDomainTfExternalPending({ domain: 'Example.COM.' });
        expect(parseDomainTf(pending)).toEqual({ domain: 'example.com', mode: 'external-pending', zoneId: null });
        const active = appendValidationResource(pending);
        expect(parseDomainTf(active)).toEqual({ domain: 'example.com', mode: 'external-active', zoneId: null });
        expect(parseDomainTf('')).toBeNull();
        expect(parseDomainTf(null)).toBeNull();
    });

    it('parses legacy deploy-stack markers', () => {
        const legacy = '# deploy-stack:domain-mode=external-pending\n# deploy-stack:zone-id=Z123\n'
            + 'resource "x" "y" {\n  domain_name = "Example.COM."\n}\n';
        expect(parseDomainTf(legacy)).toEqual({ domain: 'example.com', mode: 'external-pending', zoneId: 'Z123' });
        // route53 resolves through the structural fallback (as before).
        const legacyRoute53 = '# deploy-stack:domain-mode=route53\n# deploy-stack:zone-id=Z123\n'
            + 'resource "aws_route53_record" "cdn_alias_a" {}\n';
        expect(parseDomainTf(legacyRoute53)).toEqual({ domain: null, mode: 'route53', zoneId: 'Z123' });
    });

    it('migrates a legacy pending marker to grada active on activation', () => {
        const legacy = '# deploy-stack:domain-mode=external-pending\n# Managed by `deploy-stack domain`.\n';
        const active = appendValidationResource(legacy);
        expect(active).toContain('# grada:domain-mode=external-active');
        expect(active).not.toContain('deploy-stack:domain-mode');
        expect(parseDomainTf(active).mode).toBe('external-active');
    });
});

describe('parseDomainArgs', () => {
    it('parses subcommands, positionals, and flags', () => {
        expect(parseDomainArgs(['domain', 'add', 'example.com', '--zone-id', 'Z1'])).toMatchObject({
            subcommand: 'add', domain: 'example.com', zoneId: 'Z1', activate: false, force: false,
        });
        expect(parseDomainArgs(['domain', 'add', 'example.com', '--zone-id=Z1', '--activate', '--force'])).toMatchObject({
            zoneId: 'Z1', activate: true, force: true,
        });
        expect(parseDomainArgs(['domain', 'verify'])).toMatchObject({ subcommand: 'verify' });
        expect(parseDomainArgs(['domain', 'remove', '--yes'])).toMatchObject({ subcommand: 'remove', yes: true });
        expect(parseDomainArgs(['domain', 'status'])).toMatchObject({ subcommand: 'status' });
    });

    it('hardens against non-array input', () => {
        expect(parseDomainArgs(null).subcommand).toBeUndefined();
        expect(parseDomainArgs('add').subcommand).toBeUndefined();
        expect(parseDomainArgs([]).subcommand).toBeUndefined();
    });
});

describe('domain.tf builders', () => {
    it('renders Route 53 mode with validation, cert validation, and alias records', () => {
        const rendered = renderDomainTfRoute53({ domain: 'example.com', zoneId: 'Z123' });
        expect(rendered).toContain('# grada:domain-mode=route53');
        expect(rendered).toContain('# grada:zone-id=Z123');
        expect(rendered).not.toContain('provider "aws"');
        expect(rendered).toContain('resource "aws_acm_certificate" "domain"');
        expect(rendered).toContain('= aws.us_east_1');
        expect(rendered).toContain('create_before_destroy = true');
        expect(rendered).toContain('for_each = terraform.workspace == "default" ? { for dvo in aws_acm_certificate.domain[0].domain_validation_options');
        expect(rendered).toContain('validation_record_fqdns = [for record in aws_route53_record.domain_validation : record.fqdn]');
        expect(rendered).toContain('resource "aws_route53_record" "cdn_alias_a"');
        expect(rendered).toContain('resource "aws_route53_record" "cdn_alias_aaaa"');
        expect(rendered).toContain('evaluate_target_health = false');
        expect(rendered).toContain('aws_cloudfront_distribution.cdn.hosted_zone_id');
        expect(rendered).toContain('output "custom_domain_url"');
        expect(rendered).toContain('output "acm_certificate_arn"');
    });

    it('renders external-pending mode without validation or alias records', () => {
        const rendered = renderDomainTfExternalPending({ domain: 'example.com' });
        expect(rendered).toContain('# grada:domain-mode=external-pending');
        expect(rendered).not.toContain('provider "aws"');
        expect(rendered).toContain('resource "aws_acm_certificate" "domain"');
        expect(rendered).not.toContain('aws_acm_certificate_validation');
        expect(rendered).not.toContain('cdn_alias_a');
        expect(rendered).toContain('output "acm_validation_records"');
        expect(rendered).toContain('output "custom_domain_cname_target"');
    });

    it('appendValidationResource transitions pending to active idempotently', () => {
        const pending = renderDomainTfExternalPending({ domain: 'example.com' });
        const active = appendValidationResource(pending);
        expect(active).toContain('# grada:domain-mode=external-active');
        expect(active).toContain('resource "aws_acm_certificate_validation" "domain"');
        expect(active).toContain('output "custom_domain_url"');
        expect(active).toContain('https://example.com');
        expect(appendValidationResource(active)).toBe(active);
        const route53 = renderDomainTfRoute53({ domain: 'example.com', zoneId: 'Z1' });
        expect(appendValidationResource(route53)).toBe(route53);
    });
});

describe('us_east_1 provider backfill', () => {
    it('appends the alias provider to main.tf on domain add when missing', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        writeMainTf(dir);
        const result = await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com', zoneId: 'Z1' });
        expect(result.ok).toBe(true);
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('alias  = "us_east_1"');
        expect(mainTf.match(/alias\s*=\s*"us_east_1"/g)).toHaveLength(1);
        // domain.tf keeps only the provider reference, not the configuration.
        const domainTf = fs.readFileSync(path.join(dir, 'terraform', 'domain.tf'), 'utf-8');
        expect(domainTf).not.toContain('provider "aws"');
        expect(domainTf).toContain('= aws.us_east_1');
    });

    it('leaves main.tf untouched on add when the alias already exists', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        writeMainTf(dir, `${MAIN_TF_NO_ALIAS}\nprovider "aws" {\n  alias  = "us_east_1"\n  region = "us-east-1"\n}\n`);
        const before = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        const result = await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com', zoneId: 'Z1' });
        expect(result.ok).toBe(true);
        expect(fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8')).toBe(before);
    });

    it('backfills main.tf on domain remove before deleting domain.tf', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        writeMainTf(dir);
        await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com', zoneId: 'Z1' });
        // Simulate a project that added the domain before the provider moved.
        writeMainTf(dir);
        const result = await runDomain({ cwd: dir, subcommand: 'remove', yes: true });
        expect(result).toMatchObject({ ok: true, removed: true });
        expect(fs.existsSync(path.join(dir, 'terraform', 'domain.tf'))).toBe(false);
        expect(fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8')).toContain('alias  = "us_east_1"');
    });

    it('ships the alias provider in the generated main.tf template', () => {
        const template = fs.readFileSync(new URL('../templates/terraform/main.tf', import.meta.url), 'utf-8');
        expect(template).toContain('alias  = "us_east_1"');
        expect(template).toContain('region = "us-east-1"');
        expect(template).toContain('# tflint-ignore: terraform_unused_declarations\nprovider "aws" {\n  alias  = "us_east_1"');
    });

    it('is a no-op when main.tf is missing', () => {
        const dir = makeTmp();
        const mainTfPath = path.join(dir, 'terraform', 'main.tf');
        expect(ensureUsEast1Provider(mainTfPath)).toBe(false);
        expect(fs.existsSync(mainTfPath)).toBe(false);
    });

    it('appends with blank-line separation and reports true when missing', () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const mainTfPath = path.join(dir, 'terraform', 'main.tf');
        expect(ensureUsEast1Provider(mainTfPath)).toBe(true);
        const mainTf = fs.readFileSync(mainTfPath, 'utf-8');
        expect(mainTf).toContain('}\n\n# tflint-ignore: terraform_unused_declarations\nprovider "aws" {\n  alias  = "us_east_1"');
        expect(mainTf.endsWith('}\n')).toBe(true);
        expect(ensureUsEast1Provider(mainTfPath)).toBe(false);
    });

    it('detects whitespace-variant alias declarations', () => {
        const dir = makeTmp();
        writeMainTf(dir, 'provider "aws" {\n\talias\t=\t"us_east_1"\n}\n');
        const mainTfPath = path.join(dir, 'terraform', 'main.tf');
        expect(ensureUsEast1Provider(mainTfPath)).toBe(false);
        expect(fs.readFileSync(mainTfPath, 'utf-8')).not.toContain('region = "us-east-1"');
    });
});

describe('CloudFront patching', () => {
    it('patches conditional aliases and viewer_certificate', () => {
        const patched = patchCloudFrontDomain(CLOUDFRONT_TF, 'example.com');
        expect(patched).toContain('aliases = terraform.workspace == "default" ? ["example.com"] : []');
        expect(patched).toContain('acm_certificate_arn            = terraform.workspace == "default" ? aws_acm_certificate_validation.domain[0].certificate_arn : null');
        expect(patched).toContain('ssl_support_method             = terraform.workspace == "default" ? "sni-only" : null');
        expect(patched).toContain('minimum_protocol_version       = terraform.workspace == "default" ? "TLSv1.2_2021" : "TLSv1"');
        expect(patched).toContain('cloudfront_default_certificate = terraform.workspace != "default"');
        expect(patched).toContain('origin {');
        expect(patchCloudFrontDomain(patched, 'example.com')).toBe(patched);
    });

    it('merges with user-added aliases without clobbering', () => {
        const once = patchCloudFrontDomain(CLOUDFRONT_TF, 'example.com');
        const twice = patchCloudFrontDomain(once, 'www.example.com');
        expect(twice).toContain('aliases = terraform.workspace == "default" ? ["example.com", "www.example.com"] : []');
        expect(twice.match(/example\.com/g).length).toBeGreaterThanOrEqual(2);
    });

    it('scopes strictly to the "cdn" distribution', () => {
        const withStorage = `${CLOUDFRONT_TF}\nresource "aws_cloudfront_distribution" "storage_cdn" {\n  viewer_certificate {\n    cloudfront_default_certificate = true\n  }\n}\n`;
        const patched = patchCloudFrontDomain(withStorage, 'example.com');
        expect(patched.match(/acm_certificate_arn/g)).toHaveLength(1);
        expect(patched).toContain('resource "aws_cloudfront_distribution" "storage_cdn"');
        const storageBlock = patched.slice(patched.indexOf('"storage_cdn"'));
        expect(storageBlock).toContain('cloudfront_default_certificate = true');
    });

    it('returns content unchanged when the distribution is missing', () => {
        expect(patchCloudFrontDomain('provider "aws" {}\n', 'example.com')).toBe('provider "aws" {}\n');
    });

    it('unpatches one domain while preserving other aliases', () => {
        const patched = patchCloudFrontDomain(patchCloudFrontDomain(CLOUDFRONT_TF, 'example.com'), 'www.example.com');
        const removed = unpatchCloudFrontDomain(patched, 'example.com');
        expect(removed).toContain('aliases = terraform.workspace == "default" ? ["www.example.com"] : []');
        // Remaining aliases require an ACM cert: keep the wiring, never the
        // default certificate (CloudFront rejects that combination).
        expect(removed).toContain('acm_certificate_arn');
        expect(removed).not.toContain('cloudfront_default_certificate = true');
        const empty = unpatchCloudFrontDomain(removed, 'www.example.com');
        expect(empty).not.toContain('aliases');
        expect(empty).toContain('cloudfront_default_certificate = true');
        expect(unpatchCloudFrontDomain(CLOUDFRONT_TF, 'example.com')).toContain('cloudfront_default_certificate');
    });

    it('leaves the content untouched when the domain is not wired', () => {
        const patched = patchCloudFrontDomain(CLOUDFRONT_TF, 'example.com');
        expect(unpatchCloudFrontDomain(patched, 'other.com')).toBe(patched);
        expect(unpatchCloudFrontDomain(CLOUDFRONT_TF, 'other.com')).toBe(CLOUDFRONT_TF);
    });

    it('isCloudFrontWired detects the wired state', () => {
        expect(isCloudFrontWired(CLOUDFRONT_TF, 'example.com')).toBe(false);
        expect(isCloudFrontWired(patchCloudFrontDomain(CLOUDFRONT_TF, 'example.com'), 'example.com')).toBe(true);
        expect(isCloudFrontWired(patchCloudFrontDomain(CLOUDFRONT_TF, 'example.com'), 'other.com')).toBe(false);
    });
});

describe('workspace guards', () => {
    it('scopes Route 53 domain.tf resources to the default workspace', () => {
        const rendered = renderDomainTfRoute53({ domain: 'example.com', zoneId: 'Z123' });
        const guards = rendered.split('= terraform.workspace == "default" ? 1 : 0').length - 1;
        expect(guards).toBe(4);
        expect(rendered).toContain('for_each = terraform.workspace == "default" ? { for dvo in aws_acm_certificate.domain[0].domain_validation_options');
        expect(rendered).toContain('certificate_arn         = aws_acm_certificate.domain[0].arn');
        expect(rendered).toContain('value = terraform.workspace == "default" ? aws_acm_certificate.domain[0].arn : null');
        expect(rendered).toContain('output "custom_domain_url"');
    });

    it('scopes external-pending outputs to the default workspace', () => {
        const rendered = renderDomainTfExternalPending({ domain: 'example.com' });
        expect(rendered).toContain('count             = terraform.workspace == "default" ? 1 : 0');
        expect(rendered).toContain('value = terraform.workspace == "default" ? [for dvo in aws_acm_certificate.domain[0].domain_validation_options');
        expect(rendered).toContain('] : []');
        // Static outputs stay unguarded.
        expect(rendered).toContain('value = aws_cloudfront_distribution.cdn.domain_name');
    });

    it('appends a guarded validation resource on verify', () => {
        const active = appendValidationResource(renderDomainTfExternalPending({ domain: 'example.com' }));
        expect(active).toContain('count           = terraform.workspace == "default" ? 1 : 0');
        expect(active).toContain('certificate_arn = aws_acm_certificate.domain[0].arn');
    });

    it('patches workspace-conditional aliases and viewer certificate', () => {
        const patched = patchCloudFrontDomain(CLOUDFRONT_TF, 'example.com');
        expect(patched).toContain('aliases = terraform.workspace == "default" ? ["example.com"] : []');
        expect(patched).toContain('cloudfront_default_certificate = terraform.workspace != "default"');
        expect(patched).toContain('acm_certificate_arn            = terraform.workspace == "default" ? aws_acm_certificate_validation.domain[0].certificate_arn : null');
        expect(patched).toContain('ssl_support_method             = terraform.workspace == "default" ? "sni-only" : null');
        expect(patched).toContain('minimum_protocol_version       = terraform.workspace == "default" ? "TLSv1.2_2021" : "TLSv1"');
        expect(patchCloudFrontDomain(patched, 'example.com')).toBe(patched);
    });

    it('merges into and unpatches from the conditional true branch', () => {
        const twice = patchCloudFrontDomain(patchCloudFrontDomain(CLOUDFRONT_TF, 'example.com'), 'www.example.com');
        expect(twice).toContain('? ["example.com", "www.example.com"] : []');
        const removed = unpatchCloudFrontDomain(twice, 'example.com');
        expect(removed).toContain('? ["www.example.com"] : []');
        expect(removed).not.toContain('aliases = ["default"]');
        const empty = unpatchCloudFrontDomain(removed, 'www.example.com');
        expect(empty).not.toContain('aliases');
        expect(empty).toContain('cloudfront_default_certificate = true');
    });
});

describe('domain: guards and validation order', () => {
    it('fails unknown and missing subcommands with UNKNOWN_DOMAIN_SUBCOMMAND', async () => {
        const unknown = await runDomain({ subcommand: 'frobnicate' });
        expect(unknown.ok).toBe(false);
        expect(unknown.reason).toBe('unknown-domain-subcommand');
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('domain_run', expect.objectContaining({
            success: false, error_code: 'UNKNOWN_DOMAIN_SUBCOMMAND',
        }));
        expect(capturedOutput()).toContain('Usage:');

        vi.clearAllMocks();
        const missing = await runDomain({ cwd: makeTmp() });
        expect(missing.ok).toBe(false);
        expect(missing.reason).toBe('unknown-domain-subcommand');
    });

    it('reports a closed-enum subcommand without echoing user input', async () => {
        await runDomain({ subcommand: 'frobnicate' });
        expect(trackEvent).toHaveBeenCalledWith('domain_run', expect.objectContaining({
            success: false, error_code: 'UNKNOWN_DOMAIN_SUBCOMMAND', subcommand: 'unknown',
        }));
        for (const [, props] of vi.mocked(trackEvent).mock.calls) {
            expect(JSON.stringify(props)).not.toContain('frobnicate');
        }

        vi.clearAllMocks();
        await runDomain({ cwd: makeTmp() });
        expect(trackEvent).toHaveBeenCalledWith('domain_run', expect.objectContaining({
            success: false, error_code: 'UNKNOWN_DOMAIN_SUBCOMMAND', subcommand: 'none',
        }));

        for (const bad of [null, '', '   ', 42, ['add']]) {
            vi.clearAllMocks();
            await runDomain({ cwd: makeTmp(), subcommand: bad });
            expect(trackEvent).toHaveBeenCalledWith('domain_run', expect.objectContaining({
                success: false, subcommand: 'none',
            }));
        }

        vi.clearAllMocks();
        await runDomain({ cwd: makeTmp(), subcommand: '  Delete  ' });
        expect(trackEvent).toHaveBeenCalledWith('domain_run', expect.objectContaining({
            success: false, subcommand: 'unknown',
        }));
    });

    it('validates flags before filesystem guards', async () => {
        const badDomain = await runDomain({ cwd: makeTmp(), subcommand: 'add', domain: 'not a domain' });
        expect(badDomain.ok).toBe(false);
        expect(badDomain.reason).toBe('invalid-domain');
        expect(trackEvent).toHaveBeenCalledWith('domain_run', expect.objectContaining({
            error_code: 'INVALID_DOMAIN',
        }));

        vi.clearAllMocks();
        const badZone = await runDomain({ cwd: makeTmp(), subcommand: 'add', domain: 'example.com', zoneId: 'nope' });
        expect(badZone.ok).toBe(false);
        expect(badZone.reason).toBe('invalid-zone-id');
    });

    it('fails through PROJECT_NOT_INITIALIZED on unresolvable cwd', async () => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => { throw new Error('deleted'); });
        try {
            const result = await runDomain({ subcommand: 'status' });
            expect(result).toEqual({ ok: false, reason: 'project-not-initialized' });
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            cwdSpy.mockRestore();
        }
    });

    it('fails with TERRAFORM_NOT_INITIALIZED when cloudfront.tf is missing', async () => {
        const result = await runDomain({ cwd: makeTmp(), subcommand: 'add', domain: 'example.com' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('terraform-not-initialized');
        expect(trackEvent).toHaveBeenCalledWith('domain_run', expect.objectContaining({
            error_code: 'TERRAFORM_NOT_INITIALIZED',
        }));
    });

    it('hardens runDomain against non-object input', async () => {
        for (const bad of [null, 42, 'add', []]) {
            const result = await runDomain(bad);
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('unknown-domain-subcommand');
        }
    });
});

describe('domain add', () => {
    it('writes Route 53 domain.tf and patches CloudFront in one step', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        const result = await runDomain({ cwd: dir, subcommand: 'add', domain: 'Example.COM', zoneId: 'Z123' });
        expect(result.ok).toBe(true);
        expect(result.mode).toBe('route53');
        expect(result.domain).toBe('example.com');
        const domainTf = fs.readFileSync(path.join(dir, 'terraform', 'domain.tf'), 'utf-8');
        expect(domainTf).toContain('# grada:domain-mode=route53');
        expect(domainTf).toContain('domain_name       = "example.com"');
        const cloudfront = fs.readFileSync(path.join(dir, 'terraform', 'cloudfront.tf'), 'utf-8');
        expect(cloudfront).toContain('aliases = terraform.workspace == "default" ? ["example.com"] : []');
        expect(cloudfront).toContain('acm_certificate_arn');
        expect(trackEvent).toHaveBeenCalledWith('domain_run', {
            projectName: expect.any(String), subcommand: 'add', mode: 'route53', success: true,
        });
    });

    it('stages external-pending domain.tf without touching CloudFront', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        const result = await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com' });
        expect(result.ok).toBe(true);
        expect(result.mode).toBe('external-pending');
        expect(result.cloudfrontPatched).toBe(false);
        const domainTf = fs.readFileSync(path.join(dir, 'terraform', 'domain.tf'), 'utf-8');
        expect(domainTf).toContain('# grada:domain-mode=external-pending');
        expect(fs.readFileSync(path.join(dir, 'terraform', 'cloudfront.tf'), 'utf-8')).toBe(CLOUDFRONT_TF);
        expect(capturedOutput()).toContain('domain verify');
    });

    it('supports --activate for one-step external activation', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        const result = await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com', activate: true });
        expect(result.ok).toBe(true);
        expect(result.mode).toBe('external-active');
        expect(fs.readFileSync(path.join(dir, 'terraform', 'domain.tf'), 'utf-8'))
            .toContain('# grada:domain-mode=external-active');
        expect(fs.readFileSync(path.join(dir, 'terraform', 'cloudfront.tf'), 'utf-8')).toContain('aliases = terraform.workspace == "default" ? ["example.com"] : []');
    });

    it('refuses to overwrite without --force and replaces cleanly with it', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        await runDomain({ cwd: dir, subcommand: 'add', domain: 'old.com', zoneId: 'Z1' });
        const rerun = await runDomain({ cwd: dir, subcommand: 'add', domain: 'new.com', zoneId: 'Z1' });
        expect(rerun.ok).toBe(false);
        expect(rerun.reason).toBe('domain-already-configured');
        expect(exitSpy).not.toHaveBeenCalled();

        const forced = await runDomain({ cwd: dir, subcommand: 'add', domain: 'new.com', zoneId: 'Z1', force: true });
        expect(forced.ok).toBe(true);
        const cloudfront = fs.readFileSync(path.join(dir, 'terraform', 'cloudfront.tf'), 'utf-8');
        expect(cloudfront).toContain('aliases = terraform.workspace == "default" ? ["new.com"] : []');
        expect(cloudfront).not.toContain('old.com');
    });

    it('fails when cloudfront.tf lacks the cdn distribution', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir, 'provider "aws" {}\n');
        const result = await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com', zoneId: 'Z1' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('cloudfront-resource-not-found');
        // domain.tf was still written so the user can fix cloudfront.tf and verify.
        expect(fs.existsSync(path.join(dir, 'terraform', 'domain.tf'))).toBe(true);
    });
});

describe('domain verify', () => {
    it('fails with DOMAIN_NOT_CONFIGURED when domain.tf is missing', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        const result = await runDomain({ cwd: dir, subcommand: 'verify' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('domain-not-configured');
    });

    it('transitions external-pending to active and patches CloudFront', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com' });
        const result = await runDomain({ cwd: dir, subcommand: 'verify' });
        expect(result).toMatchObject({ ok: true, mode: 'external-active' });
        expect(fs.readFileSync(path.join(dir, 'terraform', 'domain.tf'), 'utf-8'))
            .toContain('resource "aws_acm_certificate_validation" "domain"');
        expect(fs.readFileSync(path.join(dir, 'terraform', 'cloudfront.tf'), 'utf-8')).toContain('aliases = terraform.workspace == "default" ? ["example.com"] : []');
        expect(capturedOutput()).toContain('npx grada-run apply');
    });

    it('treats activate as an alias and active modes as idempotent no-ops', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com', zoneId: 'Z1' });
        const viaAlias = await runDomain({ cwd: dir, subcommand: 'activate' });
        expect(viaAlias).toMatchObject({ ok: true, mode: 'route53', alreadyActive: true });
        const again = await runDomain({ cwd: dir, subcommand: 'verify' });
        expect(again.alreadyActive).toBe(true);
        const cloudfront = fs.readFileSync(path.join(dir, 'terraform', 'cloudfront.tf'), 'utf-8');
        expect(cloudfront.match(/example\.com/g)).toHaveLength(1);
    });
});

describe('domain status', () => {
    it('reports unconfigured projects without failing', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        const result = await runDomain({ cwd: dir, subcommand: 'status' });
        expect(result).toEqual({ ok: true, subcommand: 'status', configured: false });
        expect(exitSpy).not.toHaveBeenCalled();
        expect(capturedOutput()).toContain('No custom domain configured');
        expect(outro).toHaveBeenCalledWith(expect.stringContaining('No custom domain configured'));
    });

    it('shows mode, wiring state, and the DNS table from outputs', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com' });
        const getOutputs = vi.fn(async () => ({
            acm_validation_records: { value: [{ name: '_abc.example.com', type: 'CNAME', value: '_xyz.acm-validations.aws.' }] },
            custom_domain_cname_target: { value: 'd123.cloudfront.net' },
        }));
        const result = await runDomain({ cwd: dir, subcommand: 'status', getOutputs });
        expect(result).toMatchObject({ ok: true, configured: true, mode: 'external-pending', wired: false });
        expect(getOutputs).toHaveBeenCalledWith(path.join(dir, 'terraform'));
        const output = capturedOutput();
        expect(output).toContain('example.com');
        expect(output).toContain('external-pending');
        expect(output).toContain('not wired yet');
        expect(output).toContain('_abc.example.com');
        expect(output).toContain('d123.cloudfront.net');

        await runDomain({ cwd: dir, subcommand: 'verify' });
        const wiredResult = await runDomain({ cwd: dir, subcommand: 'status', getOutputs: async () => ({}) });
        expect(wiredResult.wired).toBe(true);
        expect(capturedOutput()).toContain('wired');
    });

    it('prints full DNS record names and values without truncation', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com' });
        const longName = '_a4eb99e0dcf66697ca96b16f62897925.very-long-subdomain-name.example.com';
        const longValue = '_b5fc88f1adg77708db07c27f73908036.long-validation-value.acm-validations.aws.';
        const getOutputs = vi.fn(async () => ({
            acm_validation_records: { value: [{ name: longName, type: 'CNAME', value: longValue }] },
        }));
        await runDomain({ cwd: dir, subcommand: 'status', getOutputs });
        const output = capturedOutput();
        expect(output).toContain(longName);
        expect(output).toContain(longValue);
        expect(output).not.toContain('…');
    });

    it('closes with an outro reflecting the wired state', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com' });
        vi.mocked(outro).mockClear();
        await runDomain({ cwd: dir, subcommand: 'status', getOutputs: async () => ({}) });
        expect(vi.mocked(outro)).toHaveBeenCalledWith(expect.stringContaining('Run npx grada-run domain verify once DNS records are in place.'));

        await runDomain({ cwd: dir, subcommand: 'verify' });
        vi.mocked(outro).mockClear();
        await runDomain({ cwd: dir, subcommand: 'status', getOutputs: async () => ({}) });
        expect(vi.mocked(outro)).toHaveBeenCalledWith(expect.stringContaining('Domain is active on CloudFront.'));
    });
});

describe('domain remove', () => {
    it('fails with DOMAIN_NOT_CONFIGURED when nothing is configured', async () => {
        const dir = makeTmp();
        const result = await runDomain({ cwd: dir, subcommand: 'remove', yes: true });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('domain-not-configured');
    });

    it('removes domain.tf and restores the default certificate with --yes', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com', zoneId: 'Z1' });
        const result = await runDomain({ cwd: dir, subcommand: 'remove', yes: true });
        expect(result).toMatchObject({ ok: true, removed: true, domain: 'example.com' });
        expect(fs.existsSync(path.join(dir, 'terraform', 'domain.tf'))).toBe(false);
        const cloudfront = fs.readFileSync(path.join(dir, 'terraform', 'cloudfront.tf'), 'utf-8');
        expect(cloudfront).not.toContain('aliases');
        expect(cloudfront).toContain('cloudfront_default_certificate = true');
        expect(trackEvent).toHaveBeenCalledWith('domain_run', expect.objectContaining({
            subcommand: 'remove', success: true,
        }));
    });

    it('keeps ACM wiring and warns when hand-added aliases remain', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com', zoneId: 'Z1' });
        // Simulate a hand-added second alias (add is replace-only).
        const cloudfrontTfPath = path.join(dir, 'terraform', 'cloudfront.tf');
        fs.writeFileSync(cloudfrontTfPath, patchCloudFrontDomain(fs.readFileSync(cloudfrontTfPath, 'utf-8'), 'www.example.com'));
        const result = await runDomain({ cwd: dir, subcommand: 'remove', yes: true });
        expect(result).toMatchObject({ ok: true, removed: true, domain: 'example.com' });
        const cloudfront = fs.readFileSync(cloudfrontTfPath, 'utf-8');
        expect(cloudfront).toContain('www.example.com');
        expect(cloudfront).toContain('acm_certificate_arn');
        expect(cloudfront).not.toContain('cloudfront_default_certificate = true');
        const text = capturedOutput();
        expect(text).toContain('www.example.com');
        expect(text).not.toContain('restored to the default certificate');
    });

    it('requires --yes in headless mode', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com', zoneId: 'Z1' });
        const result = await runDomain({ cwd: dir, subcommand: 'remove', isHeadless: true });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('confirmation-required');
        expect(fs.existsSync(path.join(dir, 'terraform', 'domain.tf'))).toBe(true);
    });

    it('refuses inferred-headless remove without flags as non-interactive', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com', zoneId: 'Z1' });
        const result = await runDomain({ cwd: dir, subcommand: 'remove' });
        expect(result).toMatchObject({ ok: false, reason: 'non-interactive' });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('domain_run', expect.objectContaining({
            error_code: 'DOMAIN_NON_INTERACTIVE',
            reason: 'non-interactive',
        }));
        expect(vi.mocked(confirm)).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(dir, 'terraform', 'domain.tf'))).toBe(true);
    });

    it('prompts interactively and handles cancel/decline cleanly', async () => {
        const dir = makeTmp();
        writeCloudfrontTf(dir);
        await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com', zoneId: 'Z1' });

        vi.mocked(confirm).mockResolvedValueOnce(Symbol('clack:cancel'));
        const cancelled = await runDomain({ cwd: dir, subcommand: 'remove', isHeadless: false });
        expect(cancelled).toEqual({ ok: false, reason: 'cancelled' });
        expect(exitSpy).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(dir, 'terraform', 'domain.tf'))).toBe(true);

        vi.mocked(confirm).mockResolvedValueOnce(false);
        const declined = await runDomain({ cwd: dir, subcommand: 'remove', isHeadless: false });
        expect(declined.reason).toBe('cancelled');

        vi.mocked(confirm).mockResolvedValueOnce(true);
        const removed = await runDomain({ cwd: dir, subcommand: 'remove', isHeadless: false });
        expect(removed.ok).toBe(true);
        expect(fs.existsSync(path.join(dir, 'terraform', 'domain.tf'))).toBe(false);
    });

    it('tolerates a missing cloudfront.tf on remove', async () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'domain.tf'),
            renderDomainTfExternalPending({ domain: 'example.com' })
        );
        const result = await runDomain({ cwd: dir, subcommand: 'remove', yes: true });
        expect(result.ok).toBe(true);
        expect(fs.existsSync(path.join(dir, 'terraform', 'domain.tf'))).toBe(false);
    });
});
