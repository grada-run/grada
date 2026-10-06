// Target-matrix audit artifact (roadmap: AI-Driven Edge-Case & State
// Transition Audit). Every Day-2 command × every compute target gets one
// verdict: GUARD (refuses cleanly), ADAPT (behaves per target), or
// AGNOSTIC (target-independent by construction). Cells already covered in
// a command's own test file are listed, not duplicated:
//
//   sleep/wake  ecs ADAPT / lambda ADAPT / static GUARD  -> tests/sleep-wake.test.js
//   exec        ecs ADAPT / lambda GUARD / static GUARD  -> tests/exec.test.js
//   rollback    ecs ADAPT / lambda GUARD / static GUARD  -> tests/rollback.test.js
//   logs        ecs ADAPT / lambda ADAPT / static ADAPT  -> tests/logs.test.js + below
//   add sqs     ecs ADAPT / lambda WARN  / static WARN   -> tests/add.test.js + below
//   status      ecs/lambda/static ADAPT                  -> tests/status.test.js
//
// This file proves every remaining cell: diagnose, db ×6, secrets ×3,
// gc, alerts, logs-static, add-sqs-static, eject, drift, doctor,
// destroy, and mcp analyze_stack.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// before the rest of the module graph is evaluated.
import { clackPromptsMockFactory } from './helpers/clack.js';
import { telemetryMockFactory } from './helpers/telemetry.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import { runDiagnose } from '../src/commands/diagnose.js';
import { runDb, DB_SUBCOMMANDS } from '../src/commands/db.js';
import { pushSecrets, pullSecrets, auditSecrets } from '../src/commands/secrets.js';
import { runGc } from '../src/commands/gc.js';
import { runAlerts } from '../src/commands/alerts.js';
import { runLogs } from '../src/commands/logs.js';
import { runAdd } from '../src/commands/add.js';
import { ejectStack } from '../src/commands/eject.js';
import { runDrift } from '../src/commands/drift.js';
import { runDoctor } from '../src/commands/doctor.js';
import { destroyStack } from '../src/commands/destroy.js';
import { handleAnalyzeStack } from '../src/commands/mcp.js';
import { log } from '@clack/prompts';
import { trackEvent } from '../src/core/telemetry.js';
import { teardownStateBucket } from '../src/utils/aws.js';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock('@clack/prompts', () => clackPromptsMockFactory());
vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, spawn: mockSpawn };
});
vi.mock('../src/utils/aws.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
    TROUBLESHOOTING_URL: actual.TROUBLESHOOTING_URL,
    checkAwsCredentials: vi.fn().mockResolvedValue({ accountId: '123456789012', region: 'us-east-2' }),
    provisionStateBucket: vi.fn().mockResolvedValue({ awsAccountId: '123456789012', stateBucketName: 'mock-tf-state-bucket' }),
    teardownStateBucket: vi.fn().mockResolvedValue(true),
    isAuthError: () => false,
    handleAuthErrorBranch: () => false,
    // Injected clients pass through; the default client models "nothing
    // provisioned" so no-database paths resolve to null.
    resolveClient: (injected) => injected ?? {
        send: async (command) => {
            const name = command.constructor.name;
            if (name === 'DescribeDBInstancesCommand') {
                throw Object.assign(new Error('DBInstanceNotFound'), { name: 'DBInstanceNotFound' });
            }
            if (name === 'DescribeDBClustersCommand') {
                throw Object.assign(new Error('DBClusterNotFoundFault'), { name: 'DBClusterNotFoundFault' });
            }
            throw new Error(`unexpected command ${name}`);
        },
    },
    };
});
vi.mock('../src/utils/system.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, checkDependency: vi.fn().mockResolvedValue(true) };
});

const STATIC_TF = 'locals {\n  app_name = "myapp"\n}\nresource "aws_cloudfront_distribution" "site" {}\n';

let root;
let exitSpy;
let logSpy;
let originalCwd;

function makeProject(name, mainTf = STATIC_TF, extraFiles = {}) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), mainTf);
    for (const [rel, content] of Object.entries(extraFiles)) {
        const target = path.join(dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    return dir;
}

function makeChild({ code = 0, stdout = '', stderr = '' } = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('close', code);
    });
    return child;
}

beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'target-matrix-'));
    originalCwd = process.cwd();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    mockSpawn.mockImplementation(() => makeChild({ stdout: 'Apply complete!\n' }));
});

afterEach(() => {
    process.chdir(originalCwd);
    exitSpy.mockRestore();
    logSpy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
});

function output() {
    return stripVTControlCharacters(logSpy.mock.calls.map((call) => String(call[0])).join('\n'));
}

describe('matrix: diagnose (GUARD static)', () => {
    it('fails fast on static before any AWS lookup', async () => {
        const dir = makeProject('diagnose-static');
        const ecsClient = { send: vi.fn() };
        const logsClient = { send: vi.fn() };
        const result = await runDiagnose({ cwd: dir, json: true, ecsClient, logsClient });
        expect(result).toMatchObject({ ok: false, reason: 'static-target-unsupported' });
        expect(ecsClient.send).not.toHaveBeenCalled();
        expect(logsClient.send).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(output()).toContain('not supported on Static targets');
    });
});

describe('matrix: db suite (GUARD static × 6)', () => {
    it.each(DB_SUBCOMMANDS)('db %s fails cleanly on static', async (subcommand) => {
        const dir = makeProject(`db-${subcommand}-static`);
        const result = await runDb(['db', subcommand], { cwd: dir, json: true });
        expect(result).toMatchObject({ ok: false, reason: 'static-target-unsupported' });
        expect(exitSpy).not.toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith('db_run', expect.objectContaining({
            error_code: 'STATIC_TARGET_UNSUPPORTED',
        }));
    });

    it('still shows usage for missing/unknown subcommands (guard only wraps known ones)', async () => {
        const dir = makeProject('db-usage-static');
        const result = await runDb(['db'], { cwd: dir, json: true });
        expect(result).toMatchObject({ ok: false, reason: 'unknown-db-subcommand' });
    });
});

describe('matrix: secrets suite (GUARD static × 3)', () => {
    it.each([
        ['push', pushSecrets, 'secrets_pushed'],
        ['pull', pullSecrets, 'secrets_pull'],
        ['audit', auditSecrets, 'secrets_audit'],
    ])('secrets %s fails cleanly on static without touching AWS', async (name, fn, event) => {
        const dir = makeProject(`secrets-${name}-static`);
        fs.writeFileSync(path.join(dir, '.env'), 'FOO=bar\n');
        process.chdir(dir);
        try {
            const result = await fn('.env', 'myapp', {});
            expect(result).toMatchObject({ ok: false, reason: 'static-target-unsupported' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(trackEvent).toHaveBeenCalledWith(event, expect.objectContaining({
                error_code: 'STATIC_TARGET_UNSUPPORTED',
            }));
        } finally {
            process.chdir(originalCwd);
        }
    });
});

describe('matrix: gc (ADAPT — clean exit on static)', () => {
    it('reports zero orphans on static without prompting', async () => {
        const dir = makeProject('gc-static');
        const empty = () => ({ send: vi.fn(async () => ({})) });
        const result = await runGc({
            cwd: dir, projectName: 'myapp', region: 'us-east-2',
            ecrClient: empty(), logsClient: empty(), ec2Client: empty(),
        });
        expect(result.totalCount).toBe(0);
        expect(result.deleted).toBe(false);
        expect(exitSpy).not.toHaveBeenCalled();
    });
});

describe('matrix: alerts (GUARD static)', () => {
    it('exits with the ECS-only error on static', async () => {
        const dir = makeProject('alerts-static');
        const result = await runAlerts({ cwd: dir, projectName: 'myapp', region: 'us-east-2' });
        expect(result).toMatchObject({ ok: false, reason: 'alerts-target-unsupported' });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(output()).toContain('detected target: static');
    });
});

describe('matrix: logs (ADAPT static via missing-group guidance)', () => {
    it('prints guidance instead of crashing on static', async () => {
        const dir = makeProject('logs-static');
        const logsClient = {
            send: vi.fn(async () => {
                throw Object.assign(new Error('The specified log group does not exist.'), { name: 'ResourceNotFoundException' });
            }),
        };
        const result = await runLogs({ cwd: dir, projectName: 'myapp', region: 'us-east-2', tail: 5, logsClient });
        expect(result.logs).toEqual([]);
        expect(result.logGroup).toBeTruthy();
    });
});

describe('matrix: add queue:sqs (WARN static)', () => {
    it('warns on static and never creates worker.tf', async () => {
        const dir = makeProject('add-sqs-static');
        const result = await runAdd({ cwd: dir, capability: 'queue:sqs' });
        expect(result.ok).toBe(true);
        expect(fs.existsSync(path.join(dir, 'terraform', 'sqs.tf'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'terraform', 'worker.tf'))).toBe(false);
        expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('long-running workers require ECS'));
    });
});

describe('matrix: eject (AGNOSTIC)', () => {
    it('strips metadata on static exactly like any target', async () => {
        const dir = makeProject('eject-static', `${STATIC_TF}\ndefault_tags {\n  tags = {\n    ManagedBy = "grada"\n  }\n}\n`);
        process.chdir(dir);
        try {
            await ejectStack({ yes: true });
            const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
            expect(mainTf).not.toContain('ManagedBy');
            expect(trackEvent).toHaveBeenCalledWith('project_ejected', expect.anything());
            expect(exitSpy).not.toHaveBeenCalled();
        } finally {
            process.chdir(originalCwd);
        }
    });
});

describe('matrix: drift (AGNOSTIC)', () => {
    it('checks a static plan with no target branch', async () => {
        const dir = makeProject('drift-static');
        const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: 'No changes. Your infrastructure matches the configuration.\n', stderr: '' }));
        const result = await runDrift({ cwd: dir, projectName: 'myapp', region: 'us-east-2', spawnSyncImpl, json: true });
        expect(result).toMatchObject({ ok: true, action: 'check', drift: false });
        expect(spawnSyncImpl).toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
    });
});

describe('matrix: doctor (AGNOSTIC)', () => {
    it('checks the toolchain identically regardless of target', async () => {
        makeProject('doctor-static');
        await runDoctor();
        expect(trackEvent).toHaveBeenCalledWith('doctor_run', expect.objectContaining({ success: true }));
    });
});

describe('matrix: destroy (AGNOSTIC)', () => {
    it('destroys a static project with no database settle and no target branch', async () => {
        const dir = makeProject('destroy-static', STATIC_TF, {
            'terraform/backend.tf': 'terraform {\n  backend "s3" {\n    bucket = "myapp-tf-state"\n    region = "us-east-2"\n  }\n}\n',
        });
        const rdsClient = {
            send: vi.fn(async (command) => {
                const name = command.constructor.name;
                if (name === 'DescribeDBInstancesCommand') {
                    throw Object.assign(new Error('DBInstanceNotFound'), { name: 'DBInstanceNotFound' });
                }
                if (name === 'DescribeDBClustersCommand') {
                    throw Object.assign(new Error('DBClusterNotFoundFault'), { name: 'DBClusterNotFoundFault' });
                }
                throw new Error(`unexpected command ${name}`);
            }),
        };
        process.chdir(dir);
        try {
            await destroyStack({ yes: true, rdsClient });
            expect(mockSpawn).toHaveBeenCalledWith('terraform', expect.arrayContaining(['destroy']), expect.anything());
            expect(vi.mocked(teardownStateBucket)).toHaveBeenCalled();
            expect(exitSpy).not.toHaveBeenCalled();
        } finally {
            process.chdir(originalCwd);
        }
    });
});

describe('matrix: mcp analyze_stack (ADAPT)', () => {
    it('reports the static target', async () => {
        const dir = makeProject('mcp-static');
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '*' } }));
        const result = await handleAnalyzeStack({ cwd: dir });
        expect(JSON.parse(result.content[0].text)).toMatchObject({ computeTarget: 'static' });
    });
});
