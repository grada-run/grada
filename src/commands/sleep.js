import path from 'path';
import { spawnSync } from 'child_process';
import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { RDSClient, StopDBInstanceCommand, StopDBClusterCommand } from '@aws-sdk/client-rds';
import color from 'picocolors';
import { intro, outro, spinner, confirm, cancel } from '@clack/prompts';
import { trackSuccess, trackFailure } from '../core/telemetry.js';
import { failCommand, failProjectNotInitialized } from '../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { handleAuthErrorBranch, resolveClient } from '../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveHeadless, resolveCwd, readTerraformComputeTarget } from '../utils/resolvers.js';
import { findDbTarget } from '../utils/rds.js';
import { fetchActiveService } from '../utils/ecs.js';
import { parseTerraformConfig, estimateSleepSavings } from '../utils/visualizer.js';
import {
    resolveSleepTarget,
    readSleepState,
    writeSleepState,
    ensureSleepGitignore,
    computeAutoRestartAt,
    formatUtcTimestamp,
    resolveTargetIntercept,
    reportSleepWakeSkip,
} from '../utils/sleep-state.js';
import {
    readCronScheduleName,
    hasCronAddon,
    hasSqsWorkerScaling,
    hasRedisAddon,
    setSchedulerState,
    setWorkerScalingSuspended,
} from '../utils/sleep-targets.js';

export const SLEEP_CONFIRM_MESSAGE = "Put environment to sleep? This will take the web service offline until you run 'grada wake'.";

export function parseSleepArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'sleep') args.shift();
    const { options, rest } = parseFlags(args, {
        string: ['project-name', 'cluster', 'service', 'db-identifier', 'region', 'workspace'],
        boolean: ['skip-db', 'wait', 'no-wait', 'yes', 'force', 'headless', 'strict'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0) options.env = positionals[0];
    if (positionals.length > 1) options.unexpectedPositionals = positionals.slice(1);
    return options;
}

function isMysqlEngine(engine) {
    return engine === 'mysql' || engine === 'aurora-mysql';
}

export async function runSleep(input = {}) {
    const options = normalizeOptions(input);
    let cwd;
    let region;
    let projectName;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'sleep_run' });
    }
    const target = resolveSleepTarget(options, cwd);
    const computeTarget = readTerraformComputeTarget(cwd);
    const isLambda = computeTarget === 'lambda';
    const isStatic = computeTarget === 'static';
    const headless = resolveHeadless(options);
    const skipDb = options.skipDb === true || options.skipDb === 'true';
    const confirmed = options.yes === true || options.yes === 'true'
        || options.force === true || options.force === 'true';

    intro(color.bgCyan(color.black(' grada sleep 💤 ')));

    if (Array.isArray(options.unexpectedPositionals) && options.unexpectedPositionals.length > 0) {
        return failCommand({
            message: `\n✖ Unexpected argument "${options.unexpectedPositionals[0]}". Pass a single environment: sleep [env].\n`,
            event: 'sleep_run',
            telemetry: { projectName },
            errorCode: 'UNEXPECTED_POSITIONAL_ARGS',
            reason: 'unexpected-positional-args',
            resultExtra: { cluster: target.cluster, region },
        });
    }

    // Scale-to-zero intercept: static targets have no compute or database,
    // so there is nothing to sleep. Runs before the confirm gate and any
    // AWS call — prompting to take "production offline" would be nonsense.
    if (resolveTargetIntercept({ computeTarget })) {
        return reportSleepWakeSkip({
            command: 'sleep',
            reason: 'static-target',
            target,
            projectName,
            region,
            strict: options.strict,
        });
    }

    // FinOps Preservation: Lambda compute is already scale-to-zero, but a
    // provisioned database must still hibernate. Probe RDS (read-only)
    // before the confirm gate: no database means nothing to sleep, while
    // --skip-db short-circuits the probe entirely (ECS is skipped by
    // target, the database by flag). Client construction performs no
    // network I/O, and probe failures fall through to the main flow so
    // auth errors surface through the standard branch.
    const rdsClient = resolveClient(options.rdsClient, RDSClient, { region });
    let lambdaDbTarget = null;
    let lambdaDbProbed = false;
    if (isLambda) {
        const skipDbIntercept = resolveTargetIntercept({ computeTarget, skipDb });
        if (skipDbIntercept) {
            return reportSleepWakeSkip({
                command: 'sleep',
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
                command: 'sleep',
                reason: noDbIntercept.reason,
                target,
                projectName,
                region,
                strict: options.strict,
            });
        }
    }

    // Safety guard: sleeping the default (production) environment takes the
    // web service offline, so it needs an explicit confirmation.
    if (target.requiresConfirm && !confirmed) {
        if (headless) {
            return failCommand({
                message: '\n✖ Sleeping the default environment requires confirmation. Re-run with --yes.\n',
                event: 'sleep_run',
                telemetry: { projectName, env_kind: target.envKind },
                errorCode: 'CONFIRMATION_REQUIRED',
                reason: 'confirmation-required',
                resultExtra: { cluster: target.cluster, region },
            });
        }
        console.log(color.yellow('\n⚠ This will take the web service offline until you run "grada wake".'));
        const answer = await confirm({ message: SLEEP_CONFIRM_MESSAGE, initialValue: false });
        if (answer !== true) {
            cancel('Cancelled. Nothing was changed.');
            return { ok: false, reason: 'cancelled', cluster: target.cluster, region };
        }
    }

    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });
    // rdsClient was resolved above the confirm gate for the Lambda probe.
    const runSync = options.spawnSyncImpl || spawnSync;

    const s = spinner();
    s.start(`Putting ${target.envKey} to sleep...`);

    try {
        // Lambda compute is already scale-to-zero: there are no services to
        // scale, so sleep only stops the database and pauses schedules.
        const appService = isLambda ? null : await fetchActiveService(ecsClient, target.cluster, target.appService);
        const workerService = isLambda ? null : await fetchActiveService(ecsClient, target.cluster, target.workerService);

        let ecsScaled = 0;
        let prevApp = 0;
        let prevWorker = 0;
        const serviceNotes = [];
        for (const [label, service, serviceName] of [
            ['app', appService, target.appService],
            ['worker', workerService, target.workerService],
        ]) {
            if (!service) continue;
            const desired = service.desiredCount ?? 0;
            if (desired > 0) {
                await ecsClient.send(new UpdateServiceCommand({
                    cluster: target.cluster,
                    service: serviceName,
                    desiredCount: 0,
                }));
                ecsScaled += 1;
                serviceNotes.push({ label, name: serviceName, scaled: true, prev: desired });
            } else {
                serviceNotes.push({ label, name: serviceName, scaled: false, prev: 0 });
            }
            if (label === 'app') prevApp = desired;
            else prevWorker = desired;
        }
        const servicesMissing = !appService && !workerService;

        let dbTarget = null;
        let dbStopped = false;
        let dbNote = null;
        if (!skipDb) {
            // Lambda already probed above the confirm gate — reuse it so a
            // hibernation run describes RDS exactly once.
            dbTarget = lambdaDbProbed
                ? lambdaDbTarget
                : await findDbTarget(rdsClient, {
                dbIdentifier: target.dbIdentifier,
                dbClusterIdentifier: target.dbClusterIdentifier,
            });
            if (!dbTarget) {
                dbNote = 'no database provisioned';
            } else if (dbTarget.status === 'available') {
                if (dbTarget.kind === 'cluster') {
                    await rdsClient.send(new StopDBClusterCommand({ DBClusterIdentifier: dbTarget.id }));
                } else {
                    await rdsClient.send(new StopDBInstanceCommand({ DBInstanceIdentifier: dbTarget.id }));
                }
                dbStopped = true;
            } else if (dbTarget.status === 'stopped' || dbTarget.status === 'stopping') {
                dbNote = `already ${dbTarget.status}`;
            } else {
                dbNote = `transitional (${dbTarget.status}), skipping`;
            }
        }

        if (servicesMissing && !dbTarget) {
            s.stop(color.yellow('Nothing to sleep.'));
            return failCommand({
                print: () => {
                    // Static intercepts above; Lambda without a database
                    // intercepts above. This Lambda branch survives only for
                    // the probe-failed fallback path.
                    if (isLambda) {
                        console.log(`\n  No databases found for ${color.cyan(target.appPrefix)} — and Lambda compute is already scale-to-zero.`);
                    } else {
                        console.log(`\n  No ECS services or databases found for ${color.cyan(target.appPrefix)}.`);
                    }
                    console.log(`  Run ${color.green('npx grada-run apply')} to provision your infrastructure.\n`);
                },
                event: 'sleep_run',
                telemetry: { projectName, env_kind: target.envKind, error_code: 'NOTHING_TO_SLEEP' },
                reason: 'nothing-to-sleep',
                resultExtra: { cluster: target.cluster, region },
            });
        }

        // Pause scheduled work so nothing wakes the environment back up: a
        // firing cron schedule would keep launching (and billing) tasks
        // against the stopped database, and queue-depth scaling would
        // revive the worker on the next message. Skips degrade to notes —
        // sleep itself still succeeds.
        const cronConfigured = hasCronAddon(cwd);
        let cronName = null;
        let cronPaused = false;
        let cronNote = null;
        if (cronConfigured) {
            cronName = readCronScheduleName(cwd, target.appPrefix);
            if (!cronName) {
                cronNote = 'schedule name unreadable, skipped';
            } else {
                const paused = setSchedulerState({ name: cronName, enabled: false, region, run: runSync });
                if (paused.ok) {
                    cronPaused = true;
                    if (paused.skipped) cronNote = 'already paused';
                } else if (paused.reason === 'not-deployed') {
                    cronNote = 'not deployed yet, skipped';
                } else if (paused.reason === 'cli-missing') {
                    cronNote = 'skipped (AWS CLI not found)';
                } else {
                    cronNote = `could not pause (${paused.detail || paused.reason})`;
                }
            }
        }
        const scalingConfigured = hasSqsWorkerScaling(cwd);
        let scalingSuspended = false;
        let scalingNote = null;
        if (scalingConfigured) {
            const suspended = setWorkerScalingSuspended({
                cluster: target.cluster, service: target.workerService, suspended: true, region, run: runSync,
            });
            if (suspended.ok) {
                scalingSuspended = true;
                if (suspended.skipped) scalingNote = 'already suspended';
            } else if (suspended.reason === 'not-registered') {
                scalingNote = 'not registered, skipped';
            } else if (suspended.reason === 'cli-missing') {
                scalingNote = 'skipped (AWS CLI not found)';
            } else {
                scalingNote = `could not suspend (${suspended.detail || suspended.reason})`;
            }
        }

        // Persist the ledger: a repeat sleep never overwrites the original
        // replica counts with 0, and keeps the original 7-day window (AWS
        // counts from the actual stop, not from re-runs).
        const nowMs = options.nowMs ?? Date.now();
        const state = readSleepState(cwd);
        const existing = state[target.envKey] && typeof state[target.envKey] === 'object'
            ? state[target.envKey]
            : null;
        const storedApp = isLambda ? 0 : (prevApp > 0 ? prevApp : (existing?.services?.app ?? 1));
        const storedWorker = isLambda ? 0 : (prevWorker > 0 ? prevWorker : (existing?.services?.worker ?? (workerService ? 1 : 0)));
        const sleptAt = existing?.sleptAt ?? new Date(nowMs).toISOString();
        const autoRestartAt = existing?.autoRestartAt ?? computeAutoRestartAt(nowMs).toISOString();
        state[target.envKey] = {
            env: target.envKey,
            sleptAt,
            autoRestartAt,
            services: { app: storedApp, worker: storedWorker },
            dbId: dbTarget?.id ?? existing?.dbId ?? null,
            dbKind: dbTarget?.kind ?? existing?.dbKind ?? null,
        };
        writeSleepState(cwd, state);
        ensureSleepGitignore(cwd);

        const tfConfig = parseTerraformConfig(path.join(cwd, 'terraform'));
        const hasDb = tfConfig.hasDb || Boolean(dbTarget);
        const dbEngine = dbTarget
            ? (dbTarget.kind === 'cluster' ? 'aurora-postgresql' : (isMysqlEngine(dbTarget.engine) ? 'mysql' : 'postgres'))
            : tfConfig.dbEngine;
        const savings = estimateSleepSavings({
            cpu: tfConfig.cpu,
            memory: tfConfig.memory,
            hasDb,
            dbEngine,
            appReplicas: appService ? storedApp : 0,
            workerReplicas: workerService ? storedWorker : 0,
        });

        s.stop(color.green('Environment asleep. 💤'));
        console.log('');
        if (isLambda) {
            console.log(`  ${color.dim('lambda:')} scale-to-zero compute — nothing to scale`);
        }
        for (const note of serviceNotes) {
            if (note.scaled) {
                console.log(`  ${color.dim('ecs:')} ${color.cyan(note.name)} scaled to 0 (was ${note.prev})`);
            } else {
                console.log(`  ${color.dim('ecs:')} ${color.cyan(note.name)} already asleep`);
            }
        }
        if (skipDb) {
            console.log(`  ${color.dim('rds:')} skipped (--skip-db)`);
        } else if (dbStopped) {
            console.log(`  ${color.dim('rds:')} ${color.cyan(dbTarget.id)} stopping...`);
        } else {
            console.log(`  ${color.dim('rds:')} ${dbNote}`);
        }
        if (cronConfigured) {
            const label = cronName ? `${color.cyan(cronName)} ` : '';
            console.log(`  ${color.dim('cron:')} ${label}${cronPaused && !cronNote ? 'paused' : cronNote}`);
        }
        if (scalingConfigured) {
            console.log(`  ${color.dim('scaling:')} ${scalingSuspended && !scalingNote ? 'worker auto-scaling suspended' : scalingNote}`);
        }
        if (hasRedisAddon(cwd)) {
            console.log(`  ${color.dim('cache:')} Valkey keeps billing (~$9.49/mo) — ElastiCache has no pause API`);
        }
        console.log(color.yellow(`\n  ⚠ AWS Note: Stopped RDS databases automatically restart after 7 days (${formatUtcTimestamp(autoRestartAt)}). Re-run "npx grada-run sleep" or "npx grada-run destroy" for longer archiving.`));
        console.log(color.green(`\n  💰 Estimated Savings While Asleep: ~$${savings.hourly}/hr (~$${savings.monthly}/mo in ${isLambda ? 'RDS compute' : 'Fargate + RDS compute'} paused)`));
        const wakeEnv = target.envKey === 'default' ? '' : ` ${target.envKey}`;
        console.log(color.dim(`  Wake anytime with: npx grada-run wake${wakeEnv}\n`));

        await trackSuccess('sleep_run', {
            projectName,
            env_kind: target.envKind,
            ecs_scaled: ecsScaled,
            db_stopped: dbStopped,
            db_kind: dbTarget?.kind ?? 'none',
            cron_paused: cronPaused,
            scaling_suspended: scalingSuspended,
        });
        outro(color.green('Done.'));
        return {
            ok: true,
            env: target.envKey,
            cluster: target.cluster,
            region,
            ecsScaled,
            dbStopped,
            dbKind: dbTarget?.kind ?? null,
            cronPaused,
            scalingSuspended,
            autoRestartAt,
            savings,
        };
    } catch (error) {
        await trackFailure('sleep_run', {
            projectName,
            env_kind: target.envKind,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        if (handleAuthErrorBranch(error, s, options)) {
            return { ok: false, reason: 'error', cluster: target.cluster, region };
        }
        try { s.stop(color.red('❌ Sleep failed.')); } catch { /* spinner already stopped */ }
        return failCommand({
            message: `✖ ${error?.message || error}`,
            hint: 'Check your AWS credentials and region, then try again.',
            reason: 'error',
            resultExtra: { cluster: target.cluster, region },
        });
    }
}

export const sleepCommand = runSleep;

export default runSleep;
