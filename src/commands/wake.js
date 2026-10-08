import { spawnSync } from 'child_process';
import { ECSClient, DescribeServicesCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand, StartDBInstanceCommand, StartDBClusterCommand } from '@aws-sdk/client-rds';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackSuccess, trackFailure } from '../core/telemetry.js';
import { failCommand, failProjectNotInitialized } from '../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { handleAuthErrorBranch, resolveClient } from '../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveCwd, readTerraformComputeTarget } from '../utils/resolvers.js';
import { findDbTarget } from '../utils/rds.js';
import { fetchActiveService } from '../utils/ecs.js';
import { pollUntil } from '../utils/system.js';
import {
    resolveSleepTarget,
    readSleepState,
    removeSleepStateEntry,
    resolveTargetIntercept,
    reportSleepWakeSkip,
} from '../utils/sleep-state.js';
import {
    readCronScheduleName,
    hasCronAddon,
    hasSqsWorkerScaling,
    setSchedulerState,
    setWorkerScalingSuspended,
} from '../utils/sleep-targets.js';

export const DEFAULT_WAKE_TIMEOUT_MS = 600000;
export const DEFAULT_WAKE_POLL_INTERVAL_MS = 5000;

export function parseWakeArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'wake') args.shift();
    const { options, rest } = parseFlags(args, {
        string: ['project-name', 'cluster', 'service', 'db-identifier', 'region', 'workspace'],
        boolean: ['skip-db', 'wait', 'no-wait', 'strict'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0) options.env = positionals[0];
    if (positionals.length > 1) options.unexpectedPositionals = positionals.slice(1);
    return options;
}

export async function runWake(input = {}) {
    const options = normalizeOptions(input);
    let cwd;
    let region;
    let projectName;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'wake_run' });
    }
    const target = resolveSleepTarget(options, cwd);
    const computeTarget = readTerraformComputeTarget(cwd);
    const isLambda = computeTarget === 'lambda';
    const isStatic = computeTarget === 'static';
    const skipDb = options.skipDb === true || options.skipDb === 'true';
    const noWait = options.noWait === true || options.noWait === 'true'
        || options.wait === false || options.wait === 'false';
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WAKE_POLL_INTERVAL_MS;

    intro(color.bgCyan(color.black(' grada wake ☀️ ')));

    if (Array.isArray(options.unexpectedPositionals) && options.unexpectedPositionals.length > 0) {
        return failCommand({
            message: `\n✖ Unexpected argument "${options.unexpectedPositionals[0]}". Pass a single environment: wake [env].\n`,
            event: 'wake_run',
            telemetry: { projectName },
            errorCode: 'UNEXPECTED_POSITIONAL_ARGS',
            reason: 'unexpected-positional-args',
            resultExtra: { cluster: target.cluster, region },
        });
    }

    // Scale-to-zero intercept: static targets have no compute or database,
    // so there is nothing to wake. Runs before any state read or AWS call.
    if (resolveTargetIntercept({ computeTarget })) {
        return reportSleepWakeSkip({
            command: 'wake',
            reason: 'static-target',
            target,
            projectName,
            region,
            strict: options.strict,
        });
    }

    // FinOps Preservation (mirrors sleep): Lambda compute needs no
    // wake-up, but a stopped database must still start. Probe RDS
    // read-only before doing anything else; --skip-db short-circuits the
    // probe. Probe failures fall through to the main flow.
    const rdsClient = resolveClient(options.rdsClient, RDSClient, { region });
    let lambdaDbTarget = null;
    let lambdaDbProbed = false;
    if (isLambda) {
        const skipDbIntercept = resolveTargetIntercept({ computeTarget, skipDb });
        if (skipDbIntercept) {
            return reportSleepWakeSkip({
                command: 'wake',
                reason: skipDbIntercept.reason,
                target,
                projectName,
                region,
                strict: options.strict,
            });
        }
        try {
            lambdaDbTarget = await findDbTarget(rdsClient, {
                dbIdentifier: target.dbIdentifier,
                dbClusterIdentifier: target.dbClusterIdentifier,
            });
            lambdaDbProbed = true;
        } catch {
            lambdaDbProbed = false;
        }
        const noDbIntercept = resolveTargetIntercept({
            computeTarget,
            skipDb,
            dbTarget: lambdaDbTarget,
            dbProbed: lambdaDbProbed,
        });
        if (noDbIntercept) {
            return reportSleepWakeSkip({
                command: 'wake',
                reason: noDbIntercept.reason,
                target,
                projectName,
                region,
                strict: options.strict,
            });
        }
    }

    const entry = readSleepState(cwd)[target.envKey] || null;
    if (entry?.autoRestartAt && Date.now() > Date.parse(entry.autoRestartAt)) {
        console.log(color.yellow('\n⚠ The 7-day sleep window has elapsed — AWS may have auto-restarted the database already.'));
    }

    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });
    // rdsClient was resolved above for the Lambda probe.
    const runSync = options.spawnSyncImpl || spawnSync;

    // Already-awake fast path: with no ledger entry the environment was
    // never put to sleep by this CLI (or was already woken). Probe live
    // state instead of blindly restoring 1/1 defaults — a second wake
    // must not issue UpdateService calls. Only a missing ledger reaches
    // this probe, so normal ledger-driven wakes are untouched. When
    // nothing is found at all, fall through to the main flow so the
    // NOTHING_TO_WAKE guidance is preserved.
    let probedServices = null;
    let probedDb = null;
    let probedDbSettled = false;
    if (!entry) {
        const appSvc = isLambda ? null : await fetchActiveService(ecsClient, target.cluster, target.appService);
        const workerSvc = isLambda ? null : await fetchActiveService(ecsClient, target.cluster, target.workerService);
        probedServices = { app: appSvc, worker: workerSvc };
        if (!skipDb) {
            try {
                probedDb = lambdaDbProbed
                    ? lambdaDbTarget
                    : await findDbTarget(rdsClient, {
                        dbIdentifier: target.dbIdentifier,
                        dbClusterIdentifier: target.dbClusterIdentifier,
                    });
                probedDbSettled = true;
            } catch {
                probedDbSettled = false;
            }
        } else {
            probedDbSettled = true;
        }
        const foundServices = [appSvc, workerSvc].filter(Boolean);
        const foundDb = probedDbSettled && probedDb;
        if (probedDbSettled && (foundServices.length > 0 || foundDb)) {
            const servicesAwake = foundServices.every((service) => (service.desiredCount ?? 0) > 0);
            const dbAwake = !foundDb || foundDb.status !== 'stopped';
            if (servicesAwake && dbAwake) {
                return reportSleepWakeSkip({
                    command: 'wake',
                    reason: 'already-awake',
                    target,
                    projectName,
                    region,
                    strict: options.strict,
                });
            }
        }
    }

    const s = spinner();
    s.start(`Waking ${target.envKey}...`);

    try {
        // 1. Start the database first so booting containers never
        // crash-loop on an unreachable database.
        let dbTarget = null;
        let dbStarted = false;
        if (!skipDb) {
            // Probes above are reused so a wake run describes RDS exactly
            // once: the no-ledger probe first, then the Lambda pre-probe.
            dbTarget = probedDbSettled
                ? probedDb
                : lambdaDbProbed
                    ? lambdaDbTarget
                    : await findDbTarget(rdsClient, {
                        dbIdentifier: target.dbIdentifier,
                        dbClusterIdentifier: target.dbClusterIdentifier,
                    });
            if (dbTarget && dbTarget.status === 'stopped') {
                if (dbTarget.kind === 'cluster') {
                    await rdsClient.send(new StartDBClusterCommand({ DBClusterIdentifier: dbTarget.id }));
                } else {
                    await rdsClient.send(new StartDBInstanceCommand({ DBInstanceIdentifier: dbTarget.id }));
                }
                dbStarted = true;
            }
        }

        if (!noWait && dbTarget && dbStarted) {
            const isCluster = dbTarget.kind === 'cluster';
            s.message(`Waiting for ${dbTarget.id} to become available...`);
            const outcome = await pollUntil({
                intervalMs: pollIntervalMs,
                timeoutMs,
                ...(options.sleepFn ? { sleepFn: options.sleepFn } : {}),
                ...(options.nowFn ? { nowFn: options.nowFn } : {}),
                onTick: async ({ elapsedMs }) => {
                    const resp = isCluster
                        ? await rdsClient.send(new DescribeDBClustersCommand({ DBClusterIdentifier: dbTarget.id }))
                        : await rdsClient.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbTarget.id }));
                    const current = isCluster
                        ? (resp.DBClusters || [])[0] || null
                        : (resp.DBInstances || [])[0] || null;
                    if (current && current.Status === 'available') return { done: true, value: current };
                    s.message(`Waiting for ${dbTarget.id}... [${Math.floor(elapsedMs / 1000)}s]`);
                    return { done: false };
                },
            });
            if (outcome.timedOut) {
                s.stop(color.yellow('Database still starting.'));
                return failCommand({
                    print: () => {
                        console.log(color.yellow(`\n⚠ ${dbTarget.id} did not become available in time.`));
                        console.log(isLambda
                            ? `  The environment is still asleep — re-run ${color.green(`npx grada-run wake${target.envKey === 'default' ? '' : ` ${target.envKey}`}`)} once the database is available.\n`
                            : `  ECS services were left asleep — re-run ${color.green(`npx grada-run wake${target.envKey === 'default' ? '' : ` ${target.envKey}`}`)} once the database is available.\n`);
                    },
                    event: 'wake_run',
                    telemetry: { projectName, env_kind: target.envKind },
                    errorCode: 'RDS_WAKE_TIMEOUT',
                    reason: 'rds-wake-timeout',
                    resultExtra: { cluster: target.cluster, region },
                });
            }
        }

        // 2. Restore ECS desired counts (ledger first, then 1/1 defaults).
        // Lambda ledgers store 0/0: there is nothing to restore.
        const desiredApp = isLambda ? (entry?.services?.app ?? 0) : Math.max(1, entry?.services?.app ?? 1);
        const desiredWorker = isLambda ? (entry?.services?.worker ?? 0) : Math.max(1, entry?.services?.worker ?? 1);
        const restored = [];
        for (const [key, serviceName, desired] of [
            ['app', target.appService, desiredApp],
            ['worker', target.workerService, desiredWorker],
        ]) {
            if (desired <= 0) continue;
            // The no-ledger probe above already fetched both services —
            // reuse it instead of describing them a second time.
            const service = probedServices
                ? probedServices[key]
                : await fetchActiveService(ecsClient, target.cluster, serviceName);
            if (!service) continue;
            await ecsClient.send(new UpdateServiceCommand({
                cluster: target.cluster,
                service: serviceName,
                desiredCount: desired,
            }));
            restored.push({ name: serviceName, desired });
        }

        if (restored.length === 0 && !dbTarget) {
            s.stop(color.yellow('Nothing to wake.'));
            return failCommand({
                print: () => {
                    if (isLambda) {
                        console.log(`\n  No databases found for ${color.cyan(target.appPrefix)} — and Lambda compute needs no wake-up.`);
                    } else {
                        console.log(`\n  No ECS services or databases found for ${color.cyan(target.appPrefix)}.`);
                    }
                    console.log(`  Run ${color.green('npx grada-run apply')} to provision your infrastructure.\n`);
                },
                event: 'wake_run',
                telemetry: { projectName, env_kind: target.envKind, error_code: 'NOTHING_TO_WAKE' },
                reason: 'nothing-to-wake',
                resultExtra: { cluster: target.cluster, region },
            });
        }

        // Resume the scheduled work sleep paused. A resume failure warns
        // loudly — a schedule left disabled would silently stop cron — but
        // the environment itself is already awake, so wake still succeeds.
        const cronConfigured = hasCronAddon(cwd);
        let cronName = null;
        let cronResumed = false;
        let cronNote = null;
        if (cronConfigured) {
            cronName = readCronScheduleName(cwd, target.appPrefix);
            if (!cronName) {
                cronNote = 'schedule name unreadable, skipped';
            } else {
                const resumed = setSchedulerState({ name: cronName, enabled: true, region, run: runSync });
                if (resumed.ok) {
                    cronResumed = true;
                    if (resumed.skipped) cronNote = 'already running';
                } else if (resumed.reason === 'not-deployed') {
                    cronNote = 'not deployed yet, skipped';
                } else if (resumed.reason === 'cli-missing') {
                    cronNote = 'skipped (AWS CLI not found)';
                } else {
                    cronNote = `could not resume (${resumed.detail || resumed.reason})`;
                }
            }
        }
        const scalingConfigured = hasSqsWorkerScaling(cwd);
        let scalingResumed = false;
        let scalingNote = null;
        if (scalingConfigured) {
            const resumed = setWorkerScalingSuspended({
                cluster: target.cluster, service: target.workerService, suspended: false, region, run: runSync,
            });
            if (resumed.ok) {
                scalingResumed = true;
                if (resumed.skipped) scalingNote = 'already active';
            } else if (resumed.reason === 'not-registered') {
                scalingNote = 'not registered, skipped';
            } else if (resumed.reason === 'cli-missing') {
                scalingNote = 'skipped (AWS CLI not found)';
            } else {
                scalingNote = `could not resume (${resumed.detail || resumed.reason})`;
            }
        }

        if (!noWait && restored.length > 0) {
            s.message('Waiting for ECS tasks to start...');
            const outcome = await pollUntil({
                intervalMs: pollIntervalMs,
                timeoutMs,
                ...(options.sleepFn ? { sleepFn: options.sleepFn } : {}),
                ...(options.nowFn ? { nowFn: options.nowFn } : {}),
                onTick: async ({ elapsedMs }) => {
                    const resp = await ecsClient.send(new DescribeServicesCommand({
                        cluster: target.cluster,
                        services: restored.map((r) => r.name),
                    }));
                    const services = resp.services || [];
                    const ready = restored.every(({ name, desired }) => {
                        const svc = services.find((candidate) => candidate.serviceName === name || candidate.serviceArn?.endsWith(`/${name}`));
                        return svc && (svc.runningCount ?? 0) >= desired;
                    });
                    if (ready) return { done: true, value: true };
                    s.message(`Waiting for ECS tasks... [${Math.floor(elapsedMs / 1000)}s]`);
                    return { done: false };
                },
            });
            if (outcome.timedOut) {
                s.stop(color.yellow('ECS tasks still starting.'));
                return failCommand({
                    print: () => {
                        console.log(color.yellow('\n⚠ ECS tasks did not reach the desired count in time.'));
                        console.log(`  The restore was applied — check progress with ${color.green('npx grada-run status')}.\n`);
                    },
                    event: 'wake_run',
                    telemetry: { projectName, env_kind: target.envKind },
                    errorCode: 'ECS_WAKE_TIMEOUT',
                    reason: 'ecs-wake-timeout',
                    resultExtra: { cluster: target.cluster, region },
                });
            }
        }

        removeSleepStateEntry(cwd, target.envKey);

        s.stop(color.green('Environment awake. ☀️'));
        console.log('');
        if (isLambda) {
            console.log(`  ${color.dim('lambda:')} scale-to-zero compute — nothing to restore`);
        }
        if (skipDb) {
            console.log(`  ${color.dim('rds:')} skipped (--skip-db)`);
        } else if (dbStarted) {
            console.log(`  ${color.dim('rds:')} ${color.cyan(dbTarget.id)} started`);
        } else if (dbTarget) {
            console.log(`  ${color.dim('rds:')} ${color.cyan(dbTarget.id)} already ${dbTarget.status}`);
        } else {
            console.log(`  ${color.dim('rds:')} no database provisioned`);
        }
        for (const { name, desired } of restored) {
            console.log(`  ${color.dim('ecs:')} ${color.cyan(name)} restored to ${desired}`);
        }
        if (cronConfigured) {
            const label = cronName ? `${color.cyan(cronName)} ` : '';
            console.log(`  ${color.dim('cron:')} ${label}${cronResumed && !cronNote ? 'resumed' : cronNote}`);
        }
        if (scalingConfigured) {
            console.log(`  ${color.dim('scaling:')} ${scalingResumed && !scalingNote ? 'worker auto-scaling resumed' : scalingNote}`);
        }
        console.log('');

        await trackSuccess('wake_run', {
            projectName,
            env_kind: target.envKind,
            ecs_restored: restored.length,
            db_started: dbStarted,
            waited: !noWait,
            cron_resumed: cronResumed,
            scaling_resumed: scalingResumed,
        });
        outro(color.green('Done.'));
        return {
            ok: true,
            env: target.envKey,
            cluster: target.cluster,
            region,
            ecsRestored: restored.length,
            dbStarted,
            waited: !noWait,
            cronResumed,
            scalingResumed,
        };
    } catch (error) {
        await trackFailure('wake_run', {
            projectName,
            env_kind: target.envKind,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        if (handleAuthErrorBranch(error, s, options)) {
            return { ok: false, reason: 'error', cluster: target.cluster, region };
        }
        try { s.stop(color.red('❌ Wake failed.')); } catch { /* spinner already stopped */ }
        return failCommand({
            message: `✖ ${error?.message || error}`,
            hint: 'Check your AWS credentials and region, then try again.',
            reason: 'error',
            resultExtra: { cluster: target.cluster, region },
        });
    }
}

export const wakeCommand = runWake;

export default runWake;
