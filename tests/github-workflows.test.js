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
    'push', 'pull_request', 'pull_request_target', 'schedule', 'workflow_dispatch', 'workflow_call',
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
        for (const nested of ['push', 'pull_request', 'pull_request_target']) {
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

    it('deploy.yml and deploy-lambda.yml invalidate the app CDN after deploy', () => {
        for (const filename of ['deploy.yml', 'deploy-lambda.yml']) {
            const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
            // Same lookup convention as the static workflow: the distro
            // carries comment "${local.app_name}-cdn" (BUG-82).
            expect(raw).toContain('CF_COMMENT: {{PROJECT_NAME}}{{RESOURCE_SUFFIX}}-cdn');
            expect(raw).toContain('- name: Invalidate CloudFront');
            expect(raw).toContain('aws cloudfront create-invalidation');
            expect(raw).toContain('--paths "/*"');
        }
    });

    // BUG-195: tasks must never start on an unpushed tag — the image
    // is built and pushed before `terraform apply` moves anything, with
    // a targeted repo bootstrap (the repo itself is TF-managed) and
    // job-level AWS credentials (previously only grada-action had them).
    it.each(['deploy.yml', 'deploy-lambda.yml'])('%s pushes the image before applying infrastructure', (filename) => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
        expect(raw).toContain('Bootstrap ECR repository');
        expect(raw).toContain('-target=aws_ecr_repository.app');
        expect(raw).toContain('aws-actions/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a # v4');
        const bootstrap = raw.indexOf('- name: Bootstrap ECR repository');
        const push = raw.indexOf('- name: Push image to Amazon ECR');
        const apply = raw.indexOf('- name: Apply Infrastructure Changes');
        expect(bootstrap).toBeGreaterThanOrEqual(0);
        expect(push).toBeGreaterThan(bootstrap);
        expect(apply).toBeGreaterThan(push);
    });

    // BUG-150: `update-service` returns before the rollout finishes —
    // wait for stability and verify the PRIMARY deployment actually
    // runs the registered revision (a breaker rollback re-stabilizes on
    // the OLD revision, which the wait alone would report green).
    it('deploy.yml waits for rollout stability before invalidating', () => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'deploy.yml'), 'utf8');
        expect(raw).toContain('aws ecs wait services-stable');
        expect(raw).toContain('deployments[?status==`PRIMARY`].taskDefinition');
        expect(raw).toContain('steps.register-task-def.outputs.task-arn');
        const force = raw.indexOf('- name: Force ECS deployment');
        const wait = raw.indexOf('aws ecs wait services-stable');
        const invalidate = raw.indexOf('- name: Invalidate CloudFront');
        expect(wait).toBeGreaterThan(force);
        expect(invalidate).toBeGreaterThan(wait);
        // Worker rollouts gate the same way (worker trees only).
        expect(raw).toContain('steps.register-worker-task-def.outputs.task-arn');
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

    // BUG-140: fork PRs must never obtain the admin CI role. Preview
    // and teardown run on pull_request_target (file from base, so the
    // guard below is attacker-immutable), check out the PR head SHA
    // explicitly, and run privileged steps same-repo-only.
    it.each(['preview.yml', 'preview-lambda.yml'])('%s runs privileged preview steps same-repo-only', (filename) => {
        const doc = parseTemplate(filename);
        expect(doc.on.pull_request, `${filename} must not trigger on pull_request`).toBeUndefined();
        expect(doc.on.pull_request_target.types).toEqual(['opened', 'synchronize', 'reopened']);
        const job = doc.jobs['deploy-preview'];
        expect(job.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
        const checkout = job.steps.find((s) => s?.uses?.startsWith('actions/checkout@'));
        expect(checkout?.with?.ref).toBe('${{ github.event.pull_request.head.sha }}');
        const notice = Object.values(doc.jobs).find((j) => j?.if?.includes('head.repo.full_name != github.repository'));
        expect(notice, `${filename} must loudly skip fork PRs`).toBeDefined();
    });

    // BUG-138/199: STS denies a missing role and a trust mismatch with
    // the same message, so the API won't support distinguishing them:
    // every assume failure on a skippable workflow skips loud (green)
    // with both cases + pointers named. No error-text grep (it can never
    // match), no exit 1 in the interpret block. Deploy never skips
    // (fails with the bootstrap pointer).
    it.each(['drift.yml', 'teardown.yml', 'preview.yml', 'preview-lambda.yml'])('%s skips loud with guidance on any assume failure', (filename) => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
        expect(raw).toContain('id: aws-creds');
        expect(raw).toContain('continue-on-error: true');
        expect(raw).toContain('- name: Interpret credential failure');
        expect(raw).not.toContain('assume-role-with-web-identity');
        expect(raw).not.toContain('NoSuchEntity');
        expect(raw).toContain('::notice::');
        expect(raw).toContain('npx grada-run apply');
        expect(raw).toContain('terraform/oidc.tf');
        // The interpret block must green the run: no exit 1 between it
        // and the next step.
        const interpret = raw.split('- name: Interpret credential failure')[1].split('\n      - name: ')[0];
        expect(interpret, `${filename} interpret must not exit 1`).not.toContain('exit 1');
        // Post-credential AWS steps gate on the assume outcome.
        expect(raw).toContain("steps.aws-creds.outcome == 'success'");
    });

    // BUG-189: hand-rolled terraform without -input=false hangs on
    // prompts, and no job has a timeout — a stuck apply bills the
    // runner forever.
    it('pins -input=false on every raw terraform apply/destroy/plan/init', () => {
        for (const filename of ['deploy.yml', 'deploy-lambda.yml', 'preview.yml', 'preview-lambda.yml', 'teardown.yml', 'drift.yml']) {
            const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
            for (const line of raw.split('\n')) {
                if (line.trim().startsWith('#')) continue;
                if (/\bterraform\s+(init|apply|destroy|plan)\b/.test(line)) {
                    expect(line, `${filename}: ${line.trim()}`).toContain('-input=false');
                }
            }
        }
    });

    it('sets timeout-minutes on every job', () => {
        for (const filename of ['deploy.yml', 'deploy-lambda.yml', 'deploy-static.yml', 'preview.yml', 'preview-lambda.yml', 'teardown.yml', 'drift.yml']) {
            const doc = parseTemplate(filename);
            for (const [jobName, job] of Object.entries(doc.jobs)) {
                expect(job?.['timeout-minutes'], `${filename} :: ${jobName}`).toBeGreaterThan(0);
            }
        }
    });

    // BUG-190: every preview push appends a new PR comment (noise), and
    // a failed preview leaves the last green URL standing as truth.
    it.each(['preview.yml', 'preview-lambda.yml'])('%s keeps one sticky comment and reports failures', (filename) => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
        expect(raw).toContain('grada-preview');
        expect(raw).toContain('updateComment');
        expect(raw).toContain('if: failure()');
    });

    // BUG-192: the Push step echoes an output no step id exposes.
    it.each(['deploy.yml', 'deploy-lambda.yml'])('%s exposes the pushed image via a step id', (filename) => {
        const doc = parseTemplate(filename);
        const push = doc.jobs.deploy.steps.find((s) => s?.name === 'Push image to Amazon ECR');
        expect(push?.id, `${filename} push step id`).toBeTruthy();
    });

    // BUG-193: the scan step claims SARIF output but emits a table.
    it.each(['deploy.yml', 'deploy-lambda.yml'])('%s labels the container scan honestly', (filename) => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
        expect(raw).not.toContain('SARIF');
        expect(raw).toContain('Scan Container for Vulnerabilities (table summary)');
    });

    // BUG-194: cancelling mid-apply strands the S3 lockfile with no
    // recovery pointer — annotate every apply/destroy workflow.
    it.each(['deploy.yml', 'deploy-lambda.yml', 'preview.yml', 'preview-lambda.yml', 'teardown.yml'])('%s annotates cancellation recovery', (filename) => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
        expect(raw).toContain('if: cancelled()');
        expect(raw).toContain('force-unlock');
        expect(raw).toContain('.tflock');
    });

    it('deploy.yml fails loud (never skips) on credential failure', () => {
        for (const filename of ['deploy.yml', 'deploy-lambda.yml']) {
            const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
            expect(raw, filename).toContain('id: aws-creds');
            expect(raw, filename).toContain('- name: Interpret credential failure');
            expect(raw, filename).toContain('npx grada-run apply');
            expect(raw, filename).not.toContain("steps.aws-creds.outcome == 'success'");
        }
    });

    // BUG-201: the static deploy missed the attempt-and-interpret
    // rollout — it fails raw on an absent stack. Same deploy-side
    // shape as deploy.yml: job-level assume + fail loud with the
    // bootstrap pointer naming the missing role.
    it('deploy-static.yml fails loud with the bootstrap pointer on credential failure', () => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'deploy-static.yml'), 'utf8');
        expect(raw).toContain('id: aws-creds');
        expect(raw).toContain('continue-on-error: true');
        expect(raw).toContain('- name: Interpret credential failure');
        expect(raw).toContain('npx grada-run apply');
        expect(raw).toContain('aws-actions/configure-aws-credentials@');
        expect(raw).not.toContain("steps.aws-creds.outcome == 'success'");
    });

    // BUG-141: preview DBs carry deletion protection and `terraform
    // destroy` never applies var updates, so teardown lifts protection
    // out-of-band (instance + cluster) before destroying.
    it('teardown.yml lifts preview deletion protection before destroy', () => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'teardown.yml'), 'utf8');
        expect(raw).toContain('modify-db-instance');
        expect(raw).toContain('--no-deletion-protection');
        expect(raw).toContain('modify-db-cluster');
        expect(raw).toContain('wait db-instance-available');
        expect(raw).toContain('wait db-cluster-available');
        // Workspace-derived identifier (matches ${local.app_name}-db).
        expect(raw).toContain('{{PROJECT_NAME}}-${{ env.WORKSPACE }}{{RESOURCE_SUFFIX}}');
        // Lift precedes the destroy.
        expect(raw.indexOf('modify-db-instance')).toBeLessThan(raw.indexOf('terraform destroy -auto-approve'));
    });

    // BUG-173: previews rebuild and redeploy but never invalidate —
    // every push re-caches stale HTML until TTL expiry.
    it.each(['preview.yml', 'preview-lambda.yml'])('%s invalidates its preview distribution after deploy', (filename) => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
        // Workspace-suffixed comment (matches ${local.app_name}-cdn).
        expect(raw).toContain('CF_COMMENT: {{PROJECT_NAME}}-pr-${{ github.event.pull_request.number }}{{RESOURCE_SUFFIX}}-cdn');
        expect(raw).toContain('- name: Invalidate CloudFront');
        expect(raw).toContain('aws cloudfront create-invalidation');
        const invalidate = raw.indexOf('- name: Invalidate CloudFront');
        const comment = raw.indexOf('- name: Comment PR');
        expect(invalidate).toBeGreaterThanOrEqual(0);
        expect(comment).toBeGreaterThan(invalidate);
    });

    // BUG-154: teardown shares preview's cancellable group, so reopening
    // a PR cancels the in-flight destroy. Separate group + lock timeouts
    // (the state lock now serializes the destroy/apply race instead).
    it('teardown runs in its own non-cancellable group', () => {
        const preview = fs.readFileSync(path.join(TEMPLATES_DIR, 'preview.yml'), 'utf8');
        const teardown = fs.readFileSync(path.join(TEMPLATES_DIR, 'teardown.yml'), 'utf8');
        const previewGroup = preview.match(/group:\s*(.+)/)[1].trim();
        const teardownGroup = teardown.match(/group:\s*(.+)/)[1].trim();
        expect(teardownGroup).not.toBe(previewGroup);
        expect(parseTemplate('teardown.yml').concurrency).not.toHaveProperty('cancel-in-progress');
        expect(preview).toContain('-lock-timeout=');
        expect(teardown).toContain('-lock-timeout=');
    });

    // BUG-155: the drift plan step exits 0 on every path (exit 1 errors
    // go green and silent) — errors must fail the run and file an issue.
    it('drift.yml fails loud on plan errors', () => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'drift.yml'), 'utf8');
        const planStep = raw.slice(raw.indexOf('- name: Terraform Plan'), raw.indexOf('- name: Check provisioned state'));
        expect(planStep).toContain('EXITCODE');
        expect(planStep).toMatch(/if \[ "\$EXITCODE" = "1" \]; then exit 1; fi/);
        expect(raw).toContain('iac-drift-check-failed');
    });

    it('plan.yml gates PR plans behind the same-repo guard with a fork notice', () => {
        const doc = parseTemplate('plan.yml');
        expect(doc.on.pull_request, 'plan.yml must not trigger on pull_request (BUG-140)').toBeUndefined();
        expect(doc.on.pull_request_target.types).toEqual(['opened', 'synchronize', 'reopened']);
        expect(doc.on.pull_request_target.paths).toEqual(['terraform/**']);
        expect(doc.permissions).toMatchObject({ 'id-token': 'write', contents: 'read', 'pull-requests': 'write' });
        expect(doc.concurrency.group).toContain('github.event.pull_request.number');
        expect(doc.concurrency['cancel-in-progress']).toBe(true);
        const job = doc.jobs['terraform-plan'];
        expect(job.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
        const checkout = job.steps.find((s) => s?.uses?.startsWith('actions/checkout@'));
        expect(checkout?.with?.ref).toBe('${{ github.event.pull_request.head.sha }}');
        expect(doc.jobs['fork-notice'].if).toContain('github.event.pull_request.head.repo.full_name != github.repository');
    });

    it('plan.yml fails loud (never skips) on credential failure', () => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'plan.yml'), 'utf8');
        expect(raw).toContain('id: aws-creds');
        expect(raw).toContain('continue-on-error: true');
        expect(raw).toContain('- name: Interpret credential failure');
        expect(raw).toContain('npx grada-run apply');
        expect(raw).not.toContain("steps.aws-creds.outcome == 'success'");
    });

    it('plan.yml posts a sticky diff-highlighted comment with truncation', () => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'plan.yml'), 'utf8');
        expect(raw).toContain('<!-- grada-plan -->');
        expect(raw).toContain('<details><summary>Show Plan</summary>');
        // Fence is backslash-escaped in source (it sits inside a JS template literal).
        expect(raw).toContain('\\`\\`\\`diff');
        expect(raw).toContain('30000');
        expect(raw).toContain('terraform_wrapper: false');
        expect(raw).toContain('-detailed-exitcode');
        expect(raw).toContain('terraform show -no-color tfplan > plan.txt');
        expect(raw).toContain('-lock-timeout=5m');
    });

    it.each([
        ['deploy.yml', 'DEPLOY_ROLE_NAME'],
        ['deploy-lambda.yml', 'DEPLOY_ROLE_NAME'],
        ['deploy-static.yml', 'DEPLOY_ROLE_NAME'],
        ['preview.yml', 'PREVIEW_ROLE_NAME'],
        ['preview-lambda.yml', 'PREVIEW_ROLE_NAME'],
        ['teardown.yml', 'PREVIEW_ROLE_NAME'],
    ])('%s assumes the {{%s}} role', (filename, placeholder) => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
        expect(raw).toContain(`role/{{${placeholder}}}`);
        expect(raw).not.toMatch(/-github-actions-role["'\s]/);
    });

    it('drift.yml and plan.yml keep the scaffolded {{ROLE_ARN}} placeholder', () => {
        for (const filename of ['drift.yml', 'plan.yml']) {
            const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
            expect(raw).toContain('role-to-assume: {{ROLE_ARN}}');
        }
    });

    it('teardown.yml destroys same-repo previews only', () => {
        const doc = parseTemplate('teardown.yml');
        expect(doc.on.pull_request, 'teardown.yml must not trigger on pull_request').toBeUndefined();
        expect(doc.on.pull_request_target.types).toEqual(['closed']);
        const job = doc.jobs['destroy-preview'];
        expect(job.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
        const checkout = job.steps.find((s) => s?.uses?.startsWith('actions/checkout@'));
        expect(checkout?.with?.ref).toBe('${{ github.event.pull_request.head.sha }}');
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

    it('preview cancels superseded runs; teardown has its own group and never cancels', () => {
        for (const filename of ['preview.yml', 'preview-lambda.yml']) {
            const doc = parseTemplate(filename);
            expect(doc.concurrency, filename).toMatchObject({
                group: 'preview-${{ github.event.pull_request.number }}',
                'cancel-in-progress': true,
            });
        }
        const teardown = parseTemplate('teardown.yml');
        // Own group (BUG-154): sharing preview's group let a reopen
        // cancel the in-flight destroy.
        expect(teardown.concurrency.group).toBe('teardown-${{ github.event.pull_request.number }}');
        expect(teardown.concurrency, 'teardown must run to completion, never cancel').not.toHaveProperty('cancel-in-progress');
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
        const injected = injectMigrationGate(raw.replace(PLACEHOLDER_RE, 'dummy'), { cmd: 'node ./dist/migrate.cjs', dbIdentifier: 'dummy-db' });
        expect(injected).toContain('# grada:db-migrate-start');
        const doc = yamlLoad(injected, { schema: CORE_SCHEMA });
        const steps = doc.jobs.deploy.steps;
        expect(steps.some((s) => typeof s?.run === 'string' && s.run.includes('migrate'))).toBe(true);
    });
});

describe('workflow supply-chain pins', () => {
    const templates = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.yml'));

    it.each(templates)('%s pins every action to a full commit SHA', (filename) => {
        const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
        const refs = [...raw.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1]);
        expect(refs.length).toBeGreaterThan(0);
        for (const ref of refs) {
            expect(ref, `${filename}: ${ref}`).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
        }
    });

    it('matches the ACTION_PINS single source (no drifted template)', async () => {
        const { ACTION_PINS } = await import('../src/data/action-pins.js');
        for (const filename of templates) {
            const raw = fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8');
            for (const [, action, sha] of raw.matchAll(/uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})/g)) {
                expect(ACTION_PINS[action], `${filename}: unknown action ${action}`).toBeDefined();
                expect(sha, `${filename}: ${action} drifted from ACTION_PINS`).toBe(ACTION_PINS[action].sha);
            }
        }
    });
});
