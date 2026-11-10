// CI hardening contract: scanners run on rendered output, containers run
// non-root, and accepted AWS cost trade-offs carry explicit Trivy ignores.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function readRepo(rel) {
    return fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
}

function finalStage(content) {
    const lines = content.split('\n');
    let lastFromIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*FROM\s+/i.test(lines[i])) lastFromIdx = i;
    }
    return lines.slice(lastFromIdx + 1).join('\n');
}

describe('CI scans rendered templates (not raw {{VARS}})', () => {
    for (const workflow of ['.github/workflows/test.yml', '.github/workflows/publish.yml']) {
        it(`${workflow} renders ecs+lambda+static then scans the rendered dirs`, () => {
            const yml = readRepo(workflow);
            expect(yml).toContain('mktemp -d');
            expect(yml).toContain('init --target ecs --headless');
            expect(yml).toContain('init --target lambda --headless');
            expect(yml).toContain('init --target static --headless');
            expect(yml).toContain('SCAN_ROOT/static/terraform');
            expect(yml).toContain('tflint');
            expect(yml).toContain("'config'");
            expect(yml).toContain("SCAN_ROOT }}/static'");
            // Must not scan the repo root / raw templates folder.
            expect(yml).not.toMatch(/tflint --recursive/);
            expect(yml).not.toMatch(/scan-dir:\s*['\"]?\.\s*['\"]?\s*$/m);
        });
    }
});

describe('Terraform is installed before grada renders (init shells to terraform fmt)', () => {
    for (const workflow of ['.github/workflows/test.yml', '.github/workflows/publish.yml']) {
        it(`${workflow} sets up Terraform ahead of the render step`, () => {
            const yml = readRepo(workflow);
            const setup = yml.indexOf('hashicorp/setup-terraform');
            const render = yml.indexOf('Render templates for IaC scanning');
            expect(setup).toBeGreaterThanOrEqual(0);
            expect(render).toBeGreaterThanOrEqual(0);
            expect(setup).toBeLessThan(render);
        });
    }

    it('iac-validation.yml installs Terraform in every scaffold job', () => {
        const yml = readRepo('.github/workflows/iac-validation.yml');
        // Split per job; the lambda job carries its scaffold commands in the
        // matrix block (textually before steps), so assert presence per job
        // rather than textual order within the job.
        const jobs = yml.split('runs-on: ubuntu-latest').slice(1);
        const scaffoldJobs = jobs.filter((job) => job.includes('bin/cli.js'));
        expect(scaffoldJobs.length).toBe(4);
        for (const job of scaffoldJobs) {
            expect(job).toContain('hashicorp/setup-terraform');
        }
    });
});

describe('Our own CI never emits telemetry (job-level DO_NOT_TRACK)', () => {
    for (const workflow of ['.github/workflows/test.yml', '.github/workflows/publish.yml', '.github/workflows/iac-validation.yml']) {
        it(`${workflow} silences every runner job above its steps`, () => {
            const yml = readRepo(workflow);
            const jobs = yml.split('runs-on: ubuntu-latest').slice(1);
            expect(jobs.length).toBeGreaterThan(0);
            for (const job of jobs) {
                const silenced = job.indexOf("DO_NOT_TRACK: '1'");
                const steps = job.indexOf('steps:');
                expect(silenced).toBeGreaterThanOrEqual(0);
                expect(silenced).toBeLessThan(steps);
            }
        });
    }
});

describe('Docker templates run as non-root (DS-0002)', () => {
    const dir = path.join(process.cwd(), 'templates', 'docker');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.Dockerfile'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
        it(`${file} ends its final stage as a non-root USER`, () => {
            const runner = finalStage(readRepo(`templates/docker/${file}`));
            const users = runner.split('\n').filter((l) => /^\s*USER\s+\S+/i.test(l));
            expect(users.length).toBeGreaterThanOrEqual(1);
            const finalUser = users[users.length - 1].trim().split(/\s+/)[1];
            expect(['root', '0']).not.toContain(finalUser);
        });
    }
});

describe('Terraform templates suppress accepted AWS trade-offs', () => {
    it('s3 addon ignores CMK (0132) and WAF (0011)', () => {
        const tf = readRepo('templates/terraform/addons/s3.tf');
        expect(tf).toContain('trivy:ignore:AVD-AWS-0132');
        expect(tf).toContain('trivy:ignore:AVD-AWS-0011');
    });

    it('static site ignores CMK (0132) and WAF (0011)', () => {
        const tf = readRepo('templates/terraform/static/main.tf');
        expect(tf).toContain('trivy:ignore:AVD-AWS-0132');
        expect(tf).toContain('trivy:ignore:AVD-AWS-0011');
    });

    it('Valkey replication group ignores at-rest (0045) and transit (0051) encryption', () => {
        const tf = readRepo('templates/terraform/addons/redis.tf');
        expect(tf).toContain('trivy:ignore:AVD-AWS-0045');
        expect(tf).toContain('trivy:ignore:AVD-AWS-0051');
    });
});

describe('Shift-left: local test:iac matches blocking CI scans', () => {
    it('package.json exposes the local IaC hook', () => {
        const pkg = JSON.parse(readRepo('package.json'));
        expect(pkg.scripts['test:iac']).toBe('node ./scripts/test-iac.js');
    });

    it('scripts/test-iac.js renders to /tmp/grada-iac-test and runs blocking Docker scans', () => {
        const script = readRepo('scripts/test-iac.js');
        expect(script).toContain('/tmp/grada-iac-test');
        expect(script).toContain('init --target ecs --headless');
        expect(script).toContain('aquasec/trivy');
        expect(script).toContain('config');
        expect(script).toContain('--exit-code 1 --severity HIGH,CRITICAL');
        expect(script).toContain('ghcr.io/terraform-linters/tflint');
    });

    it('scripts/test-iac.js also renders and scans the static target', () => {
        const script = readRepo('scripts/test-iac.js');
        expect(script).toContain('/tmp/grada-iac-test-static');
        expect(script).toContain('init --target static --headless');
        expect(script).toContain('test-app-static-base');
    });

    it('scripts/test-iac.js warns and exits 0 without Docker', () => {
        const script = readRepo('scripts/test-iac.js');
        expect(script).toContain('Docker is required to run test:iac locally');
        expect(script).toContain('process.exit(0)');
    });

    it('iac-validation.yml runs the same blocking Trivy config command', () => {
        const yml = readRepo('.github/workflows/iac-validation.yml');
        expect(yml).toContain('aquasec/trivy config --exit-code 1 --severity HIGH,CRITICAL');
    });
});

describe('Preview guardrails are self-protecting (BUG-207/208)', () => {
    it('denies CI-role mutation on the preview role (scoped to the CI roles)', () => {
        const tf = readRepo('templates/terraform/oidc.tf');
        const guardrails = tf.slice(tf.indexOf('resource "aws_iam_role_policy" "preview_guardrails"'));
        expect(guardrails).toContain('DenyCIRoleMutation');
        for (const action of ['iam:DeleteRole', 'iam:UpdateAssumeRolePolicy', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy']) {
            expect(guardrails).toContain(action);
        }
        // Scoped to the CI role ARNs (not *): preview stacks legitimately
        // manage their own pr-suffixed IAM roles.
        expect(guardrails).toContain('aws_iam_role.github_actions_deploy[0].arn');
        expect(guardrails).toContain('aws_iam_role.github_actions_preview[0].arn');
    });

    it('covers the worker service and drops the invalid cluster-less ARN', () => {
        const tf = readRepo('templates/terraform/oidc.tf');
        expect(tf).toContain('service/${local.prod_prefix}-cluster/${local.prod_prefix}-worker-service');
        expect(tf).not.toContain('service/${local.prod_prefix}-service"');
    });

    it('denies prod snapshot, secrets, and log-group deletion', () => {
        const tf = readRepo('templates/terraform/oidc.tf');
        const guardrails = tf.slice(tf.indexOf('resource "aws_iam_role_policy" "preview_guardrails"'));
        expect(guardrails).toContain('rds:DeleteDBSnapshot');
        expect(guardrails).toContain('rds:DeleteDBClusterSnapshot');
        expect(guardrails).toContain('snapshot:${local.prod_prefix}-db-*');
        expect(guardrails).toContain('cluster-snapshot:${local.prod_prefix}-db-cluster-*');
        expect(guardrails).toContain('secretsmanager:DeleteSecret');
        expect(guardrails).toContain('secret:${local.prod_prefix}-secrets-*');
        expect(guardrails).toContain('logs:DeleteLogGroup');
        expect(guardrails).toContain('log-group:/ecs/${local.prod_prefix}');
    });
});

describe('Preview permissions boundary (BUG-212)', () => {
    it('forces every created role to carry the boundary', () => {
        const tf = readRepo('templates/terraform/oidc.tf');
        const guardrails = tf.slice(tf.indexOf('resource "aws_iam_role_policy" "preview_guardrails"'));
        expect(guardrails).toContain('DenyRoleWithoutBoundary');
        expect(guardrails).toContain('iam:CreateRole');
        expect(guardrails).toContain('iam:PermissionsBoundary');
        expect(guardrails).toContain(`${'${local.prod_prefix}'}-preview-boundary`);
    });

    it('lets neither preview nor backdoor creds touch the boundary', () => {
        const tf = readRepo('templates/terraform/oidc.tf');
        const guardrails = tf.slice(tf.indexOf('resource "aws_iam_role_policy" "preview_guardrails"'));
        expect(guardrails).toContain('iam:PutRolePermissionsBoundary');
        expect(guardrails).toContain('iam:DeleteRolePermissionsBoundary');
        expect(guardrails).toContain('DenyBoundaryMutation');
        const boundary = tf.slice(tf.indexOf('resource "aws_iam_policy" "preview_boundary"'));
        expect(boundary).toContain('"iam:*"');
    });

    it('caps backdoor roles at the task data-plane (deny-list mirror)', () => {
        const tf = readRepo('templates/terraform/oidc.tf');
        const boundary = tf.slice(tf.indexOf('resource "aws_iam_policy" "preview_boundary"'));
        // Base allow with guardrail-mirroring denies: default-allow so a
        // missing entry weakens security instead of breaking prod tasks.
        expect(boundary).toContain('BoundaryBaseAllow');
        for (const action of ['cloudtrail:*', 'organizations:*', 'ec2:RunInstances', 'rds:DeleteDBInstance', 's3:DeleteBucket', 'dynamodb:DeleteTable', 'sqs:DeleteQueue', 'ecs:DeleteCluster', 'ecr:BatchDeleteImage', 'secretsmanager:DeleteSecret', 'logs:DeleteLogGroup']) {
            expect(boundary).toContain(action);
        }
    });

    it('resolves the boundary ARN in every workspace', () => {
        const tf = readRepo('templates/terraform/oidc.tf');
        expect(tf).toContain('resource "aws_iam_policy" "preview_boundary"');
        expect(tf).toContain('data "aws_iam_policy" "preview_boundary"');
        expect(tf).toContain('preview_boundary_arn');
    });

    it('every managed role is born bounded', () => {
        for (const rel of ['templates/terraform/main.tf', 'templates/terraform/main-lambda.tf', 'templates/terraform/addons/cron.tf', 'templates/terraform/addons/cron-lambda.tf']) {
            const content = readRepo(rel);
            const roles = content.match(/resource "aws_iam_role" "[^"]+"/g) || [];
            expect(roles.length).toBeGreaterThan(0);
            const bounded = content.match(/permissions_boundary\s*=\s*local\.preview_boundary_arn/g) || [];
            expect(bounded.length).toBe(roles.length);
        }
    });
});

describe('Tier 2 live-service job in e2e.yml', () => {
    it('runs tier2 on schedule/manual dispatch with a 90-minute timeout', () => {
        const yml = readRepo('.github/workflows/e2e.yml');
        expect(yml).toContain('tier2:');
        expect(yml).toContain("if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
        expect(yml).toContain('timeout-minutes: 90');
        expect(yml).toContain('npm run test:e2e:tier2');
    });

    it('queues overlapping runs instead of cancelling them', () => {
        const yml = readRepo('.github/workflows/e2e.yml');
        expect(yml).toContain('group: grada-e2e-tier2');
        expect(yml).toContain('cancel-in-progress: false');
    });

    it('guarantees destroy then gc in an always() fallback with artifact upload', () => {
        const yml = readRepo('.github/workflows/e2e.yml');
        const tier2 = yml.slice(yml.indexOf('tier2:'));
        expect(tier2).toContain('if: always()');
        const destroyIdx = tier2.indexOf('destroy --headless --yes --allow-data-loss');
        const gcIdx = tier2.indexOf('gc --headless --yes');
        expect(destroyIdx).toBeGreaterThan(-1);
        expect(gcIdx).toBeGreaterThan(destroyIdx);
        expect(tier2).toContain('e2e-tier2-workspace');
    });
});
