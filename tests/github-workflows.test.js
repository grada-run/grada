import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { load as yamlLoad, CORE_SCHEMA } from 'js-yaml';
import { injectMigrationGate } from '../src/commands/db/migrate.js';

const TEMPLATES_DIR = path.resolve('templates/github');
// Placeholders ({{FOO}}) break YAML parsing, so substitute dummies first.
// GitHub expressions (${{ ... }}) are valid plain scalars — leave them.
const PLACEHOLDER_RE = /(?<!\$)\{\{[^}]+\}\}/g;

function parseTemplate(filename) {
    const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
    return yamlLoad(raw.replace(PLACEHOLDER_RE, 'dummy'), { schema: CORE_SCHEMA });
}

const TOP_LEVEL_TRIGGERS = new Set([
    'push', 'pull_request', 'schedule', 'workflow_dispatch', 'workflow_call',
]);
// `schedule` is a top-level trigger only — nested under push/pull_request
// GitHub rejects the whole workflow file.
const NESTABLE_TRIGGER_KEYS = new Set([
    'branches', 'branches-ignore', 'paths', 'paths-ignore', 'tags',
    'tags-ignore', 'types', 'paths-ignore',
]);

describe('github workflow templates', () => {
    const templates = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.yml'));

    it.each(templates)('%s parses as valid YAML with a valid `on:` block', (filename) => {
        const doc = parseTemplate(filename);
        expect(doc).toBeTypeOf('object');
        expect(doc.on).toBeTypeOf('object');
        for (const key of Object.keys(doc.on)) {
            expect(TOP_LEVEL_TRIGGERS.has(key), `unknown top-level trigger '${key}' in ${filename}`).toBe(true);
        }
        for (const nested of ['push', 'pull_request']) {
            if (doc.on[nested] == null) continue;
            expect(doc.on[nested]).toBeTypeOf('object');
            for (const key of Object.keys(doc.on[nested])) {
                expect(NESTABLE_TRIGGER_KEYS.has(key), `'${key}' nested under '${nested}' in ${filename}`).toBe(true);
            }
        }
        if (doc.on.schedule !== undefined) {
            expect(Array.isArray(doc.on.schedule)).toBe(true);
            for (const entry of doc.on.schedule) {
                expect(entry).toHaveProperty('cron');
            }
        }
    });

    it('deploy.yml redeploys the worker service alongside web', () => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'deploy.yml'), 'utf8');
        // Worker identity (mirrors the ECS_SERVICE/ECS_TASK_FAMILY pair).
        expect(raw).toContain('ECS_WORKER_SERVICE: {{PROJECT_NAME}}{{RESOURCE_SUFFIX}}-worker-service');
        expect(raw).toContain('ECS_WORKER_TASK_FAMILY: {{PROJECT_NAME}}{{RESOURCE_SUFFIX}}-worker-task');
        // SHA-pinned revision + force-deploy, gated on worker existence so
        // workerless projects skip cleanly.
        expect(raw).toContain('- name: Register worker task definition');
        expect(raw).toContain('- name: Force worker deployment');
        expect(raw).toContain("if: hashFiles('terraform/worker.tf') != ''");
        expect(raw).toContain('steps.register-worker-task-def.outputs.task-arn');
        expect(raw).toContain('--service ${{ env.ECS_WORKER_SERVICE }}');
    });

    it('preview.yml still parses after preview-gate injection', async () => {
        const { injectPreviewMigrationGate } = await import('../src/commands/db/migrate.js');
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'preview.yml'), 'utf8');
        const injected = injectPreviewMigrationGate(raw.replace(PLACEHOLDER_RE, 'dummy'), { cmd: 'node ./dist/migrate.cjs' });
        expect(injected).toContain('# grada:db-migrate-start');
        const doc = yamlLoad(injected, { schema: CORE_SCHEMA });
        const steps = doc.jobs['deploy-preview'].steps;
        expect(steps.some((s) => s?.name === 'Preview Database Migration')).toBe(true);
    });

    it('publish.yml verifies both npm packages land at the same version', () => {
        const raw = fs.readFileSync(path.resolve('.github/workflows/publish.yml'), 'utf8');
        const doc = yamlLoad(raw, { schema: CORE_SCHEMA });
        const steps = doc.jobs['build-and-publish'].steps;
        const guard = steps.find((s) => typeof s?.name === 'string' && /lockstep|version.*match/i.test(s.name));
        expect(guard, 'publish.yml must have a dual-package version guard step').toBeDefined();
        expect(guard.run).toContain('grada-run');
        expect(guard.run).toContain('@grada-run/grada');
        // The guard must read the immutable version-doc endpoint, never the
        // packument: `npm view` stayed stale 10+ minutes after the 0.40.3
        // publish and failed the release on live versions.
        expect(guard.run).toContain('https://registry.npmjs.org/${ENCODED}/${EXPECTED}');
        expect(guard.run).toContain('"%{http_code}"');
        // npm exposes new versions minutes after accepting them, so the
        // read-back confirmation is advisory only: it must retry briefly
        // and report a notice — never fail the job (0.40.2/0.40.3/0.40.4
        // each failed a hard read-back gate on live versions).
        expect(guard.run).toContain('seq 1 12');
        expect(guard.run).not.toContain('exit 1');
        expect(guard.run).toContain('::notice::');
        // The publish steps are the real acceptance gate: each must assert
        // npm's own success line for its package, since only the write path
        // can confirm acceptance.
        const primary = steps.find((s) => typeof s?.name === 'string' && s.name.includes('Publish Primary Package'));
        expect(primary.run).toContain('grada-run@${EXPECTED}');
        const scoped = steps.find((s) => typeof s?.name === 'string' && s.name.includes('Publish Scoped Alias'));
        expect(scoped.run).toContain('@grada-run/grada@${EXPECTED}');
        // Re-runs must survive already-live versions (tolerating only the
        // specific already-published error), or a retried release can never
        // go green.
        for (const name of ['Publish Primary Package', 'Publish Scoped Alias']) {
            const step = steps.find((s) => typeof s?.name === 'string' && s.name.includes(name));
            expect(step.run).toContain('previously published versions');
        }
        // Must run after both publishes so it verifies the live registry.
        const names = steps.map((s) => s?.name || '');
        const guardIdx = names.indexOf(guard.name);
        expect(guardIdx).toBeGreaterThan(names.findIndex((n) => /Publish Primary Package/.test(n)));
        expect(guardIdx).toBeGreaterThan(names.findIndex((n) => /Publish Scoped Alias/.test(n)));
    });

    it('pins every third-party action to an immutable ref (no @master/@main)', () => {
        const roots = [TEMPLATES_DIR, path.resolve('.github/workflows')];
        for (const root of roots) {
            for (const file of fs.readdirSync(root).filter((f) => f.endsWith('.yml'))) {
                const raw = fs.readFileSync(path.join(root, file), 'utf8');
                for (const match of raw.matchAll(/uses:\s*([^\s#]+)/g)) {
                    const ref = match[1];
                    if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
                    const pin = ref.split('@')[1] || '';
                    expect(pin, `${file}: '${ref}' must not float on a branch`).not.toMatch(/^(master|main|latest|stable)$/);
                }
            }
        }
    });

    it.each(templates)('%s never references secrets in a step if: (Actions rejects it)', (filename) => {
        const doc = parseTemplate(filename);
        for (const job of Object.values(doc.jobs || {})) {
            for (const step of job.steps || []) {
                if (typeof step.if === 'string') expect(step.if, filename).not.toContain('secrets.');
            }
        }
    });

    it('deploy templates serialize production deploys per branch', () => {
        for (const filename of ['deploy.yml', 'deploy-lambda.yml', 'deploy-static.yml']) {
            const doc = parseTemplate(filename);
            expect(doc.concurrency, filename).toMatchObject({
                group: 'deploy-${{ github.ref }}',
                'cancel-in-progress': true,
            });
        }
    });

    it('preview and teardown share one group per PR; only teardown never cancels', () => {
        for (const filename of ['preview.yml', 'preview-lambda.yml']) {
            const doc = parseTemplate(filename);
            expect(doc.concurrency, filename).toMatchObject({
                group: 'preview-${{ github.event.pull_request.number }}',
                'cancel-in-progress': true,
            });
        }
        const teardown = parseTemplate('teardown.yml');
        expect(teardown.concurrency.group).toBe('preview-${{ github.event.pull_request.number }}');
        expect(teardown.concurrency, 'teardown must queue, never cancel').not.toHaveProperty('cancel-in-progress');
    });

    it('teardown exits green when the preview workspace is absent', () => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'teardown.yml'), 'utf8');
        expect(raw).toContain('terraform workspace list');
        expect(raw).toContain('nothing to tear down');
    });

    it('teardown stays red when the workspace listing itself fails', () => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'teardown.yml'), 'utf8');
        expect(raw).toContain('WORKSPACES=$(terraform workspace list 2>&1) || { echo "$WORKSPACES"; exit 1; }');
        expect(raw).not.toMatch(/workspace list 2>\/dev\/null/);
    });

    it('preview posts the CloudFront URL, never the blocked direct ALB URL', () => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'preview.yml'), 'utf8');
        expect(raw).toContain('terraform output -raw cloudfront_url');
        expect(raw).not.toContain('alb_direct_url');
        const lambdaRaw = fs.readFileSync(path.join(TEMPLATES_DIR, 'preview-lambda.yml'), 'utf8');
        expect(lambdaRaw).toContain('terraform output -raw api_gateway_url');
    });

    it('every template terraform init is non-interactive', () => {
        for (const filename of templates) {
            const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
            for (const match of raw.matchAll(/^\s*terraform init(.*)$/gm)) {
                expect(match[1], `${filename}: bare 'terraform init' prompts mid-CI`).toContain('-input=false');
            }
        }
    });

    it('deploy.yml still parses after migration-gate injection', () => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'deploy.yml'), 'utf8');
        const injected = injectMigrationGate(raw.replace(PLACEHOLDER_RE, 'dummy'), { cmd: 'node ./dist/migrate.cjs' });
        expect(injected).toContain('# grada:db-migrate-start');
        const doc = yamlLoad(injected, { schema: CORE_SCHEMA });
        const steps = doc.jobs.deploy.steps;
        expect(steps.some((s) => typeof s?.run === 'string' && s.run.includes('migrate'))).toBe(true);
    });
});
