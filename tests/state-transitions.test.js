import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { mockConfirm, mockSelect, mockLogWarn } from './helpers/clack.js';
import { createTmpDirTracker } from './helpers/tmpdir.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stripVTControlCharacters } from 'node:util';



vi.mock('../src/utils/aws.js', () => ({
    handleAuthErrorBranch: () => false,
    handleAwsAuthError: vi.fn(),
    isAuthError: vi.fn(() => false),
    printAwsAuthGuidance: vi.fn(),
    resolveClient: (injected) => injected,
    provisionStateBucket: vi.fn().mockResolvedValue({
        awsAccountId: '123456789012',
        stateBucketName: 'mock-tf-state-bucket',
    }),
    ensureStateBucketExists: vi.fn().mockResolvedValue({ bucket: 'mock-tf-state-bucket' }),
    teardownStateBucket: vi.fn().mockResolvedValue(true),
    drainBucketObjects: vi.fn().mockResolvedValue({ deleted: 0, failed: [] }),
}));

// Round-2 rows drive init/destroy, which gate on the terraform binary;
// the mock keeps every other system helper real.
vi.mock('../src/utils/system.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        checkDependency: vi.fn().mockResolvedValue(true),
    };
});

vi.mock('../src/utils/terraform.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        runTerraformCommand: vi.fn().mockResolvedValue(undefined),
        getTerraformOutputs: vi.fn().mockResolvedValue({}),
    };
});

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
import { ejectStack, parseEjectArgs } from '../src/commands/eject.js';
import { runSleep, parseSleepArgs } from '../src/commands/sleep.js';
import { runWake, parseWakeArgs } from '../src/commands/wake.js';
import { runRollback } from '../src/commands/rollback.js';
import { resolveSleepTarget, readSleepState, writeSleepState } from '../src/utils/sleep-state.js';
import { writeEjectedMarker, readEjectedMarker, writeEjectedSentinel, requireManagedTree } from '../src/utils/terraform-metadata.js';
import { pushSecrets } from '../src/commands/secrets.js';
import { parseTerraformConfig } from '../src/utils/visualizer.js';
import { runTerraformCommand, getTerraformOutputs } from '../src/utils/terraform.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';
import { mainStack } from '../src/commands/init.js';
import * as destroyModule from '../src/commands/destroy.js';
import { runGc, parseGcArgs } from '../src/commands/gc.js';
import { provisionStateBucket, isAuthError, printAwsAuthGuidance } from '../src/utils/aws.js';

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
                db.instance.DBInstanceStatus = 'stopping';
                return {};
            }
            if (name === 'StopDBClusterCommand' && db?.cluster) {
                db.cluster.Status = 'stopping';
                return {};
            }
            if (name === 'StartDBInstanceCommand' && db?.instance) {
                db.instance.DBInstanceStatus = 'starting';
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
    // Reset (not just clear) the shared mocks: unconsumed mock*Once
    // entries from an earlier test must never leak into a later one.
    runTerraformCommand.mockReset();
    runTerraformCommand.mockResolvedValue(undefined);
    mockConfirm.mockReset();
    mockSelect.mockReset();
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
        mockHealthyEcsOutputs();
        const result = await applyStack({ isHeadless: true, force: true });
        expect(runTerraformCommand).toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith(
            'forced_apply_while_asleep',
            expect.objectContaining({ env: 'default' })
        );
        expect(result).toMatchObject({ ok: true }); // in-process success returns; only CLI exits
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('S1b: real CLI entry still exits 0 on success (including headless CLI)', async () => {
        asleepFixture();
        mockHealthyEcsOutputs();
        const savedArgv = process.argv;
        process.argv = ['node', '/usr/local/bin/grada', 'apply', '--headless'];
        try {
            await applyStack({ isHeadless: true, force: true });
        } finally {
            process.argv = savedArgv;
        }
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('S1c: interactive apply offers wake-and-continue, then proceeds', async () => {
        asleepFixture();
        mockConfirm.mockResolvedValueOnce(true);
        const wakeImpl = vi.fn(async () => ({ ok: true }));
        await applyStack({ wakeImpl, isHeadless: false });
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
        const result = await applyStack({ wakeImpl, isHeadless: false });
        expect(result).toMatchObject({ ok: false, reason: 'cancelled' });
        expect(wakeImpl).not.toHaveBeenCalled();
        expect(runTerraformCommand).not.toHaveBeenCalled();
    });

    it('S1c: a failed wake aborts the apply with WAKE_FAILED', async () => {
        asleepFixture();
        mockConfirm.mockResolvedValueOnce(true);
        const wakeImpl = vi.fn(async () => ({ ok: false, reason: 'rds-wake-timeout' }));
        const result = await applyStack({ wakeImpl, isHeadless: false });
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
            db: { instance: { Engine: 'postgres', DBInstanceStatus: 'stopped' } },
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
        expect(mainTf).toContain('"name" : "DB_USER"');
        expect(mainTf).toContain('master_user_secret[0].secret_arn');
        const workerTf = fs.readFileSync(path.join(dir, 'terraform', 'worker.tf'), 'utf-8');
        expect(workerTf).toContain('"DB_HOST"');
        expect(workerTf).toContain('"name" : "DB_USER"');
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
        expect(mainTf.match(/"name" : "DB_USER"/g)).toHaveLength(1);
    });

    it('S11e: hand-referenced DB without database.tf fails DB_ALREADY_REFERENCED', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        const mainPath = path.join(dir, 'terraform', 'main.tf');
        fs.writeFileSync(mainPath, fs.readFileSync(mainPath, 'utf-8').replace(
            '{ "name": "NODE_ENV", "value": "production" }',
            '{ "name" : "DB_HOST", "value" : aws_db_instance.postgres.address }'
        ));
        const result = await runAdd({ cwd: dir, capability: 'db:postgres' });
        expect(result).toMatchObject({ ok: false, reason: 'db-already-referenced' });
        const forced = await runAdd({ cwd: dir, capability: 'db:postgres', force: true });
        expect(forced.ok).toBe(true);
    });
});

// --- Round-2 helpers (S12–S37) ---

function writeManifestV2(dir, { target = 'ecs', appliedTarget = undefined, files = {} } = {}) {
    fs.mkdirSync(path.join(dir, '.grada'), { recursive: true });
    const manifest = { version: 2, target, files };
    if (appliedTarget !== undefined) manifest.appliedTarget = appliedTarget;
    fs.writeFileSync(path.join(dir, '.grada', 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function writeLastRunMarker(dir, marker = {}) {
    fs.mkdirSync(path.join(dir, '.grada'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.grada', 'last-run.json'), JSON.stringify({
        status: 'running',
        command: 'apply',
        args: ['apply', '-auto-approve'],
        pid: 4242,
        startedAt: new Date().toISOString(),
        ...marker,
    }, null, 2));
}

// Completion-scenario outputs: L1 fails fully-empty maps, so tests
// whose intent is "apply completes" mock a healthy ECS outputs map.
function mockHealthyEcsOutputs() {
    getTerraformOutputs.mockResolvedValueOnce({
        alb_direct_url: { value: 'http://myapp-alb-123.us-east-2.elb.amazonaws.com' },
        ecr_repository_url: { value: '123456789012.dkr.ecr.us-east-2.amazonaws.com/myapp-repo' },
    });
}

function writeBackendWithBucket(dir, bucket = 'myapp-tfstate-123456789012', region = 'us-east-2') {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'terraform', 'backend.tf'),
        `terraform {\n  backend "s3" {\n    bucket = "${bucket}"\n    region = "${region}"\n  }\n}\n`
    );
}

function rdsNotFoundClient() {
    return {
        send: vi.fn(async (command) => {
            const name = command.constructor.name;
            if (name === 'DescribeDBInstancesCommand') {
                throw Object.assign(new Error('not found'), { name: 'DBInstanceNotFound' });
            }
            if (name === 'DescribeDBClustersCommand') {
                throw Object.assign(new Error('not found'), { name: 'DBClusterNotFoundFault' });
            }
            throw new Error(`unexpected RDS command: ${name}`);
        }),
    };
}

function rdsAvailableInstanceClient(instance = {}) {
    return {
        send: vi.fn(async (command) => {
            const name = command.constructor.name;
            if (name === 'DescribeDBInstancesCommand') {
                return {
                    DBInstances: [{
                        DBInstanceIdentifier: 'myapp-db',
                        Engine: 'postgres',
                        DBInstanceStatus: 'available',
                        Status: 'available',
                        ...instance,
                    }],
                };
            }
            if (name === 'DescribeDBClustersCommand') {
                throw Object.assign(new Error('not found'), { name: 'DBClusterNotFoundFault' });
            }
            if (name === 'CreateDBSnapshotCommand') return { DBSnapshot: { Status: 'creating' } };
            throw new Error(`unexpected RDS command: ${name}`);
        }),
    };
}

const LOCK_STDERR = [
    'Error: Error acquiring the state lock:',
    '',
    'Error message: 2 errors occurred:',
    'Lock Info:',
    '  ID:        abc-123-lock',
    '  Path:      myapp-tfstate-123456789012/terraform.tfstate',
    '  Operation: OperationTypeApply',
    '',
    'Terraform acquires a state lock to protect the state from being written',
    'by multiple users at the same time.',
].join('\n');

describe('S12: target-switch destroy gate', () => {
    function switchFixture() {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeManifestV2(dir, { target: 'ecs', appliedTarget: 'static' });
        process.chdir(dir);
        return dir;
    }

    it('S12a: headless apply across targets refuses with zero terraform calls', async () => {
        switchFixture();
        const result = await applyStack({ isHeadless: true });
        expect(result).toMatchObject({ ok: false, reason: 'target-switch-destroy-review' });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(runTerraformCommand).not.toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith('infrastructure_applied', expect.objectContaining({
            error_code: 'TARGET_SWITCH_DESTROY_REVIEW',
        }));
        expect(output()).toContain('--destroy-previous-target');
    });

    it('S12b: --destroy-previous-target proceeds and records the override', async () => {
        switchFixture();
        mockHealthyEcsOutputs();
        const result = await applyStack({ isHeadless: true, destroyPreviousTarget: true });
        expect(result).toMatchObject({ ok: true });
        expect(runTerraformCommand).toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith('target_switch_override', expect.objectContaining({
            from: 'static',
            to: 'ecs',
        }));
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('S12b: parseApplyArgs parses --destroy-previous-target', () => {
        expect(applyModule.parseApplyArgs(['apply', '--destroy-previous-target'])).toMatchObject({
            destroyPreviousTarget: true,
        });
    });

    it('parses --progress on apply and destroy, both value forms', () => {
        expect(applyModule.parseApplyArgs(['apply', '--progress', 'lines'])).toMatchObject({ progress: 'lines' });
        expect(applyModule.parseApplyArgs(['apply', '--progress=spinner'])).toMatchObject({ progress: 'spinner' });
        expect(destroyModule.parseDestroyArgs(['destroy', '--progress', 'lines'])).toMatchObject({ progress: 'lines' });
        expect(destroyModule.parseDestroyArgs(['destroy', '--progress=spinner'])).toMatchObject({ progress: 'spinner' });
        expect(applyModule.parseApplyArgs(['apply']).progress).toBeUndefined();
    });

    it('refuses an invalid --progress before any terraform call', async () => {
        const applyResult = await applyStack({ progress: 'bogus' });
        expect(applyResult).toMatchObject({ ok: false, reason: 'invalid-progress-mode' });
        expect(trackEvent).toHaveBeenCalledWith('infrastructure_applied', expect.objectContaining({
            error_code: 'INVALID_PROGRESS_MODE',
        }));
        const destroyResult = await destroyModule.destroyStack({ progress: 'bogus' });
        expect(destroyResult).toMatchObject({ ok: false, reason: 'invalid-progress-mode' });
        expect(trackEvent).toHaveBeenCalledWith('infrastructure_destroyed', expect.objectContaining({
            error_code: 'INVALID_PROGRESS_MODE',
        }));
        expect(runTerraformCommand).not.toHaveBeenCalled();
        expect(output()).toContain('Supported modes: lines, spinner');
    });

    it('threads --progress into every terraform call of an apply', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeSleepState(dir, {
            default: {
                env: 'default',
                sleptAt: new Date().toISOString(),
                autoRestartAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
                services: { app: 1 },
            },
        });
        process.chdir(dir);
        mockHealthyEcsOutputs();
        await applyStack({ isHeadless: true, force: true, progress: 'lines' });
        expect(runTerraformCommand).toHaveBeenCalled();
        for (const call of runTerraformCommand.mock.calls) {
            expect(call[4]).toMatchObject({ progress: 'lines' });
        }
    });

    it('S12c: same-target re-apply is not gated', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeManifestV2(dir, { target: 'ecs', appliedTarget: 'ecs' });
        process.chdir(dir);
        mockHealthyEcsOutputs();
        const result = await applyStack({ isHeadless: true });
        expect(result).toMatchObject({ ok: true });
        expect(runTerraformCommand).toHaveBeenCalled();
        expect(trackEvent).not.toHaveBeenCalledWith('target_switch_override', expect.anything());
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('S12: v2 manifest without appliedTarget (never applied) proceeds', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeManifestV2(dir, { target: 'ecs' });
        process.chdir(dir);
        mockHealthyEcsOutputs();
        const result = await applyStack({ isHeadless: true });
        expect(result).toMatchObject({ ok: true });
        expect(runTerraformCommand).toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('S12 interactive: plan review confirm proceeds, decline cancels', async () => {
        switchFixture();
        mockConfirm.mockResolvedValueOnce(true);
        mockHealthyEcsOutputs();
        const result = await applyStack({ isHeadless: false });
        expect(result).toMatchObject({ ok: true });
        expect(runTerraformCommand).toHaveBeenCalledWith(
            expect.arrayContaining(['plan']),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything()
        );
        expect(runTerraformCommand).toHaveBeenCalledWith(
            ['apply', '-auto-approve'],
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything()
        );
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('S12 interactive: declining the switch review cancels with zero apply', async () => {
        switchFixture();
        mockConfirm.mockResolvedValueOnce(false);
        const result = await applyStack({ isHeadless: false });
        expect(result).toMatchObject({ ok: false, reason: 'cancelled' });
        expect(runTerraformCommand).not.toHaveBeenCalledWith(
            ['apply', '-auto-approve'],
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything()
        );
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('S12 legacy: v1 manifest (applied unknown) refuses closed', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        backup.writeInitManifest(dir);
        process.chdir(dir);
        const result = await applyStack({ isHeadless: true });
        expect(result).toMatchObject({ ok: false, reason: 'target-switch-destroy-review' });
        expect(runTerraformCommand).not.toHaveBeenCalled();
        expect(output()).toContain('--destroy-previous-target');
    });
});

describe('S13: interrupted-run surfacing', () => {
    it('apply warns when the last-run marker shows an interrupted run', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeLastRunMarker(dir);
        process.chdir(dir);
        await applyStack({ isHeadless: true });
        expect(mockLogWarn).toHaveBeenCalledWith(expect.stringMatching(/interrupt/i));
        expect(runTerraformCommand).toHaveBeenCalled();
    });
});

describe('S14: stale state lock', () => {
    function lockFixture() {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        process.chdir(dir);
        return dir;
    }

    it('S14a: headless apply names STATE_LOCK_HELD with a runbook', async () => {
        lockFixture();
        const runTerraformImpl = vi.fn(async (args) => {
            if (args[0] === 'init') return;
            throw new Error(LOCK_STDERR);
        });
        const result = await applyStack({ isHeadless: true, runTerraformImpl });
        expect(result).toMatchObject({ ok: false, reason: 'state-lock-held' });
        expect(trackEvent).toHaveBeenCalledWith('infrastructure_applied', expect.objectContaining({
            error_code: 'STATE_LOCK_HELD',
        }));
        expect(trackEvent).toHaveBeenCalledWith('state_lock_detected', expect.objectContaining({
            command: 'apply',
        }));
        expect(output()).toContain('force-unlock');
        expect(output()).toContain('abc-123-lock');
    });

    it('S14b: interactive confirm runs force-unlock and retries', async () => {
        lockFixture();
        mockConfirm.mockResolvedValueOnce(true);
        mockHealthyEcsOutputs();
        let applies = 0;
        const runTerraformImpl = vi.fn(async (args) => {
            if (args[0] === 'init') return;
            if (args[0] === 'force-unlock') return;
            applies += 1;
            if (applies === 1) throw new Error(LOCK_STDERR);
        });
        const result = await applyStack({ runTerraformImpl, isHeadless: false });
        expect(result).toMatchObject({ ok: true });
        expect(runTerraformImpl).toHaveBeenCalledWith(
            expect.arrayContaining(['force-unlock', 'abc-123-lock']),
            expect.anything(),
            expect.anything(),
            expect.anything()
        );
        expect(applies).toBe(2);
        expect(trackEvent).toHaveBeenCalledWith('state_lock_force_unlocked', expect.objectContaining({
            mode: 'interactive',
        }));
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('S14c: headless --force-unlock proceeds without prompting', async () => {
        lockFixture();
        mockHealthyEcsOutputs();
        let applies = 0;
        const runTerraformImpl = vi.fn(async (args) => {
            if (args[0] === 'init') return;
            if (args[0] === 'force-unlock') return;
            applies += 1;
            if (applies === 1) throw new Error(LOCK_STDERR);
        });
        const result = await applyStack({ isHeadless: true, forceUnlock: 'abc-123-lock', runTerraformImpl });
        expect(result).toMatchObject({ ok: true });
        expect(runTerraformImpl).toHaveBeenCalledWith(
            expect.arrayContaining(['force-unlock']),
            expect.anything(),
            expect.anything(),
            expect.anything()
        );
        expect(mockConfirm).not.toHaveBeenCalled();
        expect(applies).toBe(2);
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('S14c: parseApplyArgs parses --force-unlock <id>', () => {
        expect(applyModule.parseApplyArgs(['apply', '--force-unlock', 'abc-123'])).toMatchObject({
            forceUnlock: 'abc-123',
        });
    });
});

describe('S15: parallel adds', () => {
    it('concurrent adds keep every env injection', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        const [sqs, dynamo] = await Promise.all([
            runAdd({ cwd: dir, capability: 'queue:sqs' }),
            runAdd({ cwd: dir, capability: 'db:dynamodb' }),
        ]);
        expect(sqs.ok).toBe(true);
        expect(dynamo.ok).toBe(true);
        expect(fs.existsSync(path.join(dir, 'terraform', 'sqs.tf'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'terraform', 'dynamodb.tf'))).toBe(true);
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('SQS_QUEUE_URL');
        expect(mainTf).toContain('DYNAMODB_TABLE_NAME');
    });
});

function headlessInitOptions(target = 'ecs') {
    return {
        isHeadless: true,
        headlessOptions: { dir: '.', framework: 'node', region: 'us-east-2' },
        initOptions: { target },
    };
}

describe('S16: preserved files across re-init', () => {
    it('S16a: secret_keys.json is carried forward, not reset', async () => {
        const dir = makeTmp();
        writeInitTree(dir);
        fs.writeFileSync(path.join(dir, 'terraform', 'secret_keys.json'), JSON.stringify(['API_KEY', 'STRIPE_SECRET']));
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'myapp' }));
        backup.writeInitManifest(dir);
        process.chdir(dir);
        await mainStack(headlessInitOptions());
        const keys = JSON.parse(fs.readFileSync(path.join(dir, 'terraform', 'secret_keys.json'), 'utf-8'));
        expect(keys).toEqual(['API_KEY', 'STRIPE_SECRET']);
    }, 30000);

    it('S16b: custom .tf is swept to .bak with a printed pointer', async () => {
        const dir = makeTmp();
        writeInitTree(dir);
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'myapp' }));
        backup.writeInitManifest(dir);
        fs.writeFileSync(path.join(dir, 'terraform', 'custom.tf'), '# hand-written\n');
        process.chdir(dir);
        await mainStack(headlessInitOptions());
        const bak = fs.readdirSync(dir).find((e) => e.startsWith('terraform.bak.'));
        expect(bak).toBeTruthy();
        expect(fs.existsSync(path.join(dir, bak, 'custom.tf'))).toBe(true);
        expect(output()).toMatch(/terraform\.bak\./);
    }, 30000);
});

describe('S17: manifest intended/applied target', () => {
    it('init records the intended target', async () => {
        const dir = makeTmp();
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'myapp' }));
        process.chdir(dir);
        await mainStack(headlessInitOptions());
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.grada', 'manifest.json'), 'utf-8'));
        expect(manifest.version).toBe(2);
        expect(manifest.target).toBe('ecs');
    }, 30000);

    it('apply records the applied target', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeManifestV2(dir, { target: 'ecs' });
        process.chdir(dir);
        mockHealthyEcsOutputs();
        const result = await applyStack({ isHeadless: true });
        expect(result).toMatchObject({ ok: true });
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.grada', 'manifest.json'), 'utf-8'));
        expect(manifest.appliedTarget).toBe('ecs');
        expect(exitSpy).not.toHaveBeenCalled();
    });
});

describe('S18: bucket-recovery resume gate', () => {
    function recoveryFixture() {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        fs.writeFileSync(
            path.join(dir, 'terraform', 'backend.tf'),
            'backend "s3" {\n  bucket = "myapp-tfstate-123456789012"\n  key = "state/terraform.tfstate"\n  region = "us-east-2"\n}\n'
        );
        process.chdir(dir);
        return dir;
    }

    function recoveryScript() {
        let inits = 0;
        let applies = 0;
        const runTerraformImpl = vi.fn(async (args) => {
            if (args[0] === 'init') {
                inits += 1;
                if (inits === 1) throw new Error('Error: Failed to get existing workspaces: S3 bucket "myapp-tfstate-1" does not exist (NoSuchBucket).');
                return;
            }
            applies += 1;
            throw new Error('Error: creating VPC (myapp-vpc): EntityAlreadyExists: The VPC already exists');
        });
        return { runTerraformImpl, counts: () => ({ inits, applies }) };
    }

    it('S18a: collisions after recreate refuse with an import runbook', async () => {
        recoveryFixture();
        const { runTerraformImpl, counts } = recoveryScript();
        const result = await applyStack({ isHeadless: true, runTerraformImpl });
        expect(result).toMatchObject({ ok: false, reason: 'recreate-collision' });
        expect(counts().applies).toBe(1);
        expect(output()).toContain('terraform import');
        expect(trackEvent).toHaveBeenCalledWith('bucket_recovery_probed', expect.objectContaining({
            collisions: 1,
        }));
    });

    it('S18b: --force-resume proceeds preserving approval mode', async () => {
        recoveryFixture();
        const { runTerraformImpl, counts } = recoveryScript();
        const result = await applyStack({ isHeadless: true, forceResume: true, runTerraformImpl });
        expect(counts().applies).toBe(1);
        expect(trackEvent).toHaveBeenCalledWith('bucket_recovery_resume_forced', expect.anything());
        expect(result).not.toMatchObject({ reason: 'recreate-collision' });
    });

    it('S18b: parseApplyArgs parses --force-resume', () => {
        expect(applyModule.parseApplyArgs(['apply', '--force-resume'])).toMatchObject({
            forceResume: true,
        });
    });
});

describe('S19: destroy inits first', () => {
    it('destroy runs terraform init before destroy', async () => {
        const dir = makeTmp();
        writeBackendWithBucket(dir);
        process.chdir(dir);
        await destroyModule.destroyStack({ isHeadless: true, rdsClient: rdsNotFoundClient() });
        const calls = runTerraformCommand.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0][0][0]).toBe('init');
        expect(calls[calls.length - 1][0]).toContain('destroy');
    });

    it('parseDestroyArgs exists and parses destroy flags', () => {
        expect(typeof destroyModule.parseDestroyArgs).toBe('function');
    });
});

describe('S20: eject asleep preflight', () => {
    function sleptFixture() {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeSleepState(dir, {
            default: {
                env: 'default',
                sleptAt: new Date().toISOString(),
                autoRestartAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
                services: { app: 1, worker: 0 },
                dbId: 'myapp-db-cluster',
                dbKind: 'cluster',
            },
        });
        process.chdir(dir);
        return dir;
    }

    it('interactive eject warns ASLEEP and offers wake-first', async () => {
        sleptFixture();
        mockConfirm.mockResolvedValueOnce(true);
        mockConfirm.mockResolvedValueOnce(true);
        const wakeImpl = vi.fn(async () => ({ ok: true }));
        await ejectStack({ wakeImpl, isHeadless: false });
        expect(output()).toMatch(/ASLEEP/);
        expect(wakeImpl).toHaveBeenCalled();
        expect(readEjectedMarker(process.cwd())).toMatchObject({ ejectedAt: expect.any(String) });
    });

    it('declining wake-first aborts the eject', async () => {
        sleptFixture();
        mockConfirm.mockResolvedValueOnce(false);
        const wakeImpl = vi.fn(async () => ({ ok: true }));
        await ejectStack({ wakeImpl, isHeadless: false });
        expect(wakeImpl).not.toHaveBeenCalled();
        expect(readEjectedMarker(process.cwd())).toBeNull();
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('headless eject while asleep refuses unless --force', async () => {
        sleptFixture();
        const refused = await ejectStack({ isHeadless: true });
        expect(refused).toMatchObject({ ok: false, reason: 'eject-while-asleep' });
        expect(readEjectedMarker(process.cwd())).toBeNull();
    });

    it('headless eject while asleep proceeds with --force', async () => {
        const dir = sleptFixture();
        await ejectStack({ isHeadless: true, force: true });
        expect(readEjectedMarker(dir)).toMatchObject({ ejectedAt: expect.any(String) });
    });

    it('parseEjectArgs parses --force', () => {
        expect(parseEjectArgs(['eject', '--force'])).toMatchObject({ force: true });
        expect(parseEjectArgs(['eject']).force).toBe(false);
    });
});

describe('S21: eject emits bucket cleanup', () => {
    it('eject writes STATE_BUCKET_CLEANUP.md with bucket and region', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeBackendWithBucket(dir, 'myapp-tfstate-999', 'eu-west-1');
        process.chdir(dir);
        await ejectStack({ yes: true });
        const cleanup = fs.readFileSync(path.join(dir, 'STATE_BUCKET_CLEANUP.md'), 'utf-8');
        expect(cleanup).toContain('myapp-tfstate-999');
        expect(cleanup).toContain('eu-west-1');
    });

    it('asleep eject includes rds start commands for the recorded db', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeBackendWithBucket(dir);
        writeSleepState(dir, {
            default: {
                env: 'default',
                sleptAt: new Date().toISOString(),
                autoRestartAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
                services: { app: 1, worker: 0 },
                dbId: 'myapp-db-cluster',
                dbKind: 'cluster',
            },
        });
        process.chdir(dir);
        mockConfirm.mockResolvedValueOnce(true);
        mockConfirm.mockResolvedValueOnce(true);
        await ejectStack({ wakeImpl: vi.fn(async () => ({ ok: true })), isHeadless: false });
        const cleanup = fs.readFileSync(path.join(dir, 'STATE_BUCKET_CLEANUP.md'), 'utf-8');
        expect(cleanup).toContain('start-db-cluster');
        expect(cleanup).toContain('myapp-db-cluster');
    });

    it('force eject while asleep migrates the ledger to SLEEPING.md', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeBackendWithBucket(dir);
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
        await ejectStack({ isHeadless: true, force: true });
        const sleeping = fs.readFileSync(path.join(dir, 'SLEEPING.md'), 'utf-8');
        expect(sleeping).toContain('myapp-db');
        expect(sleeping).toMatch(/ASLEEP/);
        expect(readSleepState(dir)).toEqual({});
        expect(trackEvent).toHaveBeenCalledWith('sleep_entry_cleared', expect.objectContaining({ by: 'eject' }));
    });
});

describe('S22: provision-before-backup', () => {
    it('a failed provision leaves the pre-backup tree intact', async () => {
        const dir = makeTmp();
        writeInitTree(dir);
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'myapp' }));
        backup.writeInitManifest(dir);
        process.chdir(dir);
        vi.mocked(provisionStateBucket).mockRejectedValueOnce(new Error('ExpiredToken: credentials expired'));
        const result = await mainStack(headlessInitOptions());
        expect(result).toMatchObject({ ok: false });
        expect(fs.existsSync(path.join(dir, 'terraform', 'main.tf'))).toBe(true);
        expect(fs.readdirSync(dir).some((e) => e.startsWith('terraform.bak.'))).toBe(false);
    }, 30000);

    it('an auth failure during provision prints recovery guidance and still tracks cli-error', async () => {
        const dir = makeTmp();
        writeInitTree(dir);
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'myapp' }));
        backup.writeInitManifest(dir);
        process.chdir(dir);
        vi.mocked(provisionStateBucket).mockRejectedValueOnce(Object.assign(
            new Error('The security token included in the request is expired'),
            { name: 'ExpiredTokenException' },
        ));
        vi.mocked(isAuthError).mockReturnValueOnce(true);
        const result = await mainStack(headlessInitOptions());
        expect(result).toMatchObject({ ok: false });
        expect(printAwsAuthGuidance).toHaveBeenCalledTimes(1);
        expect(trackEvent).toHaveBeenCalledWith('cli-error', expect.objectContaining({
            step: 'aws_provisioning',
            error_code: 'ExpiredTokenException',
        }));
    }, 30000);
});

describe('S23: committed eject sentinel', () => {
    it('fresh clones detect the sentinel instead of silently re-managing', async () => {
        const dir = makeTmp();
        writeInitTree(dir);
        process.chdir(dir);
        await ejectStack({ yes: true });
        expect(fs.existsSync(path.join(dir, '.grada-ejected'))).toBe(true);
        // Simulate a fresh clone: local-only .grada/ never arrives.
        fs.rmSync(path.join(dir, '.grada'), { recursive: true, force: true });
        const result = await backup.handleExistingFiles(dir, true);
        expect(result).toMatchObject({ ok: false, reason: 'ejected-project' });
        expect(fs.existsSync(path.join(dir, 'terraform', 'main.tf'))).toBe(true);
    });
});

describe('S24: destroy data-loss gate', () => {
    function dbDestroyFixture() {
        const dir = makeTmp();
        writeBackendWithBucket(dir);
        writeEcsMainTf(dir);
        // New-template database.tf: protection wired to the data-loss variable.
        fs.writeFileSync(path.join(dir, 'terraform', 'database.tf'), [
            'variable "grada_allow_data_loss" {',
            '  type    = bool',
            '  default = false',
            '}',
            '',
            'resource "aws_db_instance" "postgres" {',
            '  identifier          = "myapp-db"',
            '  deletion_protection = !var.grada_allow_data_loss',
            '}',
            '',
        ].join('\n'));
        process.chdir(dir);
        return dir;
    }

    it('headless destroy with a live DB refuses without --allow-data-loss', async () => {
        dbDestroyFixture();
        const result = await destroyModule.destroyStack({ isHeadless: true, rdsClient: rdsAvailableInstanceClient() });
        expect(result).toMatchObject({ ok: false, reason: 'data-loss-unconfirmed' });
        expect(runTerraformCommand).not.toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith('infrastructure_destroyed', expect.objectContaining({
            error_code: 'DATA_LOSS_UNCONFIRMED',
        }));
        expect(output()).toContain('--allow-data-loss');
        expect(output()).toContain('destroy without a snapshot');
        expect(output()).not.toContain('snapshot it first');
    });

    it('headless destroy with --allow-data-loss passes the var and skips the snapshot', async () => {
        dbDestroyFixture();
        const rdsClient = rdsAvailableInstanceClient();
        await destroyModule.destroyStack({ isHeadless: true, allowDataLoss: true, rdsClient });
        const destroyCall = runTerraformCommand.mock.calls.find(([args]) => args[0] === 'destroy');
        expect(destroyCall).toBeTruthy();
        expect(destroyCall[0].join(' ')).toContain('grada_allow_data_loss=true');
        const snapshotCalls = rdsClient.send.mock.calls.filter(([c]) => c.constructor.name === 'CreateDBSnapshotCommand');
        expect(snapshotCalls).toHaveLength(0);
    });

    it('interactive confirm names the cluster and snapshots before destroy', async () => {
        dbDestroyFixture();
        mockConfirm.mockResolvedValueOnce(true);
        const rdsClient = rdsAvailableInstanceClient();
        await destroyModule.destroyStack({ rdsClient, isHeadless: false });
        expect(output()).toContain('myapp-db');
        const snapshotCalls = rdsClient.send.mock.calls.filter(([c]) => c.constructor.name === 'CreateDBSnapshotCommand');
        expect(snapshotCalls).toHaveLength(1);
        expect(trackEvent).toHaveBeenCalledWith('db_destroy_checkpoint', expect.objectContaining({
            db_kind: 'instance',
        }));
        expect(runTerraformCommand).toHaveBeenCalled();
    });

    it('generated database templates wire deletion protection to the var', () => {
        for (const file of ['database.tf', 'database-mysql.tf', 'database-aurora-postgresql.tf']) {
            const content = fs.readFileSync(path.resolve(originalCwd, 'templates/terraform', file), 'utf-8');
            expect(content).toContain('deletion_protection');
            expect(content).toContain('grada_allow_data_loss');
            expect(content).toContain('pre-wakes stopped');
        }
    });

    it('parseDestroyArgs parses destroy flags', () => {
        expect(destroyModule.parseDestroyArgs(['destroy', '--allow-data-loss'])).toMatchObject({
            allowDataLoss: true,
        });
    });
});

function gcTagFixtures(project) {
    return project === null ? [] : [{ Key: 'GradaProject', Value: project }];
}

function scriptedGcClients({ addresses = [], repos = [], logGroups = [], vpcs = [], secrets = [] } = {}) {
    const ecrClient = {
        send: vi.fn(async (command) => {
            if (command.constructor.name === 'DescribeRepositoriesCommand') return { repositories: repos };
            if (command.constructor.name === 'DescribeImagesCommand') return { imageDetails: [] };
            return {};
        }),
    };
    const logsClient = {
        send: vi.fn(async (command) => {
            if (command.constructor.name === 'DescribeLogGroupsCommand') return { logGroups };
            return {};
        }),
    };
    const ec2Client = {
        send: vi.fn(async (command) => {
            if (command.constructor.name === 'DescribeAddressesCommand') return { Addresses: addresses };
            if (command.constructor.name === 'DescribeVpcsCommand') return { Vpcs: vpcs };
            return {};
        }),
    };
    const secretsClient = {
        send: vi.fn(async (command) => {
            if (command.constructor.name === 'ListSecretsCommand') return { SecretList: secrets };
            return {};
        }),
    };
    return { ecrClient, logsClient, ec2Client, secretsClient };
}

describe('S25: gc scoping', () => {
    it('S25a: foreign and untagged EIPs are never proposed for release', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        const { ecrClient, logsClient, ec2Client } = scriptedGcClients({
            addresses: [
                { PublicIp: '1.1.1.1', AllocationId: 'eip-own', Tags: gcTagFixtures('myapp') },
                { PublicIp: '2.2.2.2', AllocationId: 'eip-foreign', Tags: gcTagFixtures('other') },
                { PublicIp: '3.3.3.3', AllocationId: 'eip-legacy' },
            ],
        });
        mockConfirm.mockResolvedValueOnce(true);
        const result = await runGc({ cwd: dir, projectName: 'myapp', region: 'us-east-2', ecrClient, logsClient, ec2Client, isHeadless: false });
        expect(result.unattachedEips.map((e) => e.AllocationId)).toEqual(['eip-own']);
        const released = ec2Client.send.mock.calls.filter(([c]) => c.constructor.name === 'ReleaseAddressCommand');
        expect(released.map(([c]) => c.input.AllocationId)).toEqual(['eip-own']);
        expect(result.deleted).toBe(true);
    });

    it('S25b: --deep dry-run lists tag-keyed orphans with state/secrets report-only', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeBackendWithBucket(dir, 'myapp-tfstate-1', 'us-east-2');
        const { ecrClient, logsClient, ec2Client, secretsClient } = scriptedGcClients({
            vpcs: [{ VpcId: 'vpc-orphan', Tags: gcTagFixtures('myapp') }],
            secrets: [{ Name: 'myapp-secrets', Tags: gcTagFixtures('myapp') }],
        });
        const result = await runGc({ cwd: dir, projectName: 'myapp', region: 'us-east-2', deep: true, ecrClient, logsClient, ec2Client, secretsClient });
        expect(result.deep.deletable.map((r) => r.id)).toContain('vpc-orphan');
        const reportKinds = result.deep.reportOnly.map((r) => r.kind);
        expect(reportKinds).toContain('state-bucket');
        expect(reportKinds).toContain('secret');
        expect(result.deleted).toBe(false);
    });

    it('S25b: parseGcArgs parses --deep and --yes', () => {
        expect(parseGcArgs(['gc', '--deep'])).toMatchObject({ deep: true });
        expect(parseGcArgs(['gc', '--yes'])).toMatchObject({ yes: true });
    });
});

describe('S28: asleep-aware add/rollback', () => {
    it('S28a: add on an asleep env warns but proceeds', async () => {
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
        const result = await runAdd({ cwd: dir, capability: 'queue:sqs' });
        expect(result.ok).toBe(true);
        expect(output()).toMatch(/asleep/i);
        expect(trackEvent).toHaveBeenCalledWith('asleep_add_warned', expect.objectContaining({
            capability: 'queue:sqs',
        }));
    });

    it('rollback on an asleep env warns but proceeds', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeSleepState(dir, {
            default: {
                env: 'default',
                sleptAt: new Date().toISOString(),
                autoRestartAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
                services: { app: 1, worker: 0 },
                dbId: null,
                dbKind: null,
            },
        });
        const arn = (rev) => `arn:aws:ecs:us-east-2:123456789012:task-definition/myapp-task:${rev}`;
        const ecsClient = {
            send: vi.fn(async (command) => {
                const name = command.constructor.name;
                if (name === 'DescribeServicesCommand') {
                    return {
                        services: [{
                            serviceName: 'myapp-service',
                            status: 'ACTIVE',
                            taskDefinition: arn(5),
                            desiredCount: 1,
                            runningCount: 1,
                        }],
                    };
                }
                if (name === 'DescribeTaskDefinitionCommand') {
                    return { taskDefinition: { taskDefinitionArn: arn(5), revision: 5, status: 'INACTIVE' } };
                }
                throw new Error(`unexpected ECS command: ${name}`);
            }),
        };
        const result = await runRollback({
            cwd: dir,
            projectName: 'myapp',
            cluster: 'myapp-cluster',
            service: 'myapp-service',
            region: 'us-east-2',
            revision: '5',
            isHeadless: true,
            ecsClient,
        });
        // The warn is advisory: the flow proceeds to normal revision handling.
        expect(output()).toMatch(/asleep/i);
        expect(result).toMatchObject({ ok: false, reason: 'revision-not-found' });
    });

    it('S28b: rollback on lambda fails with a dedicated code and actual', async () => {
        const dir = makeTmp();
        writeLambdaMainTf(dir);
        const result = await runRollback({
            cwd: dir,
            projectName: 'myapp',
            cluster: 'myapp-cluster',
            service: 'myapp-service',
            region: 'us-east-2',
            isHeadless: true,
        });
        expect(result).toMatchObject({ ok: false, reason: 'lambda-target-unsupported', actual: 'lambda' });
        expect(exitSpy).toHaveBeenCalledWith(3);
        expect(output()).not.toMatch(/grada rollback/);
    });
});

describe('S29: ledger cleanup', () => {
    function sleptEntry() {
        return {
            env: 'default',
            sleptAt: new Date().toISOString(),
            autoRestartAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
            services: { app: 1, worker: 0 },
            dbId: 'myapp-db',
            dbKind: 'instance',
        };
    }

    it('S29a: successful destroy removes the env ledger entry', async () => {
        const dir = makeTmp();
        writeBackendWithBucket(dir);
        writeEcsMainTf(dir);
        writeSleepState(dir, { default: sleptEntry() });
        process.chdir(dir);
        await destroyModule.destroyStack({ isHeadless: true, rdsClient: rdsNotFoundClient() });
        expect(readSleepState(dir).default).toBeUndefined();
    });

    it('S29b: wake with nothing to wake clears the stale entry', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeSleepState(dir, { default: sleptEntry() });
        const { ecsClient, rdsClient } = mockSleepClients({ ecs: {}, db: null });
        const result = await runWake({ cwd: dir, projectName: 'myapp', region: 'us-east-2', noWait: true, ecsClient, rdsClient });
        expect(result).toMatchObject({ ok: false, reason: 'nothing-to-wake' });
        expect(readSleepState(dir).default).toBeUndefined();
    });
});

describe('S30: managed-tree guard', () => {
    function ejectedFixture() {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        process.chdir(dir);
        return dir;
    }

    // ejectStack prints "eject" banners of its own; clear the spies so the
    // assertions below only see the guarded command's output.
    async function ejectQuietly(options) {
        await ejectStack(options);
        logSpy.mockClear();
        errSpy.mockClear();
    }

    it('headless apply on an ejected tree refuses unless --force', async () => {
        ejectedFixture();
        await ejectQuietly({ yes: true });
        const result = await applyStack({ isHeadless: true });
        expect(result).toMatchObject({ ok: false, reason: 'ejected-project' });
        expect(runTerraformCommand).not.toHaveBeenCalled();
        expect(output()).toMatch(/eject/i);
    });

    it('apply on an ejected tree proceeds with --force', async () => {
        ejectedFixture();
        await ejectQuietly({ yes: true });
        await applyStack({ isHeadless: true, force: true });
        expect(runTerraformCommand).toHaveBeenCalled();
    });

    it('interactive apply on an ejected tree warns and confirms', async () => {
        ejectedFixture();
        await ejectQuietly({ yes: true });
        mockConfirm.mockResolvedValueOnce(true);
        await applyStack({ isHeadless: false });
        expect(output()).toMatch(/eject/i);
        expect(runTerraformCommand).toHaveBeenCalled();
    });

    it('headless destroy on an ejected tree refuses with zero terraform calls', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeEjectedMarker(dir);
        writeEjectedSentinel(dir);
        process.chdir(dir);
        const result = await destroyModule.destroyStack({ isHeadless: true });
        expect(result).toMatchObject({ ok: false, reason: 'ejected-project' });
        expect(runTerraformCommand).not.toHaveBeenCalled();
    });

    it('headless sleep on an ejected tree refuses', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeEjectedMarker(dir);
        const result = await runSleep({ cwd: dir, projectName: 'myapp', region: 'us-east-2', isHeadless: true });
        expect(result).toMatchObject({ ok: false, reason: 'ejected-project' });
    });

    it('headless wake on an ejected tree refuses', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeEjectedSentinel(dir);
        const result = await runWake({ cwd: dir, projectName: 'myapp', region: 'us-east-2', isHeadless: true });
        expect(result).toMatchObject({ ok: false, reason: 'ejected-project' });
    });

    it('headless rollback on an ejected tree refuses before the target guard', async () => {
        const dir = makeTmp();
        writeLambdaMainTf(dir);
        writeEjectedMarker(dir);
        const result = await runRollback({
            cwd: dir,
            projectName: 'myapp',
            cluster: 'myapp-cluster',
            service: 'myapp-service',
            region: 'us-east-2',
            isHeadless: true,
        });
        expect(result).toMatchObject({ ok: false, reason: 'ejected-project' });
    });

    it('headless secrets push on an ejected tree refuses', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeEjectedMarker(dir);
        process.chdir(dir);
        const result = await pushSecrets('.env', 'myapp', { isHeadless: true });
        expect(result).toMatchObject({ ok: false, reason: 'ejected-project' });
    });
});

describe('R10: managed-tree guard units', () => {
    function ejectedDir() {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeEjectedMarker(dir);
        writeEjectedSentinel(dir);
        return dir;
    }

    it('managed trees proceed silently', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        const result = await requireManagedTree({ cwd: dir, command: 'apply', options: { isHeadless: true } });
        expect(result).toEqual({ proceed: true });
        expect(output()).toBe('');
        expect(trackEvent).not.toHaveBeenCalledWith('managed_tree_refused', expect.anything());
    });

    it('headless refuses with the ejected reason and telemetry', async () => {
        const dir = ejectedDir();
        const result = await requireManagedTree({
            cwd: dir, command: 'destroy', options: { isHeadless: true }, event: 'infrastructure_destroyed',
        });
        expect(result.proceed).toBe(false);
        expect(result.result).toMatchObject({ ok: false, reason: 'ejected-project' });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('managed_tree_refused', expect.objectContaining({ command: 'destroy' }));
    });

    it('--force proceeds without prompting', async () => {
        const dir = ejectedDir();
        const result = await requireManagedTree({ cwd: dir, command: 'apply', options: { isHeadless: true, force: true } });
        expect(result).toMatchObject({ proceed: true, ejected: 'both' });
    });

    it('interactive decline cancels cleanly', async () => {
        const dir = ejectedDir();
        mockConfirm.mockResolvedValueOnce(false);
        const result = await requireManagedTree({ cwd: dir, command: 'sleep', options: { isHeadless: false } });
        expect(result).toMatchObject({ proceed: false, result: { ok: false, reason: 'cancelled' } });
        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(trackEvent).toHaveBeenCalledWith('managed_tree_refused', expect.objectContaining({ command: 'sleep' }));
    });

    it('warn mode proceeds with a warning', async () => {
        const dir = ejectedDir();
        const result = await requireManagedTree({ cwd: dir, command: 'status', options: {}, mode: 'warn' });
        expect(result).toMatchObject({ proceed: true, ejected: 'both' });
        expect(output()).toMatch(/eject/i);
    });
});

describe('S31: outputs contract', () => {
    it('empty outputs produce a partial-state advisory and non-zero exit', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        process.chdir(dir);
        await applyStack({ isHeadless: true });
        expect(output()).toMatch(/partial/i);
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('outputs_contract_violated', expect.objectContaining({
            target: 'ecs',
        }));
    });

    it('--allow-partial-outputs downgrades the empty map to a warning', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        process.chdir(dir);
        const result = await applyStack({ isHeadless: true, allowPartialOutputs: true });
        expect(result).toMatchObject({ ok: true });
        expect(output()).toMatch(/partial/i);
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('names the resumed partial apply when a prior interrupt marker exists', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        fs.mkdirSync(path.join(dir, '.grada'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, '.grada', 'last-run.json'),
            JSON.stringify({ status: 'interrupted', command: 'apply', startedAt: '2026-10-01T00:00:00Z' })
        );
        process.chdir(dir);
        await applyStack({ isHeadless: true });
        expect(output()).toMatch(/resumed\/completed partial apply/);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});

describe('S32: static add policy', () => {
    it('S32a: queue:sqs on static warns with a machine-readable code', async () => {
        const dir = makeTmp();
        writeStaticMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'queue:sqs' });
        expect(result.ok).toBe(true);
        expect(result.warning).toBe('static-target-unwired');
        expect(fs.existsSync(path.join(dir, 'terraform', 'sqs.tf'))).toBe(true);
        expect(output()).toMatch(/without a worker/);
    });

    it('S32b: cron on static is refused by the policy table', async () => {
        const dir = makeTmp();
        writeStaticMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'cron' });
        expect(result).toMatchObject({ ok: false, reason: 'static-target-unsupported' });
        expect(fs.existsSync(path.join(dir, 'terraform', 'cron.tf'))).toBe(false);
        expect(trackEvent).toHaveBeenCalledWith('add_run', expect.objectContaining({
            error_code: 'STATIC_TARGET_UNSUPPORTED',
        }));
    });
});

describe('S33: current-revision rollback', () => {
    const arn = (rev) => `arn:aws:ecs:us-east-2:123456789012:task-definition/myapp-task:${rev}`;

    function ecsOptions(dir, overrides = {}) {
        return {
            cwd: dir,
            projectName: 'myapp',
            cluster: 'myapp-cluster',
            service: 'myapp-service',
            region: 'us-east-2',
            pollIntervalMs: 1,
            timeoutMs: 50,
            isHeadless: true,
            ...overrides,
        };
    }

    it('requesting the deployed revision warns instead of silent-redeploy', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        const ecsClient = {
            send: vi.fn(async (command) => {
                const name = command.constructor.name;
                if (name === 'DescribeServicesCommand') {
                    return {
                        services: [{
                            serviceName: 'myapp-service',
                            status: 'ACTIVE',
                            taskDefinition: arn(5),
                            desiredCount: 1,
                            runningCount: 1,
                        }],
                    };
                }
                if (name === 'DescribeTaskDefinitionCommand') {
                    return { taskDefinition: { taskDefinitionArn: arn(5), family: 'myapp-task', revision: 5, status: 'ACTIVE' } };
                }
                throw new Error(`unexpected ECS command: ${name}`);
            }),
        };
        const result = await runRollback(ecsOptions(dir, { revision: '5', skipWait: true, ecsClient }));
        expect(result).toMatchObject({ ok: false, reason: 'rollback-current-revision' });
        expect(output()).toMatch(/already|current/i);
        expect(ecsClient.send.mock.calls.some(([c]) => c.constructor.name === 'UpdateServiceCommand')).toBe(false);
    });

    it('headless selects the newest eligible revision', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        const ecsClient = {
            send: vi.fn(async (command) => {
                const name = command.constructor.name;
                if (name === 'DescribeServicesCommand') {
                    return {
                        services: [{
                            serviceName: 'myapp-service',
                            status: 'ACTIVE',
                            taskDefinition: arn(5),
                            desiredCount: 1,
                            runningCount: 1,
                        }],
                    };
                }
                if (name === 'ListTaskDefinitionsCommand') return { taskDefinitionArns: [arn(5), arn(4), arn(3)] };
                if (name === 'UpdateServiceCommand') return {};
                throw new Error(`unexpected ECS command: ${name}`);
            }),
        };
        const result = await runRollback(ecsOptions(dir, { skipWait: true, ecsClient }));
        expect(result).toMatchObject({ ok: true, targetRevision: '4' });
    });

    it('interactive prompts over at most five newest eligible revisions', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        const ecsClient = {
            send: vi.fn(async (command) => {
                const name = command.constructor.name;
                if (name === 'DescribeServicesCommand') {
                    return {
                        services: [{
                            serviceName: 'myapp-service',
                            status: 'ACTIVE',
                            taskDefinition: arn(9),
                            desiredCount: 1,
                            runningCount: 1,
                        }],
                    };
                }
                if (name === 'ListTaskDefinitionsCommand') {
                    return { taskDefinitionArns: [arn(8), arn(7), arn(6), arn(5), arn(4), arn(3), arn(2)] };
                }
                if (name === 'DescribeTaskDefinitionCommand') {
                    const rev = Number(String(command.input.taskDefinition).split(':').pop());
                    return {
                        taskDefinition: {
                            taskDefinitionArn: arn(rev),
                            revision: rev,
                            status: 'ACTIVE',
                            containerDefinitions: [{ image: 'myapp:rev' }],
                            registeredAt: '2026-01-01T00:00:00Z',
                        },
                    };
                }
                if (name === 'UpdateServiceCommand') return {};
                throw new Error(`unexpected ECS command: ${name}`);
            }),
        };
        mockSelect.mockResolvedValueOnce(arn(8));
        const result = await runRollback(ecsOptions(dir, { isHeadless: false, skipWait: true, ecsClient }));
        expect(result).toMatchObject({ ok: true, targetRevision: '8' });
        const promptOptions = mockSelect.mock.calls[0][0].options;
        expect(promptOptions).toHaveLength(5);
        expect(promptOptions[0].value).toBe(arn(8));
    });
});

describe('S34: corrupt ledger quarantine', () => {
    it('unparseable sleep-state.json is quarantined, not read as {}', async () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, '.grada'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.grada', 'sleep-state.json'), '{not json!!!');
        const state = readSleepState(dir);
        expect(state).toEqual({});
        const leftovers = fs.readdirSync(path.join(dir, '.grada'));
        expect(leftovers.some((e) => e.startsWith('sleep-state.json.corrupt.'))).toBe(true);
    });

    it('prints a one-line notice naming the quarantine file', async () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, '.grada'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.grada', 'sleep-state.json'), '{not json!!!');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            readSleepState(dir);
            const [backup] = fs.readdirSync(path.join(dir, '.grada'))
                .filter((e) => e.startsWith('sleep-state.json.corrupt.'));
            expect(backup).toBeDefined();
            // Assert before the finally restores the spy: mockRestore
            // clears the recorded calls along with the implementation.
            const notice = logSpy.mock.calls
                .map((call) => stripVTControlCharacters(String(call[0] ?? '')))
                .find((line) => line.includes(backup));
            expect(notice).toBeDefined();
            expect(notice).toContain('quarantined');
        } finally {
            logSpy.mockRestore();
        }
    });
});

describe('S35: wake clears sleep auto-vars first', () => {
    it('wake deletes sleep.auto.tfvars before its restore apply', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        const tfvarsPath = path.join(dir, 'terraform', 'sleep.auto.tfvars');
        fs.writeFileSync(tfvarsPath, 'asleep = true\n');
        writeSleepState(dir, {
            default: {
                env: 'default',
                sleptAt: new Date().toISOString(),
                autoRestartAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
                services: { app: 1, worker: 0 },
                dbId: null,
                dbKind: 'none',
            },
        });
        const target = resolveSleepTarget({ projectName: 'myapp', region: 'us-east-2' }, dir);
        const { ecsClient, rdsClient } = mockSleepClients({
            ecs: { [target.appService]: activeService(target.appService, 0) },
            db: null,
        });
        let tfvarsExistedAtApply = null;
        runTerraformCommand.mockImplementationOnce(async () => {
            tfvarsExistedAtApply = fs.existsSync(tfvarsPath);
        });
        const result = await runWake({ cwd: dir, projectName: 'myapp', region: 'us-east-2', noWait: true, ecsClient, rdsClient });
        expect(result.ok).toBe(true);
        expect(fs.existsSync(tfvarsPath)).toBe(false);
        expect(tfvarsExistedAtApply).toBe(false);
    });
});

describe('S36: deep deletion predicate', () => {
    it('same-prefix foreign and untagged resources never enter the deletion set', async () => {
        const dir = makeTmp();
        writeEcsMainTf(dir);
        writeBackendWithBucket(dir);
        const { ecrClient, logsClient, ec2Client, secretsClient } = scriptedGcClients({
            vpcs: [
                { VpcId: 'vpc-foreign', Tags: gcTagFixtures('myapp-evil') },
                { VpcId: 'vpc-legacy' },
                { VpcId: 'vpc-own', Tags: gcTagFixtures('myapp') },
            ],
        });
        const result = await runGc({ cwd: dir, projectName: 'myapp', region: 'us-east-2', deep: true, ecrClient, logsClient, ec2Client, secretsClient });
        expect(result.deep.deletable.map((r) => r.id)).toEqual(['vpc-own']);
        expect(result.deep.reportOnly.map((r) => r.id)).toEqual(expect.arrayContaining(['vpc-foreign', 'vpc-legacy']));
    });
});

describe('S37: deletion-protection remedy', () => {
    it('destroy blocked by deletion protection names --allow-data-loss', async () => {
        const dir = makeTmp();
        writeBackendWithBucket(dir);
        writeEcsMainTf(dir);
        process.chdir(dir);
        runTerraformCommand.mockResolvedValueOnce(undefined);
        runTerraformCommand.mockRejectedValueOnce(new Error('Error: deleting RDS DB Instance (myapp-db): InvalidDBInstanceState: The DB instance has deletion protection enabled and cannot be deleted'));
        const result = await destroyModule.destroyStack({ isHeadless: true, rdsClient: rdsNotFoundClient() });
        expect(result).toMatchObject({ ok: false, reason: 'deletion-protection-active' });
        expect(output()).toContain('--allow-data-loss');
        expect(output()).toContain('WITHOUT a final snapshot');
        expect(output()).toContain('all data is permanently destroyed');
        expect(output()).not.toContain('after the pre-destroy snapshot checkpoint');
    });
});
