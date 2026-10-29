import {
    ECSClient,
    DescribeServicesCommand,
    ListTaskDefinitionsCommand,
    DescribeTaskDefinitionCommand,
    UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import color from 'picocolors';
import path from 'path';
import { intro, outro, spinner, select, isCancel } from '@clack/prompts';
import { trackEvent, flushTelemetry, trackSuccess, trackFailure, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { failCommand, failAwsError, failProjectNotInitialized, refuseIfNonInteractive, refuseUnknownFlags } from '../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { isAuthError, handleAwsAuthError, resolveClient } from '../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveCluster, resolveService, readFileSafe, withWorkspaceNamespace, resolveCwd, guardComputeTarget, readResourceSuffix } from '../utils/resolvers.js';
import { requireManagedTree } from '../utils/terraform-metadata.js';
import { truncateSpinnerText } from '../utils/spinner-text.js';
import { guardSleepingEnv, resolveSleepTarget } from '../utils/sleep-state.js';
import {
    discoverEligibleRevisions as discoverWithAdapter,
    createEcsRevisionAdapter,
    pickNewestEligible,
    INTERACTIVE_CANDIDATE_LIMIT,
} from '../utils/revision-discovery.js';
import { sleep } from '../utils/system.js';

export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_TIMEOUT_MS = 300000;

export function parseRollbackArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'rollback') args.shift();
    const { options: parsed, rest, unknown } = parseFlags(args, {
        string: ['cluster', 'service', 'region', 'workspace'],
        boolean: ['skip-wait', 'headless'],
    });
    const options = { skipWait: false, ...parsed };
    if (unknown.length > 0) options.unknownFlags = unknown;
    for (const arg of rest) {
        if (typeof arg === 'string' && !arg.startsWith('-') && options.revision === undefined) {
            options.revision = arg;
        }
    }
    return options;
}

function parseFamilyAndRevision(taskDefArn) {
    const familyAndRev = String(taskDefArn).split('/').pop();
    const [family, revStr] = familyAndRev.split(':');
    return { family, revNum: Number(revStr) };
}

function formatRegisteredAt(registeredAt) {
    if (registeredAt instanceof Date) return registeredAt.toISOString().slice(0, 10);
    if (registeredAt) return String(registeredAt).slice(0, 10);
    return '';
}

// Discovers ACTIVE revisions older than the deployed one, newest first.
// Thin ECS wrapper over the target-agnostic revision-discovery seam
// (kept as the pinned import for existing callers).
export async function discoverEligibleRevisions(ecsClient, family, currentRevNum) {
    return discoverWithAdapter(createEcsRevisionAdapter(ecsClient), family, currentRevNum);
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runRollback(input = {}) {
    setActiveCommandName('rollback');
    try {
        return await runRollbackMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runRollbackMain(input = {}) {
    const options = normalizeOptions(input);
    const unknownRefusal = await refuseUnknownFlags(options, { command: 'rollback', event: 'rollback_run' });
    if (unknownRefusal) return unknownRefusal;
    let cwd;
    let region;
    let projectName;
    let cluster;
    let service;
    let namespacedProject;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);

        // Namespace cluster/service for PR-preview workspaces; explicit
        // --cluster/--service flags still win inside the resolvers.
        const namespacedOptions = withWorkspaceNamespace(options, cwd);
        namespacedProject = namespacedOptions.projectName;
        cluster = resolveCluster(namespacedOptions, cwd);
        service = resolveService(namespacedOptions, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'rollback_run' });
    }

    const headless = typeof options.isHeadless === 'boolean'
        ? options.isHeadless
        : Boolean(process.env.CI || !process.stdin.isTTY);

    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Ejected trees refuse before anything else; the target guard sits
    // above client construction and the banner so unsupported targets
    // fail with zero AWS contact and zero noise.
    const managedTree = await requireManagedTree({
        cwd, command: 'rollback', options, event: 'rollback_run', projectName,
    });
    if (!managedTree.proceed) return managedTree.result;

    const targetGuard = guardComputeTarget({ cwd, command: 'Rollback', supported: ['ecs'] });
    if (targetGuard) {
        const functionName = `${projectName}${readResourceSuffix(cwd)}-fn`;
        trackEvent('rollback_target_unsupported', { projectName, actual: targetGuard.actual });
        return failCommand({
            message: targetGuard.message,
            hint: targetGuard.actual === 'lambda'
                ? `Redeploy a previous image instead: aws lambda update-function-code --function-name ${functionName} --image-uri <ecr-repo>:<sha-tag> --region ${region}\n  List past image tags with: aws ecr describe-images --repository-name ${projectName}${readResourceSuffix(cwd)}-repo --region ${region}`
                : 'Static sites have no revisions — push to redeploy.',
            event: 'rollback_run',
            telemetry: { projectName },
            errorCode: targetGuard.errorCode,
            reason: targetGuard.reason,
            resultExtra: { cluster, service, region, actual: targetGuard.actual },
            // Dedicated refusal code: distinct from failure's 1 and
            // strict-skip's 2 so automation can tell "wrong target" apart.
            exitCode: 3,
        });
    }

    // Rollback is a warner, not a refuser: an asleep env proceeds (the
    // restore targets stopped services), with apply gated until wake.
    await guardSleepingEnv({
        cwd,
        envKey: resolveSleepTarget(options, cwd).envKey,
        options,
        command: 'rollback',
        mode: 'warn',
        projectName,
    });

    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });

    intro(color.bgCyan(color.black(' grada rollback ⏪ ')));

    const s = spinner();
    s.start('Inspecting service and task revisions...');

    try {
        // 1. Fetch current service state.
        const svcResp = await ecsClient.send(new DescribeServicesCommand({ cluster, services: [service] }));
        const serviceDesc = (svcResp.services || [])[0] || null;

        if (!serviceDesc || serviceDesc.status !== 'ACTIVE') {
            s.stop(color.yellow('Service not found.'));
            return failCommand({
                print: () => {
                    console.log(`\n  The ECS service ${color.cyan(service)} does not exist or is inactive.`);
                    console.log(`  Run ${color.green('npx grada-run apply')} to provision your infrastructure.\n`);
                },
                event: 'rollback_run',
                telemetry: { projectName, error_code: 'SERVICE_NOT_FOUND' },
                reason: 'service-not-found',
                resultExtra: { cluster, service, region },
                exitCode: 1,
            });
        }

        const currentTaskDefArn = serviceDesc.taskDefinition;
        const { family, revNum: currentRevNum } = parseFamilyAndRevision(currentTaskDefArn);

        let targetTaskDefArn;
        let targetRevisionNum;

        if (options.revision !== undefined && options.revision !== null && String(options.revision).trim() !== '') {
            // Case A: explicit revision.
            const rawRevision = String(options.revision).trim();
            const targetInput = /^\d+$/.test(rawRevision) ? `${family}:${rawRevision}` : rawRevision;
            let descResp;
            try {
                descResp = await ecsClient.send(new DescribeTaskDefinitionCommand({ taskDefinition: targetInput }));
            } catch {
                descResp = null;
            }
            if (!descResp?.taskDefinition || descResp.taskDefinition.status === 'INACTIVE') {
                s.stop(color.red('Revision not found.'));
                return failCommand({
                    message: `\n✖ Task definition "${targetInput}" was not found in family "${family}".`,
                    hint: 'List recent revisions with: aws ecs list-task-definitions --family-prefix ' + family + ` --region ${region}\n`,
                    event: 'rollback_run',
                    telemetry: { projectName, error_code: 'REVISION_NOT_FOUND' },
                    reason: 'revision-not-found',
                    resultExtra: { cluster, service, region },
                    exitCode: 1,
                });
            }
            targetTaskDefArn = descResp.taskDefinition.taskDefinitionArn;
            targetRevisionNum = String(descResp.taskDefinition.revision);
            // Explicit family/ARN input escapes the numeric path's forced
            // family scoping: refuse to re-point the service at a foreign
            // family's task definition (fail closed when family is absent).
            if (descResp.taskDefinition.family !== family) {
                s.stop(color.red('Foreign task definition family.'));
                return failCommand({
                    message: `\n✖ Task definition "${targetInput}" belongs to family "${descResp.taskDefinition.family ?? 'unknown'}", not "${family}". Rollback stays within the service's own family.`,
                    hint: 'List recent revisions with: aws ecs list-task-definitions --family-prefix ' + family + ` --region ${region}\n`,
                    event: 'rollback_run',
                    telemetry: { projectName, error_code: 'REVISION_FAMILY_MISMATCH' },
                    reason: 'revision-family-mismatch',
                    resultExtra: { cluster, service, region },
                    exitCode: 1,
                });
            }
            // A request for the currently deployed revision warns instead
            // of silently redeploying it.
            if (targetTaskDefArn === currentTaskDefArn) {
                s.stop(color.yellow('Already on the requested revision.'));
                trackEvent('rollback_current_revision_warned', { projectName, revision: targetRevisionNum });
                return failCommand({
                    message: `\n⚠ Service ${service} is already on revision ${targetRevisionNum} — nothing to roll back.`,
                    tone: 'yellow',
                    hint: '  Request a different revision, or deploy again to create rollback history.\n',
                    event: 'rollback_run',
                    telemetry: { projectName, error_code: 'CURRENT_REVISION_REQUESTED' },
                    reason: 'rollback-current-revision',
                    resultExtra: { cluster, service, region },
                    exitCode: 1,
                });
            }
            s.stop(`Resolved revision ${targetRevisionNum}.`);
        } else {
            // Case B: discover eligible older revisions via the shared seam.
            const eligibleArns = await discoverWithAdapter(createEcsRevisionAdapter(ecsClient), family, currentRevNum);

            if (eligibleArns.length === 0) {
                s.stop(color.yellow('No previous revisions.'));
                return failCommand({
                    message: `\n⚠ Family ${family} is on revision ${currentRevNum} with no previous ACTIVE revisions — nothing to roll back to.\n  Deploy again to create rollback history.\n`,
                    tone: 'yellow',
                    event: 'rollback_run',
                    telemetry: { projectName, error_code: 'NO_PRIOR_REVISIONS' },
                    reason: 'no-prior-revisions',
                    resultExtra: { cluster, service, region },
                    exitCode: 1,
                });
            }

            // Inferred-headless runs (CI, no TTY) refuse instead of
            // silently auto-picking: an explicit revision (Case A) or an
            // explicit --headless flag still bypasses this gate.
            const refused = await refuseIfNonInteractive(options, {
                message: `\n✖ rollback needs a revision before rolling back.`,
                hint: '  Re-run with an explicit revision (rollback 12) or --headless to take the newest previous revision non-interactively.\n',
                event: 'rollback_run',
                telemetry: { projectName },
                errorCode: 'ROLLBACK_NON_INTERACTIVE',
            });
            if (refused) return refused;
            if (headless) {
                targetTaskDefArn = pickNewestEligible(eligibleArns);
                targetRevisionNum = targetTaskDefArn.split(':').pop();
                s.stop(`Selected previous revision ${targetRevisionNum}.`);
            } else {
                const candidates = eligibleArns.slice(0, INTERACTIVE_CANDIDATE_LIMIT);
                const settled = await Promise.allSettled(
                    candidates.map((arn) => ecsClient.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn })))
                );
                const promptOptions = candidates.map((arn, index) => {
                    const result = settled[index];
                    if (result.status === 'fulfilled') {
                        const taskDef = result.value?.taskDefinition || {};
                        const rev = taskDef.revision ?? arn.split(':').pop();
                        const rawImage = taskDef.containerDefinitions?.[0]?.image || 'unknown';
                        return {
                            value: arn,
                            label: `Revision ${rev} — ${rawImage.split('/').pop()}`,
                            hint: formatRegisteredAt(taskDef.registeredAt),
                        };
                    }
                    return {
                        value: arn,
                        label: `Revision ${arn.split(':').pop()} — unknown`,
                        hint: '',
                    };
                });
                s.stop('Found previous revisions.');
                const selectedArn = await select({
                    message: 'Select a task definition revision to roll back to:',
                    options: promptOptions,
                });
                if (isCancel(selectedArn)) {
                    outro(color.yellow('Rollback cancelled.'));
                    return { ok: false, reason: 'cancelled', cluster, service, region };
                }
                targetTaskDefArn = selectedArn;
                targetRevisionNum = targetTaskDefArn.split(':').pop();
            }
        }

        // 1b. Worker rollback (BUG-85): deploys advance web AND worker,
        // so a rollback must move both — otherwise the worker keeps the bad
        // image. Explicit --service keeps single-service semantics (the
        // escape hatch); workerless trees (no worker.tf) skip. Resolved
        // BEFORE any update so a worker with no rollback history fails
        // loud with zero half-state.
        let workerTarget = null;
        const explicitService = (typeof options.service === 'string' && options.service.trim() !== '')
            || (typeof options.serviceName === 'string' && options.serviceName.trim() !== '');
        if (!explicitService && readFileSafe(path.join(cwd, 'terraform', 'worker.tf')) !== null) {
            const workerService = `${namespacedProject}${readResourceSuffix(cwd)}-worker-service`;
            const workerResp = await ecsClient.send(new DescribeServicesCommand({ cluster, services: [workerService] }));
            const workerDesc = (workerResp.services || [])[0] || null;
            if (!workerDesc || workerDesc.status !== 'ACTIVE') {
                console.log(color.yellow(`⚠ Worker service ${workerService} not found or inactive — rolling back ${service} only.`));
            } else {
                const { family: workerFamily, revNum: workerCurrentRev } = parseFamilyAndRevision(workerDesc.taskDefinition);
                const workerEligible = await discoverWithAdapter(createEcsRevisionAdapter(ecsClient), workerFamily, workerCurrentRev);
                if (workerEligible.length === 0) {
                    s.stop(color.yellow('No previous worker revisions.'));
                    return failCommand({
                        message: `\n⚠ Family ${workerFamily} is on revision ${workerCurrentRev} with no previous ACTIVE revisions — refusing to roll back ${service} alone (the worker would keep the bad image).\n  Deploy again to create worker rollback history, or re-run with --service ${service} to roll back the web service only.\n`,
                        tone: 'yellow',
                        event: 'rollback_run',
                        telemetry: { projectName, error_code: 'WORKER_NO_PRIOR_REVISIONS' },
                        reason: 'worker-no-prior-revisions',
                        resultExtra: { cluster, service, region },
                        exitCode: 1,
                    });
                }
                const workerTargetArn = pickNewestEligible(workerEligible);
                workerTarget = { service: workerService, taskDefArn: workerTargetArn, revision: workerTargetArn.split(':').pop() };
            }
        }

        // 2. Trigger the rollback.
        const triggerLabel = workerTarget
            ? `${service} to revision ${targetRevisionNum} and ${workerTarget.service} to revision ${workerTarget.revision}`
            : `${service} to revision ${targetRevisionNum}`;
        s.start(truncateSpinnerText(`Rolling back ${triggerLabel}...`));
        await ecsClient.send(new UpdateServiceCommand({
            cluster,
            service,
            taskDefinition: targetTaskDefArn,
            forceNewDeployment: true,
        }));
        if (workerTarget) {
            await ecsClient.send(new UpdateServiceCommand({
                cluster,
                service: workerTarget.service,
                taskDefinition: workerTarget.taskDefArn,
                forceNewDeployment: true,
            }));
        }

        if (options.skipWait === true) {
            const skipLabel = workerTarget
                ? `revision ${targetRevisionNum} (web) and ${workerTarget.revision} (worker)`
                : `revision ${targetRevisionNum}`;
            s.stop(`Rollback to ${skipLabel} triggered.`);
            await trackSuccess('rollback_run', {
                projectName,
                targetRevision: String(targetRevisionNum),
                skipWait: true,
                ...(workerTarget ? { workerTargetRevision: String(workerTarget.revision) } : {}),
            });
            outro(color.green(`Rollback to ${skipLabel} initiated! 🚀`));
            return {
                ok: true, targetTaskDefArn, targetRevision: targetRevisionNum, cluster, service, region,
                ...(workerTarget ? { worker: { service: workerTarget.service, targetTaskDefArn: workerTarget.taskDefArn, targetRevision: workerTarget.revision } } : {}),
            };
        }

        // 3. Monitor each deployment until it stabilizes or times out,
        // with live spinner updates on every non-terminal tick. Web
        // first, then the worker; a worker failure names the completed
        // web rollback so the half-state is never a mystery.
        const webWait = await waitForPrimaryStable({
            s, ecsClient, cluster, service, targetTaskDefArn, targetRevisionNum,
            pollIntervalMs, timeoutMs, projectName, region,
        });
        if (!webWait.ok) return webWait.failure;
        if (workerTarget) {
            const workerWait = await waitForPrimaryStable({
                s, ecsClient, cluster, service: workerTarget.service,
                targetTaskDefArn: workerTarget.taskDefArn, targetRevisionNum: workerTarget.revision,
                pollIntervalMs, timeoutMs, projectName, region,
                doneNote: `${service} already rolled back to revision ${targetRevisionNum}`,
            });
            if (!workerWait.ok) return workerWait.failure;
        }

        const doneLabel = workerTarget
            ? `revision ${targetRevisionNum} (web) and ${workerTarget.revision} (worker)`
            : `revision ${targetRevisionNum}`;
        s.stop(color.green(`Rolled back to ${doneLabel}.`));
        await trackSuccess('rollback_run', {
            projectName,
            targetRevision: String(targetRevisionNum),
            ...(workerTarget ? { workerTargetRevision: String(workerTarget.revision) } : {}),
        });
        outro(color.green(workerTarget
            ? `Services successfully rolled back to ${doneLabel}! 🚀`
            : `Service successfully rolled back to revision ${targetRevisionNum}! 🚀`));
        return {
            ok: true, targetTaskDefArn, targetRevision: targetRevisionNum, cluster, service, region,
            ...(workerTarget ? { worker: { service: workerTarget.service, targetTaskDefArn: workerTarget.taskDefArn, targetRevision: workerTarget.revision } } : {}),
        };
    } catch (error) {
        if (isAuthError(error)) {
            await trackFailure('rollback_run', { projectName, error_code: 'AUTH_EXPIRED' });
            handleAwsAuthError(error, s, options);
            return { ok: false, reason: 'auth-error', cluster, service, region };
        }
        s.stop(color.red('❌ Rollback failed.'));
        return failAwsError({
            event: 'rollback_run',
            error,
            telemetry: { projectName },
            reason: 'error',
            resultExtra: { cluster, service, region },
            exitCode: 1,
        });
    }
}

// Polls one service until its PRIMARY deployment settles on the target
// revision (or fails/times out). Shared by the web and worker waits;
// `doneNote` names already-completed work on the failure prints so a
// late worker failure never hides the finished web rollback.
async function waitForPrimaryStable({
    s, ecsClient, cluster, service, targetTaskDefArn, targetRevisionNum,
    pollIntervalMs, timeoutMs, projectName, region, doneNote = null,
}) {
    const startTime = Date.now();
    const deadline = startTime + timeoutMs;
    while (true) {
        const pollResp = await ecsClient.send(new DescribeServicesCommand({ cluster, services: [service] }));
        const svc = (pollResp.services || [])[0] || null;
        const primary = svc?.deployments?.find(
            (d) => d.status === 'PRIMARY' && d.taskDefinition === targetTaskDefArn
        );

        if (primary && (primary.rolloutState === 'COMPLETED'
            || (primary.runningCount === primary.desiredCount
                && primary.desiredCount > 0
                && (svc.deployments || []).length === 1))) {
            return { ok: true };
        }

        if (primary?.rolloutState === 'FAILED') {
            s.stop(color.red('❌ Rollback deployment failed.'));
            return {
                ok: false,
                failure: await failCommand({
                    print: () => {
                        console.log(color.red('\n✖ The rollback deployment failed to stabilize.'));
                        if (doneNote) console.log(color.yellow(`  Note: ${doneNote}.`));
                        console.log(`  Check service health with ${color.green('npx grada-run status')} and recent output with ${color.green('npx grada-run logs')}.\n`);
                    },
                    event: 'rollback_run',
                    telemetry: { projectName, error_code: 'ROLLOUT_FAILED', targetRevision: String(targetRevisionNum) },
                    reason: 'rollout-failed',
                    resultExtra: { cluster, service, region },
                    exitCode: 1,
                }),
            };
        }

        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        // Every poll frame goes through the width budget: the
        // crashing-container variant walls past 131 columns on long
        // service names without it.
        const progressStem = `Rolling back ${service} to revision ${targetRevisionNum}... [${elapsedSec}s]`;
        if (!primary) {
            s.message(truncateSpinnerText(`${progressStem} (registering deployment...)`));
        } else {
            const runningCount = primary.runningCount ?? 0;
            const desiredCount = primary.desiredCount ?? 0;
            const pendingCount = primary.pendingCount ?? 0;
            const failedTasks = primary.failedTasks ?? 0;
            if (failedTasks > 0) {
                s.message(truncateSpinnerText(`${progressStem} (${runningCount}/${desiredCount} running, ${pendingCount} pending, ${failedTasks} failed ⚠️ — container crashing)`));
            } else if (runningCount >= desiredCount && desiredCount > 0 && pendingCount === 0) {
                s.message(truncateSpinnerText(`${progressStem} (${runningCount}/${desiredCount} running — draining previous tasks)`));
            } else {
                s.message(truncateSpinnerText(`${progressStem} (${runningCount}/${desiredCount} running, ${pendingCount} pending)`));
            }
        }

        if (Date.now() >= deadline) {
            s.stop(color.yellow('⚠ Rollback timed out waiting for ECS stabilization.'));
            return {
                ok: false,
                failure: await failCommand({
                    print: () => {
                        console.log(color.yellow('\n⚠ The rollback is still in progress.'));
                        if (doneNote) console.log(color.yellow(`  Note: ${doneNote}.`));
                        console.log(`  Check progress with ${color.green('npx grada-run status')}.\n`);
                    },
                    event: 'rollback_run',
                    telemetry: { projectName, error_code: 'ROLLOUT_TIMEOUT', targetRevision: String(targetRevisionNum) },
                    reason: 'rollout-timeout',
                    resultExtra: { cluster, service, region },
                    exitCode: 1,
                }),
            };
        }

        await sleep(pollIntervalMs);
    }
}

// Convenience alias mirroring the CLI verb.
export const rollbackCommand = runRollback;

export default runRollback;
