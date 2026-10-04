import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackPromptsMockFactory } from './helpers/clack.js';
import { telemetryMockFactory } from './helpers/telemetry.js';
import { createTmpDirTracker } from './helpers/tmpdir.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stripVTControlCharacters } from 'node:util';
import { runSleep, parseSleepArgs } from '../src/commands/sleep.js';
import { runWake, parseWakeArgs } from '../src/commands/wake.js';
import {
    resolveSleepTarget,
    normalizeSleepEnv,
    readSleepState,
    writeSleepState,
    removeSleepStateEntry,
    ensureSleepGitignore,
    computeAutoRestartAt,
    formatUtcTimestamp,
    RDS_AUTO_RESTART_MS,
} from '../src/utils/sleep-state.js';
import { estimateSleepSavings } from '../src/utils/visualizer.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';
import { confirm } from '@clack/prompts';
import {
    readCronScheduleName,
    setSchedulerState,
    setWorkerScalingSuspended,
} from '../src/utils/sleep-targets.js';

vi.mock('@clack/prompts', () => clackPromptsMockFactory());

vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));

vi.mock('../src/utils/aws.js', () => ({
    handleAuthErrorBranch: () => false,
    resolveClient: (injected) => injected,
}));

const tmp = createTmpDirTracker();
let exitSpy;
let logSpy;

function makeTmp() {
    return tmp.makeTmp('sleep-wake-test-');
}

// Minimal ECS/RDS recorder: `ecs` maps service names to service objects,
// `db` is the findDbTarget result inputs ({ instance, cluster }).
function mockClients({ ecs = {}, db = null, onCommand = null } = {}) {
    const seen = [];
    const ecsClient = {
        send: vi.fn(async (command) => {
            seen.push(command.constructor.name);
            if (onCommand) await onCommand(command);
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
            seen.push(command.constructor.name);
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
    return { ecsClient, rdsClient, seen };
}

function activeService(name, desiredCount) {
    return { serviceName: name, status: 'ACTIVE', desiredCount, runningCount: desiredCount };
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

describe('parseSleepArgs / parseWakeArgs', () => {
    it('parses the positional env and sleep flags', () => {
        const options = parseSleepArgs(['sleep', 'staging', '--skip-db', '--region', 'eu-west-1', '--yes']);
        expect(options).toMatchObject({ env: 'staging', skipDb: true, region: 'eu-west-1', yes: true });
    });

    it('parses wake flags including --no-wait and --workspace', () => {
        const options = parseWakeArgs(['wake', '--no-wait', '--workspace', 'pr-42']);
        expect(options).toMatchObject({ noWait: true, workspace: 'pr-42' });
        expect(options.env).toBeUndefined();
    });

    it('drops confirmation flags that wake never reads', () => {
        const options = parseWakeArgs(['wake', '--no-wait', '--yes', '--force', '--headless']);
        expect(options.noWait).toBe(true);
        expect(options.yes).toBeUndefined();
        expect(options.force).toBeUndefined();
        expect(options.headless).toBeUndefined();
    });

    it('collects extra positionals for the guard', () => {
        expect(parseSleepArgs(['sleep', 'a', 'b']).unexpectedPositionals).toEqual(['b']);
    });
});

describe('normalizeSleepEnv', () => {
    it('maps default aliases and passes named envs through', () => {
        expect(normalizeSleepEnv('default')).toBe('default');
        expect(normalizeSleepEnv('prod')).toBe('default');
        expect(normalizeSleepEnv('Production')).toBe('default');
        expect(normalizeSleepEnv('staging')).toBe('staging');
        expect(normalizeSleepEnv('  pr-42  ')).toBe('pr-42');
    });

    it('returns null for blank or non-string input', () => {
        expect(normalizeSleepEnv('')).toBeNull();
        expect(normalizeSleepEnv('   ')).toBeNull();
        expect(normalizeSleepEnv(undefined)).toBeNull();
        expect(normalizeSleepEnv(42)).toBeNull();
    });
});

describe('resolveSleepTarget', () => {
    it('resolves default names with no env', () => {
        const dir = makeTmp();
        const target = resolveSleepTarget({ projectName: 'myapp' }, dir);
        expect(target).toMatchObject({
            envKey: 'default',
            envKind: 'default',
            requiresConfirm: true,
            appPrefix: 'myapp',
            cluster: 'myapp-cluster',
            appService: 'myapp-service',
            workerService: 'myapp-worker-service',
            dbIdentifier: 'myapp-db',
            dbClusterIdentifier: 'myapp-db-cluster',
        });
    });

    it('namespaces names for a positional env', () => {
        const dir = makeTmp();
        const target = resolveSleepTarget({ projectName: 'myapp', env: 'staging' }, dir);
        expect(target).toMatchObject({
            envKey: 'staging',
            envKind: 'named',
            requiresConfirm: false,
            appPrefix: 'myapp-staging',
            cluster: 'myapp-staging-cluster',
            workerService: 'myapp-staging-worker-service',
            dbIdentifier: 'myapp-staging-db',
        });
    });

    it('prefers --workspace over the positional env', () => {
        const dir = makeTmp();
        const target = resolveSleepTarget({ projectName: 'myapp', env: 'staging', workspace: 'pr-42' }, dir);
        expect(target.envKey).toBe('pr-42');
        expect(target.appPrefix).toBe('myapp-pr-42');
    });

    it('lets explicit resource flags win', () => {
        const dir = makeTmp();
        const target = resolveSleepTarget({
            projectName: 'myapp',
            env: 'staging',
            cluster: 'custom-cluster',
            service: 'custom-service',
            dbIdentifier: 'custom-db',
        }, dir);
        expect(target.cluster).toBe('custom-cluster');
        expect(target.appService).toBe('custom-service');
        expect(target.dbIdentifier).toBe('custom-db');
    });

    it('requires confirmation for prod aliases and auto-detected workspaces', () => {
        const dir = makeTmp();
        expect(resolveSleepTarget({ projectName: 'myapp', env: 'prod' }, dir).requiresConfirm).toBe(true);
        fs.mkdirSync(path.join(dir, '.terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.terraform', 'environment'), 'pr-42');
        const auto = resolveSleepTarget({ projectName: 'myapp' }, dir);
        expect(auto.envKey).toBe('pr-42');
        expect(auto.requiresConfirm).toBe(true);
    });
});

describe('sleep-state ledger', () => {
    it('round-trips entries and removes by env', () => {
        const dir = makeTmp();
        expect(readSleepState(dir)).toEqual({});
        writeSleepState(dir, { staging: { env: 'staging' } });
        expect(readSleepState(dir)).toEqual({ staging: { env: 'staging' } });
        expect(removeSleepStateEntry(dir, 'staging')).toBe(true);
        expect(removeSleepStateEntry(dir, 'staging')).toBe(false);
        expect(readSleepState(dir)).toEqual({});
    });

    it('reads corrupt files as empty', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, '.grada'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.grada', 'sleep-state.json'), '{nope');
        expect(readSleepState(dir)).toEqual({});
    });

    it('falls back to the legacy ledger path', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, '.deploy-stack'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, '.deploy-stack', 'sleep-state.json'),
            JSON.stringify({ default: { env: 'default' } })
        );
        expect(readSleepState(dir)).toEqual({ default: { env: 'default' } });
    });

    it('prefers the new ledger path over legacy', () => {
        const dir = makeTmp();
        writeSleepState(dir, { staging: { env: 'staging' } });
        fs.mkdirSync(path.join(dir, '.deploy-stack'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, '.deploy-stack', 'sleep-state.json'),
            JSON.stringify({ default: { env: 'default' } })
        );
        expect(readSleepState(dir)).toEqual({ staging: { env: 'staging' } });
    });

    it('gitignores the ledger exactly once', () => {
        const dir = makeTmp();
        expect(ensureSleepGitignore(dir)).toBe(true);
        expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.grada/');
        expect(ensureSleepGitignore(dir)).toBe(false);
    });

    it('leaves a legacy gitignore rule intact while adding the new one', () => {
        const dir = makeTmp();
        fs.writeFileSync(path.join(dir, '.gitignore'), '# Local deploy-stack runtime state (sleep/wake)\n.deploy-stack/\n');
        expect(ensureSleepGitignore(dir)).toBe(true);
        const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
        expect(content).toContain('.deploy-stack/');
        expect(content).toContain('.grada/');
        expect(ensureSleepGitignore(dir)).toBe(false);
    });

    it('computes the 7-day auto-restart timestamp in UTC', () => {
        const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
        expect(computeAutoRestartAt(nowMs).getTime()).toBe(nowMs + RDS_AUTO_RESTART_MS);
        expect(formatUtcTimestamp(computeAutoRestartAt(nowMs))).toBe('2026-01-08 12:00 UTC');
    });
});

describe('estimateSleepSavings', () => {
    it('pauses Fargate replicas plus RDS compute, never storage', () => {
        const savings = estimateSleepSavings({ hasDb: true, appReplicas: 1, workerReplicas: 0 });
        expect(savings.fargateMonthly).toBe('9.01');
        expect(savings.dbComputeMonthly).toBe('11.68');
        expect(savings.monthly).toBe('20.69');
        expect(savings.hourly).toBe('0.028');
    });

    it('counts the worker and zeroes Aurora compute', () => {
        const withWorker = estimateSleepSavings({ hasDb: true, appReplicas: 1, workerReplicas: 1 });
        expect(withWorker.monthly).toBe('29.70');
        const aurora = estimateSleepSavings({ hasDb: true, dbEngine: 'aurora-postgresql', appReplicas: 1 });
        expect(aurora.dbComputeMonthly).toBe('0.00');
        expect(aurora.monthly).toBe('9.01');
    });
});

describe('runSleep', () => {
    function sleepOptions(dir, overrides = {}) {
        return {
            cwd: dir,
            projectName: 'myapp',
            region: 'us-east-2',
            env: 'staging',
            nowMs: Date.UTC(2026, 0, 1, 12, 0, 0),
            ...overrides,
        };
    }

    it('scales services to zero, stops the instance, and persists state', async () => {
        const dir = makeTmp();
        const { ecsClient, rdsClient, seen } = mockClients({
            ecs: {
                'myapp-staging-service': activeService('myapp-staging-service', 1),
                'myapp-staging-worker-service': activeService('myapp-staging-worker-service', 2),
            },
            db: { instance: { Engine: 'postgres', Status: 'available', DBName: 'db' } },
        });
        const result = await runSleep(sleepOptions(dir, { ecsClient, rdsClient }));
        expect(result.ok).toBe(true);
        expect(result.ecsScaled).toBe(2);
        expect(result.dbStopped).toBe(true);
        expect(seen).toContain('UpdateServiceCommand');
        expect(seen).toContain('StopDBInstanceCommand');
        expect(exitSpy).not.toHaveBeenCalled();

        const state = readSleepState(dir);
        expect(state.staging).toMatchObject({
            env: 'staging',
            services: { app: 1, worker: 2 },
            dbKind: 'instance',
        });
        expect(state.staging.autoRestartAt).toBe('2026-01-08T12:00:00.000Z');
        expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.grada/');

        const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
        expect(output).toContain('2026-01-08 12:00 UTC');
        expect(output).toContain('Estimated Savings While Asleep');
        expect(output).toContain('npx grada-run wake staging');
        expect(trackEvent).toHaveBeenCalledWith('sleep_run', expect.objectContaining({
            env_kind: 'named', ecs_scaled: 2, db_stopped: true, db_kind: 'instance', success: true,
        }));
    });

    it('stops Aurora clusters with StopDBClusterCommand', async () => {
        const dir = makeTmp();
        const { ecsClient, rdsClient, seen } = mockClients({
            ecs: { 'myapp-staging-service': activeService('myapp-staging-service', 1) },
            db: { cluster: { Engine: 'aurora-postgresql', Status: 'available' } },
        });
        const result = await runSleep(sleepOptions(dir, { ecsClient, rdsClient }));
        expect(result.ok).toBe(true);
        expect(result.dbKind).toBe('cluster');
        expect(seen).toContain('StopDBClusterCommand');
        expect(seen).not.toContain('StopDBInstanceCommand');
    });

    it('is idempotent when services are already asleep and the db is stopped', async () => {
        const dir = makeTmp();
        const { ecsClient, rdsClient, seen } = mockClients({
            ecs: { 'myapp-staging-service': activeService('myapp-staging-service', 0) },
            db: { instance: { Engine: 'postgres', Status: 'stopped' } },
        });
        const result = await runSleep(sleepOptions(dir, { ecsClient, rdsClient }));
        expect(result.ok).toBe(true);
        expect(result.ecsScaled).toBe(0);
        expect(result.dbStopped).toBe(false);
        expect(seen).not.toContain('UpdateServiceCommand');
        expect(seen).not.toContain('StopDBInstanceCommand');
        // No ledger history: defaults restore to 1/0 (no worker service live).
        expect(readSleepState(dir).staging.services).toEqual({ app: 1, worker: 0 });
    });

    it('preserves the original replica counts on a repeat sleep', async () => {
        const dir = makeTmp();
        const ecs = { 'myapp-staging-service': activeService('myapp-staging-service', 3) };
        const first = mockClients({ ecs, db: { instance: { Engine: 'postgres', Status: 'available' } } });
        await runSleep(sleepOptions(dir, { ecsClient: first.ecsClient, rdsClient: first.rdsClient }));
        expect(readSleepState(dir).staging.services.app).toBe(3);
        const second = mockClients({ ecs, db: { instance: { Engine: 'postgres', Status: 'stopping' } } });
        await runSleep(sleepOptions(dir, { ecsClient: second.ecsClient, rdsClient: second.rdsClient }));
        expect(readSleepState(dir).staging.services.app).toBe(3);
    });

    it('honors --skip-db and skips transitional databases', async () => {
        const dir = makeTmp();
        const skipped = mockClients({
            ecs: { 'myapp-staging-service': activeService('myapp-staging-service', 1) },
            db: { instance: { Engine: 'postgres', Status: 'available' } },
        });
        await runSleep(sleepOptions(dir, { ecsClient: skipped.ecsClient, rdsClient: skipped.rdsClient, skipDb: true }));
        expect(skipped.seen).not.toContain('DescribeDBInstancesCommand');

        const transitional = mockClients({
            ecs: { 'myapp-staging-service': activeService('myapp-staging-service', 1) },
            db: { instance: { Engine: 'postgres', Status: 'starting' } },
        });
        const result = await runSleep(sleepOptions(dir, { ecsClient: transitional.ecsClient, rdsClient: transitional.rdsClient }));
        expect(result.ok).toBe(true);
        expect(result.dbStopped).toBe(false);
        expect(transitional.seen).not.toContain('StopDBInstanceCommand');
    });

    it('fails when nothing exists to sleep', async () => {
        const dir = makeTmp();
        const { ecsClient, rdsClient } = mockClients({});
        const result = await runSleep(sleepOptions(dir, { ecsClient, rdsClient }));
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('nothing-to-sleep');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('guards the default environment: headless requires --yes', async () => {
        const dir = makeTmp();
        const { ecsClient, rdsClient } = mockClients({
            ecs: { 'myapp-service': activeService('myapp-service', 1) },
        });
        const denied = await runSleep({ cwd: dir, projectName: 'myapp', region: 'us-east-2', isHeadless: true, ecsClient, rdsClient });
        expect(denied.ok).toBe(false);
        expect(denied.reason).toBe('confirmation-required');
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(ecsClient.send).not.toHaveBeenCalled();

        vi.mocked(confirm).mockResolvedValueOnce(false);
        const declined = await runSleep({ cwd: dir, projectName: 'myapp', region: 'us-east-2', isHeadless: false, ecsClient, rdsClient });
        expect(declined).toMatchObject({ ok: false, reason: 'cancelled' });

        vi.mocked(confirm).mockResolvedValueOnce(true);
        const accepted = await runSleep({ cwd: dir, projectName: 'myapp', region: 'us-east-2', isHeadless: false, ecsClient, rdsClient });
        expect(accepted.ok).toBe(true);
        expect(vi.mocked(confirm)).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    });
});

describe('runWake', () => {
    function wakeOptions(dir, overrides = {}) {
        return {
            cwd: dir,
            projectName: 'myapp',
            region: 'us-east-2',
            env: 'staging',
            pollIntervalMs: 1,
            timeoutMs: 1000,
            ...overrides,
        };
    }

    it('starts the database first, then restores ledger counts', async () => {
        const dir = makeTmp();
        writeSleepState(dir, {
            staging: {
                env: 'staging',
                sleptAt: new Date().toISOString(),
                autoRestartAt: new Date(Date.now() + 3600_000).toISOString(),
                services: { app: 2, worker: 1 },
                dbId: 'myapp-staging-db',
                dbKind: 'instance',
            },
        });
        const db = { instance: { Engine: 'postgres', Status: 'stopped' } };
        const order = [];
        const { ecsClient, rdsClient } = mockClients({
            ecs: {
                'myapp-staging-service': { ...activeService('myapp-staging-service', 0), runningCount: 2 },
                'myapp-staging-worker-service': { ...activeService('myapp-staging-worker-service', 0), runningCount: 1 },
            },
            db,
            onCommand: async (command) => {
                if (command.constructor.name === 'StartDBInstanceCommand') order.push('start-db');
                if (command.constructor.name === 'UpdateServiceCommand') order.push('restore-ecs');
            },
        });
        // RDS reports available as soon as the start lands.
        rdsClient.send.mockImplementation(async (command) => {
            const name = command.constructor.name;
            if (name === 'DescribeDBInstancesCommand') {
                if (db.instance.Status === 'starting') db.instance.Status = 'available';
                return { DBInstances: [db.instance] };
            }
            if (name === 'StartDBInstanceCommand') {
                order.push('start-db');
                db.instance.Status = 'starting';
                return {};
            }
            if (name === 'DescribeDBClustersCommand') throw Object.assign(new Error('x'), { name: 'DBClusterNotFoundFault' });
            throw new Error(`unexpected RDS command: ${name}`);
        });
        const updates = [];
        ecsClient.send.mockImplementation(async (command) => {
            const name = command.constructor.name;
            if (name === 'DescribeServicesCommand') {
                return { services: (command.input.services || []).map((serviceName) => ({
                    serviceName, status: 'ACTIVE', desiredCount: 0, runningCount: serviceName.endsWith('worker-service') ? 1 : 2,
                })) };
            }
            if (name === 'UpdateServiceCommand') {
                order.push('restore-ecs');
                updates.push({ service: command.input.service, desiredCount: command.input.desiredCount });
                return {};
            }
            throw new Error(`unexpected ECS command: ${name}`);
        });

        const result = await runWake(wakeOptions(dir, { ecsClient, rdsClient }));
        expect(result.ok).toBe(true);
        expect(result.dbStarted).toBe(true);
        expect(result.ecsRestored).toBe(2);
        expect(result.waited).toBe(true);
        expect(order[0]).toBe('start-db');
        expect(updates).toContainEqual({ service: 'myapp-staging-service', desiredCount: 2 });
        expect(updates).toContainEqual({ service: 'myapp-staging-worker-service', desiredCount: 1 });
        expect(readSleepState(dir)).toEqual({});
        expect(trackEvent).toHaveBeenCalledWith('wake_run', expect.objectContaining({
            env_kind: 'named', ecs_restored: 2, db_started: true, waited: true, success: true,
        }));
    });

    it('defaults to 1/1 without ledger state and skips waiting with --no-wait', async () => {
        const dir = makeTmp();
        const updates = [];
        const ecsClient = {
            send: vi.fn(async (command) => {
                if (command.constructor.name === 'DescribeServicesCommand') {
                    return { services: (command.input.services || []).map((serviceName) => ({ serviceName, status: 'ACTIVE', desiredCount: 0, runningCount: 0 })) };
                }
                updates.push({ service: command.input.service, desiredCount: command.input.desiredCount });
                return {};
            }),
        };
        const rdsClient = {
            send: vi.fn(async (command) => {
                if (command.constructor.name === 'DescribeDBInstancesCommand') {
                    return { DBInstances: [{ Engine: 'postgres', Status: 'available' }] };
                }
                throw new Error(`unexpected RDS command: ${command.constructor.name}`);
            }),
        };
        const result = await runWake(wakeOptions(dir, { ecsClient, rdsClient, noWait: true }));
        expect(result.ok).toBe(true);
        expect(result.waited).toBe(false);
        expect(result.dbStarted).toBe(false);
        expect(updates).toContainEqual({ service: 'myapp-staging-service', desiredCount: 1 });
        expect(updates).toContainEqual({ service: 'myapp-staging-worker-service', desiredCount: 1 });
        // No polling: two discovery Describes (app + worker), then UpdateService only.
        expect(ecsClient.send.mock.calls.filter(([command]) => command.constructor.name === 'DescribeServicesCommand')).toHaveLength(2);
    });

    it('fails on RDS wake timeout and keeps the ledger for retry', async () => {
        const dir = makeTmp();
        writeSleepState(dir, { staging: { env: 'staging', services: { app: 1, worker: 0 } } });
        const ecsClient = { send: vi.fn(async () => ({ services: [] })) };
        const rdsClient = {
            send: vi.fn(async (command) => {
                if (command.constructor.name === 'DescribeDBInstancesCommand') {
                    return { DBInstances: [{ Engine: 'postgres', Status: 'starting' }] };
                }
                if (command.constructor.name === 'StartDBInstanceCommand') return {};
                throw new Error(`unexpected: ${command.constructor.name}`);
            }),
        };
        // First call: stopped → start; subsequent polls: starting forever.
        let calls = 0;
        const inner = rdsClient.send.getMockImplementation();
        rdsClient.send.mockImplementation(async (command) => {
            if (command.constructor.name === 'DescribeDBInstancesCommand' && calls++ === 0) {
                return { DBInstances: [{ Engine: 'postgres', Status: 'stopped' }] };
            }
            return inner(command);
        });
        const result = await runWake(wakeOptions(dir, {
            ecsClient,
            rdsClient,
            timeoutMs: 0,
            sleepFn: async () => {},
            nowFn: (() => { let now = 1000; return () => now++; })(),
        }));
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('rds-wake-timeout');
        expect(readSleepState(dir).staging).toBeTruthy();
    });

    it('warns when the 7-day window elapsed', async () => {
        const dir = makeTmp();
        writeSleepState(dir, {
            staging: {
                env: 'staging',
                autoRestartAt: new Date(Date.now() - 1000).toISOString(),
                services: { app: 1, worker: 0 },
            },
        });
        const ecsClient = {
            send: vi.fn(async (command) => {
                if (command.constructor.name === 'DescribeServicesCommand') {
                    return { services: [{ serviceName: command.input.services[0], status: 'ACTIVE', desiredCount: 0, runningCount: 1 }] };
                }
                return {};
            }),
        };
        const rdsClient = {
            send: vi.fn(async (command) => {
                if (command.constructor.name === 'DescribeDBInstancesCommand') {
                    return { DBInstances: [{ Engine: 'postgres', Status: 'available' }] };
                }
                throw Object.assign(new Error('x'), { name: 'DBClusterNotFoundFault' });
            }),
        };
        await runWake(wakeOptions(dir, { ecsClient, rdsClient, noWait: true }));
        const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
        expect(output).toContain('7-day sleep window has elapsed');
    });
});

describe('sleep-targets: cron schedule discovery', () => {
    it('resolves the schedule name from cron.tf with the app prefix', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'cron.tf'),
            'resource "aws_scheduler_schedule" "cron" {\n  name = "${local.app_name}-cron-nightly-cleanup"\n}\n'
        );
        expect(readCronScheduleName(dir, 'myapp-staging')).toBe('myapp-staging-cron-nightly-cleanup');
    });

    it('returns null when cron.tf is missing or hand-edited', () => {
        expect(readCronScheduleName(makeTmp(), 'myapp')).toBeNull();
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'terraform', 'cron.tf'), '# nothing scheduled here\n');
        expect(readCronScheduleName(dir, 'myapp')).toBeNull();
    });
});

describe('sleep-targets: scheduler state', () => {
    const scheduleDoc = {
        Name: 'myapp-staging-cron-nightly',
        Arn: 'arn:aws:scheduler:us-east-2:123456789012:schedule/default/myapp-staging-cron-nightly',
        CreationDate: '2026-01-01T00:00:00Z',
        LastModificationDate: '2026-01-02T00:00:00Z',
        State: 'ENABLED',
        ScheduleExpression: 'rate(1 hour)',
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        Target: { Arn: 'arn:aws:ecs:cluster', RoleArn: 'arn:aws:iam:role' },
    };

    it('passes the fetched document back with only State flipped', () => {
        const seen = [];
        const run = vi.fn((cmd, args) => {
            seen.push(args);
            if (args[1] === 'get-schedule') return { status: 0, stdout: JSON.stringify(scheduleDoc), stderr: '' };
            return { status: 0, stdout: '{}', stderr: '' };
        });
        expect(setSchedulerState({ name: scheduleDoc.Name, enabled: false, region: 'us-east-2', run })).toEqual({ ok: true });
        const updateArgs = seen.find((args) => args[1] === 'update-schedule');
        const payload = JSON.parse(updateArgs[updateArgs.indexOf('--cli-input-json') + 1]);
        expect(payload).toMatchObject({
            Name: scheduleDoc.Name,
            State: 'DISABLED',
            ScheduleExpression: 'rate(1 hour)',
            ScheduleExpressionTimezone: 'UTC',
            FlexibleTimeWindow: { Mode: 'OFF' },
            Target: scheduleDoc.Target,
        });
        expect(payload).not.toHaveProperty('Arn');
        expect(payload).not.toHaveProperty('CreationDate');
        expect(payload).not.toHaveProperty('LastModificationDate');
    });

    it('skips the update when already in the desired state', () => {
        const run = vi.fn(() => ({
            status: 0, stdout: JSON.stringify({ ...scheduleDoc, State: 'DISABLED' }), stderr: '',
        }));
        expect(setSchedulerState({ name: scheduleDoc.Name, enabled: false, region: 'us-east-2', run }))
            .toEqual({ ok: true, skipped: 'already' });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('reports undeployed schedules and a missing CLI', () => {
        const notFound = () => ({ status: 254, stdout: '', stderr: 'An error occurred (ResourceNotFoundException) when calling GetSchedule' });
        expect(setSchedulerState({ name: 'x', enabled: false, region: 'us-east-2', run: notFound }).reason).toBe('not-deployed');
        const noCli = () => ({ error: { code: 'ENOENT' } });
        expect(setSchedulerState({ name: 'x', enabled: false, region: 'us-east-2', run: noCli }).reason).toBe('cli-missing');
    });
});

describe('sleep-targets: worker scaling suspend/resume', () => {
    it('suspends all three scaling dimensions when registered', () => {
        const seen = [];
        const run = vi.fn((cmd, args) => {
            seen.push(args);
            if (args[1] === 'describe-scalable-targets') {
                return { status: 0, stdout: JSON.stringify({ ScalableTargets: [{ SuspendedState: {} }] }), stderr: '' };
            }
            return { status: 0, stdout: '{}', stderr: '' };
        });
        const result = setWorkerScalingSuspended({
            cluster: 'myapp-staging-cluster', service: 'myapp-staging-worker-service', suspended: true, region: 'us-east-2', run,
        });
        expect(result).toEqual({ ok: true });
        const register = seen.find((args) => args[1] === 'register-scalable-target');
        expect(register).toContain('service/myapp-staging-cluster/myapp-staging-worker-service');
        const flag = register[register.indexOf('--suspended-state') + 1];
        expect(flag).toContain('DynamicScalingInSuspended=true');
        expect(flag).toContain('DynamicScalingOutSuspended=true');
        expect(flag).toContain('ScheduledScalingSuspended=true');
    });

    it('skips unregistered targets and already-matching state', () => {
        const empty = vi.fn(() => ({ status: 0, stdout: JSON.stringify({ ScalableTargets: [] }), stderr: '' }));
        expect(setWorkerScalingSuspended({ cluster: 'c', service: 's', suspended: true, region: 'us-east-2', run: empty }).reason)
            .toBe('not-registered');
        expect(empty).toHaveBeenCalledTimes(1);
        const already = vi.fn(() => ({
            status: 0,
            stdout: JSON.stringify({ ScalableTargets: [{ SuspendedState: { DynamicScalingInSuspended: true, DynamicScalingOutSuspended: true, ScheduledScalingSuspended: true } }] }),
            stderr: '',
        }));
        expect(setWorkerScalingSuspended({ cluster: 'c', service: 's', suspended: true, region: 'us-east-2', run: already }))
            .toEqual({ ok: true, skipped: 'already' });
        expect(already).toHaveBeenCalledTimes(1);
    });
});

describe('runSleep: cron pause, scaling suspend, and cache note', () => {
    function baseOptions(dir, overrides = {}) {
        return {
            cwd: dir,
            projectName: 'myapp',
            region: 'us-east-2',
            env: 'staging',
            nowMs: Date.UTC(2026, 0, 1, 12, 0, 0),
            ...overrides,
        };
    }

    function writeCronTf(dir, slug = 'nightly') {
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'cron.tf'),
            `resource "aws_scheduler_schedule" "cron" {\n  name = "\${local.app_name}-cron-${slug}"\n}\n`
        );
    }

    it('pauses the cron schedule and suspends worker scaling', async () => {
        const dir = makeTmp();
        writeCronTf(dir);
        fs.writeFileSync(path.join(dir, 'terraform', 'sqs.tf'), '# queue\n');
        fs.writeFileSync(path.join(dir, 'terraform', 'worker.tf'), '# worker\n');
        const { ecsClient, rdsClient } = mockClients({
            ecs: {
                'myapp-staging-service': activeService('myapp-staging-service', 1),
                'myapp-staging-worker-service': activeService('myapp-staging-worker-service', 1),
            },
        });
        const seen = [];
        const spawnSyncImpl = vi.fn((cmd, args) => {
            seen.push(args);
            if (args[1] === 'get-schedule') {
                return {
                    status: 0,
                    stdout: JSON.stringify({
                        State: 'ENABLED',
                        ScheduleExpression: 'rate(1 hour)',
                        ScheduleExpressionTimezone: 'UTC',
                        FlexibleTimeWindow: { Mode: 'OFF' },
                        Target: { Arn: 'a', RoleArn: 'r' },
                    }),
                    stderr: '',
                };
            }
            if (args[1] === 'describe-scalable-targets') {
                return { status: 0, stdout: JSON.stringify({ ScalableTargets: [{ SuspendedState: {} }] }), stderr: '' };
            }
            return { status: 0, stdout: '{}', stderr: '' };
        });
        const result = await runSleep(baseOptions(dir, { ecsClient, rdsClient, skipDb: true, spawnSyncImpl }));
        expect(result.ok).toBe(true);
        expect(result.cronPaused).toBe(true);
        expect(result.scalingSuspended).toBe(true);
        const getArgs = seen.find((args) => args[1] === 'get-schedule');
        expect(getArgs).toContain('myapp-staging-cron-nightly');
        expect(getArgs).toContain('us-east-2');
        const updateArgs = seen.find((args) => args[1] === 'update-schedule');
        expect(JSON.parse(updateArgs[updateArgs.indexOf('--cli-input-json') + 1])).toMatchObject({ State: 'DISABLED' });
        const registerArgs = seen.find((args) => args[1] === 'register-scalable-target');
        expect(registerArgs[registerArgs.indexOf('--suspended-state') + 1]).toContain('DynamicScalingOutSuspended=true');
        const output = stripVTControlCharacters(logSpy.mock.calls.map((call) => String(call[0])).join('\n'));
        expect(output).toContain('myapp-staging-cron-nightly paused');
        expect(output).toContain('worker auto-scaling suspended');
        expect(trackEvent).toHaveBeenCalledWith('sleep_run', expect.objectContaining({
            cron_paused: true, scaling_suspended: true, success: true,
        }));
    });

    it('skips gracefully when the schedule is undeployed and scaling is unregistered', async () => {
        const dir = makeTmp();
        writeCronTf(dir);
        fs.writeFileSync(path.join(dir, 'terraform', 'sqs.tf'), '# queue\n');
        fs.writeFileSync(path.join(dir, 'terraform', 'worker.tf'), '# worker\n');
        const { ecsClient, rdsClient } = mockClients({
            ecs: { 'myapp-staging-service': activeService('myapp-staging-service', 1) },
        });
        const spawnSyncImpl = vi.fn((cmd, args) => {
            if (args[1] === 'get-schedule') return { status: 254, stdout: '', stderr: 'ResourceNotFoundException' };
            if (args[1] === 'describe-scalable-targets') return { status: 0, stdout: JSON.stringify({ ScalableTargets: [] }), stderr: '' };
            return { status: 0, stdout: '{}', stderr: '' };
        });
        const result = await runSleep(baseOptions(dir, { ecsClient, rdsClient, skipDb: true, spawnSyncImpl }));
        expect(result.ok).toBe(true);
        expect(result.cronPaused).toBe(false);
        expect(result.scalingSuspended).toBe(false);
        const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
        expect(output).toContain('not deployed yet, skipped');
        expect(output).toContain('not registered, skipped');
    });

    it('notes unpausable Valkey billing when redis.tf exists', async () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'terraform', 'redis.tf'), '# valkey\n');
        const { ecsClient, rdsClient } = mockClients({
            ecs: { 'myapp-staging-service': activeService('myapp-staging-service', 1) },
        });
        const result = await runSleep(baseOptions(dir, { ecsClient, rdsClient, skipDb: true }));
        expect(result.ok).toBe(true);
        const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
        expect(output).toContain('Valkey keeps billing (~$9.49/mo)');
    });

    it('stays silent about cron, scaling, and cache when unconfigured', async () => {
        const dir = makeTmp();
        const { ecsClient, rdsClient } = mockClients({
            ecs: { 'myapp-staging-service': activeService('myapp-staging-service', 1) },
        });
        const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: '{}', stderr: '' }));
        const result = await runSleep(baseOptions(dir, { ecsClient, rdsClient, skipDb: true, spawnSyncImpl }));
        expect(result.ok).toBe(true);
        expect(spawnSyncImpl).not.toHaveBeenCalled();
        const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
        expect(output).not.toContain('cron:');
        expect(output).not.toContain('scaling:');
        expect(output).not.toContain('cache:');
    });
});

describe('runWake: cron resume and scaling resume', () => {
    it('resumes the cron schedule and worker scaling', async () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'cron.tf'),
            'resource "aws_scheduler_schedule" "cron" {\n  name = "${local.app_name}-cron-nightly"\n}\n'
        );
        fs.writeFileSync(path.join(dir, 'terraform', 'sqs.tf'), '# queue\n');
        fs.writeFileSync(path.join(dir, 'terraform', 'worker.tf'), '# worker\n');
        writeSleepState(dir, {
            staging: {
                env: 'staging',
                sleptAt: new Date().toISOString(),
                autoRestartAt: new Date(Date.now() + 3600_000).toISOString(),
                services: { app: 1, worker: 1 },
            },
        });
        const { ecsClient, rdsClient } = mockClients({
            ecs: {
                'myapp-staging-service': activeService('myapp-staging-service', 0),
                'myapp-staging-worker-service': activeService('myapp-staging-worker-service', 0),
            },
        });
        const seen = [];
        const spawnSyncImpl = vi.fn((cmd, args) => {
            seen.push(args);
            if (args[1] === 'get-schedule') {
                return {
                    status: 0,
                    stdout: JSON.stringify({
                        State: 'DISABLED',
                        ScheduleExpression: 'rate(1 hour)',
                        ScheduleExpressionTimezone: 'UTC',
                        FlexibleTimeWindow: { Mode: 'OFF' },
                        Target: { Arn: 'a', RoleArn: 'r' },
                    }),
                    stderr: '',
                };
            }
            if (args[1] === 'describe-scalable-targets') {
                return {
                    status: 0,
                    stdout: JSON.stringify({ ScalableTargets: [{ SuspendedState: { DynamicScalingInSuspended: true, DynamicScalingOutSuspended: true, ScheduledScalingSuspended: true } }] }),
                    stderr: '',
                };
            }
            return { status: 0, stdout: '{}', stderr: '' };
        });
        const result = await runWake({
            cwd: dir, projectName: 'myapp', region: 'us-east-2', env: 'staging',
            noWait: true, pollIntervalMs: 1, timeoutMs: 1000,
            ecsClient, rdsClient, skipDb: true, spawnSyncImpl,
        });
        expect(result.ok).toBe(true);
        expect(result.cronResumed).toBe(true);
        expect(result.scalingResumed).toBe(true);
        const updateArgs = seen.find((args) => args[1] === 'update-schedule');
        expect(JSON.parse(updateArgs[updateArgs.indexOf('--cli-input-json') + 1])).toMatchObject({ State: 'ENABLED' });
        const registerArgs = seen.find((args) => args[1] === 'register-scalable-target');
        expect(registerArgs[registerArgs.indexOf('--suspended-state') + 1]).toContain('DynamicScalingOutSuspended=false');
        const output = stripVTControlCharacters(logSpy.mock.calls.map((call) => String(call[0])).join('\n'));
        expect(output).toContain('myapp-staging-cron-nightly resumed');
        expect(output).toContain('worker auto-scaling resumed');
        expect(trackEvent).toHaveBeenCalledWith('wake_run', expect.objectContaining({
            cron_resumed: true, scaling_resumed: true, success: true,
        }));
    });
});

describe('runSleep on --target lambda projects', () => {
    function lambdaDir() {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "myapp${local.env_suffix}"\n}\nresource "aws_lambda_function" "app" {}\n'
        );
        return dir;
    }

    it('stops the database without touching ECS and ledgers zero replicas', async () => {
        const dir = lambdaDir();
        const { ecsClient, rdsClient, seen } = mockClients({
            ecs: { 'myapp-staging-service': activeService('myapp-staging-service', 1) },
            db: { instance: { Engine: 'postgres', Status: 'available', DBName: 'db' } },
        });
        const result = await runSleep({
            cwd: dir, projectName: 'myapp', region: 'us-east-2', env: 'staging',
            nowMs: Date.UTC(2026, 0, 1, 12, 0, 0), ecsClient, rdsClient,
        });
        expect(result.ok).toBe(true);
        expect(result.ecsScaled).toBe(0);
        expect(result.dbStopped).toBe(true);
        expect(seen).not.toContain('DescribeServicesCommand');
        expect(seen).not.toContain('UpdateServiceCommand');
        expect(seen).toContain('StopDBInstanceCommand');
        expect(readSleepState(dir).staging).toMatchObject({ services: { app: 0, worker: 0 } });
    });

    it('reports nothing to sleep when no database exists', async () => {
        const dir = lambdaDir();
        const { ecsClient, rdsClient } = mockClients({});
        const result = await runSleep({
            cwd: dir, projectName: 'myapp', region: 'us-east-2', env: 'staging', ecsClient, rdsClient,
        });
        expect(result).toMatchObject({ ok: false, reason: 'nothing-to-sleep' });
    });
});

describe('runSleep on --target static projects', () => {
    function staticDir() {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "myapp"\n}\nresource "aws_cloudfront_distribution" "site" {}\n'
        );
        return dir;
    }

    it('reports static targets as nothing to sleep without the apply pointer', async () => {
        const dir = staticDir();
        const { ecsClient, rdsClient } = mockClients({});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const result = await runSleep({
                cwd: dir, projectName: 'myapp', region: 'us-east-2', env: 'staging', ecsClient, rdsClient,
            });
            expect(result).toMatchObject({ ok: false, reason: 'nothing-to-sleep' });
            const output = stripVTControlCharacters(logSpy.mock.calls.map((call) => String(call[0])).join('\n'));
            expect(output).toContain('is a static target — no compute or database to sleep');
            expect(output).not.toContain('npx grada-run apply');
        } finally {
            logSpy.mockRestore();
        }
    });
});

describe('runWake on --target lambda projects', () => {
    function lambdaDir() {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "myapp${local.env_suffix}"\n}\nresource "aws_lambda_function" "app" {}\n'
        );
        return dir;
    }

    it('starts the database without restoring ECS services', async () => {
        const dir = lambdaDir();
        writeSleepState(dir, {
            staging: {
                env: 'staging',
                sleptAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
                autoRestartAt: new Date(Date.UTC(2026, 0, 8)).toISOString(),
                services: { app: 0, worker: 0 },
                dbId: 'myapp-staging-db',
                dbKind: 'instance',
            },
        });
        const { ecsClient, rdsClient, seen } = mockClients({
            ecs: { 'myapp-staging-service': activeService('myapp-staging-service', 0) },
            db: { instance: { Engine: 'postgres', Status: 'stopped', DBName: 'db' } },
        });
        const result = await runWake({
            cwd: dir, projectName: 'myapp', region: 'us-east-2', env: 'staging',
            noWait: true, ecsClient, rdsClient,
        });
        expect(result.ok).toBe(true);
        expect(result.dbStarted).toBe(true);
        expect(result.ecsRestored).toBe(0);
        expect(seen).not.toContain('UpdateServiceCommand');
        expect(seen).toContain('StartDBInstanceCommand');
        expect(readSleepState(dir).staging).toBeUndefined();
    });
});
