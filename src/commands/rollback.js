import {
    ECSClient,
    DescribeServicesCommand,
    ListTaskDefinitionsCommand,
    DescribeTaskDefinitionCommand,
    UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import color from 'picocolors';
import { intro, outro, spinner, select, isCancel } from '@clack/prompts';
import { trackEvent, flushTelemetry, trackSuccess, trackFailure } from '../core/telemetry.js';
import { failCommand, failProjectNotInitialized } from '../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { isAuthError, handleAwsAuthError, resolveClient } from '../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveCluster, resolveService, readFileSafe, resolveWorkspaceSuffix, resolveCwd, guardComputeTarget } from '../utils/resolvers.js';
import { sleep } from '../utils/system.js';

export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_TIMEOUT_MS = 300000;

export function parseRollbackArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'rollback') args.shift();
    const { options: parsed, rest } = parseFlags(args, {
        string: ['cluster', 'service', 'region', 'workspace'],
        boolean: ['skip-wait'],
    });
    const options = { skipWait: false, ...parsed };
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

export async function runRollback(input = {}) {
    const options = normalizeOptions(input);
    let cwd;
    let region;
    let projectName;
    let cluster;
    let service;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);

        // Namespace cluster/service for PR-preview workspaces; explicit
        // --cluster/--service flags still win inside the resolvers.
        const namespacedProject = `${projectName}${resolveWorkspaceSuffix(options, cwd)}`;
        const namespacedOptions = { ...options, projectName: namespacedProject };
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

    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });

    intro(color.bgCyan(color.black(' grada rollback ⏪ ')));

    const targetGuard = guardComputeTarget({ cwd, command: 'Rollback', supported: ['ecs'] });
    if (targetGuard) {
        const functionName = `${projectName}-fn`;
        return failCommand({
            message: targetGuard.message,
            hint: targetGuard.actual === 'lambda'
                ? `Redeploy a previous image instead: aws lambda update-function-code --function-name ${functionName} --image-uri <ecr-repo>:<sha-tag> --region ${region}\n  List past image tags with: aws ecr describe-images --repository-name ${projectName}-repo --region ${region}`
                : 'Static sites have no revisions — push to redeploy.',
            event: 'rollback_run',
            telemetry: { projectName },
            errorCode: targetGuard.errorCode,
            reason: targetGuard.reason,
            resultExtra: { cluster, service, region },
        });
    }

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
            });
        }

        const currentTaskDefArn = serviceDesc.taskDefinition;
        const { family, revNum: currentRevNum } = parseFamilyAndRevision(currentTaskDefArn);

        let targetTaskDefArn;
        let targetRevisionNum;

        if (options.revision !== undefined && options.revision !== null && String(options.revision).trim() !== '') {
            // Case A: explicit revision. A request for the currently deployed
            // revision is accepted silently; UpdateService with
            // forceNewDeployment still redeploys it.
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
                });
            }
            targetTaskDefArn = descResp.taskDefinition.taskDefinitionArn;
            targetRevisionNum = String(descResp.taskDefinition.revision);
            s.stop(`Resolved revision ${targetRevisionNum}.`);
        } else {
            // Case B: discover eligible older revisions.
            const listResp = await ecsClient.send(new ListTaskDefinitionsCommand({
                familyPrefix: family,
                status: 'ACTIVE',
                sort: 'DESC',
                maxResults: 10,
            }));
            const eligibleArns = (listResp.taskDefinitionArns || []).filter(
                (arn) => Number(arn.split(':').pop()) < currentRevNum
            );

            if (eligibleArns.length === 0) {
                s.stop(color.yellow('No previous revisions.'));
                return failCommand({
                    message: `\n⚠ No previous task definition revisions found for family ${family}. Cannot roll back.\n`,
                    tone: 'yellow',
                    event: 'rollback_run',
                    telemetry: { projectName, error_code: 'NO_PRIOR_REVISIONS' },
                    reason: 'no-prior-revisions',
                    resultExtra: { cluster, service, region },
                });
            }

            if (headless) {
                targetTaskDefArn = eligibleArns[0];
                targetRevisionNum = targetTaskDefArn.split(':').pop();
                s.stop(`Selected previous revision ${targetRevisionNum}.`);
            } else {
                const candidates = eligibleArns.slice(0, 5);
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

        // 2. Trigger the rollback.
        s.start(`Rolling back ${service} to revision ${targetRevisionNum}...`);
        await ecsClient.send(new UpdateServiceCommand({
            cluster,
            service,
            taskDefinition: targetTaskDefArn,
            forceNewDeployment: true,
        }));

        if (options.skipWait === true) {
            s.stop(`Rollback to revision ${targetRevisionNum} triggered.`);
            await trackSuccess('rollback_run', { projectName, targetRevision: String(targetRevisionNum), skipWait: true });
            outro(color.green(`Rollback to revision ${targetRevisionNum} initiated! 🚀`));
            return { ok: true, targetTaskDefArn, targetRevision: targetRevisionNum, cluster, service, region };
        }

        // 3. Monitor the deployment until it stabilizes or times out,
        // with live spinner updates on every non-terminal tick.
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
                s.stop(color.green(`Rolled back to revision ${targetRevisionNum}.`));
                await trackSuccess('rollback_run', { projectName, targetRevision: String(targetRevisionNum) });
                outro(color.green(`Service successfully rolled back to revision ${targetRevisionNum}! 🚀`));
                return { ok: true, targetTaskDefArn, targetRevision: targetRevisionNum, cluster, service, region };
            }

            if (primary?.rolloutState === 'FAILED') {
                s.stop(color.red('❌ Rollback deployment failed.'));
                return failCommand({
                    print: () => {
                        console.log(color.red('\n✖ The rollback deployment failed to stabilize.'));
                        console.log(`  Check service health with ${color.green('npx grada-run status')} and recent output with ${color.green('npx grada-run logs')}.\n`);
                    },
                    event: 'rollback_run',
                    telemetry: { projectName, error_code: 'ROLLOUT_FAILED', targetRevision: String(targetRevisionNum) },
                    reason: 'rollout-failed',
                    resultExtra: { cluster, service, region },
                });
            }

            const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
            if (!primary) {
                s.message(`Rolling back ${service} to revision ${targetRevisionNum}... [${elapsedSec}s] (registering deployment...)`);
            } else {
                const runningCount = primary.runningCount ?? 0;
                const desiredCount = primary.desiredCount ?? 0;
                const pendingCount = primary.pendingCount ?? 0;
                const failedTasks = primary.failedTasks ?? 0;
                if (failedTasks > 0) {
                    s.message(`Rolling back ${service} to revision ${targetRevisionNum}... [${elapsedSec}s] (${runningCount}/${desiredCount} running, ${pendingCount} pending, ${failedTasks} failed ⚠️ — container crashing)`);
                } else if (runningCount >= desiredCount && desiredCount > 0 && pendingCount === 0) {
                    s.message(`Rolling back ${service} to revision ${targetRevisionNum}... [${elapsedSec}s] (${runningCount}/${desiredCount} running — draining previous tasks)`);
                } else {
                    s.message(`Rolling back ${service} to revision ${targetRevisionNum}... [${elapsedSec}s] (${runningCount}/${desiredCount} running, ${pendingCount} pending)`);
                }
            }

            if (Date.now() >= deadline) {
                s.stop(color.yellow('⚠ Rollback timed out waiting for ECS stabilization.'));
                return failCommand({
                    print: () => {
                        console.log(color.yellow('\n⚠ The rollback is still in progress.'));
                        console.log(`  Check progress with ${color.green('npx grada-run status')}.\n`);
                    },
                    event: 'rollback_run',
                    telemetry: { projectName, error_code: 'ROLLOUT_TIMEOUT', targetRevision: String(targetRevisionNum) },
                    reason: 'rollout-timeout',
                    resultExtra: { cluster, service, region },
                });
            }

            await sleep(pollIntervalMs);
        }
    } catch (error) {
        if (isAuthError(error)) {
            await trackFailure('rollback_run', { projectName, error_code: 'AUTH_EXPIRED' });
            handleAwsAuthError(error, s, options);
            return { ok: false, reason: 'auth-error', cluster, service, region };
        }
        await trackFailure('rollback_run', {
            projectName,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        s.stop(color.red('❌ Rollback failed.'));
        return failCommand({
            message: `✖ ${error?.message || error}`,
            hint: 'Check your AWS credentials and region, then try again.',
            reason: 'error',
            resultExtra: { cluster, service, region },
        });
    }
}

// Convenience alias mirroring the CLI verb.
export const rollbackCommand = runRollback;

export default runRollback;
