import { RDSClient, CreateDBSnapshotCommand, DescribeDBSnapshotsCommand, CreateDBClusterSnapshotCommand, DescribeDBClusterSnapshotsCommand } from '@aws-sdk/client-rds';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackSuccess, trackFailure, setActiveCommandName, resetActiveCommandName } from '../../core/telemetry.js';
import { failCommand, failProjectNotInitialized } from '../../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../../utils/args.js';
import { handleAuthErrorBranch, resolveClient } from '../../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveAppName, resolveCwd } from '../../utils/resolvers.js';
import { findDbTarget, generateSnapshotId, isValidSnapshotId, resolveDbIdentifier, resolveDbClusterIdentifier } from '../../utils/rds.js';
import { pollUntil, parseTimeoutSeconds } from '../../utils/system.js';

export const DEFAULT_BACKUP_TIMEOUT_SECONDS = 900;
export const DEFAULT_BACKUP_POLL_INTERVAL_MS = 5000;

const SNAPSHOT_NOT_FOUND_NAMES = new Set(['DBSnapshotNotFound', 'DBSnapshotNotFoundFault']);
const CLUSTER_SNAPSHOT_NOT_FOUND_NAMES = new Set(['DBClusterSnapshotNotFound', 'DBClusterSnapshotNotFoundFault']);

export function parseDbBackupArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'db') args.shift();
    if (args[0] === 'backup') args.shift();
    const { options, rest } = parseFlags(args, {
        string: [
            { name: 'id', key: 'snapshotId' },
            { name: 'timeout', key: 'timeout' },
            { name: 'project-name', key: 'projectName' },
            { name: 'region', key: 'region' },
            { name: 'workspace', key: 'workspace' },
            { name: 'db-identifier', key: 'dbIdentifier' },
        ],
        boolean: ['no-wait', 'headless'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0) options.unexpectedPositionals = positionals;
    return options;
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runDbBackup(input = {}) {
    setActiveCommandName('db_backup');
    try {
        return await runDbBackupMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runDbBackupMain(input = {}) {
    const options = normalizeOptions(input);
    let cwd;
    let region;
    let projectName;
    let dbIdentifier;
    let dbClusterIdentifier;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
        const appName = resolveAppName(projectName, options.workspace, cwd);
        dbIdentifier = resolveDbIdentifier({ ...options, projectName }, cwd);
        dbClusterIdentifier = resolveDbClusterIdentifier({ ...options, projectName }, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'db_backup_run' });
    }
    const noWait = options.noWait === true || options.noWait === 'true';

    intro(color.bgCyan(color.black(' grada db backup 📸 ')));

    if (Array.isArray(options.unexpectedPositionals) && options.unexpectedPositionals.length > 0) {
        return failCommand({
            message: `\n✖ Unexpected argument "${options.unexpectedPositionals[0]}". Set the snapshot id with --id <snapshot-id>.\n`,
            event: 'db_backup_run',
            telemetry: { projectName },
            errorCode: 'UNEXPECTED_POSITIONAL_ARGS',
            reason: 'unexpected-positional-args',
            resultExtra: { dbIdentifier, region },
        });
    }

    if (options.snapshotId !== undefined && !isValidSnapshotId(options.snapshotId)) {
        return failCommand({
            message: `\n✖ Invalid --id "${options.snapshotId}". Snapshot ids start with a letter, use letters/digits/hyphens (no "--", no trailing "-").\n`,
            event: 'db_backup_run',
            telemetry: { projectName },
            errorCode: 'INVALID_SNAPSHOT_ID',
            reason: 'invalid-snapshot-id',
            resultExtra: { dbIdentifier, region },
        });
    }

    const timeoutSeconds = parseTimeoutSeconds(options.timeout, DEFAULT_BACKUP_TIMEOUT_SECONDS);
    if (timeoutSeconds === null) {
        return failCommand({
            message: `\n✖ Invalid --timeout "${options.timeout}". Use a positive number of seconds (default ${DEFAULT_BACKUP_TIMEOUT_SECONDS}).\n`,
            event: 'db_backup_run',
            telemetry: { projectName },
            errorCode: 'INVALID_TIMEOUT',
            reason: 'invalid-timeout',
            resultExtra: { dbIdentifier, region },
        });
    }

    const rdsClient = resolveClient(options.rdsClient, RDSClient, { region });
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_BACKUP_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? timeoutSeconds * 1000;

    const s = spinner();
    s.start('Finding your database...');

    try {
        const target = await findDbTarget(rdsClient, { dbIdentifier, dbClusterIdentifier });
        if (!target) {
            s.stop();
            return failCommand({
                print: () => {
                    console.log(color.yellow('\n⚠ No database found.'));
                    console.log(`  No RDS database named ${color.cyan(dbIdentifier)} exists in this environment.`);
                    console.log(`  Re-run ${color.green('npx grada-run')} and answer "Yes" to the database prompt, then ${color.green('npx grada-run apply')}.\n`);
                },
                event: 'db_backup_run',
                telemetry: { projectName },
                errorCode: 'RDS_INSTANCE_NOT_FOUND',
                reason: 'rds-instance-not-found',
                resultExtra: { dbIdentifier, region },
            });
        }
        const isCluster = target.kind === 'cluster';

        const snapshotId = (typeof options.snapshotId === 'string' && options.snapshotId.trim())
            ? options.snapshotId.trim()
            : generateSnapshotId(target.id);

        s.message(`Creating snapshot ${snapshotId}...`);
        const snapshotTags = [
            { Key: 'ManagedBy', Value: 'grada' },
            { Key: 'Project', Value: projectName },
        ];
        if (isCluster) {
            await rdsClient.send(new CreateDBClusterSnapshotCommand({
                DBClusterIdentifier: target.id,
                DBClusterSnapshotIdentifier: snapshotId,
                Tags: snapshotTags,
            }));
        } else {
            await rdsClient.send(new CreateDBSnapshotCommand({
                DBInstanceIdentifier: target.id,
                DBSnapshotIdentifier: snapshotId,
                Tags: snapshotTags,
            }));
        }

        if (noWait) {
            s.stop(color.green('Snapshot creation started.'));
            console.log(`\n  Snapshot ${color.cyan(snapshotId)} is being created (status: creating).`);
            console.log(color.dim(`  Restore it later with: npx grada-run db restore ${snapshotId}\n`));
            await trackSuccess('db_backup_run', { projectName, waited: false, db_kind: target.kind });
            outro(color.green('Done.'));
            return { ok: true, snapshotId, status: 'creating' };
        }

        s.message(`Waiting for snapshot ${snapshotId} to become available...`);
        const outcome = await pollUntil({
            intervalMs: pollIntervalMs,
            timeoutMs,
            onTick: async ({ elapsedMs }) => {
                let snapshots = [];
                try {
                    if (isCluster) {
                        const resp = await rdsClient.send(
                            new DescribeDBClusterSnapshotsCommand({ DBClusterSnapshotIdentifier: snapshotId })
                        );
                        snapshots = resp.DBClusterSnapshots || [];
                    } else {
                        const resp = await rdsClient.send(
                            new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: snapshotId })
                        );
                        snapshots = resp.DBSnapshots || [];
                    }
                } catch (error) {
                    // The snapshot is not describable for a moment right after
                    // creation (eventual consistency), so keep polling.
                    const notFoundNames = isCluster ? CLUSTER_SNAPSHOT_NOT_FOUND_NAMES : SNAPSHOT_NOT_FOUND_NAMES;
                    if (error && notFoundNames.has(error.name)) {
                        s.message(`Waiting for snapshot ${snapshotId}... [${Math.floor(elapsedMs / 1000)}s]`);
                        return { done: false };
                    }
                    throw error;
                }
                const snapshot = snapshots[0] || null;
                if (snapshot && snapshot.Status === 'available') {
                    return { done: true, value: snapshot };
                }
                s.message(`Waiting for snapshot ${snapshotId}... [${Math.floor(elapsedMs / 1000)}s]`);
                return { done: false };
            },
        });

        if (outcome.timedOut) {
            s.stop(color.yellow('Snapshot still creating.'));
            return failCommand({
                print: () => {
                    console.log(color.yellow(`\n⚠ Snapshot ${snapshotId} did not become available within ${timeoutSeconds}s.`));
                    console.log('  Creation continues in the background — check status in the AWS console or retry with a larger --timeout.');
                    console.log(color.dim(`  Restore it once available with: npx grada-run db restore ${snapshotId}\n`));
                },
                event: 'db_backup_run',
                telemetry: { projectName, waited: true },
                errorCode: 'SNAPSHOT_TIMEOUT',
                reason: 'snapshot-timeout',
                resultExtra: { dbIdentifier, region, snapshotId },
            });
        }

        s.stop(color.green('Snapshot available.'));
        console.log(`\n  Snapshot ${color.cyan(snapshotId)} is ready.`);
        console.log(color.dim(`  Restore it with: npx grada-run db restore ${snapshotId}\n`));
        await trackSuccess('db_backup_run', { projectName, waited: true, db_kind: target.kind });
        outro(color.green('Done.'));
        return { ok: true, snapshotId, status: 'available' };
    } catch (error) {
        await trackFailure('db_backup_run', {
            projectName,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        if (handleAuthErrorBranch(error, s, options)) {
            return { ok: false, reason: 'error', dbIdentifier, region };
        }
        try { s.stop(color.red('❌ Db backup failed.')); } catch { /* spinner already stopped */ }
        return failCommand({
            message: `✖ ${error?.message || error}`,
            hint: 'Check your AWS credentials and region, then try again.',
            reason: 'error',
            resultExtra: { dbIdentifier, region },
        });
    }
}

export default runDbBackup;
