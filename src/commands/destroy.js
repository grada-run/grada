import fsSync from 'fs';
import path from 'path';
import { intro, outro, confirm, spinner, cancel } from '@clack/prompts';
import color from 'picocolors';
import { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand, StartDBInstanceCommand, StartDBClusterCommand, CreateDBSnapshotCommand, CreateDBClusterSnapshotCommand, ModifyDBInstanceCommand, ModifyDBClusterCommand } from '@aws-sdk/client-rds';
import { S3Client } from '@aws-sdk/client-s3';
import { teardownStateBucket, drainBucketObjects, resolveClient } from '../utils/aws.js';
import { checkDependency, pollUntil } from '../utils/system.js';
import { trackEvent, flushTelemetry, trackSuccess, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { failCommand, shouldAutoApprove, refuseIfNonInteractive, refuseUnknownFlags } from '../utils/command.js';
import { runTerraformCommand, readLastRunMarker, isInterruptedMarker, ensureTerraformInit, getTerraformStateBuckets, DEFAULT_TERRAFORM_PHASE_TIMEOUT_MS } from '../utils/terraform.js';
import { classifyTerraformError, getRunbook, ERROR_CODES } from '../utils/terraform-errors.js';
import { findDbTarget, dbStatusOf, resolveDbIdentifier, resolveDbClusterIdentifier, generateSnapshotId } from '../utils/rds.js';
import { requireManagedTree, parseStateBucketBackend } from '../utils/terraform-metadata.js';
import { guardSleepingEnv } from '../utils/sleep-state.js';
import { normalizeOptions, parseFlags, normalizeArgv } from '../utils/args.js';

export const DEFAULT_DESTROY_DB_TIMEOUT_MS = 600000;
export const DEFAULT_DESTROY_DB_SETTLE_TIMEOUT_MS = 1800000;
export const DEFAULT_DESTROY_DB_POLL_INTERVAL_MS = 5000;

// True when the tree's database template declares the data-loss variable
// (new templates only). Destroy passes the -var override exclusively in
// that case: undeclared -var values are a Terraform error, and old trees
// predate deletion protection entirely.
export function treeDeclaresDataLossVar(tfDir) {
    for (const file of ['database.tf', 'database-mysql.tf', 'database-aurora-postgresql.tf']) {
        try {
            if (fsSync.readFileSync(path.join(tfDir, file), 'utf8').includes('grada_allow_data_loss')) {
                return true;
            }
        } catch {
            // Missing/unreadable template: keep looking.
        }
    }
    return false;
}

export function parseDestroyArgs(argv = []) {
    const args = normalizeArgv(argv);
    const { options, unknown } = parseFlags(args, {
        boolean: ['allow-data-loss', 'force'],
        string: ['force-unlock'],
    });
    if (unknown.length > 0) options.unknownFlags = unknown;
    return { allowDataLoss: false, force: false, ...options };
}

// Classifies a failed `terraform destroy` once. State locks get the
// unlock-and-retry flow (flag, one interactive ask, else refuse);
// other recognized failures get a named runbook instead of raw stderr.
// Returns `{ retried: true }` when the destroy recovered so the caller
// continues to bucket cleanup, else `{ retried: false, result }`.
async function handleDestroyTerraformError({ options, tfDirPath, attemptDestroy, error }) {
    const actualProjectName = path.basename(process.cwd());
    const errString = String(error.message || error);
    const structuredCode = typeof error.code === 'string' && ERROR_CODES.includes(error.code) ? error.code : null;
    const classified = classifyTerraformError(errString);
    const code = structuredCode || classified?.code || null;
    const lockId = error.lockId || classified?.lockId || null;

    const namedFail = (namedCode) => {
        const runbook = getRunbook(namedCode, { headless: shouldAutoApprove(options), lockId });
        return {
            retried: false,
            result: failCommand({
                message: `\n✖ ${runbook.message}\n  ${runbook.hint}\n`,
                useErrorStream: true,
                event: 'infrastructure_destroyed',
                telemetry: { projectName: actualProjectName, error_code: namedCode },
                errorCode: namedCode,
                reason: namedCode.toLowerCase().replace(/_/g, '-'),
            }),
        };
    };

    if (code === 'STATE_LOCK_HELD') {
        trackEvent('state_lock_detected', { projectName: actualProjectName, command: 'destroy' });
        const flagId = typeof options.forceUnlock === 'string' && options.forceUnlock.trim() !== ''
            ? options.forceUnlock.trim()
            : null;
        const unlockId = flagId || lockId;
        const approvedByFlag = flagId !== null || options.forceUnlock === true;

        const unlockAndRetry = async (mode) => {
            await runTerraformCommand(['force-unlock', '-force', unlockId], tfDirPath);
            trackEvent('state_lock_force_unlocked', { projectName: actualProjectName, mode });
            await flushTelemetry();
            try {
                await attemptDestroy();
            } catch (retryError) {
                // No retry loops: whatever the retry hits is terminal.
                return { retried: false, result: failCommand({ message: String(retryError.message || retryError), useErrorStream: true, event: 'infrastructure_destroyed', errorCode: retryError.code || 'UNKNOWN', reason: 'destroy-retry-failed' }) };
            }
            return { retried: true };
        };

        if (unlockId && approvedByFlag) return unlockAndRetry('flag');
        if (unlockId && !shouldAutoApprove(options)) {
            const refused = await refuseIfNonInteractive(options, {
                message: `\n✖ destroy needs approval to force-unlock the Terraform state lock.`,
                hint: `  Re-run with --force-unlock ${unlockId} to unlock non-interactively.\n`,
                event: 'infrastructure_destroyed',
                telemetry: { projectName: actualProjectName },
                errorCode: 'DESTROY_NON_INTERACTIVE',
            });
            if (refused) return refused;
            const runbook = getRunbook('STATE_LOCK_HELD', { headless: false, lockId });
            console.error(color.red(`✖ ${runbook.message}`));
            console.log(`  ${runbook.hint}`);
            const confirmed = await confirm({
                message: `Force-unlock state lock ${unlockId} and retry the destroy?`,
                initialValue: false,
            });
            if (confirmed === true) return unlockAndRetry('interactive');
        }
        return namedFail('STATE_LOCK_HELD');
    }

    if (code === 'BACKEND_RECONFIGURE_REQUIRED' || code === 'DESTROY_DEPENDENCY_VIOLATION'
        || code === 'CLOUDFRONT_IN_PROGRESS' || code === 'DELETION_PROTECTION_ACTIVE') {
        return namedFail(code);
    }

    return {
        retried: false,
        result: failCommand({
            message: error.message,
            useErrorStream: true,
            event: 'infrastructure_destroyed',
            telemetry: { projectName: actualProjectName, error_code: error.code || 'UNKNOWN' },
        }),
    };
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function destroyStack(input = {}) {
    setActiveCommandName('destroy');
    try {
        return await destroyStackMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function destroyStackMain(input = {}) {
    const options = normalizeOptions(input);
    const unknownRefusal = await refuseUnknownFlags(options, { command: 'destroy', event: 'infrastructure_destroyed' });
    if (unknownRefusal) return unknownRefusal;
    intro(color.bgRed(color.white(' grada destroy 🗑️  ')));

    // Ejected trees are user-owned: refuse unless --force.
    const managedTree = await requireManagedTree({
        cwd: process.cwd(), command: 'destroy', options,
        event: 'infrastructure_destroyed', projectName: path.basename(process.cwd()),
    });
    if (!managedTree.proceed) return managedTree.result;

    const tfDirPath = path.join(process.cwd(), 'terraform');
    const backendFilePath = path.join(tfDirPath, 'backend.tf');

    if (!fsSync.existsSync(backendFilePath)) {
        return failCommand({
            print: () => {
                console.error(color.red('✖ No terraform/backend.tf found in the current directory.'));
                console.log(color.yellow('Are you in the root of a grada project?'));
            },
        });
    }

    const hasTerraform = await checkDependency('terraform');
    if (!hasTerraform) {
        return failCommand({ message: '✖ Terraform is not installed.', useErrorStream: true });
    }

    // 0. Extract Bucket and Region from backend.tf (pure reads, needed
    // by discovery below and bucket cleanup later).
    const backendContent = fsSync.readFileSync(backendFilePath, 'utf-8');
    const { bucket: bucketName, region: backendRegion } = parseStateBucketBackend(backendContent);

    const region = backendRegion ?? 'us-east-2';

    const timeoutMs = options.timeoutMs ?? DEFAULT_DESTROY_DB_TIMEOUT_MS;
    const settleTimeoutMs = options.dbSettleTimeoutMs ?? DEFAULT_DESTROY_DB_SETTLE_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_DESTROY_DB_POLL_INTERVAL_MS;
    const pollOverrides = {
        ...(options.sleepFn ? { sleepFn: options.sleepFn } : {}),
        ...(options.nowFn ? { nowFn: options.nowFn } : {}),
    };
    const allowDataLoss = options.allowDataLoss === true || options.allowDataLoss === 'true';
    const skipDbPreflight = options.force === true || options.force === 'true';
    const projectNameForTelemetry = path.basename(process.cwd());

    // 0b. Read-only database discovery for the data-loss gate. Lookup
    // failures fail fast, before the user is asked to confirm anything.
    // --force skips discovery (and therefore the gate): the documented
    // escape hatch for wedged states.
    const rdsClient = resolveClient(options.rdsClient, RDSClient, { region });
    let dbTarget = null;
    if (!skipDbPreflight) {
        try {
            dbTarget = await findDbTarget(rdsClient, {
                dbIdentifier: resolveDbIdentifier(options, process.cwd()),
                dbClusterIdentifier: resolveDbClusterIdentifier(options, process.cwd()),
            });
        } catch (error) {
            return failCommand({
                message: error.message,
                useErrorStream: true,
                event: 'infrastructure_destroyed',
                telemetry: { projectName: projectNameForTelemetry, error_code: error.code || 'RDS_DESTROY_PREFLIGHT_FAILED' },
                hint: 'Check your AWS credentials and region, then try again.',
            });
        }
    } else {
        trackEvent('rds_preflight_skipped', { projectName: projectNameForTelemetry, reason: 'force' });
    }

    // 0c. Data-loss gate (M1): a live database needs explicit
    // --allow-data-loss headless, or an interactive confirm naming the
    // cluster (which also takes a pre-destroy snapshot below). A
    // database that is already `deleting` needs no protection.
    const dbNeedsProtection = dbTarget && !allowDataLoss && dbTarget.status !== 'deleting';
    if (dbNeedsProtection && shouldAutoApprove(options)) {
        return failCommand({
            message: `\n✖ Refusing to destroy: database ${dbTarget.id} is still provisioned and --allow-data-loss was not passed.`,
            hint: `  Re-run with --allow-data-loss to destroy without a snapshot, or run interactively (a pre-destroy snapshot is taken first), or delete the database by hand.\n`,
            event: 'infrastructure_destroyed',
            telemetry: { projectName: projectNameForTelemetry, error_code: 'DATA_LOSS_UNCONFIRMED' },
            errorCode: 'DATA_LOSS_UNCONFIRMED',
            reason: 'data-loss-unconfirmed',
        });
    }

    if (!shouldAutoApprove(options)) {
        const refused = await refuseIfNonInteractive(options, {
            message: `\n✖ destroy needs confirmation before tearing down infrastructure.`,
            hint: dbNeedsProtection
                ? '  Re-run with --yes --allow-data-loss to destroy non-interactively (no pre-destroy snapshot), or run interactively to snapshot first.\n'
                : '  Re-run with --yes to destroy non-interactively.\n',
            event: 'infrastructure_destroyed',
            telemetry: { projectName: projectNameForTelemetry },
            errorCode: 'DESTROY_NON_INTERACTIVE',
        });
        if (refused) return refused;
    }

    const proceed = shouldAutoApprove(options) ? true : await confirm({
        message: dbNeedsProtection
            ? color.red(`⚠️  WARNING: This will permanently destroy all AWS resources including database ${dbTarget.id} (a pre-destroy snapshot will be taken first). Are you absolutely sure?`)
            : color.red('⚠️  WARNING: This will permanently destroy all AWS resources associated with this project. Are you absolutely sure?'),
        initialValue: false,
    });

    if (!proceed) {
        cancel('Destruction cancelled. Your infrastructure is safe.');
        process.exit(0);
    }

    // Surface an interrupted previous run. Informational only — the new
    // run overwrites the marker when it starts.
    const lastRun = readLastRunMarker(process.cwd());
    if (isInterruptedMarker(lastRun)) {
        console.warn(color.yellow(`⚠ Previous ${lastRun.command || 'terraform'} run was interrupted (started ${lastRun.startedAt || 'unknown'}). If it died mid-apply, review with ${color.green('cd terraform && terraform plan')} before trusting this run.`));
    }

    const s = spinner();
    const lifecycleOpts = { markerDir: process.cwd(), timeoutMs: DEFAULT_TERRAFORM_PHASE_TIMEOUT_MS };

    // 1. Init first (R4): destroy on a fresh checkout or a wiped
    // .terraform cache must not trip over missing plugins.
    const runInit = () => ensureTerraformInit(tfDirPath, runTerraformCommand, s, { prefix: 'Initializing', upgrade: false, lifecycleOpts });
    try {
        await runInit();
    } catch (error) {
        const handled = await handleDestroyTerraformError({ options, tfDirPath, attemptDestroy: runInit, error });
        if (!handled.retried) return handled.result;
    }

    // 1b. Wake a non-available database first: RDS rejects deletes of a
    // stopped (or transitional) cluster/instance with
    // InvalidDBClusterStateFault, which fails `terraform destroy` on asleep
    // environments. No-op when no database exists, it is available, or it
    // is already deleting. Only `stopped` is startable; transitional
    // states (creating/backing-up/modifying/starting/stopping) are
    // waitable with their own longer settle budget (H8).
    try {
        if (dbTarget && dbTarget.status !== 'available' && dbTarget.status !== 'deleting') {
            const isCluster = dbTarget.kind === 'cluster';
            const readStatus = async () => {
                const resp = isCluster
                    ? await rdsClient.send(new DescribeDBClustersCommand({ DBClusterIdentifier: dbTarget.id }))
                    : await rdsClient.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbTarget.id }));
                const current = isCluster
                    ? (resp.DBClusters || [])[0] || null
                    : (resp.DBInstances || [])[0] || null;
                return dbStatusOf(current, isCluster ? 'cluster' : 'instance');
            };
            // A `stopping` database settles to `stopped`, never directly to
            // `available` — so transitional states wait for a stable state
            // first, `stopped` issues Start, then everything waits for
            // `available`. A database that disappears mid-wait (null) lets
            // the destroy proceed.
            const waitForStable = () => pollUntil({
                intervalMs: pollIntervalMs,
                timeoutMs: settleTimeoutMs,
                ...pollOverrides,
                onTick: async ({ elapsedMs }) => {
                    const status = await readStatus();
                    if (status === 'stopped' || status === 'available' || status === null) {
                        return { done: true, value: status };
                    }
                    s.message(`Waiting for ${dbTarget.id} to settle (${status})... [${Math.floor(elapsedMs / 1000)}s]`);
                    return { done: false };
                },
            });
            const waitForAvailable = () => pollUntil({
                intervalMs: pollIntervalMs,
                timeoutMs,
                ...pollOverrides,
                onTick: async ({ elapsedMs }) => {
                    const status = await readStatus();
                    if (status === 'available' || status === null) return { done: true, value: status };
                    s.message(`Waiting for ${dbTarget.id} to become available... [${Math.floor(elapsedMs / 1000)}s]`);
                    return { done: false };
                },
            });
            s.start('Waking database before destruction...');
            let status = dbTarget.status;
            if (status !== 'stopped') {
                const settled = await waitForStable();
                if (settled.timedOut) {
                    s.stop(color.yellow('Database still transitioning.'));
                    const actualProjectName = path.basename(process.cwd());
                    return failCommand({
                        print: () => {
                            console.log(color.yellow(`\n⚠ ${dbTarget.id} did not leave the ${status} state in time — RDS refuses to delete non-available databases.`));
                            console.log(`  Re-run ${color.green('npx grada-run destroy')} once the database is available.\n`);
                        },
                        event: 'infrastructure_destroyed',
                        telemetry: { projectName: actualProjectName, error_code: 'RDS_DESTROY_PREFLIGHT_TIMEOUT' },
                    });
                }
                status = settled.value;
            }
            if (status === 'stopped') {
                if (isCluster) {
                    await rdsClient.send(new StartDBClusterCommand({ DBClusterIdentifier: dbTarget.id }));
                } else {
                    await rdsClient.send(new StartDBInstanceCommand({ DBInstanceIdentifier: dbTarget.id }));
                }
                status = 'starting';
            }
            if (status !== null) {
                const outcome = await waitForAvailable();
                if (outcome.timedOut) {
                    s.stop(color.yellow('Database still starting.'));
                    const actualProjectName = path.basename(process.cwd());
                    return failCommand({
                        print: () => {
                            console.log(color.yellow(`\n⚠ ${dbTarget.id} did not become available in time — RDS refuses to delete non-available databases.`));
                            console.log(`  Re-run ${color.green('npx grada-run destroy')} once the database is available.\n`);
                        },
                        event: 'infrastructure_destroyed',
                        telemetry: { projectName: actualProjectName, error_code: 'RDS_DESTROY_PREFLIGHT_TIMEOUT' },
                    });
                }
            }
            s.stop('Database is available.');
            trackEvent('rds_preflight_waited', { projectName: projectNameForTelemetry, from_state: dbTarget.status });
        } else if (dbTarget) {
            trackEvent('rds_preflight_skipped', { projectName: projectNameForTelemetry, reason: dbTarget.status === 'deleting' ? 'deleting' : 'available' });
        } else if (!skipDbPreflight) {
            trackEvent('rds_preflight_skipped', { projectName: projectNameForTelemetry, reason: 'no-database' });
        }
    } catch (error) {
        if (error && typeof error.exitCode === 'number') throw error;
        try { s.stop(color.red('❌ Pre-destroy database check failed.')); } catch { /* spinner already stopped */ }
        const actualProjectName = path.basename(process.cwd());
        return failCommand({
            message: error.message,
            useErrorStream: true,
            event: 'infrastructure_destroyed',
            telemetry: { projectName: actualProjectName, error_code: error.code || 'RDS_DESTROY_PREFLIGHT_FAILED' },
            hint: 'Check your AWS credentials and region, then try again.',
        });
    }

    // 1c. Pre-destroy snapshot checkpoint (M1). Skipped only with
    // --allow-data-loss (explicit acceptance) or a `deleting` database
    // (nothing left to protect).
    if (dbNeedsProtection) {
        const snapshotId = generateSnapshotId(dbTarget.id);
        s.start(`Snapshotting database ${dbTarget.id} before destruction...`);
        try {
            if (dbTarget.kind === 'cluster') {
                await rdsClient.send(new CreateDBClusterSnapshotCommand({ DBClusterSnapshotIdentifier: snapshotId, DBClusterIdentifier: dbTarget.id }));
            } else {
                await rdsClient.send(new CreateDBSnapshotCommand({ DBSnapshotIdentifier: snapshotId, DBInstanceIdentifier: dbTarget.id }));
            }
        } catch (error) {
            s.stop(color.red('❌ Pre-destroy snapshot failed.'));
            return failCommand({
                message: `\n✖ Refusing to destroy: pre-destroy snapshot of ${dbTarget.id} failed (${error.message}). Re-run with --allow-data-loss to destroy without a snapshot.`,
                useErrorStream: true,
                event: 'infrastructure_destroyed',
                telemetry: { projectName: projectNameForTelemetry, error_code: 'DB_SNAPSHOT_FAILED' },
                errorCode: 'DB_SNAPSHOT_FAILED',
                reason: 'db-snapshot-failed',
            });
        }
        s.stop(`Database snapshot ${snapshotId} started.`);
        console.log(color.green(`📸 Pre-destroy snapshot: ${snapshotId}`));
        trackEvent('db_destroy_checkpoint', { projectName: projectNameForTelemetry, db_kind: dbTarget.kind });
        await flushTelemetry();
    }

    // 1d. Lift RDS deletion protection via SDK before terraform destroy.
    // The `-var grada_allow_data_loss=true` below cannot do this on its
    // own: `terraform destroy` never applies updates, so a protected
    // cluster or instance still fails deletion with
    // DELETION_PROTECTION_ACTIVE. Runs for any live, non-deleting
    // database once destruction is authorized (flag or interactive
    // confirm above); --force skips discovery so dbTarget is null there.
    // Afterwards waits briefly for `available` again: the modify flips
    // the state to `modifying`, and a destroy issued mid-transition
    // fails with InvalidDBInstanceState instead. Every failure here
    // warns and proceeds — terraform reports the authoritative outcome.
    if (dbTarget && dbTarget.status !== 'deleting') {
        const isCluster = dbTarget.kind === 'cluster';
        s.start(`Lifting RDS deletion protection on ${dbTarget.id}...`);
        let lifted = false;
        try {
            if (isCluster) {
                await rdsClient.send(new ModifyDBClusterCommand({ DBClusterIdentifier: dbTarget.id, DeletionProtection: false, ApplyImmediately: true }));
            } else {
                await rdsClient.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: dbTarget.id, DeletionProtection: false, ApplyImmediately: true }));
            }
            lifted = true;
        } catch (error) {
            s.stop(color.yellow('Could not lift RDS deletion protection.'));
            console.log(color.yellow(`⚠ RDS modify failed (${error.message}) — proceeding anyway; terraform destroy will report the authoritative outcome.`));
            trackEvent('deletion_protection_lift_failed', { projectName: projectNameForTelemetry, db_kind: dbTarget.kind, error_code: error.name || 'UNKNOWN' });
        }
        if (lifted) {
            const outcome = await pollUntil({
                intervalMs: pollIntervalMs,
                timeoutMs,
                ...pollOverrides,
                onTick: async ({ elapsedMs }) => {
                    let status = null;
                    try {
                        const resp = isCluster
                            ? await rdsClient.send(new DescribeDBClustersCommand({ DBClusterIdentifier: dbTarget.id }))
                            : await rdsClient.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbTarget.id }));
                        const current = isCluster
                            ? (resp.DBClusters || [])[0] || null
                            : (resp.DBInstances || [])[0] || null;
                        status = dbStatusOf(current, isCluster ? 'cluster' : 'instance');
                    } catch {
                        status = null;
                    }
                    if (status === 'available' || status === null || status === 'deleting') return { done: true, value: status };
                    s.message(`Waiting for ${dbTarget.id} after lifting protection (${status})... [${Math.floor(elapsedMs / 1000)}s]`);
                    return { done: false };
                },
            });
            if (outcome.timedOut) {
                s.stop(color.yellow('Database still transitioning after the protection lift.'));
                console.log(color.yellow(`⚠ ${dbTarget.id} did not settle — proceeding anyway; terraform destroy will report the authoritative outcome.`));
            } else {
                s.stop('RDS deletion protection lifted.');
            }
            trackEvent('deletion_protection_lifted', { projectName: projectNameForTelemetry, db_kind: dbTarget.kind, via: allowDataLoss ? 'flag' : 'prompt' });
        }
        await flushTelemetry();
    }

    // 1e. Drain Terraform-managed S3 buckets (addon storage, static sites)
    // so `terraform destroy` never trips BucketNotEmpty on buckets with
    // objects. The state bucket is excluded — Terraform reads state from
    // it throughout the destroy. Skipped under CI_MOCK_AWS (no real AWS)
    // and whenever state lists no buckets.
    if (process.env.CI_MOCK_AWS !== 'true') {
        const drainTargets = (await getTerraformStateBuckets(tfDirPath)).filter((name) => name !== bucketName);
        if (drainTargets.length > 0) {
            s.start(`Draining ${drainTargets.length} S3 bucket(s) before destroy...`);
            const drainClient = new S3Client({ region });
            let drainedObjects = 0;
            const drainFailures = [];
            for (const target of drainTargets) {
                try {
                    const { deleted, failed } = await drainBucketObjects({ s3Client: drainClient, bucket: target });
                    drainedObjects += deleted;
                    for (const entry of failed) drainFailures.push({ bucket: target, ...entry });
                } catch (error) {
                    if (error?.name === 'NoSuchBucket') continue;
                    s.stop(color.red('❌ S3 bucket drain failed.'));
                    return failCommand({
                        message: `\n✖ Could not drain S3 bucket ${target} before destroy: ${error.message}`,
                        hint: '  Empty the bucket by hand (or delete it) and re-run destroy.\n',
                        useErrorStream: true,
                        event: 'infrastructure_destroyed',
                        telemetry: { projectName: projectNameForTelemetry },
                        errorCode: 'BUCKET_DRAIN_FAILED',
                        reason: 'bucket-drain-failed',
                        resultExtra: { bucket: target, region },
                    });
                }
            }
            if (drainFailures.length > 0) {
                s.stop(color.red('❌ S3 bucket drain failed.'));
                return failCommand({
                    print: () => {
                        console.error(color.red(`\n✖ Could not drain every object before destroy (${drainFailures.length} residual).`));
                        console.log(color.yellow('  Residual objects (delete by hand in the AWS Console, then re-run destroy):'));
                        for (const item of drainFailures.slice(0, 20)) {
                            console.log(`    - ${item.bucket}/${item.key}: ${item.reason}`);
                        }
                    },
                    event: 'infrastructure_destroyed',
                    telemetry: { projectName: projectNameForTelemetry },
                    errorCode: 'BUCKET_DRAIN_FAILED',
                    reason: 'bucket-drain-failed',
                    resultExtra: { region },
                });
            }
            s.stop(`Drained ${drainedObjects} object(s) from ${drainTargets.length} bucket(s).`);
            trackEvent('bucket_drain_completed', {
                projectName: projectNameForTelemetry,
                bucket_count: drainTargets.length,
                deleted_count: drainedObjects,
            });
        }
    }

    // 2. Execute Terraform Destroy (the data-loss var additionally flips
    // the template flag on trees that declare it; the SDK lift above is
    // what actually unprotects the live resource).
    s.start('Destroying AWS compute resources (this takes a few minutes)...');
    const destroyArgs = ['destroy', '-auto-approve'];
    if (dbTarget && treeDeclaresDataLossVar(tfDirPath)) {
        destroyArgs.push('-var', 'grada_allow_data_loss=true');
    }
    const attemptDestroy = () => runTerraformCommand(destroyArgs, tfDirPath, s, 'Destroying', lifecycleOpts);
    try {
        await attemptDestroy();
        s.stop('AWS compute resources destroyed.');
    } catch (error) {
        s.stop(color.red('❌ Terraform destroy failed.'));
        const handled = await handleDestroyTerraformError({ options, tfDirPath, attemptDestroy, error });
        if (!handled.retried) return handled.result;
    }

    // 3. Clean up the S3 State Bucket
    let deleteS3Bucket = false;

    if (bucketName) {
        if (!shouldAutoApprove(options)) {
            const refused = await refuseIfNonInteractive(options, {
                message: `\n✖ destroy needs confirmation before deleting the S3 state bucket.`,
                hint: '  Re-run with --yes to delete the state bucket non-interactively.\n',
                event: 'infrastructure_destroyed',
                telemetry: { projectName: projectNameForTelemetry },
                errorCode: 'DESTROY_NON_INTERACTIVE',
            });
            if (refused) return refused;
        }
        deleteS3Bucket = shouldAutoApprove(options) ? true : await confirm({
            message: color.yellow(`AWS compute resources destroyed. Do you also want to permanently delete the S3 state bucket?\n  (Select 'No' if you plan to run 'grada apply' later to spin this back up.)`),
            initialValue: false,
        });

        if (deleteS3Bucket && typeof deleteS3Bucket !== 'symbol') {
            s.start(`Emptying and deleting S3 state bucket: ${bucketName}...`);
            try {
                const bucketResult = await teardownStateBucket(region, bucketName);
                const remaining = bucketResult && typeof bucketResult === 'object' && Array.isArray(bucketResult.remaining)
                    ? bucketResult.remaining
                    : [];
                if (remaining.length > 0) {
                    s.stop(color.yellow(`S3 bucket ${bucketName} partially deleted.`));
                    console.log(color.yellow('  Residual objects (delete by hand in the AWS Console):'));
                    for (const item of remaining.slice(0, 20)) {
                        console.log(`    - ${item.key}: ${item.reason}`);
                    }
                    trackEvent('bucket_teardown_residual', { projectName: projectNameForTelemetry, remaining_count: remaining.length });
                } else {
                    s.stop(`S3 bucket ${bucketName} successfully deleted.`);
                }
            } catch (error) {
                s.stop(`❌ Failed to delete S3 bucket. You may need to delete it manually in the AWS Console.`);
                console.error(color.red(`AWS Error: ${error.message}`));
            }
        } else {
            console.log(color.cyan(`\n  S3 bucket retained. You can run 'npx grada-run apply' anytime to restore your infrastructure.`));
        }
    }

    const actualProjectName = path.basename(process.cwd());
    await trackSuccess('infrastructure_destroyed', {
        projectName: actualProjectName,
        region,
        retained_state_bucket: !(deleteS3Bucket && typeof deleteS3Bucket !== 'symbol')
    });

    // The infra is gone: drop exactly this env's ledger entry so a later
    // sleep starts clean instead of inheriting a stale asleep record.
    // Destroy is single-env (default); named workspaces are out of scope.
    await guardSleepingEnv({
        cwd: process.cwd(),
        envKey: 'default',
        options,
        command: 'destroy',
        mode: 'clear-on-success',
        projectName: actualProjectName,
        clearedBy: 'destroy',
    });

    outro(color.green('✅ Infrastructure successfully destroyed. Your AWS bill is safe.'));
}