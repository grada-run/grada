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

    it('iac-validation scaffold dirs fit the 26-char confinement bound', async () => {
        const { load } = await import('js-yaml');
        const { MAX_CONFINED_PROJECT_LENGTH } = await import('../src/utils/resolvers.js');
        const doc = load(readRepo('.github/workflows/iac-validation.yml'));
        const over = [];
        for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
            const matrix = job?.strategy?.matrix ?? {};
            const values = {};
            for (const [key, list] of Object.entries(matrix)) {
                if (key === 'include') continue;
                values[key] = Array.isArray(list) ? list.map(String) : [String(list)];
            }
            if (Array.isArray(matrix.include)) {
                for (const entry of matrix.include) {
                    for (const [key, value] of Object.entries(entry ?? {})) {
                        if (typeof value === 'string' && !value.includes('\n')) {
                            (values[key] ??= []).push(value);
                        }
                    }
                }
            }
            for (const step of job.steps ?? []) {
                const run = typeof step?.run === 'string' ? step.run : '';
                for (const match of run.matchAll(/APP_DIR="\$TMPROOT\/([^"]+)"/g)) {
                    const pattern = match[1];
                    let expanded = [pattern];
                    for (const [, key] of pattern.matchAll(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g)) {
                        const options = values[key] ?? [];
                        expanded = expanded.flatMap((text) => options.map((v) => text.replace(new RegExp(`\\$\\{\\{\\s*matrix\\.${key}\\s*\\}\\}`), v)));
                    }
                    for (const dir of expanded) {
                        if (dir.length > MAX_CONFINED_PROJECT_LENGTH) over.push(`${jobName}: ${dir} (${dir.length})`);
                    }
                }
            }
        }
        expect(over, `scaffold dirs past the bound:\n${over.join('\n')}`).toEqual([]);
    });
});

describe('Preview guardrails are self-protecting', () => {
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
        // Exact-2 collapse (quota economy): the only rds verbs matching
        // DeleteDB*Snapshot are the two deletes.
        expect(guardrails).toContain('rds:DeleteDB*Snapshot');
        expect(guardrails).not.toContain('rds:DeleteDBSnapshot');
        expect(guardrails).not.toContain('rds:DeleteDBClusterSnapshot');
        expect(guardrails).toContain('secretsmanager:DeleteSecret');
        expect(guardrails).toContain('logs:DeleteLogGroup');
        // Resource lists live in the shared locals both twins consume.
        // Snapshot entries are middle-wildcards (automated `rds:` names).
        for (const arn of [
            'snapshot:*${local.prod_prefix}-db*',
            'cluster-snapshot:*${local.prod_prefix}-db-cluster*',
            'secret:${local.prod_prefix}-secrets-*',
            'log-group:/ecs/${local.prod_prefix}',
        ]) {
            expect(tf).toContain(arn);
        }
    });
});

describe('Preview permissions boundary', () => {
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
        // PassRole is carved out of the IAM veto; the veto itself is
        // an explicit IAM-write list — never NotAction, which would deny
        // every service (see the carve-out assertions below).
        const chunk = sidChunk(boundary, 'BoundaryDenyIAM');
        expect(chunk).not.toContain('NotAction');
        // Exact-2 collapse (quota economy): these are the only IAM verbs
        // matching *PermissionsBoundary — no List*/Get* form exists.
        expect(chunk).toContain('iam:*PermissionsBoundary');
        expect(chunk).not.toContain('iam:PutRolePermissionsBoundary');
        expect(chunk).not.toContain('iam:DeleteRolePermissionsBoundary');
    });

    it('caps backdoor roles at the task data-plane (deny-list mirror)', () => {
        const { boundary } = twinSlices();
        // Base allow with guardrail-mirroring denies: default-allow so a
        // missing entry weakens security instead of breaking prod tasks.
        expect(boundary).toContain('BoundaryBaseAllow');
        for (const action of ['cloudtrail:*', 'organizations:*', 'ec2:RunInstances', 'rds:DeleteDBInstance', 's3:DeleteBucket', 'dynamodb:Delete*', 'sqs:DeleteQueue', 'ecs:Delete*', 'ecr:BatchDeleteImage', 'secretsmanager:DeleteSecret', 'logs:DeleteLogGroup']) {
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

describe('Permissions boundary PassRole carve-out', () => {
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

describe('Preview task-role confinement', () => {
    it('denies prod task execution on anchored ARNs (guardrail side)', () => {
        const { tf, guardrails } = twinSlices();
        const chunk = sidChunk(guardrails, 'DenyProdTaskExecution');
        for (const action of ['ecs:RunTask', 'ecs:StopTask', 'ecs:ExecuteCommand', 'ecs:CreateService']) {
            expect(chunk).toContain(action);
        }
        // Shutdown verbs merged in (quota economy): Update/DeleteService
        // and DeleteCluster share the cluster+service resources already
        // listed here, so a separate statement would re-inline ~280
        // chars of ARNs for nothing. The scheduler carve-out is a
        // no-op for these verbs (the scheduler role can never call
        // them), so the merge changes no effective permission.
        expect(chunk).toContain('ecs:UpdateService');
        // DeleteService + DeleteCluster fold into ecs:Delete* — which
        // also matches DeleteTaskDefinitions on this statement's
        // task-definition ARNs, closing a gap (deregisters stay in the
        // Registration statement, untouched).
        expect(chunk).toContain('ecs:Delete*');
        expect(chunk).not.toContain('ecs:DeleteService');
        expect(chunk).not.toContain('ecs:DeleteCluster');
        expect(sidChunk(guardrails, 'DenyProdECSShutdown')).toBe('');
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
        const registration = sidChunk(guardrails, 'DenyProdTaskDefRegistration');
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

    it('mirrors the new statements into the boundary (PassRole via the trio)', () => {
        const { boundary } = twinSlices();
        for (const sid of ['BoundaryDenyTaskExecution', 'BoundaryDenyTaskDefRegistration', 'BoundaryDenyAppRoleMutation']) {
            expect(sidChunk(boundary, sid), `${sid} missing`).not.toBe('');
        }
        expect(sidChunk(boundary, 'BoundaryDenyECSShutdown')).toBe('');
        // No flat pass-role twin (see the scheduler repair suite): the
        // OffService/OffTarget/OffScheduler trio gates it instead.
        expect(sidChunk(boundary, 'BoundaryDenyPassRole')).toBe('');
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
        // Exact enumeration: 16 identical + 1 asymmetric + 4 no-twin by
        // design + 1 trio-subsumed. A new Sid without a twin fails here.
        // (Shutdown merged into TaskExecution and snapshot sharing into
        // ComputeAbuse for quota; Table/Snapshot Deletion renamed to
        // Table/SnapshotData when data verbs joined.)
        const identicalTwins = [
            'DenyComputeAbuse',
            'DenyProdStateDestruction',
            'DenyProdImageDeletion',
            'DenyProdLambdaRewrite',
            'DenyProdQueueDestruction',
            'DenyProdDatabaseDestruction',
            'DenyProdAuroraDestruction',
            'DenyProdTableData',
            'DenyProdSnapshotData',
            'DenyProdSecretsDeletion',
            'DenyProdLogDeletion',
            'DenyProdTaskExecution',
            'DenyProdTaskDefRegistration',
            'DenyProdAppRoleMutation',
            'DenyProdAppData',
            'DenyProdDbLifecycle',
        ];
        const asymmetricTwin = new Map([['DenyIAMBackdoors', 'BoundaryDenyIAM']]);
        const noTwinByDesign = new Set(['DenyCIRoleMutation', 'DenyRoleWithoutBoundary', 'DenyBoundarySwap', 'DenyBoundaryMutation']);
        // DenyProdPassRole has no flat boundary twin: the unconditional
        // twin denied the scheduler's own PassRole, so the boundary
        // gates PassRole via the OffService/OffTarget/OffScheduler trio
        // instead (see the scheduler repair suite).
        const trioSubsumed = new Set(['DenyProdPassRole']);
        expect([...guardrailStmts.keys()].sort()).toEqual([...identicalTwins, ...asymmetricTwin.keys(), ...noTwinByDesign, ...trioSubsumed].sort());
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

describe('Preview data-plane confinement', () => {
    // Service-scoped wildcards (quota-driven): each still only matches
    // its own service, and none match the Describe/List reads plan
    // refresh relies on. GetSecretValue is deliberately absent (plan
    // refresh reads the version resource via GetSecretValue —
    // provider-verified) as is DeleteMessage (needs a Receive handle,
    // unreachable with Receive denied).
    const APP_DATA_VERBS = [
        'secretsmanager:Put*',
        'secretsmanager:Update*',
        'sqs:Send*',
        'sqs:Receive*',
        // Move-task shuffles DLQ traffic without sending or receiving,
        // so the wildcards above miss it; unreachable from grada-driven
        // preview paths today (redrive runs on user credentials), but
        // the twin means queue traffic, and this is queue traffic.
        'sqs:StartMessageMoveTask',
    ];

    it('denies prod app-data verbs with a task-role carve-out (both twins)', () => {
        const { tf, guardrails, boundary } = twinSlices();
        for (const [label, chunk] of [['guardrail', sidChunk(guardrails, 'DenyProdAppData')], ['boundary', sidChunk(boundary, 'BoundaryDenyAppData')]]) {
            expect(chunk, `${label} statement missing`).not.toBe('');
            for (const action of APP_DATA_VERBS) {
                expect(chunk, `${label} missing ${action}`).toContain(action);
            }
            expect(chunk, label).toContain('local.guardrail_app_data_resources');
            // Workers keep working: the carve-out exempts the exact task
            // role ARN (mirrored on the guardrail side as a no-op — the
            // preview role is never a task role — so twins stay identical).
            // Singular on purpose: execution resolves taskdef secrets via
            // GetSecretValue, which no statement here denies.
            expect(chunk, label).toContain('StringNotEquals');
            expect(chunk, label).toContain('aws:PrincipalArn');
            expect(chunk, label).toContain('local.guardrail_task_role_principals');
            // Reads stay for plan refresh (describes are legitimate
            // traffic) — the accepted state-read residual.
            expect(chunk, `${label} must not deny state reads`).not.toContain('s3:GetObject');
        }
        const local = tf.slice(tf.indexOf('guardrail_app_data_resources'), tf.indexOf(']', tf.indexOf('guardrail_app_data_resources')));
        for (const arn of [
            'secret:${local.prod_prefix}-secrets-*',
            'arn:aws:sqs:',
        ]) {
            expect(local, `missing ${arn}`).toContain(arn);
        }
        // Suffix-anchored on purpose: hashed queue names keep their
        // -queue/-dlq tails, so prefix anchoring would miss them while
        // suffixes catch plain + hashed alike. Preview queues match
        // too — safe, because the preview role never sends/receives
        // (proven below) and tasks stay carved out.
        expect(local).toContain(':*-queue');
        expect(local).toContain(':*-dlq');
        expect(local).not.toContain('${local.prod_prefix}-*');
        expect(local).not.toContain('pr-');
        // Exact ARN only: a wildcard carve-out would let a backdoor role
        // match by name (CreateRole sets its own trust inline); a second
        // principal would cost quota headroom for zero proven need.
        const principals = tf.slice(tf.indexOf('guardrail_task_role_principals'), tf.indexOf(']', tf.indexOf('guardrail_task_role_principals')));
        expect(principals).toContain('-task-role"');
        expect(principals).not.toContain('-execution-role"');
        expect(principals, 'carve-out must use exact ARNs, never wildcards').not.toContain('*');
    });

    it('carve-out task formula tracks the rendered task role name', () => {
        const { tf } = twinSlices();
        const main = readRepo('templates/terraform/main.tf');
        const carve = tf.slice(tf.indexOf('guardrail_task_role_principals'));
        const rendered = main.slice(main.indexOf('task_role_safe_name'));
        // Same condition, stem arithmetic, and md5 slice modulo the base
        // var (prod-stable carve vs workspace-aware name) — a stale carve
        // would silently uncarve workers on over-cap trees.
        const condPattern = /length\("([^"]+)"\) > (\d+)/;
        const stemPattern = /substr\([^,]+,\s*0,\s*([\d\s\-+]+)\)/;
        const hashPattern = /md5\(([^)]+)\)/;
        for (const pattern of [condPattern, stemPattern, hashPattern]) {
            const a = carve.match(pattern);
            const b = rendered.match(pattern);
            expect(a, `carve ${pattern}`).not.toBeNull();
            expect(b, `rendered ${pattern}`).not.toBeNull();
            expect(a[1].replaceAll('prod_prefix', 'app_name')).toBe(b[1]);
            if (a[2] !== undefined) expect(a[2], `${pattern} cap`).toBe(b[2]);
        }
        // Both sides strip ALL hyphen-cut stems (anchored-regex
        // replace mirrors JS `.replace(/-+$/, '')`); a trim on one
        // side only would uncarve hyphen-cut workers.
        for (const [label, text] of [['carve', carve], ['rendered', rendered]]) {
            expect(text, label).toContain('replace(substr(');
            expect(text, label).toContain('"/-+$/", ""');
            expect(text, label).not.toContain('trimsuffix(substr(');
        }
    });

    it('denies prod DB lifecycle verbs with no carve-out (both twins)', () => {
        const { tf, guardrails, boundary } = twinSlices();
        for (const [label, chunk] of [['guardrail', sidChunk(guardrails, 'DenyProdDbLifecycle')], ['boundary', sidChunk(boundary, 'BoundaryDenyDbLifecycle')]]) {
            expect(chunk, `${label} statement missing`).not.toBe('');
            expect(chunk, label).toContain('rds:Stop*');
            expect(chunk, label).toContain('rds:Reboot*');
            // Start is the symmetric half (a stopped prod database must
            // not be startable from PR runs either); Restore* covers
            // point-in-time restores, which authorize the source db /
            // cluster (AWS service authorization reference).
            expect(chunk, label).toContain('rds:Start*');
            expect(chunk, label).toContain('rds:Restore*');
            expect(chunk, label).toContain('local.guardrail_db_lifecycle_resources');
            // Deliberately carve-free: no bounded role ever stops,
            // starts, reboots, or restores a database (sleep/wake and
            // db commands run on user credentials) — and one fewer
            // condition keeps the boundary under quota.
            expect(chunk, `${label} must stay carve-free`).not.toContain('aws:PrincipalArn');
        }
        const local = tf.slice(tf.indexOf('guardrail_db_lifecycle_resources'), tf.indexOf(']', tf.indexOf('guardrail_db_lifecycle_resources')));
        // Suffix-anchored like the queues: hashed identifiers keep
        // their tails. Preview DBs match too — safe, because no
        // preview workflow stops/starts/reboots/restores (proven
        // below) and Terraform's Modify calls live in the anchored
        // destruction statements, not here.
        expect(local).toContain('db:*-db*');
        expect(local).toContain('cluster:*-db-cluster');
        expect(local).not.toContain('${local.prod_prefix}-db');
        expect(local).not.toContain('pr-');
    });
});

describe('Suffix-loosened denies stay safe for preview traffic', () => {
    function readWorkflow(name) {
        return fs.readFileSync(path.join(process.cwd(), 'templates', 'github', name), 'utf-8');
    }

    it('no preview workflow sends/receives SQS (AppData loosening is safe)', () => {
        for (const file of ['preview.yml', 'preview-lambda.yml', 'teardown.yml', 'plan.yml', 'drift.yml']) {
            const content = readWorkflow(file);
            for (const verb of ['send-message', 'receive-message', 'SendMessage', 'ReceiveMessage', 'sqs:']) {
                expect(content, `${file} calls ${verb}`).not.toContain(verb);
            }
        }
    });

    it('no preview workflow stops/starts/reboots/restores RDS (lifecycle loosening is safe)', () => {
        for (const file of ['preview.yml', 'preview-lambda.yml', 'teardown.yml', 'plan.yml']) {
            const content = readWorkflow(file);
            for (const verb of ['stop-db-', 'start-db-', 'reboot-db-', 'restore-db-', 'StopDB', 'StartDB', 'RebootDB', 'RestoreDB']) {
                expect(content, `${file} calls ${verb}`).not.toContain(verb);
            }
        }
    });

    // IAM wildcard evaluation over the rendered deny patterns: prefix
    // anchoring misses hashed names, so every loosened pattern must
    // HIT prod-plain, prod-hashed, AND preview (intended over-deny),
    // while anchored statements keep HIT-ing plain and MISS-ing
    // preview. A pattern that misses plain prod fails closed here.
    function iamMatches(pattern, arn) {
        const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        return regex.test(arn);
    }

    function renderPattern(raw, prodPrefix) {
        return raw
            .split('${data.aws_region.current.name}').join('us-east-2')
            .split('${data.aws_caller_identity.current.account_id}').join('710596603276')
            .split('${local.prod_prefix}').join(prodPrefix);
    }

    it('deny patterns HIT prod names and MISS preview names per statement contract', async () => {
        const { safeSuffixedName } = await import('../src/utils/resolvers.js');
        const { tf } = twinSlices();
        const prod = 'myapp-a1b2c3';
        const longBase = 'a-very-long-project-name-that-definitely-blows-every-cap-wide-open-here';
        const hashedQueue = safeSuffixedName(longBase, '-queue', 80);
        const hashedDb = safeSuffixedName(longBase, '-db', 63);
        const arn = (service, resource) => `arn:aws:${service}:us-east-2:710596603276:${resource}`;
        const localList = (name) => {
            const start = tf.indexOf(`${name} = [`) + `${name} = [`.length;
            const end = tf.indexOf(']', start);
            return tf.slice(start, end).split('\n').map((line) => line.trim().replace(/^"|",?$/g, '').replace(/"$/, '')).filter((line) => line.startsWith('arn:')).map((entry) => renderPattern(entry, prod));
        };
        const hits = (local, resource) => localList(local).some((pattern) => iamMatches(pattern, resource));
        // Loosened statements: plain, hashed, and preview all HIT.
        expect(hits('guardrail_app_data_resources', arn('sqs', `${prod}-queue`))).toBe(true);
        expect(hits('guardrail_app_data_resources', arn('sqs', hashedQueue))).toBe(true);
        expect(hits('guardrail_app_data_resources', arn('sqs', 'myapp-pr-12-a1b2c3-queue'))).toBe(true);
        expect(hits('guardrail_db_lifecycle_resources', arn('rds', `db:${prod}-db`))).toBe(true);
        expect(hits('guardrail_db_lifecycle_resources', arn('rds', `db:${hashedDb}`))).toBe(true);
        expect(hits('guardrail_db_lifecycle_resources', arn('rds', 'db:myapp-pr-12-a1b2c3-db'))).toBe(true);
        // Anchored statements: plain HITs, preview MISSES (teardown/terraform).
        expect(hits('guardrail_queue_destruction_resources', arn('sqs', `${prod}-queue`))).toBe(true);
        expect(hits('guardrail_queue_destruction_resources', arn('sqs', 'myapp-pr-12-a1b2c3-queue'))).toBe(false);
        expect(hits('guardrail_database_destruction_resources', arn('rds', `db:${prod}-db`))).toBe(true);
        expect(hits('guardrail_database_destruction_resources', arn('rds', `db:myapp-pr-12-a1b2c3-db`))).toBe(false);
        expect(hits('guardrail_lambda_rewrite_resources', arn('lambda', `function:${prod}-fn`))).toBe(true);
        expect(hits('guardrail_lambda_rewrite_resources', arn('lambda', 'function:myapp-pr-12-a1b2c3-fn'))).toBe(false);
        // Snapshots: manual + `rds:`-prefixed automated HIT, preview MISSES.
        expect(hits('guardrail_snapshot_data_resources', arn('rds', `snapshot:${prod}-db-pre-deploy-abc1234`))).toBe(true);
        expect(hits('guardrail_snapshot_data_resources', arn('rds', `snapshot:rds:${prod}-db-2026-11-23-03-44`))).toBe(true);
        expect(hits('guardrail_snapshot_data_resources', arn('rds', `cluster-snapshot:rds:${prod}-db-cluster-2026-11-23-03-44`))).toBe(true);
        expect(hits('guardrail_snapshot_data_resources', arn('rds', 'snapshot:myapp-pr-12-a1b2c3-db-pre-deploy-abc1234'))).toBe(false);
        expect(hits('guardrail_snapshot_data_resources', arn('rds', 'snapshot:rds:myapp-pr-12-a1b2c3-db-2026-11-23-03-44'))).toBe(false);
        expect(hits('guardrail_snapshot_data_resources', arn('rds', 'snapshot:pre-deploy-abc1234'))).toBe(true);
        // Table backups: prod HITs (restore/delete authorize the backup
        // ARN, not the table), preview MISSES.
        expect(hits('guardrail_table_data_resources', arn('dynamodb', `table/${prod}-table`))).toBe(true);
        expect(hits('guardrail_table_data_resources', arn('dynamodb', `table/${prod}-table/backup/01680822138000-abcdef12`))).toBe(true);
        expect(hits('guardrail_table_data_resources', arn('dynamodb', 'table/myapp-pr-12-a1b2c3-table'))).toBe(false);
        expect(hits('guardrail_table_data_resources', arn('dynamodb', 'table/myapp-pr-12-a1b2c3-table/backup/01680822138000-abcdef12'))).toBe(false);
    });
});

describe('Scheduler survives the boundary', () => {
    it('gates boundary PassRole via the Off* trio instead of a flat twin', () => {
        // The flat BoundaryDenyPassRole twin denied the scheduler's own
        // PassRole unconditionally, defeating the OffScheduler carve-out
        // (any Deny wins) — so the trio gates alone now.
        const { boundary } = twinSlices();
        expect(sidChunk(boundary, 'BoundaryDenyPassRole')).toBe('');
        for (const sid of ['BoundaryDenyPassRoleOffService', 'BoundaryDenyPassRoleOffTarget', 'BoundaryDenyProdPassRoleOffScheduler']) {
            expect(sidChunk(boundary, sid), `${sid} missing`).not.toBe('');
        }
    });

    it('exempts the scheduler principal from both RunTask twins', () => {
        // The bounded scheduler role must RunTask its task definition at
        // trigger time; every other capped caller stays denied. The
        // guardrail twin carries the same condition (a no-op there — the
        // preview role is never the scheduler, which can only be assumed
        // by the scheduler service) so the twins stay identical.
        const { guardrails, boundary } = twinSlices();
        for (const [label, chunk] of [['guardrail', sidChunk(guardrails, 'DenyProdTaskExecution')], ['boundary', sidChunk(boundary, 'BoundaryDenyTaskExecution')]]) {
            expect(chunk, label).toContain('StringNotEquals');
            expect(chunk, label).toContain('aws:PrincipalArn');
            expect(chunk, label).toContain('role/${local.prod_prefix}-cron-scheduler-role');
        }
    });
});

describe('Snapshot guardrails cover pre-deploy names', () => {
    it('denies legacy bare pre-deploy snapshot deletion on both twins', () => {
        const { tf, guardrails, boundary } = twinSlices();
        expect(sidChunk(guardrails, 'DenyProdSnapshotData')).toContain('local.guardrail_snapshot_data_resources');
        expect(sidChunk(boundary, 'BoundaryDenySnapshotData')).toContain('local.guardrail_snapshot_data_resources');
        const local = tf.slice(tf.indexOf('guardrail_snapshot_data_resources'));
        // Middle-wildcard on purpose: automated snapshots carry an
        // `rds:` name prefix, so prefix anchoring would miss them while
        // the infix catches manual + automated alike. Preview names
        // carry `-pr-<n>-` where prod carries the bare id, so the
        // infix can never match them (pinned by the matrix test).
        expect(local).toContain('snapshot:*${local.prod_prefix}-db*');
        expect(local).toContain('cluster-snapshot:*${local.prod_prefix}-db-cluster*');
        expect(local).toContain('snapshot:pre-deploy-*');
        expect(local).toContain('cluster-snapshot:pre-deploy-*');
    });

    it('denies snapshot copy/restore/export on both twins (no exfil path)', () => {
        const { guardrails, boundary } = twinSlices();
        for (const [label, chunk] of [['guardrail', sidChunk(guardrails, 'DenyProdSnapshotData')], ['boundary', sidChunk(boundary, 'BoundaryDenySnapshotData')]]) {
            expect(chunk, `${label} statement missing`).not.toBe('');
            expect(chunk, label).toContain('rds:DeleteDB*Snapshot');
            expect(chunk, label).not.toContain('rds:DeleteDBSnapshot');
            expect(chunk, label).not.toContain('rds:DeleteDBClusterSnapshot');
            // Exfil half: copies and snapshot-based restores authorize
            // the source snapshot, exports authorize it too (AWS service
            // authorization reference) — denying here closes the
            // copy-then-read and export-to-S3 paths.
            expect(chunk, label).toContain('rds:Copy*');
            expect(chunk, label).toContain('rds:Restore*');
            expect(chunk, label).toContain('rds:StartExportTask');
            expect(chunk, `${label} must stay carve-free`).not.toContain('aws:PrincipalArn');
        }
    });

    it('denies snapshot sharing for instance and cluster snapshots (both twins)', () => {
        const { guardrails, boundary } = twinSlices();
        // Merged into ComputeAbuse for quota (one shared envelope);
        // both verbs must survive on both twins.
        for (const [label, chunk] of [['guardrail', sidChunk(guardrails, 'DenyComputeAbuse')], ['boundary', sidChunk(boundary, 'BoundaryDenyComputeAbuse')]]) {
            expect(chunk, `${label} statement missing`).not.toBe('');
            expect(chunk, label).toContain('ec2:RunInstances');
            // One wildcard covers ModifyDBSnapshotAttribute and
            // ModifyDBClusterSnapshotAttribute (the only two verbs that
            // match) — the cluster form was previously uncovered.
            expect(chunk, label).toContain('rds:Modify*SnapshotAttribute');
        }
    });
});

describe('Table guardrails deny item data, not just the table', () => {
    // Wildcard set covering all 13 DynamoDB data-plane verbs while
    // leaving Describe*/List* (plan refresh) and control verbs alone:
    // Batch* (3), *Item (4), Query, Scan, Execute* (2), Transact* (2).
    const TABLE_DATA_VERBS = [
        'dynamodb:Batch*',
        'dynamodb:*Item',
        'dynamodb:Query',
        'dynamodb:Scan',
        'dynamodb:Execute*',
        'dynamodb:Transact*',
    ];

    // PITR/backup verbs: export and point-in-time restore authorize
    // the table; backup create/delete/restore-from authorize the
    // backup ARN (separate entry below). UpdateTable closes
    // PITR-disablement (safety-feature destruction). DeleteBackup is
    // covered by Delete* and stays out for quota economy.
    const TABLE_BACKUP_VERBS = [
        'dynamodb:Export*',
        'dynamodb:Restore*',
        'dynamodb:CreateBackup',
        'dynamodb:UpdateTable',
    ];

    it('denies prod table item reads and writes with no carve-out (both twins)', () => {
        const { tf, guardrails, boundary } = twinSlices();
        for (const [label, chunk] of [['guardrail', sidChunk(guardrails, 'DenyProdTableData')], ['boundary', sidChunk(boundary, 'BoundaryDenyTableData')]]) {
            expect(chunk, `${label} statement missing`).not.toBe('');
            // DeleteTable/DeleteBackup fold into Delete* (exact
            // here: DeleteItem was already denied via *Item).
            expect(chunk, label).toContain('dynamodb:Delete*');
            expect(chunk, label).not.toContain('dynamodb:DeleteTable');
            expect(chunk, label).not.toContain('dynamodb:DeleteBackup');
            for (const action of [...TABLE_DATA_VERBS, ...TABLE_BACKUP_VERBS]) {
                expect(chunk, `${label} missing ${action}`).toContain(action);
            }
            expect(chunk, label).toContain('local.guardrail_table_data_resources');
            // Preview apps use preview tables (pr-* names never match
            // the prod pattern), so unlike the shared vault this needs
            // no task-role carve-out — and stays carve-free for quota.
            expect(chunk, `${label} must stay carve-free`).not.toContain('aws:PrincipalArn');
            // Plan refresh describes table config; item verbs never
            // match describes, and none may be added here.
            expect(chunk, `${label} must not deny describes`).not.toContain('Describe');
        }
        const local = tf.slice(tf.indexOf('guardrail_table_data_resources'), tf.indexOf(']', tf.indexOf('guardrail_table_data_resources')));
        expect(local).toContain('table/${local.prod_prefix}-table');
        expect(local).toContain('table/${local.prod_prefix}-table/backup/*');
        expect(local).not.toContain('pr-');
    });
});

// Renders the preview_boundary managed policy for a worst-case prod prefix
// and returns its AWS-counted size (compact JSON, no whitespace): the
// Statement array only, locals inlined, interpolations substituted — what
// Terraform's jsonencode ships. Guards the 6144-char managed-policy quota
// that broke tier1 E2E at a 24-char prefix.
function boundaryPolicySize(prodPrefix, region = 'us-east-2') {
    const tf = readRepo('templates/terraform/oidc.tf');
    const project = prodPrefix.replace(/-[a-f0-9]{6}$/, '');
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
    // Length conditionals (task-role carve-out): both test prefixes take
    // the plain branch — evaluate the literal form Terraform would. The
    // over branch nests quoted strings (the strip-all replace's
    // "/-+$/", ""), so the pattern allows quoted spans inside it.
    slice = slice.replace(/length\("([^"]*)"\)\s*>\s*(\d+)\s*\?\s*"((?:[^"]|"[^"]*")*)"\s*:\s*"([^"]*)"/g, (_, text, cap, over, under) =>
        JSON.stringify(text.length > Number(cap) ? over : under));
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
        for (const action of ['iam:CreateRole', 'iam:DeleteRole', 'iam:UpdateAssumeRolePolicy', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:*PermissionsBoundary', 'iam:CreatePolicy', 'iam:DeletePolicy', 'iam:*PolicyVersion', 'iam:CreateUser', 'iam:DeleteUser', 'iam:CreateAccessKey', 'iam:DeleteAccessKey']) {
            expect(chunk).toContain(action);
        }
        // *PolicyVersion additionally matches ListPolicyVersions: safe,
        // because no bounded role ever lists policy versions (preview
        // Terraform runs as the preview role, not under the boundary).
        expect(chunk).not.toContain('iam:CreatePolicyVersion');
        expect(chunk).not.toContain('iam:DeletePolicyVersion');
        // PassRole stays carved out (re-gated on service + target below).
        expect(chunk).not.toContain('iam:PassRole');
    });
});

describe('Accepted guardrail residuals stay explicit', () => {
    it('leaves Bedrock/SES spend undenied by decision, not by omission', () => {
        const { guardrails, boundary } = twinSlices();
        // Denying preview spend would gut preview fidelity for AI/email
        // apps (previews are full copies); same-repo guard + PR review
        // are the controls. Pinned so a future edit either keeps the
        // residual deliberate or closes it knowingly.
        for (const [label, slice] of [['guardrail', guardrails], ['boundary', boundary]]) {
            for (const action of (slice.match(/"([a-z0-9-]+:[^"]+)"/g) || [])) {
                expect(action, `${label} spend deny`).not.toMatch(/"(bedrock|ses):/);
            }
        }
        expect(guardrails).toContain('Accepted residual');
    });
});

describe('Boundary policy fits the 6144-char managed-policy quota (tier1 E2E)', () => {
    it('renders under quota for a 24-char prod prefix (tier1-live shape)', () => {
        expect(boundaryPolicySize('tier1-live-p64qpk-c5228d')).toBeLessThan(6144);
    });

    it('renders under quota for a 32-char prod prefix', () => {
        expect(boundaryPolicySize('abcdefghijklmnopqrstuvwxyz123456')).toBeLessThan(6144);
    });

    it('renders under quota in long-region names (ap-southeast-2, 24-char project)', () => {
        // Region length counts per interpolated ARN: ap-southeast-2 adds
        // 5 chars over us-east-2 on every regional ARN, which pushed an
        // in-bound 24-char project (31-char prod prefix with the resource
        // suffix) over quota on first apply.
        expect(boundaryPolicySize('abcdefghijklmnopqrstuvwx-a1b2c3', 'ap-southeast-2')).toBeLessThan(6144);
    });

    it('renders under quota for suffixless pre-suffix trees (31-char, ap-southeast-2)', () => {
        // Pre-suffix trees stay suffixless forever (resolveInitSuffix
        // never mints for them), so a 31-char project there is a
        // 31-char prefix — no resource suffix to blame. This window
        // fit on 0.50.1 and overflowed after the boundary growth.
        expect(boundaryPolicySize('abcdefghijklmnopqrstuvwx1234567', 'ap-southeast-2')).toBeLessThan(6144);
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
