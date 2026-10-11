import path from 'path';
import fs from 'fs';
import { intro, outro, spinner, log, cancel, confirm } from '@clack/prompts';
import color from 'picocolors';
import { renderDryRunPreview, parseTerraformConfig, buildCostTelemetryProps } from '../utils/visualizer.js';
import { detectFramework } from '../utils/detector.js';
import { trackEvent, flushTelemetry, trackSuccess, trackFailure, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { failCommand, shouldAutoApprove } from '../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { spawnSync } from 'child_process';
import { runTerraformCommand, getTerraformOutputs, readLastRunMarker, isInterruptedMarker, ensureTerraformInit, checkOutputsContract, DEFAULT_TERRAFORM_PHASE_TIMEOUT_MS } from '../utils/terraform.js';
import { classifyTerraformError, countRecreateCollisions, getRunbook, ERROR_CODES } from '../utils/terraform-errors.js';
import { readInitManifest, recordAppliedTarget } from '../utils/backup.js';
import { requireManagedTree } from '../utils/terraform-metadata.js';
import { readTerraformComputeTarget } from '../utils/resolvers.js';
import { requireAwakeEnvironment, resolveSleepTarget, guardSleepingEnv } from '../utils/sleep-state.js';
import { promptStateBucketRecovery, recreateStateBucket } from '../utils/recovery.js';
import { resolveProjectName, readResourceSuffix } from '../utils/resolvers.js';
import { ensureLambdaSeedImage } from '../utils/lambda-ecr.js';
import { runWake } from './wake.js';

export function parseApplyArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'apply' || args[0] === 'deploy') args.shift();
    const { options } = parseFlags(args, {
        boolean: ['force', 'destroy-previous-target', 'force-resume', 'allow-partial-outputs'],
        string: ['force-unlock'],
    });
    return { force: false, ...options };
}

// Unlock-and-retry flow for a stale Terraform state lock. Headless
// refuses unless `--force-unlock <id>` was passed; interactive asks once.
// Retries the apply exactly once, skipping the already-confirmed preview.
async function handleApplyStateLock({ options, tfDir, runTerraform, lockId, projectName, costProps }) {
    trackEvent('state_lock_detected', { projectName, command: 'apply' });
    const flagId = typeof options.forceUnlock === 'string' && options.forceUnlock.trim() !== ''
        ? options.forceUnlock.trim()
        : null;
    const unlockId = flagId || lockId;
    const approvedByFlag = flagId !== null || options.forceUnlock === true;

    const refuse = () => {
        const runbook = getRunbook('STATE_LOCK_HELD', { headless: true, lockId });
        return failCommand({
            message: `\n✖ ${runbook.message}`,
            hint: `  ${runbook.hint}\n`,
            event: 'infrastructure_applied',
            telemetry: { projectName, ...costProps },
            errorCode: 'STATE_LOCK_HELD',
            reason: 'state-lock-held',
        });
    };

    // Retry only once, and only with a known id: a second lock means
    // someone else really holds it.
    if (options._lockRetried === true || !unlockId) return refuse();

    const unlockAndRetry = async (mode) => {
        const unlockSpinner = spinner();
        unlockSpinner.start('Releasing the stale state lock...');
        await runTerraform(['force-unlock', '-force', unlockId], tfDir, unlockSpinner, 'Unlocking');
        unlockSpinner.stop('State lock released.');
        trackEvent('state_lock_force_unlocked', { projectName, mode });
        await flushTelemetry();
        log.message(color.cyan('Retrying the interrupted command...'));
        return applyStack({ ...options, _skipPreview: true, _lockRetried: true });
    };

    if (approvedByFlag) return unlockAndRetry('flag');
    if (!shouldAutoApprove(options)) {
        const runbook = getRunbook('STATE_LOCK_HELD', { headless: false, lockId });
        log.error(color.red(`✖ ${runbook.message}`));
        log.message(`  ${runbook.hint}\n`);
        const confirmed = await confirm({
            message: `Force-unlock state lock ${unlockId} and retry the apply?`,
            initialValue: false,
        });
        if (confirmed === true) return unlockAndRetry('interactive');
        return refuse();
    }
    return refuse();
}

// Renders the cross-target plan so the destroy side is visible before an
// override proceeds. Prints destroy lines plus the Plan summary (when the
// runner captures any — injected mocks capture nothing and print nothing).
async function renderSwitchPlan({ runTerraform, tfDir, lifecycleOpts }) {
    const planSpinner = spinner();
    planSpinner.start('Rendering the cross-target plan...');
    const lines = [];
    await runTerraform(['plan', '-input=false', '-no-color'], tfDir, planSpinner, 'Planning', {
        ...lifecycleOpts,
        onStdoutLine: (line) => lines.push(line),
    });
    planSpinner.stop('Plan rendered.');
    const interesting = lines.filter((line) => /destroy/i.test(line) || /^Plan:/.test(line.trim()));
    for (const line of interesting.slice(0, 40)) console.log(color.dim(`  ${line.trim()}`));
    if (interesting.length > 40) console.log(color.dim(`  …and ${interesting.length - 40} more destroy lines`));
}

// Target-switch destroy gate (C1). The on-disk tree is truth for what
// Terraform is about to do; the manifest records what was last applied.
// A known mismatch, or a legacy manifest with unknown history, refuses
// closed (fail-closed: the previous stack may hold live infrastructure).
// `--destroy-previous-target` renders the plan and proceeds; interactive
// runs review the rendered plan and confirm instead. Returns
// `{ proceed, previousAppliedTarget, result? }`.
async function enforceTargetSwitchGate({ options, targetDir, tfDir, runTerraform, lifecycleOpts, diskTarget }) {
    const manifest = readInitManifest(targetDir);
    const appliedTarget = manifest?.appliedTarget ?? null;
    const knownSwitch = appliedTarget !== null && appliedTarget !== diskTarget;
    const legacyUnknown = manifest !== null && manifest.version !== 2;
    if (!knownSwitch && !legacyUnknown) {
        return { proceed: true, previousAppliedTarget: appliedTarget };
    }
    const from = appliedTarget ?? 'unknown';
    const projectName = path.basename(targetDir);

    if (options.destroyPreviousTarget === true) {
        await renderSwitchPlan({ runTerraform, tfDir, lifecycleOpts });
        trackEvent('target_switch_override', { projectName, from, to: diskTarget });
        await flushTelemetry();
        log.message(color.yellow(`⚠ Target switch ${from} → ${diskTarget} approved via --destroy-previous-target. Review the plan above.`));
        return { proceed: true, previousAppliedTarget: appliedTarget };
    }

    if (!shouldAutoApprove(options)) {
        log.warn(color.yellow(`⚠ This tree targets "${diskTarget}" but the last apply recorded "${from}". Applying would destroy the previous stack.`));
        await renderSwitchPlan({ runTerraform, tfDir, lifecycleOpts });
        const confirmed = await confirm({
            message: `Apply across targets (destroy the ${from} stack, create ${diskTarget})?`,
            initialValue: false,
        });
        if (confirmed === true) {
            trackEvent('target_switch_override', { projectName, from, to: diskTarget });
            await flushTelemetry();
            return { proceed: true, previousAppliedTarget: appliedTarget };
        }
        cancel('Apply cancelled. No infrastructure was changed.');
        process.exit(0);
        return { proceed: false, result: { ok: false, reason: 'cancelled' } };
    }

    const hint = legacyUnknown
        ? 'This project predates target tracking. Run "cd terraform && terraform plan" and confirm no live infrastructure is destroyed, then re-run with --destroy-previous-target.'
        : `The last apply recorded target "${from}" but this tree targets "${diskTarget}". Run "cd terraform && terraform plan" to review the destroys, then re-run with --destroy-previous-target.`;
    return {
        proceed: false,
        previousAppliedTarget: appliedTarget,
        result: failCommand({
            message: `\n✖ Refusing to apply across compute targets (${from} → ${diskTarget}): the previous stack would be destroyed.`,
            hint: `  ${hint}\n`,
            event: 'infrastructure_applied',
            telemetry: { projectName },
            errorCode: 'TARGET_SWITCH_DESTROY_REVIEW',
            reason: 'target-switch-destroy-review',
        }),
    };
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function applyStack(input = {}) {
    setActiveCommandName('apply');
    try {
        return await applyStackMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function applyStackMain(input = {}) {
    const options = normalizeOptions(input);
    intro(color.bgCyan(color.black(' grada apply ☁️  ')));

    const targetDir = process.cwd();
    const tfDir = path.join(targetDir, 'terraform');

    // 0. Ejected trees are user-owned: refuse unless --force.
    const managedTree = await requireManagedTree({
        cwd: targetDir, command: 'apply', options,
        event: 'infrastructure_applied', projectName: path.basename(targetDir),
    });
    if (!managedTree.proceed) return managedTree.result;

    // 1. Verify that the user is inside a project generated by grada
    if (!fs.existsSync(tfDir) || !fs.existsSync(path.join(tfDir, 'main.tf'))) {
        return failCommand({
            print: () => {
                log.error(color.red('✖ No terraform directory found in current path.'));
                log.message('Please run "npx grada-run" first to generate your infrastructure templates.');
            },
        });
    }

    // 1a. Surface an interrupted previous run. Informational only — the
    // new run overwrites the marker when it starts.
    const lastRun = readLastRunMarker(targetDir);
    if (isInterruptedMarker(lastRun)) {
        log.warn(color.yellow(`⚠ Previous ${lastRun.command || 'terraform'} run was interrupted (started ${lastRun.startedAt || 'unknown'}). If it died mid-apply, review with ${color.green('cd terraform && terraform plan')} before trusting this run.`));
    }

    // 1b. Refuse to apply against an asleep environment: apply resets
    // the app desired count while the database stays stopped, so fresh
    // tasks would crash-loop. Dry runs change nothing, so they keep the
    // historical advisory warning instead of the shared gate.
    const sleepTarget = resolveSleepTarget({}, targetDir);
    if (options.isDryRun && requireAwakeEnvironment(targetDir, sleepTarget.envKey)) {
        log.warn(color.yellow(`⚠ Environment "${sleepTarget.envKey}" is asleep. This preview changes nothing; run ${color.green('npx grada-run wake')} before a real apply.`));
    } else {
        const sleepGuard = await guardSleepingEnv({
            cwd: targetDir,
            envKey: sleepTarget.envKey,
            options,
            command: 'apply',
            mode: 'refuse',
            event: 'infrastructure_applied',
            projectName: path.basename(targetDir),
            wakeImpl: options.wakeImpl || runWake,
        });
        if (!sleepGuard.proceed) return sleepGuard.result;
    }

    // 2. Read the actual AWS configuration from disk (CPU, Memory, Region, Database)
    const detectedConfig = parseTerraformConfig(tfDir);
    detectedConfig.projectName = path.basename(process.cwd());
    const costProps = buildCostTelemetryProps(detectedConfig);

    // 3. Detect the framework name using your existing detector
    const detectedFw = detectFramework(targetDir);
    detectedConfig.framework = detectedFw ? detectedFw.name : 'Container';

    // 4. Run the visualizer (passing the flag so it knows whether to prompt)
    if (options.isDryRun) {
        await renderDryRunPreview(detectedConfig, true);
        outro(color.green('Dry run complete. No infrastructure was provisioned.'));
        await trackSuccess('infrastructure_dry_run', {
            framework: detectedConfig.framework,
            ...costProps,
        });
        process.exit(0);
    } else if (shouldAutoApprove(options) || options._skipPreview === true) {
        // Internal lock-retry resumes skip the preview: the user already
        // confirmed it before the lock failure.
        await renderDryRunPreview(detectedConfig, true);
    } else {
        const confirmed = await renderDryRunPreview(detectedConfig, false);
        if (!confirmed) {
            cancel('Apply aborted.');
            process.exit(0);
        }
    }

    const s = spinner();
    const runTerraform = options.runTerraformImpl || runTerraformCommand;
    const runSync = options.spawnSyncImpl || spawnSync;
    const lifecycleOpts = { markerDir: targetDir, timeoutMs: DEFAULT_TERRAFORM_PHASE_TIMEOUT_MS };
    const diskTarget = readTerraformComputeTarget(targetDir);

    try {
        // 4b. Target-switch destroy gate (C1): refuses before any
        // Terraform call when the tree no longer matches the last apply.
        const switchGate = await enforceTargetSwitchGate({ options, targetDir, tfDir, runTerraform, lifecycleOpts, diskTarget });
        if (switchGate.proceed === false) return switchGate.result;
        const previousAppliedTarget = switchGate.previousAppliedTarget ?? null;

        // 5. Run terraform init
        s.start('Initializing Terraform plugins...');
        await ensureTerraformInit(tfDir, runTerraform, s, { upgrade: true, prefix: 'Initializing', lifecycleOpts });
        s.stop('Terraform initialized.');

        // 5b. Lambda Day-0 bootstrap: CreateFunction rejects an empty ECR
        // repository, so ensure the repository exists and seed a minimal
        // placeholder image when :latest hasn't been pushed yet. No-op on
        // reruns once CI owns the tag.
        if (detectedConfig.computeTarget === 'lambda') {
            s.start('Ensuring ECR repository for the Lambda image...');
            await runTerraform(['apply', '-target=aws_ecr_repository.app', '-input=false', '-auto-approve'], tfDir, s, 'Ensuring ECR repository', lifecycleOpts);
            s.stop('ECR repository ready.');

            s.start('Checking for a deployable container image...');
            const seed = ensureLambdaSeedImage({
                run: runSync,
                repository: `${resolveProjectName({}, targetDir)}${readResourceSuffix(targetDir)}-repo`,
                region: detectedConfig.region,
            });
            if (!seed.ok) {
                if (seed.reason === 'cli-missing') {
                    throw new Error('AWS CLI is required to bootstrap the Lambda container image on Day 0 (install it from https://aws.amazon.com/cli/, then re-run apply).');
                }
                throw new Error(`Could not bootstrap the Day-0 Lambda container image (${seed.reason}${seed.detail ? `: ${seed.detail}` : ''}). Push any image to ECR and re-run apply.`);
            }
            s.stop(seed.seeded ? 'Day-0 placeholder image seeded.' : 'Container image already present.');
        }

        // 6. Run terraform apply
        s.start('Provisioning AWS infrastructure (this may take 3–5 minutes)...');
        await runTerraform(['apply', '-auto-approve'], tfDir, s, 'Provisioning', lifecycleOpts);
        s.stop('Cloud resources provisioned.');

        // 7. Extract and print the outputs
        const outputs = await getTerraformOutputs(tfDir);

        // Record the applied target for the switch gate. Bookkeeping
        // only: a failed write warns but never fails a successful apply.
        // Runs before the outputs gate: Terraform applied regardless of
        // whether outputs came back.
        try {
            await recordAppliedTarget(targetDir, { target: diskTarget });
        } catch (recordError) {
            log.warn(color.yellow(`⚠ Apply succeeded but the applied target could not be recorded: ${recordError.message}`));
        }

        // 7b. Outputs contract: a fully-empty map means Terraform applied
        // but returned nothing usable — fail loud instead of printing a
        // hollow success. Missing keys warn (conservative start to avoid
        // false positives on customized trees); --allow-partial-outputs
        // downgrades the empty-map failure to a warning.
        const outputsCheck = checkOutputsContract(outputs, diskTarget);
        const contractProject = path.basename(targetDir);
        if (outputsCheck.empty || outputsCheck.missing.length > 0) {
            trackEvent('outputs_contract_violated', {
                projectName: contractProject,
                target: diskTarget,
                missing: outputsCheck.missing,
            });
        }
        const allowPartialOutputs = options.allowPartialOutputs === true || options.allowPartialOutputs === 'true';
        const expectedList = outputsCheck.expected.length > 0 ? outputsCheck.expected.join(', ') : '(none declared)';
        const gotList = outputsCheck.got.length > 0 ? outputsCheck.got.join(', ') : 'none';
        if (outputsCheck.empty && !allowPartialOutputs) {
            const interrupted = isInterruptedMarker(readLastRunMarker(targetDir));
            return failCommand({
                message: `\n⚠ Terraform applied, but returned no outputs (partial state) — expected [${expectedList}] for ${diskTarget}, got ${gotList}.`,
                hint: `  Next steps: run \`terraform output\` in terraform/ to inspect; if the resources exist, re-run apply; if this tree legitimately has no outputs, re-run with --allow-partial-outputs.${interrupted ? '\n  The previous run was interrupted — this looks like a resumed/completed partial apply; verify the resources above before trusting applied state.' : ''}\n`,
                event: 'infrastructure_applied',
                telemetry: { projectName: contractProject, error_code: 'PARTIAL_STATE' },
                errorCode: 'PARTIAL_STATE',
                reason: 'partial-state',
                resultExtra: { target: diskTarget },
                exitCode: 1,
            });
        }
        if (outputsCheck.missing.length > 0 || outputsCheck.empty) {
            console.log(color.yellow(`⚠ Partial outputs: expected [${expectedList}] for ${diskTarget}, got ${gotList} — proceeding; pass --allow-partial-outputs to silence this.`));
        }

        const cfUrl = outputs.cloudfront_url?.value;
        const albUrl = outputs.alb_direct_url?.value;
        const apiUrl = outputs.api_gateway_url?.value;
        const siteUrl = outputs.site_url?.value;

        let finalMessage = color.green('✅ Infrastructure is live!');
        if (cfUrl) finalMessage += `\n  🌍 App URL: ${color.cyan(cfUrl)} ${color.dim('(global CDN — share this link)')}`;
        if (albUrl) finalMessage += `\n  🚦 Direct URL: ${color.gray(albUrl)} ${color.dim('(bypasses the CDN — for debugging)')}`;
        if (apiUrl) finalMessage += `\n  🔌 API URL: ${color.gray(apiUrl)} ${color.dim('(bypasses the CDN — for debugging)')}`;
        if (siteUrl) finalMessage += `\n  🌍 Site URL: ${color.cyan(siteUrl)} ${color.dim('(global CDN — share this link)')}`;

        outro(`${finalMessage}\n\n  ${color.yellow('Push code to deploy your app and clear the 503 error:')}\n  ${color.cyan('git add . && git commit -m "ci: infra" && git push origin main')}`);

        const actualProjectName = path.basename(process.cwd());
        await trackSuccess('infrastructure_applied', {
            projectName: actualProjectName,
            framework: detectedConfig.framework,
            target: diskTarget,
            previous_applied_target: previousAppliedTarget,
            ...costProps
        });

        process.exit(0);

    } catch (error) {
        s.stop(color.red('❌ Terraform apply failed.'));

        const errString = error.message || "";
        const actualProjectName = path.basename(process.cwd());
        // Prefer the runner's structured code, else classify stderr once.
        // (The classifier reads the whole AlreadyExists family in any
        // phase — post-recovery or same-run — as a recreate collision.)
        const structuredCode = typeof error.code === 'string' && ERROR_CODES.includes(error.code) ? error.code : null;
        const classified = classifyTerraformError(errString, { postRecovery: options._postRecovery === true });
        const code = structuredCode || classified?.code || null;
        const lockId = error.lockId || classified?.lockId || null;

        if (code === 'STATE_BUCKET_MISSING' && options._postRecovery === true) {
            // The bucket is still missing after a recreate: refuse instead
            // of looping recreate→resume forever.
            const runbook = getRunbook('STATE_BUCKET_MISSING', { headless: shouldAutoApprove(options) });
            log.error(color.red(`✖ ${runbook.message}`));
            log.message(`  ${runbook.hint}\n`);
            await trackFailure('infrastructure_applied', {
                projectName: actualProjectName,
                error_code: 'STATE_BUCKET_MISSING',
                ...costProps
            });
            return failCommand({ exitCode: 1 });
        }

        if (code === 'STATE_BUCKET_MISSING') {
            log.warn('Terraform state bucket is missing (likely deleted manually or via destroy).');

            trackEvent('recovery_prompted', { type: 'state_bucket_missing' });

            const shouldRecreate = await promptStateBucketRecovery({ autoApprove: shouldAutoApprove(options) });

            if (!shouldRecreate) {
                return failCommand({
                    print: () => cancel('Apply aborted. State bucket remains missing.'),
                    event: 'recovery_declined',
                    telemetry: { type: 'state_bucket_missing' },
                });
            }

            trackEvent('recovery_accepted', { type: 'state_bucket_missing' });

            try {
                const targetRegion = detectedConfig.region || process.env.AWS_REGION || 'us-east-2';

                const recSpinner = spinner();
                recSpinner.start('Recreating S3 state bucket in AWS...');
                await recreateStateBucket({ tfDir, region: targetRegion });
                recSpinner.stop('✅ State bucket recreated.');

                trackEvent('recovery_successful', { type: 'state_bucket_missing' });

                // 3. Resume the apply flow with the caller's approval mode
                // preserved (no forced auto-approve): an interactive user
                // re-confirms the preview. `_postRecovery` marks the
                // resumed attempt (the resume attempt itself is the
                // probe — plan-refresh-only cannot surface collisions
                // against fresh empty state).
                log.message(color.cyan('Resuming infrastructure provisioning...'));
                return applyStack({ ...options, _postRecovery: true });

            } catch (recoveryErr) {
                return failCommand({
                    print: () => {
                        log.error(color.red('✖ Failed to auto-recover state bucket.'));
                        log.message(recoveryErr.message || recoveryErr);
                    },
                    event: 'recovery_failed',
                    telemetry: { type: 'state_bucket_missing', error: recoveryErr.message },
                });
            }
        }

        if (code === 'STATE_LOCK_HELD') {
            return handleApplyStateLock({ options, tfDir, runTerraform, lockId, projectName: actualProjectName, costProps });
        }

        if (code === 'RECREATE_COLLISION') {
            const collisions = countRecreateCollisions(errString) || 1;
            if (options.forceResume === true) {
                trackEvent('bucket_recovery_resume_forced', { projectName: actualProjectName });
                await flushTelemetry();
                // Escape hatch: surface Terraform's own error instead of
                // the policy refusal below.
                const runbook = getRunbook('RECREATE_COLLISION', { headless: shouldAutoApprove(options) });
                log.error(color.red(`✖ ${runbook.message}`));
                log.message(`  ${runbook.hint}\n`);
                log.message(color.dim(errString.split('\n').slice(0, 8).join('\n')));
                await trackFailure('infrastructure_applied', {
                    projectName: actualProjectName,
                    error_code: 'RECREATE_COLLISION',
                    ...costProps
                });
                return failCommand({ exitCode: 1 });
            }
            trackEvent('bucket_recovery_probed', { projectName: actualProjectName, collisions });
            await flushTelemetry();
            const runbook = getRunbook('RECREATE_COLLISION', { headless: shouldAutoApprove(options) });
            return failCommand({
                message: `\n✖ ${runbook.message}`,
                hint: `  ${runbook.hint}\n  Import each address it names, e.g.:\n    ${color.green('cd terraform && terraform import <address> <aws-id>')}\n`,
                event: 'infrastructure_applied',
                telemetry: { projectName: actualProjectName, error_code: 'RECREATE_COLLISION', ...costProps },
                errorCode: 'RECREATE_COLLISION',
                reason: 'recreate-collision',
                exitCode: 1,
            });
        }

        if (code === 'OIDC_PROVIDER_CONFLICT') {
            log.error(color.red('GitHub OIDC Provider Conflict Detected'));
            log.message('AWS only allows one GitHub Actions provider per account, and you already have one configured.');
            log.message('');
            log.message(`${color.bold('How to fix this:')}`);
            log.message(`1. Open ${color.cyan('terraform/oidc.tf')}`);
            log.message(`2. Change ${color.green('create_oidc_provider = true')} to ${color.green('create_oidc_provider = false')}`);
            log.message(`3. Run ${color.cyan('npx grada-run apply')} again.`);
        } else if (code === 'BACKEND_RECONFIGURE_REQUIRED' || code === 'CLOUDFRONT_IN_PROGRESS' || code === 'DELETION_PROTECTION_ACTIVE') {
            // Named but flow-neutral: runbook guidance with a coded
            // failure. (RECREATE_COLLISION has its dedicated branch
            // above; deletion protection's destroy flow lives in
            // destroy.js.)
            const runbook = getRunbook(code, { headless: shouldAutoApprove(options), lockId });
            log.error(color.red(`✖ ${runbook.message}`));
            log.message(`  ${runbook.hint}\n`);
            log.message(color.dim(errString.split('\n').slice(0, 8).join('\n')));
        } else {
            // Generic fallback for unknown errors
            log.error(color.red(errString));
            log.message(`${color.bold('To debug manually, navigate to your terraform folder:')}`);
            log.message(color.cyan('cd terraform && terraform apply'));
        }

        await trackFailure('infrastructure_applied', {
            projectName: actualProjectName,
            error_code: code || error.code || 'UNKNOWN',
            ...costProps
        });

        return failCommand({ exitCode: 1 });
    }
}