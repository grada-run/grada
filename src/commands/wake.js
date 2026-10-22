import path from 'path';
import { spawnSync } from 'child_process';
import { ECSClient, DescribeServicesCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand, StartDBInstanceCommand, StartDBClusterCommand } from '@aws-sdk/client-rds';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackSuccess, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { failCommand, failAwsError, trackAwsFailure, failProjectNotInitialized, refuseUnknownFlags } from '../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { isAuthError, handleAuthErrorBranch, resolveClient } from '../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveCwd, readTerraformComputeTarget } from '../utils/resolvers.js';
import { requireManagedTree } from '../utils/terraform-metadata.js';
import { findDbTarget, dbStatusOf } from '../utils/rds.js';
import { fetchActiveService, detectTaskFailure } from '../utils/ecs.js';
import { pollUntil } from '../utils/system.js';
import {
    resolveSleepTarget,
    readSleepState,
    guardSleepingEnv,
    clearSleepAutoTfvars,
    resolveTargetIntercept,
    reportSleepWakeSkip,
} from '../utils/sleep-state.js';
import { runTerraformCommand, DEFAULT_TERRAFORM_PHASE_TIMEOUT_MS } from '../utils/terraform.js';
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
    const { options, rest, unknown } = parseFlags(args, {
        string: ['project-name', 'cluster', 'service', 'db-identifier', 'region', 'workspace'],
        boolean: ['skip-db', 'wait', 'no-wait', 'strict', 'headless'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0) options.env = positionals[0];
    if (positionals.length > 1) options.unexpectedPositionals = positionals.slice(1);
    if (unknown.length > 0) options.unknownFlags = unknown;
    return options;
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runWake(input = {}) {
    setActiveCommandName('wake');
    try {
        return await runWakeMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runWakeMain(input = {}) {
    const options = normalizeOptions(input);
    const unknownRefusal = await refuseUnknownFlags(options, { command: 'wake', event: 'wake_run' });
    if (unknownRefusal) return unknownRefusal;
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

    // Ejected trees are user-owned: refuse unless --force. Runs before
    // the intercepts so ejected static trees refuse instead of skipping.
    const managedTree = await requireManagedTree({
        cwd, command: 'wake', options, event: 'wake_run', projectName,
    });
    if (!managedTree.proceed) return managedTree.result;

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
    let probedServicesSettled = false;
    let probedDb = null;
    let probedDbSettled = false;
    if (!entry) {
        // Same settle-flag pattern as the DB probe below: a failed ECS
        // probe must fall through to the main flow (which formats via
        // failAwsError), never throw the raw SDK error past every catch.
        // All-or-nothing like the DB probe — a partial pair is discarded
        // and the main flow re-fetches both services inside its try.
        let appSvc = null;
        let workerSvc = null;
        try {
            appSvc = isLambda ? null : await fetchActiveService(ecsClient, target.cluster, target.appService);
            workerSvc = isLambda ? null : await fetchActiveService(ecsClient, target.cluster, target.workerService);
            probedServices = { app: appSvc, worker: workerSvc };
            probedServicesSettled = true;
        } catch {
            probedServicesSettled = false;
        }
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
        if (probedServicesSettled && probedDbSettled && (foundServices.length > 0 || foundDb)) {
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
                    if (dbStatusOf(current, isCluster ? 'cluster' : 'instance') === 'available') return { done: true, value: current };
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
            // The ledger entry is stale (infra vanished out-of-band): clear
            // it so later commands stop seeing a ghost asleep env, and drop
            // a stale auto-vars marker with it — otherwise the next apply
            // would provision with asleep=true. No restore apply: there is
            // nothing to restore (an apply here would CREATE infra).
            await guardSleepingEnv({
                cwd, envKey: target.envKey, options, command: 'wake',
                mode: 'clear-on-success', projectName, clearedBy: 'wake-nothing',
            });
            if (Object.keys(readSleepState(cwd)).length === 0) clearSleepAutoTfvars(cwd);
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
            const waitClock = options.nowFn || Date.now;
            const waitStartMs = waitClock();
            const restoredNames = restored.map((r) => r.name);
            const probeFailure = () => detectTaskFailure({
                ecsClient, cluster: target.cluster, services: restoredNames, sinceMs: waitStartMs,
            });
            const outcome = await pollUntil({
                intervalMs: pollIntervalMs,
                timeoutMs,
                ...(options.sleepFn ? { sleepFn: options.sleepFn } : {}),
                ...(options.nowFn ? { nowFn: options.nowFn } : {}),
                onTick: async ({ elapsedMs }) => {
                    const resp = await ecsClient.send(new DescribeServicesCommand({
                        cluster: target.cluster,
                        services: restoredNames,
                    }));
                    const services = resp.services || [];
                    const ready = restored.every(({ name, desired }) => {
                        const svc = services.find((candidate) => candidate.serviceName === name || candidate.serviceArn?.endsWith(`/${name}`));
                        return svc && (svc.runningCount ?? 0) >= desired;
                    });
                    if (ready) return { done: true, value: true };
                    // Active failure detection: crash-loops and unpullable
                    // images mean fatal, not slow start — short-circuit
                    // instead of exhausting the timeout.
                    const failure = await probeFailure();
                    if (failure.kind) {
                        return { done: true, value: failure };
                    }
                    s.message(`Waiting for ECS tasks... [${Math.floor(elapsedMs / 1000)}s]`);
                    return { done: false };
                },
            });
            const shortCircuited = outcome.value && typeof outcome.value === 'object' ? outcome.value : null;
            if (shortCircuited?.kind) {
                const isPullFailure = shortCircuited.kind === 'pull-failure';
                s.stop(color.yellow(isPullFailure ? 'ECS tasks cannot start.' : 'ECS tasks are crashing.'));
                return failCommand({
                    print: () => {
                        console.log(color.yellow(isPullFailure
                            ? '\n⚠ ECS tasks cannot start: the image cannot be pulled.'
                            : '\n⚠ ECS tasks are crashing instead of starting.'));
                        console.log(`  Most recent failure: ${shortCircuited.detail}`);
                        console.log(`  The restore was applied — check progress with ${color.green('npx grada-run status')}.\n`);
                    },
                    event: 'wake_run',
                    telemetry: { projectName, env_kind: target.envKind, crash_detected: true, stopped_tasks: shortCircuited.stoppedTasks },
                    errorCode: isPullFailure ? 'ECS_WAKE_PULL_FAILURE' : 'ECS_WAKE_CRASH_LOOP',
                    reason: isPullFailure ? 'ecs-wake-pull-failure' : 'ecs-wake-crash-loop',
                    resultExtra: { cluster: target.cluster, region },
                });
            }
            if (outcome.timedOut) {
                s.stop(color.yellow('ECS tasks still starting.'));
                // Best-effort root cause for the timeout message: a single
                // crash sits below the short-circuit threshold but still
                // explains the wait.
                const failure = await probeFailure();
                return failCommand({
                    print: () => {
                        console.log(color.yellow('\n⚠ ECS tasks did not reach the desired count in time.'));
                        if (failure.detail) console.log(`  Most recent failure: ${failure.detail}`);
                        console.log(`  The restore was applied — check progress with ${color.green('npx grada-run status')}.\n`);
                    },
                    event: 'wake_run',
                    telemetry: { projectName, env_kind: target.envKind, crash_detected: failure.detail !== null, stopped_tasks: failure.stoppedTasks },
                    errorCode: 'ECS_WAKE_TIMEOUT',
                    reason: 'ecs-wake-timeout',
                    resultExtra: { cluster: target.cluster, region },
                });
            }
        }

        await guardSleepingEnv({
            cwd, envKey: target.envKey, options, command: 'wake',
            mode: 'clear-on-success', projectName, clearedBy: 'wake',
        });

        // Terraform-visible restore: when this wake cleared the last asleep
        // entry, delete the auto-vars marker BEFORE reconciling so the
        // apply restores desired counts instead of re-pinning 0. Other
        // envs still asleep keep the marker (and skip the apply).
        let restoreApplied = false;
        if (Object.keys(readSleepState(cwd)).length === 0 && clearSleepAutoTfvars(cwd)) {
            const runTerraform = options.runTerraformImpl || runTerraformCommand;
            const tfDir = path.join(cwd, 'terraform');
            try {
                s.message('Restoring Terraform state...');
                await runTerraform(['apply', '-auto-approve'], tfDir, s, 'Restoring', {
                    markerDir: cwd,
                    timeoutMs: DEFAULT_TERRAFORM_PHASE_TIMEOUT_MS,
                });
                restoreApplied = true;
            } catch (error) {
                s.stop(color.red('Restore apply failed.'));
                return failCommand({
                    print: () => {
                        console.log(color.red('\n✖ Services were restored, but the Terraform reconcile failed.'));
                        console.log(`  Live state and Terraform state disagree — run ${color.green('npx grada-run apply')} to reconcile them.`);
                        console.log(color.dim(`  Terraform said: ${error?.message || error}\n`));
                    },
                    event: 'wake_run',
                    telemetry: { projectName, env_kind: target.envKind },
                    errorCode: 'WAKE_RESTORE_FAILED',
                    reason: 'restore-apply-failed',
                    resultExtra: { cluster: target.cluster, region },
                });
            }
        }

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
            restore_applied: restoreApplied,
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
            restoreApplied,
        };
    } catch (error) {
        if (isAuthError(error)) {
            await trackAwsFailure('wake_run', error, { projectName, env_kind: target.envKind });
            handleAuthErrorBranch(error, s, options);
            return { ok: false, reason: 'error', cluster: target.cluster, region };
        }
        try { s.stop(color.red('❌ Wake failed.')); } catch { /* spinner already stopped */ }
        return failAwsError({
            event: 'wake_run',
            error,
            telemetry: { projectName, env_kind: target.envKind },
            reason: 'error',
            resultExtra: { cluster: target.cluster, region },
        });
    }
}

export const wakeCommand = runWake;

export default runWake;
