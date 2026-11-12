// CI hardening contract: scanners run on rendered output, containers run
// non-root, and accepted AWS cost trade-offs carry explicit Trivy ignores.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function readRepo(rel) {
    return fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
}

// Slices one policy block out of a template: bounded on both sides so a
// guardrail assertion can never pass on boundary text (or vice versa).
function slicePolicy(tf, startMarker, endMarker = null) {
    const start = tf.indexOf(startMarker);
    if (start === -1) return '';
    const end = endMarker === null ? tf.length : tf.indexOf(endMarker, start);
    return tf.slice(start, end === -1 ? tf.length : end);
}

// Parses a sliced policy into Sid -> { action, resource } with normalized
// source text, so twin assertions compare exactly what ships.
function statementsBySid(slice) {
    const map = new Map();
    const parts = slice.split(/Sid\s*=\s*"/);
    for (let i = 1; i < parts.length; i++) {
        const chunk = parts[i];
        const sid = chunk.slice(0, chunk.indexOf('"'));
        const action = chunk.match(/(?<!Not)Action\s*=\s*\[[^\]]*\]/s)?.[0].replace(/\s+/g, ' ') ?? null;
        const resource = chunk.match(/(?<!Not)Resource\s*=\s*(\[[^\]]*\]|local\.\w+|"[^"]*")/s)?.[0].replace(/\s+/g, ' ') ?? null;
        map.set(sid, { action, resource });
    }
    return map;
}

function sidChunk(slice, sid) {
    const parts = slice.split(/Sid\s*=\s*"/);
    for (let i = 1; i < parts.length; i++) {
        if (parts[i].startsWith(`${sid}"`)) return parts[i];
    }
    return '';
}

// Twin naming drops the guardrail-side Prod infix: DenyProdX (and
// DenyX) <-> BoundaryDenyX.
function twinSid(sid) {
    return `BoundaryDeny${sid.replace(/^Deny(Prod)?/, '')}`;
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

    it('scripts/test-iac.js wires the ECS gate with an explicit node command (mirrors CI)', () => {
        // Bare --setup-ci-migrate trips the stripped-runner refusal on
        // the seeded prisma script — CI passes an explicit command, so
        // the local script must too. Lambda keeps bare (it skips the ECS
        // gate with a warning).
        const script = readRepo('scripts/test-iac.js');
        expect(script).toContain("'--setup-ci-migrate=node ./dist/migrate.cjs'");
    });

    it('iac-validation.yml runs the same blocking Trivy config command', () => {
        const yml = readRepo('.github/workflows/iac-validation.yml');
        expect(yml).toContain('aquasec/trivy config --exit-code 1 --severity HIGH,CRITICAL');
    });
});

describe('Preview guardrails are self-protecting (BUG-207/208)', () => {
    it('denies CI-role mutation on the preview role (scoped to the CI roles)', () => {
        const { guardrails } = twinSlices();
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
        // Cluster-scoped wildcard covers the web and worker services alike
        // (exact per-service ARNs were folded into it for the 6144 quota).
        expect(tf).toContain('service/${local.prod_prefix}-cluster/*');
        expect(tf).not.toContain('service/${local.prod_prefix}-service"');
    });

    it('denies prod snapshot, secrets, and log-group deletion', () => {
        const { tf, guardrails } = twinSlices();
        expect(guardrails).toContain('rds:DeleteDBSnapshot');
        expect(guardrails).toContain('rds:DeleteDBClusterSnapshot');
        expect(guardrails).toContain('secretsmanager:DeleteSecret');
        expect(guardrails).toContain('logs:DeleteLogGroup');
        // Resource lists live in the shared locals both twins consume.
        for (const arn of [
            'snapshot:${local.prod_prefix}-db-*',
            'cluster-snapshot:${local.prod_prefix}-db-cluster-*',
            'secret:${local.prod_prefix}-secrets-*',
            'log-group:/ecs/${local.prod_prefix}',
        ]) {
            expect(tf).toContain(arn);
        }
    });
});

describe('Preview permissions boundary (BUG-212)', () => {
    it('forces every created role to carry the boundary', () => {
        const { guardrails } = twinSlices();
        expect(guardrails).toContain('DenyRoleWithoutBoundary');
        expect(guardrails).toContain('iam:CreateRole');
        expect(guardrails).toContain('iam:PermissionsBoundary');
        expect(guardrails).toContain(`${'${local.prod_prefix}'}-preview-boundary`);
    });

    it('lets neither preview nor backdoor creds touch the boundary', () => {
        const { guardrails, boundary } = twinSlices();
        expect(guardrails).toContain('iam:PutRolePermissionsBoundary');
        expect(guardrails).toContain('iam:DeleteRolePermissionsBoundary');
        expect(guardrails).toContain('DenyBoundaryMutation');
        // BUG-214 carved PassRole out of the IAM veto; the veto itself is
        // an explicit IAM-write list — never NotAction, which would deny
        // every service (see the carve-out assertions below).
        const chunk = sidChunk(boundary, 'BoundaryDenyIAM');
        expect(chunk).not.toContain('NotAction');
        expect(chunk).toContain('iam:PutRolePermissionsBoundary');
        expect(chunk).toContain('iam:DeleteRolePermissionsBoundary');
    });

    it('caps backdoor roles at the task data-plane (deny-list mirror)', () => {
        const { boundary } = twinSlices();
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

const GUARDRAIL_MARKER = 'resource "aws_iam_role_policy" "preview_guardrails"';
const BOUNDARY_MARKER = 'resource "aws_iam_policy" "preview_boundary"';
const BOUNDARY_DATA_MARKER = 'data "aws_iam_policy" "preview_boundary"';

function twinSlices() {
    const tf = readRepo('templates/terraform/oidc.tf');
    return {
        tf,
        guardrails: slicePolicy(tf, GUARDRAIL_MARKER, BOUNDARY_MARKER),
        boundary: slicePolicy(tf, BOUNDARY_MARKER, BOUNDARY_DATA_MARKER),
    };
}

describe('Permissions boundary PassRole carve-out (BUG-214)', () => {
    it('carves PassRole out of the IAM deny instead of blocking the scheduler', () => {
        const { boundary } = twinSlices();
        const chunk = sidChunk(boundary, 'BoundaryDenyIAM');
        // Explicit IAM-write list with PassRole absent (NotAction would
        // veto non-IAM services too — tier2 E2E proved it).
        expect(chunk).not.toContain('NotAction');
        expect(chunk).not.toContain('iam:PassRole');
        expect(chunk).not.toContain('"iam:*"');
        for (const action of ['iam:CreateRole', 'iam:DeleteRole', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy']) {
            expect(chunk).toContain(action);
        }
    });

    it('gates carved PassRole on the ECS tasks service', () => {
        const { boundary } = twinSlices();
        const chunk = sidChunk(boundary, 'BoundaryDenyPassRoleOffService');
        expect(chunk).toContain('"iam:PassRole"');
        expect(chunk).toContain('StringNotEquals');
        expect(chunk).toContain('iam:PassedToService');
        expect(chunk).toContain('ecs-tasks.amazonaws.com');
    });

    it('gates carved PassRole on task roles (preview patterns plus the prod pair)', () => {
        const { boundary } = twinSlices();
        const chunk = sidChunk(boundary, 'BoundaryDenyPassRoleOffTarget');
        expect(chunk).toContain('"iam:PassRole"');
        expect(chunk).toContain('NotResource');
        expect(chunk).toContain('role/{{PROJECT_NAME}}-pr-*-task-role');
        expect(chunk).toContain('role/{{PROJECT_NAME}}-pr-*-execution-role');
        // The prod pair rides the shared local, so renames flow instead
        // of silently re-narrowing the exception.
        expect(chunk).toContain('local.guardrail_app_role_resources');
    });

    it('lets only the prod scheduler pass prod roles', () => {
        const { boundary } = twinSlices();
        const chunk = sidChunk(boundary, 'BoundaryDenyProdPassRoleOffScheduler');
        expect(chunk).toContain('"iam:PassRole"');
        expect(chunk).toContain('local.guardrail_app_role_resources');
        expect(chunk).toContain('StringNotEquals');
        expect(chunk).toContain('aws:PrincipalArn');
        expect(chunk).toContain('role/${local.prod_prefix}-cron-scheduler-role');
    });
});

describe('Preview task-role confinement (BUG-215)', () => {
    it('denies prod task execution on anchored ARNs (guardrail side)', () => {
        const { tf, guardrails } = twinSlices();
        const chunk = sidChunk(guardrails, 'DenyProdTaskExecution');
        for (const action of ['ecs:RunTask', 'ecs:StopTask', 'ecs:ExecuteCommand', 'ecs:CreateService']) {
            expect(chunk).toContain(action);
        }
        expect(chunk).toContain('local.guardrail_task_execution_resources');
        const local = tf.slice(tf.indexOf('guardrail_task_execution_resources'));
        for (const arn of [
            'cluster/${local.prod_prefix}-cluster',
            'service/${local.prod_prefix}-cluster/*',
            'task/${local.prod_prefix}-cluster/*',
            'task-definition/${local.prod_prefix}-*:*',
        ]) {
            expect(local).toContain(arn);
        }
        // No describes: plan.yml refreshes prod state with preview
        // credentials, so describing prod is legitimate traffic.
        expect(chunk).not.toContain('Describe');
    });

    it('denies prod task-definition registration and prod PassRole', () => {
        const { tf, guardrails } = twinSlices();
        const registration = sidChunk(guardrails, 'DenyProdTaskDefinitionRegistration');
        expect(registration).toContain('ecs:RegisterTaskDefinition');
        expect(registration).toContain('ecs:DeregisterTaskDefinition');
        expect(registration).toContain('local.guardrail_task_definition_resources');
        const taskDefLocal = tf.slice(tf.indexOf('guardrail_task_definition_resources'));
        expect(taskDefLocal).toContain('task-definition/${local.prod_prefix}-*:*');
        const passRole = sidChunk(guardrails, 'DenyProdPassRole');
        expect(passRole).toContain('"iam:PassRole"');
        expect(passRole).toContain('local.guardrail_app_role_resources');
    });

    it('denies prod app-role mutation on string-built ARNs (no HCL refs)', () => {
        const { tf, guardrails } = twinSlices();
        const chunk = sidChunk(guardrails, 'DenyProdAppRoleMutation');
        for (const action of ['iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:UpdateAssumeRolePolicy', 'iam:DeleteRole']) {
            expect(chunk).toContain(action);
        }
        expect(chunk).toContain('local.guardrail_app_role_resources');
        const local = tf.slice(tf.indexOf('guardrail_app_role_resources'));
        expect(local).toContain('role/${local.prod_prefix}-*-role');
        // Static trees define no IAM roles: refs would dangle and fail
        // validate, so the ARNs must be string-built.
        expect(tf).not.toContain('aws_iam_role.task_role');
        expect(tf).not.toContain('aws_iam_role.execution_role');
        expect(tf).not.toContain('aws_iam_role.scheduler_cron_role');
    });

    it('closes the trust-edit bypass on all three app roles (both twins)', () => {
        // Re-trusting the prod task role and assuming it directly would
        // bypass every execution deny — so trust-policy writes and role
        // deletion are denied on task, execution, and scheduler roles.
        const { guardrails, boundary } = twinSlices();
        for (const chunk of [sidChunk(guardrails, 'DenyProdAppRoleMutation'), sidChunk(boundary, 'BoundaryDenyAppRoleMutation')]) {
            expect(chunk).toContain('iam:UpdateAssumeRolePolicy');
            expect(chunk).toContain('iam:DeleteRole');
            expect(chunk).toContain('local.guardrail_app_role_resources');
        }
    });

    it('mirrors the four new statements into the boundary', () => {
        const { boundary } = twinSlices();
        for (const sid of ['BoundaryDenyTaskExecution', 'BoundaryDenyTaskDefinitionRegistration', 'BoundaryDenyPassRole', 'BoundaryDenyAppRoleMutation']) {
            expect(sidChunk(boundary, sid), `${sid} missing`).not.toBe('');
        }
    });

    it('matches no pr-* resource on the new statements', () => {
        const { tf } = twinSlices();
        for (const local of ['guardrail_task_execution_resources', 'guardrail_task_definition_resources', 'guardrail_app_role_resources']) {
            const block = tf.slice(tf.indexOf(local), tf.indexOf(']', tf.indexOf(local)));
            expect(block, local).not.toContain('pr-');
        }
    });

    it('keeps every twinable guardrail Sid mirrored with identical Action/Resource', () => {
        const { guardrails, boundary } = twinSlices();
        const guardrailStmts = statementsBySid(guardrails);
        const boundaryStmts = statementsBySid(boundary);
        // Exact enumeration: 13 identical + 1 asymmetric + 4 no-twin by
        // design + 4 new. A new Sid without a twin fails here.
        const identicalTwins = [
            'DenyComputeAbuse',
            'DenySnapshotSharing',
            'DenyProdStateDestruction',
            'DenyProdECSShutdown',
            'DenyProdImageDeletion',
            'DenyProdLambdaRewrite',
            'DenyProdQueueDestruction',
            'DenyProdDatabaseDestruction',
            'DenyProdAuroraDestruction',
            'DenyProdTableDeletion',
            'DenyProdSnapshotDeletion',
            'DenyProdSecretsDeletion',
            'DenyProdLogDeletion',
            'DenyProdTaskExecution',
            'DenyProdTaskDefinitionRegistration',
            'DenyProdPassRole',
            'DenyProdAppRoleMutation',
        ];
        const asymmetricTwin = new Map([['DenyIAMBackdoors', 'BoundaryDenyIAM']]);
        const noTwinByDesign = new Set(['DenyCIRoleMutation', 'DenyRoleWithoutBoundary', 'DenyBoundarySwap', 'DenyBoundaryMutation']);
        expect([...guardrailStmts.keys()].sort()).toEqual([...identicalTwins, ...asymmetricTwin.keys(), ...noTwinByDesign].sort());
        for (const sid of identicalTwins) {
            const twin = boundaryStmts.get(twinSid(sid));
            expect(twin, `${sid} missing boundary twin`).toBeDefined();
            expect(twin.action, `${sid} Action drift`).toBe(guardrailStmts.get(sid).action);
            expect(twin.resource, `${sid} Resource drift`).toBe(guardrailStmts.get(sid).resource);
        }
        for (const [sid, twinSid] of asymmetricTwin) {
            expect(boundaryStmts.has(twinSid), `${sid} asymmetric twin missing`).toBe(true);
        }
        // Boundary-only Sids stay pinned too: base allow, audit/billing,
        // the asymmetric IAM deny, and the PassRole carve-out gates.
        expect([...boundaryStmts.keys()].sort()).toEqual(
            [...identicalTwins.map(twinSid), 'BoundaryBaseAllow', 'BoundaryDenyAuditBilling', 'BoundaryDenyIAM', 'BoundaryDenyPassRoleOffService', 'BoundaryDenyPassRoleOffTarget', 'BoundaryDenyProdPassRoleOffScheduler'].sort()
        );
    });
});

describe('Snapshot guardrails cover pre-deploy names (BUG-205)', () => {
    it('denies legacy bare pre-deploy snapshot deletion on both twins', () => {
        const { tf, guardrails, boundary } = twinSlices();
        expect(sidChunk(guardrails, 'DenyProdSnapshotDeletion')).toContain('local.guardrail_snapshot_deletion_resources');
        expect(sidChunk(boundary, 'BoundaryDenySnapshotDeletion')).toContain('local.guardrail_snapshot_deletion_resources');
        const local = tf.slice(tf.indexOf('guardrail_snapshot_deletion_resources'));
        expect(local).toContain('snapshot:${local.prod_prefix}-db-*');
        expect(local).toContain('cluster-snapshot:${local.prod_prefix}-db-cluster-*');
        expect(local).toContain('snapshot:pre-deploy-*');
        expect(local).toContain('cluster-snapshot:pre-deploy-*');
    });
});

// Renders the preview_boundary managed policy for a worst-case prod prefix
// and returns its AWS-counted size (compact JSON, no whitespace): the
// Statement array only, locals inlined, interpolations substituted — what
// Terraform's jsonencode ships. Guards the 6144-char managed-policy quota
// that broke tier1 E2E at a 24-char prefix.
function boundaryPolicySize(prodPrefix) {
    const tf = readRepo('templates/terraform/oidc.tf');
    const project = prodPrefix.replace(/-[a-f0-9]{6}$/, '');
    const region = 'us-east-2';
    const account = '710596603276';
    const bucket = `${prodPrefix}-tfstate-${account}`.slice(0, 63);
    const stripComments = (src) => src.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    const localList = (name) => {
        const m = tf.match(new RegExp(`${name}\\s*=\\s*\\[`));
        if (!m) throw new Error(`local ${name} not found`);
        const open = tf.indexOf(m[0]) + m[0].length - 1;
        let depth = 0;
        let i = open;
        for (; i < tf.length; i++) {
            if (tf[i] === '[') depth++;
            else if (tf[i] === ']') { depth--; if (depth === 0) break; }
        }
        return stripComments(tf.slice(open, i + 1));
    };
    const { boundary } = twinSlices();
    const arrStart = boundary.indexOf('Statement = [') + 'Statement = ['.length;
    const arrEnd = boundary.indexOf('\n    ]\n  })');
    let slice = stripComments(boundary.slice(arrStart, arrEnd));
    slice = slice.replace(/concat\(\[([\s\S]*?)\], (local\.\w+)\)/g, (_, items, ref) => {
        const list = localList(ref.replace('local.', ''));
        return `[${items.replace(/,\s*$/, '')}, ${list.slice(1, -1)}]`;
    });
    const subst = (s) => s
        .split('${data.aws_region.current.name}').join(region)
        .split('${data.aws_caller_identity.current.account_id}').join(account)
        .split('${local.prod_prefix}').join(prodPrefix)
        .split('{{STATE_BUCKET}}').join(bucket)
        .split('{{PROJECT_NAME}}').join(project);
    slice = subst(slice).replace(/local\.(\w+)/g, (_, name) => localList(name));
    slice = subst(slice);
    // HCL -> JSON: quote keys, comma-separate newline fields/items.
    let json = slice
        .replace(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g, '"$1":')
        .replace(/("[A-Za-z0-9_:.@/-]+")\s*=/g, '$1:');
    const lines = json.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
        if (!/["\]}]\s*$/.test(lines[i]) || /,\s*$/.test(lines[i])) continue;
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && !/^\s*[\]}]/.test(lines[j])) lines[i] = `${lines[i]},`;
    }
    json = `[${lines.join('\n')}]`.replace(/,(\s*[\]}])/g, '$1');
    return JSON.stringify({ Version: '2012-10-17', Statement: JSON.parse(json) }).length;
}

describe('Boundary IAM deny is scoped to IAM writes (tier2 E2E)', () => {
    it('uses Action, never NotAction: a Deny with NotAction vetoes every service', () => {
        const { boundary } = twinSlices();
        const chunk = sidChunk(boundary, 'BoundaryDenyIAM');
        expect(chunk).not.toContain('NotAction');
        expect(chunk).toMatch(/Action\s*=\s*\[/);
    });

    it('denies role/policy/user backdoors while carving out PassRole', () => {
        const { boundary } = twinSlices();
        const chunk = sidChunk(boundary, 'BoundaryDenyIAM');
        for (const action of ['iam:CreateRole', 'iam:DeleteRole', 'iam:UpdateAssumeRolePolicy', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:PutRolePermissionsBoundary', 'iam:DeleteRolePermissionsBoundary', 'iam:CreatePolicy', 'iam:DeletePolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion', 'iam:CreateUser', 'iam:DeleteUser', 'iam:CreateAccessKey', 'iam:DeleteAccessKey']) {
            expect(chunk).toContain(action);
        }
        // PassRole stays carved out (re-gated on service + target below).
        expect(chunk).not.toContain('iam:PassRole');
    });
});

describe('Boundary policy fits the 6144-char managed-policy quota (tier1 E2E)', () => {
    it('renders under quota for a 24-char prod prefix (tier1-live shape)', () => {
        expect(boundaryPolicySize('tier1-live-p64qpk-c5228d')).toBeLessThan(6144);
    });

    it('renders under quota for a 32-char prod prefix', () => {
        expect(boundaryPolicySize('abcdefghijklmnopqrstuvwxyz123456')).toBeLessThan(6144);
    });

    it('folds exact ARNs into prod_prefix-anchored wildcards', () => {
        const tf = readRepo('templates/terraform/oidc.tf');
        const block = (name) => {
            const start = tf.indexOf(name);
            return tf.slice(start, tf.indexOf(']', start));
        };
        // Single anchored patterns (exact per-resource ARNs were folded
        // into these for the quota; preview-safe: preview names carry
        // -pr-<n>- where prod carries the hex suffix).
        expect(block('guardrail_state_destruction_resources')).toContain('arn:aws:s3:::{{STATE_BUCKET}}*');
        expect(block('guardrail_queue_destruction_resources')).toContain('${local.prod_prefix}-*');
        expect(block('guardrail_database_destruction_resources')).toContain('db:${local.prod_prefix}-db*');
        expect(block('guardrail_app_role_resources')).toContain('role/${local.prod_prefix}-*-role');
        expect(block('guardrail_task_definition_resources')).toContain('task-definition/${local.prod_prefix}-*:*');
        // No unfolded exact siblings left behind.
        for (const gone of ['-worker-service"', '-worker-task:*"', '/${local.prod_prefix}-service"', '${local.prod_prefix}-queue"', '${local.prod_prefix}-dlq"', '${local.prod_prefix}-db"', '{{STATE_BUCKET}}/*"']) {
            expect(tf).not.toContain(gone);
        }
    });
});
