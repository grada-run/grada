import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackPromptsMockFactory, mockConfirm, mockSelect } from './helpers/clack.js';
import { telemetryMockFactory } from './helpers/telemetry.js';
import { createTmpDirTracker } from './helpers/tmpdir.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stripVTControlCharacters } from 'node:util';

vi.mock('@clack/prompts', () => clackPromptsMockFactory());

vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));

vi.mock('../src/utils/aws.js', () => ({
    handleAuthErrorBranch: () => false,
    handleAwsAuthError: vi.fn(),
    isAuthError: () => false,
    resolveClient: (injected) => injected,
    provisionStateBucket: vi.fn().mockResolvedValue({
        awsAccountId: '123456789012',
        stateBucketName: 'mock-tf-state-bucket',
    }),
}));

vi.mock('../src/utils/terraform.js', () => ({
    runTerraformCommand: vi.fn().mockResolvedValue(undefined),
    getTerraformOutputs: vi.fn().mockResolvedValue({}),
}));

// Keep the real parseTerraformConfig (pure file reads) but stub the
// interactive preview so apply tests stay headless.
vi.mock('../src/utils/visualizer.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        renderDryRunPreview: vi.fn().mockResolvedValue(true),
    };
});

import * as applyModule from '../src/commands/apply.js';
import * as backup from '../src/utils/backup.js';
import { runAdd } from '../src/commands/add.js';
import { ejectStack } from '../src/commands/eject.js';
import { runSleep, parseSleepArgs } from '../src/commands/sleep.js';
import { runWake, parseWakeArgs } from '../src/commands/wake.js';
import { runRollback } from '../src/commands/rollback.js';
import { resolveSleepTarget, readSleepState, writeSleepState } from '../src/utils/sleep-state.js';
import { writeEjectedMarker, readEjectedMarker } from '../src/utils/terraform-metadata.js';
import { parseTerraformConfig } from '../src/utils/visualizer.js';
import { runTerraformCommand } from '../src/utils/terraform.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';

const { applyStack } = applyModule;

const tmp = createTmpDirTracker();
const originalCwd = process.cwd();
let exitSpy;
let logSpy;
let errSpy;

function makeTmp() {
    return tmp.makeTmp('state-transitions-');
}

function output() {
    const calls = [...logSpy.mock.calls, ...errSpy.mock.calls];
    return calls.map((args) => stripVTControlCharacters(String(args[0]))).join('\n');
}

// ECS main.tf mirroring the real template shape: environment array plus the
// `secrets = concat(...)` block the DB wiring targets (main.tf:146).
function writeEcsMainTf(dir) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'terraform', 'main.tf'),
        [
            'locals {',
            '  app_name = "myapp${local.env_suffix}"',
            '}',
            '',
            'provider "aws" {',
            '  region = "us-east-2"',
            '}',
            '',
            'resource "aws_ecs_task_definition" "app" {',
            '  family = "myapp-task"',
            '  cpu = "256"',
            '  memory = "512"',
            '  container_definitions = jsonencode([',
            '    {',
            '      name      = "myapp-container"',
            '      essential = true',
            '',
            '      environment = [',
            '        { "name": "NODE_ENV", "value": "production" }',
            '      ]',
            '',
            '      secrets = concat(',
            '        [',
            '          for key in local.secret_keys : {',
            '            name      = key',
            '            valueFrom = "${local.secret_arn}:${key}::"',
            '          }',
            '        ],',
            '        [',
            '        ]',
            '      )',
            '    }',
            '  ])',
            '}',
            '',
        ].join('\n')
    );
}

function writeWorkerTf(dir) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'terraform', 'worker.tf'),
        [
            'resource "aws_ecs_task_definition" "worker" {',
            '  family = "myapp-worker-task"',
            '  container_definitions = jsonencode([',
            '    {',
            '      name      = "myapp-worker-container"',
            '      essential = true',
            '',
            '      environment = [',
            '        { "name": "NODE_ENV", "value": "production" }',
            '      ]',
            '',
            '      secrets = concat(',
            '        [',
            '          for key in local.secret_keys : {',
            '            name      = key',
            '            valueFrom = "${local.secret_arn}:${key}::"',
            '          }',
            '        ],',
            '        [',
            '        ]',
            '      )',
            '    }',
            '  ])',
            '}',
            '',
            'resource "aws_ecs_service" "worker" {',
            '  name            = "myapp-worker-service"',
            '  cluster         = aws_ecs_cluster.main.id',
            '  task_definition = aws_ecs_task_definition.worker.arn',
            '  desired_count   = 1',
            '}',
            '',
        ].join('\n')
    );
}

function writeStaticMainTf(dir) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'terraform', 'main.tf'),
        [
            'locals {',
            '  app_name = "myapp${local.env_suffix}"',
            '}',
            '',
            'resource "aws_cloudfront_distribution" "site" {',
            '  enabled = true',
            '}',
            '',
        ].join('\n')
    );
}

function writeLambdaMainTf(dir) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'terraform', 'main.tf'),
        [
            'locals {',
            '  app_name = "myapp${local.env_suffix}"',
            '}',
            '',
            'resource "aws_lambda_function" "app" {',
            '  function_name = "${local.app_name}-fn"',
            '  role          = aws_iam_role.lambda_exec.arn',
            '  package_type  = "Image"',
            '  image_uri     = "${aws_ecr_repository.app.repository_url}:latest"',
            '',
            '  environment {',
            '    variables = {',
            '      NODE_ENV = "production"',
            '    }',
            '  }',
            '}',
            '',
        ].join('\n')
    );
}

function writeBackendTf(dir) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'terraform', 'backend.tf'),
        [
            'terraform {',
            '  required_providers {',
            '    aws = {',
            '      source  = "hashicorp/aws"',
            '      version = "~> 5.0"',
            '    }',
            '    tls = {',
            '      source  = "hashicorp/tls"',
            '      version = "~> 4.0"',
            '    }',
            '  }',
            '}',
            '',
        ].join('\n')
    );
}

function writeInitTree(dir) {
    writeEcsMainTf(dir);
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:20\n');
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'name: deploy\n');
}

// Minimal ECS/RDS recorder (mirrors tests/sleep-wake.test.js): `ecs` maps
// service names to service objects, `db` feeds findDbTarget.
function mockSleepClients({ ecs = {}, db = null } = {}) {
    const ecsClient = {
        send: vi.fn(async (command) => {
            const name = command.constructor.name;
            if (name === 'DescribeServicesCommand') {
                const services = (command.input.services || [])
                    .map((serviceName) => ecs[serviceName] || null)
                    .filter(Boolean);
                return { services };
            }
            if (name === 'UpdateServiceCommand') {
                const service = ecs[command.input.service];
                if (service) service.desiredCount = command.input.desiredCount;
                return {};
            }
            throw new Error(`unexpected ECS command: ${name}`);
        }),
    };
    const rdsClient = {
        send: vi.fn(async (command) => {
            const name = command.constructor.name;
            if (name === 'DescribeDBInstancesCommand') {
                if (db?.instance) return { DBInstances: [db.instance] };
                throw Object.assign(new Error('not found'), { name: 'DBInstanceNotFound' });
            }
            if (name === 'DescribeDBClustersCommand') {
                if (db?.cluster) return { DBClusters: [db.cluster] };
                throw Object.assign(new Error('not found'), { name: 'DBClusterNotFoundFault' });
            }
            if (name === 'StopDBInstanceCommand' && db?.instance) {
                db.instance.Status = 'stopping';
                return {};
            }
            if (name === 'StopDBClusterCommand' && db?.cluster) {
                db.cluster.Status = 'stopping';
                return {};
            }
            if (name === 'StartDBInstanceCommand' && db?.instance) {
                db.instance.Status = 'starting';
                return {};
            }
            if (name === 'StartDBClusterCommand' && db?.cluster) {
                db.cluster.Status = 'starting';
                return {};
            }
            return {};
        }),
    };
    return { ecsClient, rdsClient };
}

function activeService(name, desiredCount) {
    return { serviceName: name, status: 'ACTIVE', desiredCount, runningCount: desiredCount };
}

function updateServiceCalls(ecsClient) {
    return ecsClient.send.mock.calls.filter(([command]) => command.constructor.name === 'UpdateServiceCommand');
}

beforeEach(() => {
    tmp.reset();
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    process.chdir(originalCwd);
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    tmp.cleanup();
});

describe('S1: apply while asleep', () => {
    function asleepFixture() {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeSleepState(dir, {
            default: {
                env: 'default',
                sleptAt: new Date().toISOString(),
                autoRestartAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
                services: { app: 1, worker: 0 },
                dbId: 'myapp-db',
                dbKind: 'instance',
            },
        });
        process.chdir(dir);
        return dir;
    }

    it('S1a: headless apply on an asleep env fails fast with zero terraform calls', async () => {
        asleepFixture();
        const result = await applyStack({ isHeadless: true });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('sleeping-environment');
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(runTerraformCommand).not.toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            error_code: 'SLEEPING_ENVIRONMENT',
        }));
        expect(flushTelemetry).toHaveBeenCalled();
        expect(output()).toContain('grada-run wake');
    });

    it('S1b: --force proceeds and records the override in telemetry', async () => {
        asleepFixture();
        const result = await applyStack({ isHeadless: true, force: true });
        expect(runTerraformCommand).toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith(
            'forced_apply_while_asleep',
            expect.objectContaining({ env: 'default' })
        );
        expect(result).toBeUndefined(); // success path exits 0
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('S1c: interactive apply offers wake-and-continue, then proceeds', async () => {
        asleepFixture();
        mockConfirm.mockResolvedValueOnce(true);
        const wakeImpl = vi.fn(async () => ({ ok: true }));
        await applyStack({ wakeImpl });
        expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('asleep'),
        }));
        expect(wakeImpl).toHaveBeenCalledWith(expect.objectContaining({ env: 'default' }));
        expect(runTerraformCommand).toHaveBeenCalled();
    });

    it('S1c: declining the wake aborts with zero terraform calls', async () => {
        asleepFixture();
        mockConfirm.mockResolvedValueOnce(false);
        const wakeImpl = vi.fn(async () => ({ ok: true }));
        const result = await applyStack({ wakeImpl });
        expect(result).toMatchObject({ ok: false, reason: 'cancelled' });
        expect(wakeImpl).not.toHaveBeenCalled();
        expect(runTerraformCommand).not.toHaveBeenCalled();
    });

    it('S1c: a failed wake aborts the apply with WAKE_FAILED', async () => {
        asleepFixture();
        mockConfirm.mockResolvedValueOnce(true);
        const wakeImpl = vi.fn(async () => ({ ok: false, reason: 'rds-wake-timeout' }));
        const result = await applyStack({ wakeImpl });
        expect(result).toMatchObject({ ok: false, reason: 'wake-failed', wakeReason: 'rds-wake-timeout' });
        expect(runTerraformCommand).not.toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            error_code: 'WAKE_FAILED',
        }));
    });

    it('parseApplyArgs parses --force', () => {
        expect(typeof applyModule.parseApplyArgs).toBe('function');
        expect(applyModule.parseApplyArgs(['apply', '--force'])).toMatchObject({ force: true });
        expect(applyModule.parseApplyArgs(['apply']).force).toBe(false);
    });
});

describe('S2: eject then add', () => {
    it('warns and renders a headerless addon file, keeping the tree vanilla', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        process.chdir(dir);
        await ejectStack({ yes: true });
        const result = await runAdd({ cwd: dir, capability: 'queue:sqs' });
        expect(result.ok).toBe(true);
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'sqs.tf'), 'utf-8');
        expect(rendered).not.toContain('# grada addon:');
        expect(rendered).not.toContain('Generated by');
        expect(rendered).toContain('# Billing:');
        expect(rendered).toContain('resource "aws_sqs_queue" "main"');
        expect(output()).toMatch(/eject/i);
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            projectName: 'myapp',
            capability: 'queue:sqs',
            success: true,
            ejected: true,
        });
    });

    it('eject records a marker readable by later commands', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        expect(readEjectedMarker(dir)).toBeNull();
        process.chdir(dir);
        await ejectStack({ yes: true });
        expect(readEjectedMarker(dir)).toMatchObject({ ejectedAt: expect.any(String) });
    });

    it('init re-run over an ejected project fails EJECTED_PROJECT headless, regenerates with --force', async () => {
        const dir = makeTmp();
        writeInitTree(dir);
        writeEjectedMarker(dir);
        const refused = await backup.handleExistingFiles(dir, true);
        expect(refused).toMatchObject({ ok: false, reason: 'ejected-project' });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            error_code: 'EJECTED_PROJECT',
        }));
        expect(fs.existsSync(path.join(dir, 'terraform'))).toBe(true);

        vi.clearAllMocks();
        await backup.handleExistingFiles(dir, true, { force: true });
        expect(fs.existsSync(path.join(dir, 'terraform'))).toBe(false);
    });

    it('init re-run over an ejected project confirms interactively', async () => {
        const dir = makeTmp();
        writeInitTree(dir);
        writeEjectedMarker(dir);
        mockConfirm.mockResolvedValueOnce(false);
        exitSpy.mockImplementationOnce(() => {
            const error = new Error('exit:0');
            error.exitCode = 0;
            throw error;
        });
        await expect(backup.handleExistingFiles(dir, false)).rejects.toMatchObject({ exitCode: 0 });
        expect(fs.existsSync(path.join(dir, 'terraform'))).toBe(true);

        vi.clearAllMocks();
        mockConfirm.mockResolvedValueOnce(true);
        mockSelect.mockResolvedValueOnce('backup');
        await backup.handleExistingFiles(dir, false);
        expect(fs.existsSync(path.join(dir, 'terraform'))).toBe(false);
    });
});

describe('S3: init re-run over hand edits', () => {
    it('manifest round-trip: clean tree reports no modifications, edited files are named', () => {
        const dir = makeTmp();
        writeInitTree(dir);
        backup.writeInitManifest(dir);
        expect(backup.detectModifiedTree(dir)).toEqual({ modified: [], missing: [] });
        fs.appendFileSync(path.join(dir, 'terraform', 'main.tf'), '\n# hand edit\n');
        expect(backup.detectModifiedTree(dir)).toEqual({
            modified: [path.join('terraform', 'main.tf')],
            missing: [],
        });
    });

    it('detectModifiedTree returns null for legacy projects without a manifest', () => {
        const dir = makeTmp();
        writeInitTree(dir);
        expect(backup.detectModifiedTree(dir)).toBeNull();
    });

    it('S3a: interactive re-run names modified files in the prompt', async () => {
        const dir = makeTmp();
        writeInitTree(dir);
        backup.writeInitManifest(dir);
        fs.appendFileSync(path.join(dir, 'terraform', 'main.tf'), '\n# hand edit\n');
        mockSelect.mockResolvedValueOnce('backup');
        await backup.handleExistingFiles(dir, false);
        expect(mockSelect).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('main.tf'),
        }));
        // Backup choice still regenerates (moves the tree aside).
        expect(fs.existsSync(path.join(dir, 'terraform'))).toBe(false);
    });

    it('S3a: cancelling leaves every file untouched', async () => {
        const dir = makeTmp();
        writeInitTree(dir);
        backup.writeInitManifest(dir);
        fs.appendFileSync(path.join(dir, 'Dockerfile'), '# hand edit\n');
        mockSelect.mockResolvedValueOnce('cancel');
        exitSpy.mockImplementationOnce(() => {
            const error = new Error('exit:0');
            error.exitCode = 0;
            throw error;
        });
        await expect(backup.handleExistingFiles(dir, false)).rejects.toMatchObject({ exitCode: 0 });
        expect(fs.existsSync(path.join(dir, 'terraform'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'Dockerfile'))).toBe(true);
        expect(fs.readdirSync(dir).some((entry) => entry.includes('.bak.'))).toBe(false);
    });

    it('S3b: headless re-run over modified files fails MODIFIED_TREE without touching them', async () => {
        const dir = makeTmp();
        writeInitTree(dir);
        backup.writeInitManifest(dir);
        fs.appendFileSync(path.join(dir, 'terraform', 'main.tf'), '\n# hand edit\n');
        const result = await backup.handleExistingFiles(dir, true);
        expect(result).toMatchObject({ ok: false, reason: 'modified-tree' });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            error_code: 'MODIFIED_TREE',
        }));
        expect(fs.existsSync(path.join(dir, 'terraform'))).toBe(true);
        expect(fs.readdirSync(dir).some((entry) => entry.includes('.bak.'))).toBe(false);
    });

    it('S3b: headless --force regenerates over modified files', async () => {
        const dir = makeTmp();
        writeInitTree(dir);
        backup.writeInitManifest(dir);
        fs.appendFileSync(path.join(dir, 'terraform', 'main.tf'), '\n# hand edit\n');
        await backup.handleExistingFiles(dir, true, { force: true });
        expect(fs.existsSync(path.join(dir, 'terraform'))).toBe(false);
        expect(fs.readdirSync(dir).some((entry) => entry.includes('.bak.'))).toBe(true);
    });

    it('S3c: legacy projects without a manifest keep auto-backup behavior', async () => {
        const dir = makeTmp();
        writeInitTree(dir);
        await backup.handleExistingFiles(dir, true);
        expect(fs.existsSync(path.join(dir, 'terraform'))).toBe(false);
        expect(fs.readdirSync(dir).some((entry) => entry.includes('.bak.'))).toBe(true);
    });

    it('S3c: manifest-clean re-run regenerates silently', async () => {
        const dir = makeTmp();
        writeInitTree(dir);
        backup.writeInitManifest(dir);
        await backup.handleExistingFiles(dir, true);
        expect(fs.existsSync(path.join(dir, 'terraform'))).toBe(false);
    });
});

describe('S4: wake idempotency', () => {
    function ecsWakeFixture() {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        const target = resolveSleepTarget({ projectName: 'myapp', region: 'us-east-2' }, dir);
        const ecs = {
            [target.appService]: activeService(target.appService, 0),
            [target.workerService]: activeService(target.workerService, 0),
        };
        const { ecsClient, rdsClient } = mockSleepClients({
            ecs,
            db: { instance: { Engine: 'postgres', Status: 'stopped' } },
        });
        const options = {
            cwd: dir,
            projectName: 'myapp',
            region: 'us-east-2',
            noWait: true,
            ecsClient,
            rdsClient,
        };
        return { dir, options, ecsClient, rdsClient };
    }

    it('sleep -> wake -> wake: the second wake is an already-awake no-op with zero AWS writes', async () => {
        const { dir, options, ecsClient } = ecsWakeFixture();
        writeSleepState(dir, {
            default: {
                env: 'default',
                sleptAt: new Date().toISOString(),
                autoRestartAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
                services: { app: 2, worker: 1 },
                dbId: 'myapp-db',
                dbKind: 'instance',
            },
        });
        const first = await runWake(options);
        expect(first.ok).toBe(true);
        expect(readSleepState(dir)).toEqual({});
        const afterFirst = updateServiceCalls(ecsClient).length;
        expect(afterFirst).toBe(2);

        const second = await runWake(options);
        expect(second.ok).toBe(true);
        expect(second.skipped).toBe('already-awake');
        expect(updateServiceCalls(ecsClient).length).toBe(afterFirst);
        expect(exitSpy).not.toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith('wake_run', expect.objectContaining({
            success: true,
            skipped: 'already-awake',
        }));
    });

    it('wake with a deleted ledger but asleep services still recovers via 1/1 defaults', async () => {
        const { options, ecsClient } = ecsWakeFixture();
        const result = await runWake(options);
        expect(result.ok).toBe(true);
        expect(result.skipped).toBeUndefined();
        const updates = updateServiceCalls(ecsClient);
        expect(updates.length).toBe(2);
        expect(updates.map(([command]) => command.input.desiredCount)).toEqual([1, 1]);
    });
});

describe('S5: rollback diagnostics', () => {
    const arn = (rev) => `arn:aws:ecs:us-east-2:123456789012:task-definition/myapp-task:${rev}`;

    function rollbackOptions(overrides = {}) {
        return {
            projectName: 'myapp',
            cluster: 'myapp-cluster',
            service: 'myapp-service',
            region: 'us-east-2',
            cwd: makeTmp(), // no terraform: target guard falls back to ecs
            pollIntervalMs: 1,
            timeoutMs: 50,
            isHeadless: true,
            ...overrides,
        };
    }

    function mockEcs(handler) {
        return { send: vi.fn((command) => handler(command)) };
    }

    it('S5a: single-revision rollback names the revision and the next action', async () => {
        const ecsClient = mockEcs((command) => {
            const name = command.constructor.name;
            if (name === 'DescribeServicesCommand') {
                return {
                    services: [{
                        serviceName: 'myapp-service',
                        status: 'ACTIVE',
                        taskDefinition: arn(3),
                        desiredCount: 1,
                        runningCount: 1,
                    }],
                };
            }
            if (name === 'ListTaskDefinitionsCommand') return { taskDefinitionArns: [arn(3)] };
            throw new Error(`unexpected ECS command: ${name}`);
        });
        const result = await runRollback(rollbackOptions({ ecsClient }));
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('no-prior-revisions');
        expect(output()).toContain('on revision 3');
        expect(output()).toContain('Deploy again');
        expect(trackEvent).toHaveBeenCalledWith('rollback_run', expect.objectContaining({
            error_code: 'NO_PRIOR_REVISIONS',
        }));
    });

    it('S5b: rollback before any apply directs to apply', async () => {
        const ecsClient = mockEcs((command) => {
            if (command.constructor.name === 'DescribeServicesCommand') return { services: [] };
            throw new Error(`unexpected ECS command: ${command.constructor.name}`);
        });
        const result = await runRollback(rollbackOptions({ ecsClient }));
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('service-not-found');
        expect(output()).toContain('grada-run apply');
        expect(trackEvent).toHaveBeenCalledWith('rollback_run', expect.objectContaining({
            error_code: 'SERVICE_NOT_FOUND',
        }));
    });
});

describe('S7: skip signaling', () => {
    it('S7a: static sleep exits 0 with a skipped reason', async () => {
        const dir = makeTmp();
        writeStaticMainTf(dir);
        const result = await runSleep({ cwd: dir, projectName: 'myapp', region: 'us-east-2' });
        expect(result).toMatchObject({ ok: true, skipped: 'static-target' });
        expect(exitSpy).not.toHaveBeenCalled();
        expect(output()).toContain('Nothing to do');
        expect(trackEvent).toHaveBeenCalledWith('sleep_run', expect.objectContaining({
            success: true,
            skipped: 'static-target',
        }));
    });

    it('S7a: static wake exits 0 with a skipped reason', async () => {
        const dir = makeTmp();
        writeStaticMainTf(dir);
        const result = await runWake({ cwd: dir, projectName: 'myapp', region: 'us-east-2' });
        expect(result).toMatchObject({ ok: true, skipped: 'static-target' });
        expect(exitSpy).not.toHaveBeenCalled();
        expect(output()).toContain('Nothing to do');
    });

    it('S7a: lambda without a database skips with lambda-no-database', async () => {
        const dir = makeTmp();
        writeLambdaMainTf(dir);
        const { rdsClient } = mockSleepClients({ db: null });
        const slept = await runSleep({
            cwd: dir, projectName: 'myapp', region: 'us-east-2', rdsClient,
        });
        expect(slept).toMatchObject({ ok: true, skipped: 'lambda-no-database' });
        const { rdsClient: rdsClient2 } = mockSleepClients({ db: null });
        const woken = await runWake({
            cwd: dir, projectName: 'myapp', region: 'us-east-2', rdsClient: rdsClient2,
        });
        expect(woken).toMatchObject({ ok: true, skipped: 'lambda-no-database' });
    });

    it('S7b: --strict turns skips into exit 2 with the reason preserved', async () => {
        const dir = makeTmp();
        writeStaticMainTf(dir);
        const slept = await runSleep({
            cwd: dir, projectName: 'myapp', region: 'us-east-2', strict: true,
        });
        expect(slept).toMatchObject({ ok: false, skipped: 'static-target' });
        expect(exitSpy).toHaveBeenCalledWith(2);
        expect(trackEvent).toHaveBeenCalledWith('sleep_run', expect.objectContaining({
            success: true,
            skipped: 'static-target',
        }));

        vi.clearAllMocks();
        const woken = await runWake({
            cwd: dir, projectName: 'myapp', region: 'us-east-2', strict: true,
        });
        expect(woken).toMatchObject({ ok: false, skipped: 'static-target' });
        expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('parseSleepArgs/parseWakeArgs parse --strict', () => {
        expect(parseSleepArgs(['sleep', '--strict'])).toMatchObject({ strict: true });
        expect(parseSleepArgs(['sleep']).strict).toBeUndefined();
        expect(parseWakeArgs(['wake', '--strict'])).toMatchObject({ strict: true });
        expect(parseWakeArgs(['wake']).strict).toBeUndefined();
    });
});

describe('S8: unknown db:* guidance', () => {
    it('names the valid relational capabilities', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'db:oracle' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('unsupported-capability');
        expect(output()).toContain('db:postgres');
        expect(output()).toContain('db:mysql');
        expect(output()).toContain('db:aurora-postgresql');
    });
});

describe('S9: add re-run gates', () => {
    it('S9a: queue:sqs twice still requires --force', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        const first = await runAdd({ cwd: dir, capability: 'queue:sqs' });
        expect(first.ok).toBe(true);
        const second = await runAdd({ cwd: dir, capability: 'queue:sqs' });
        expect(second).toMatchObject({ ok: false, reason: 'addon-already-exists' });
        expect(exitSpy).not.toHaveBeenCalled();
        const forced = await runAdd({ cwd: dir, capability: 'queue:sqs', force: true });
        expect(forced.ok).toBe(true);
    });

    it('S9b: bedrock model switch upserts without --force', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        await runAdd({ cwd: dir, capability: 'ai:bedrock', model: 'model.a-first', modelProvided: true });
        const switched = await runAdd({ cwd: dir, capability: 'ai:bedrock', model: 'model.b-second', modelProvided: true });
        expect(switched.ok).toBe(true);
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('model.b-second');
        expect(mainTf).not.toContain('model.a-first');
        expect(mainTf.match(/BEDROCK_MODEL_ID/g)).toHaveLength(1);
    });

    it('S9c: ses sender switch upserts without --force', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        await runAdd({
            cwd: dir, capability: 'email:ses', domain: 'example.com',
            fromEmail: 'a@example.com', region: 'us-east-2',
        });
        const rerun = await runAdd({
            cwd: dir, capability: 'email:ses', domain: 'example.com',
            fromEmail: 'b@example.com', region: 'us-east-2',
        });
        expect(rerun.ok).toBe(true);
        expect(output()).toContain('Updated terraform/ses.tf');
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('b@example.com');
        expect(mainTf).not.toContain('a@example.com');
        expect(mainTf.match(/SES_FROM_EMAIL/g)).toHaveLength(1);
    });
});

describe('S10: deploy alias', () => {
    it('bin/cli.js routes deploy to applyStack and documents it', () => {
        const content = fs.readFileSync(path.resolve(originalCwd, 'bin/cli.js'), 'utf8');
        expect(content).toContain("deploy: 'apply'");
        expect(content).toContain("dispatchCommand === 'apply'");
        expect(content).toContain('Alias of apply');
    });
});

describe('S11: post-init database', () => {
    it('S11a: add db:postgres wires RDS into an ECS project', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeWorkerTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'db:postgres' });
        expect(result.ok).toBe(true);
        const databaseTf = fs.readFileSync(path.join(dir, 'terraform', 'database.tf'), 'utf-8');
        expect(databaseTf).toContain('resource "aws_db_instance" "postgres"');
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('"DB_HOST"');
        expect(mainTf).toContain('aws_db_instance.postgres.address');
        expect(mainTf).toContain('"name": "DB_USER"');
        expect(mainTf).toContain('master_user_secret[0].secret_arn');
        const workerTf = fs.readFileSync(path.join(dir, 'terraform', 'worker.tf'), 'utf-8');
        expect(workerTf).toContain('"DB_HOST"');
        expect(workerTf).toContain('"name": "DB_USER"');
        expect(parseTerraformConfig(path.join(dir, 'terraform'))).toMatchObject({
            hasDb: true,
            dbEngine: 'postgres',
        });
        expect(trackEvent).toHaveBeenCalledWith('add_run', expect.objectContaining({
            capability: 'db:postgres',
            success: true,
        }));
    });

    it('S11b: add db:mysql renders the mysql template with DB_ENGINE', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'db:mysql' });
        expect(result.ok).toBe(true);
        const databaseTf = fs.readFileSync(path.join(dir, 'terraform', 'database.tf'), 'utf-8');
        expect(databaseTf).toContain('"mysql"');
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('"DB_ENGINE"');
        expect(mainTf).toContain('"3306"');
        expect(parseTerraformConfig(path.join(dir, 'terraform'))).toMatchObject({
            hasDb: true,
            dbEngine: 'mysql',
        });
    });

    it('S11c: add db:postgres on lambda converts, wires VPC, and uses a plain password var', async () => {
        const dir = makeTmp();
        writeLambdaMainTf(dir);
        writeBackendTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'db:postgres' });
        expect(result.ok).toBe(true);
        const databaseTf = fs.readFileSync(path.join(dir, 'terraform', 'database.tf'), 'utf-8');
        expect(databaseTf).toContain('random_password.db_password');
        const backendTf = fs.readFileSync(path.join(dir, 'terraform', 'backend.tf'), 'utf-8');
        expect(backendTf).toContain('hashicorp/random');
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('vpc_config {');
        expect(mainTf).toContain('security_group_ids');
        expect(mainTf).toContain('DB_PASSWORD = random_password.db_password.result');
    });

    it('S11d: static projects refuse add db:postgres', async () => {
        const dir = makeTmp();
        writeStaticMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'db:postgres' });
        expect(result.ok).toBe(false);
        expect(trackEvent).toHaveBeenCalledWith('add_run', expect.objectContaining({
            error_code: 'STATIC_TARGET_UNSUPPORTED',
        }));
        expect(fs.existsSync(path.join(dir, 'terraform', 'database.tf'))).toBe(false);
    });

    it('S11e: second add requires --force and stays idempotent', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        const first = await runAdd({ cwd: dir, capability: 'db:postgres' });
        expect(first.ok).toBe(true);
        const second = await runAdd({ cwd: dir, capability: 'db:postgres' });
        expect(second).toMatchObject({ ok: false, reason: 'addon-already-exists' });
        const forced = await runAdd({ cwd: dir, capability: 'db:postgres', force: true });
        expect(forced.ok).toBe(true);
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf.match(/"DB_HOST"/g)).toHaveLength(1);
        expect(mainTf.match(/"name": "DB_USER"/g)).toHaveLength(1);
    });

    it('S11e: hand-referenced DB without database.tf fails DB_ALREADY_REFERENCED', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        const mainPath = path.join(dir, 'terraform', 'main.tf');
        fs.writeFileSync(mainPath, fs.readFileSync(mainPath, 'utf-8').replace(
            '{ "name": "NODE_ENV", "value": "production" }',
            '{ "name": "DB_HOST", "value": aws_db_instance.postgres.address }'
        ));
        const result = await runAdd({ cwd: dir, capability: 'db:postgres' });
        expect(result).toMatchObject({ ok: false, reason: 'db-already-referenced' });
        const forced = await runAdd({ cwd: dir, capability: 'db:postgres', force: true });
        expect(forced.ok).toBe(true);
    });
});
