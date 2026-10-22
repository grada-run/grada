import { RDSClient, DescribeDBSnapshotsCommand, DescribeDBClusterSnapshotsCommand } from '@aws-sdk/client-rds';
import fsSync from 'fs';
import path from 'path';
import color from 'picocolors';
import { intro, outro, spinner, select, confirm, cancel, isCancel } from '@clack/prompts';
import { trackSuccess, setActiveCommandName, resetActiveCommandName } from '../../core/telemetry.js';
import { failCommand, failAwsError, trackAwsFailure, failProjectNotInitialized, refuseUnknownFlags } from '../../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../../utils/args.js';
import { isAuthError, handleAuthErrorBranch, resolveClient } from '../../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveAppName, resolveHeadless, resolveCwd } from '../../utils/resolvers.js';
import { findResourceBlock } from '../../utils/hcl.js';
import { resolveDbIdentifier, resolveDbClusterIdentifier } from '../../utils/rds.js';

const SNAPSHOT_NOT_FOUND_NAMES = new Set(['DBSnapshotNotFound', 'DBSnapshotNotFoundFault']);
const INSTANCE_NOT_FOUND_NAMES = new Set(['DBInstanceNotFound', 'DBInstanceNotFoundFault']);
const CLUSTER_NOT_FOUND_NAMES = new Set(['DBClusterNotFound', 'DBClusterNotFoundFault']);
const CLUSTER_SNAPSHOT_NOT_FOUND_NAMES = new Set(['DBClusterSnapshotNotFound', 'DBClusterSnapshotNotFoundFault']);

export const DB_RESOURCE_HEADER = 'resource "aws_db_instance" "postgres"';
export const DB_CLUSTER_RESOURCE_HEADER = 'resource "aws_rds_cluster" "postgres"';
export const SNAPSHOT_COMMENT = '# Restored via grada: keep snapshot_identifier so subsequent applies stay no-op.';

export function parseDbRestoreArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'db') args.shift();
    if (args[0] === 'restore') args.shift();
    const { options, rest, unknown } = parseFlags(args, {
        string: [
            { name: 'project-name', key: 'projectName' },
            { name: 'region', key: 'region' },
            { name: 'workspace', key: 'workspace' },
            { name: 'db-identifier', key: 'dbIdentifier' },
        ],
        boolean: ['yes', 'headless'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0) options.snapshotId = positionals[0];
    if (positionals.length > 1) options.unexpectedPositionals = positionals.slice(1);
    if (unknown.length > 0) options.unknownFlags = unknown;
    return options;
}

// Idempotently sets `snapshot_identifier` inside
// `resource "<resourceType>" "postgres"` (an `aws_db_instance` or an
// `aws_rds_cluster`): replaces the existing attribute or inserts it (with a
// keep-in-place comment) after the identity line. Returns the content
// unchanged when the resource block cannot be found. Pure and unit-tested.
export function upsertSnapshotIdentifier(hclContent, snapshotId, resourceType = 'aws_db_instance') {
    const content = String(hclContent ?? '');
    const bounds = findResourceBlock(content, resourceType, 'postgres');
    if (!bounds) return content;

    const block = content.slice(bounds.openIdx, bounds.closeIdx + 1);
    const attrPattern = /^[ \t]*snapshot_identifier\s*=\s*"[^"]*"\s*$/m;
    const attrMatch = attrPattern.exec(block);

    const indent = '  ';
    const attrLine = `${indent}snapshot_identifier = "${snapshotId}"`;
    const commentLine = `${indent}${SNAPSHOT_COMMENT}`;

    if (attrMatch) {
        let next = block.slice(0, attrMatch.index) + attrLine + block.slice(attrMatch.index + attrMatch[0].length);
        if (!next.includes(SNAPSHOT_COMMENT)) {
            const at = next.indexOf(attrLine);
            const lineStart = next.lastIndexOf('\n', at) + 1;
            next = `${next.slice(0, lineStart)}${commentLine}\n${next.slice(lineStart)}`;
        }
        return content.slice(0, bounds.openIdx) + next + content.slice(bounds.closeIdx + 1);
    }

    // Insert after the identity line (`identifier` or `cluster_identifier`)
    // so the restore pin sits next to the resource identity; fall back to
    // the top of the block.
    const identifierPattern = resourceType === 'aws_rds_cluster'
        ? /^[ \t]*cluster_identifier\s*=\s*"[^"]*"\s*$/m
        : /^[ \t]*identifier\s*=\s*"[^"]*"\s*$/m;
    const identifierMatch = identifierPattern.exec(block);
    const insertion = `${commentLine}\n${attrLine}\n`;
    let next;
    if (identifierMatch) {
        const after = identifierMatch.index + identifierMatch[0].length;
        const eol = block.indexOf('\n', after);
        const at = eol === -1 ? block.length : eol + 1;
        next = `${block.slice(0, at)}${insertion}${block.slice(at)}`;
    } else {
        const firstEol = block.indexOf('\n');
        const at = firstEol === -1 ? block.length : firstEol + 1;
        next = `${block.slice(0, at)}${insertion}${block.slice(at)}`;
    }
    return content.slice(0, bounds.openIdx) + next + content.slice(bounds.closeIdx + 1);
}

async function listSnapshotsForInstance(rdsClient, dbIdentifier) {
    const snapshots = [];
    let marker;
    try {
        do {
            const input = { DBInstanceIdentifier: dbIdentifier };
            if (marker) input.Marker = marker;
            const resp = await rdsClient.send(new DescribeDBSnapshotsCommand(input));
            for (const snapshot of resp.DBSnapshots || []) snapshots.push(snapshot);
            marker = resp.Marker;
        } while (marker);
    } catch (error) {
        // A missing instance simply has no snapshots to list.
        if (error && INSTANCE_NOT_FOUND_NAMES.has(error.name)) return [];
        throw error;
    }
    return snapshots;
}

// Cluster snapshots are normalized onto the instance field shape
// (`DBSnapshotIdentifier`) so sorting, selection, and verification below
// stay shared across both kinds.
async function listSnapshotsForCluster(rdsClient, dbClusterIdentifier) {
    const snapshots = [];
    let marker;
    try {
        do {
            const input = { DBClusterIdentifier: dbClusterIdentifier };
            if (marker) input.Marker = marker;
            const resp = await rdsClient.send(new DescribeDBClusterSnapshotsCommand(input));
            for (const snapshot of resp.DBClusterSnapshots || []) {
                snapshots.push({ ...snapshot, DBSnapshotIdentifier: snapshot.DBClusterSnapshotIdentifier });
            }
            marker = resp.Marker;
        } while (marker);
    } catch (error) {
        // A missing cluster simply has no snapshots to list.
        if (error && CLUSTER_NOT_FOUND_NAMES.has(error.name)) return [];
        throw error;
    }
    return snapshots;
}

async function lookupSnapshotById(rdsClient, snapshotId, isCluster = false) {
    try {
        if (isCluster) {
            const resp = await rdsClient.send(new DescribeDBClusterSnapshotsCommand({ DBClusterSnapshotIdentifier: snapshotId }));
            const found = (resp.DBClusterSnapshots || [])[0] || null;
            return found ? { ...found, DBSnapshotIdentifier: found.DBClusterSnapshotIdentifier } : null;
        }
        const resp = await rdsClient.send(new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: snapshotId }));
        return (resp.DBSnapshots || [])[0] || null;
    } catch (error) {
        const notFoundNames = isCluster ? CLUSTER_SNAPSHOT_NOT_FOUND_NAMES : SNAPSHOT_NOT_FOUND_NAMES;
        if (error && notFoundNames.has(error.name)) return null;
        throw error;
    }
}

function formatSnapshotHint(snapshot) {
    const when = snapshot.SnapshotCreateTime instanceof Date
        ? snapshot.SnapshotCreateTime.toISOString()
        : String(snapshot.SnapshotCreateTime || 'unknown time');
    const size = snapshot.AllocatedStorage !== undefined && snapshot.AllocatedStorage !== null
        ? `${snapshot.AllocatedStorage}GB`
        : 'unknown size';
    const type = snapshot.SnapshotType || 'unknown';
    return `${when} · ${size} · ${type}`;
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runDbRestore(input = {}) {
    setActiveCommandName('db_restore');
    try {
        return await runDbRestoreMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runDbRestoreMain(input = {}) {
    const options = normalizeOptions(input);
    const unknownRefusal = await refuseUnknownFlags(options, { command: 'db restore', event: 'db_restore_run' });
    if (unknownRefusal) return unknownRefusal;
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
        return failProjectNotInitialized({ event: 'db_restore_run' });
    }
    const headless = resolveHeadless(options);

    intro(color.bgCyan(color.black(' grada db restore 🕰️  ')));

    if (Array.isArray(options.unexpectedPositionals) && options.unexpectedPositionals.length > 0) {
        return failCommand({
            message: `\n✖ Unexpected argument "${options.unexpectedPositionals[0]}". Pass a single snapshot id: db restore <snapshot-id>.\n`,
            event: 'db_restore_run',
            telemetry: { projectName },
            errorCode: 'UNEXPECTED_POSITIONAL_ARGS',
            reason: 'unexpected-positional-args',
            resultExtra: { dbIdentifier, region },
        });
    }

    // Fail fast on a missing Terraform file before any AWS calls.
    const databaseTf = path.join(cwd, 'terraform', 'database.tf');
    let hclContent = null;
    try {
        if (fsSync.existsSync(databaseTf)) hclContent = fsSync.readFileSync(databaseTf, 'utf8');
    } catch {
        hclContent = null;
    }
    if (hclContent === null) {
        return failCommand({
            message: `\n✖ ${color.cyan('terraform/database.tf')} not found. Run ${color.green('npx grada-run')} with a managed database first.\n`,
            event: 'db_restore_run',
            telemetry: { projectName },
            errorCode: 'DATABASE_TF_NOT_FOUND',
            reason: 'database-tf-not-found',
            resultExtra: { dbIdentifier, region },
        });
    }

    const rdsClient = resolveClient(options.rdsClient, RDSClient, { region });
    const s = spinner();
    s.start('Listing database snapshots...');

    // The required database.tf file doubles as the kind signal: Aurora
    // projects restore cluster snapshots into the cluster block.
    const isCluster = hclContent.includes('resource "aws_rds_cluster"');
    const resourceLabel = isCluster ? 'aws_rds_cluster.postgres' : 'aws_db_instance.postgres';

    try {
        const requestedId = (typeof options.snapshotId === 'string' && options.snapshotId.trim())
            ? options.snapshotId.trim()
            : '';
        const listed = isCluster
            ? await listSnapshotsForCluster(rdsClient, dbClusterIdentifier)
            : await listSnapshotsForInstance(rdsClient, dbIdentifier);
        listed.sort((a, b) => {
            const ta = a.SnapshotCreateTime instanceof Date ? a.SnapshotCreateTime.getTime() : 0;
            const tb = b.SnapshotCreateTime instanceof Date ? b.SnapshotCreateTime.getTime() : 0;
            return tb - ta;
        });

        let selected = null;
        if (requestedId) {
            selected = listed.find((snap) => snap.DBSnapshotIdentifier === requestedId) || null;
            // Snapshots outlive replaced databases: fall back to a direct
            // lookup so checkpoints from previous instances stay restorable.
            if (!selected) selected = await lookupSnapshotById(rdsClient, requestedId, isCluster);
            if (!selected) {
                s.stop(color.yellow('Snapshot not found.'));
                return failCommand({
                    message: `\n✖ Snapshot "${requestedId}" was not found for database ${color.cyan(dbIdentifier)}.\n`,
                    event: 'db_restore_run',
                    telemetry: { projectName },
                    errorCode: 'SNAPSHOT_NOT_AVAILABLE',
                    reason: 'snapshot-not-available',
                    resultExtra: { dbIdentifier, region },
                });
            }
        } else {
            if (listed.length === 0) {
                s.stop(color.yellow('No snapshots found.'));
                return failCommand({
                    message: `\n✖ No snapshots found for database ${color.cyan(dbIdentifier)}. Create one with ${color.green('npx grada-run db backup')}.\n`,
                    event: 'db_restore_run',
                    telemetry: { projectName },
                    errorCode: 'NO_SNAPSHOTS_FOUND',
                    reason: 'no-snapshots-found',
                    resultExtra: { dbIdentifier, region },
                });
            }
            if (headless) {
                s.stop(color.yellow('Snapshot id required.'));
                return failCommand({
                    message: '\n✖ No snapshot id provided. Pass one positionally: db restore <snapshot-id>.\n',
                    event: 'db_restore_run',
                    telemetry: { projectName },
                    errorCode: 'MISSING_SNAPSHOT_ID',
                    reason: 'missing-snapshot-id',
                    resultExtra: { dbIdentifier, region },
                });
            }
            s.stop('Snapshots found.');
            const choice = await select({
                message: 'Select a snapshot to restore:',
                options: listed.map((snap) => ({
                    value: snap.DBSnapshotIdentifier,
                    label: snap.DBSnapshotIdentifier,
                    hint: formatSnapshotHint(snap),
                })),
            });
            if (isCancel(choice)) {
                outro(color.yellow('Restore cancelled.'));
                return { ok: false, reason: 'cancelled', dbIdentifier, region };
            }
            selected = listed.find((snap) => snap.DBSnapshotIdentifier === choice) || null;
        }

        if (!selected || selected.Status !== 'available') {
            s.stop(color.yellow('Snapshot not available.'));
            return failCommand({
                message: `\n✖ Snapshot "${selected?.DBSnapshotIdentifier || requestedId}" is not available (status: ${selected?.Status || 'unknown'}). Only available snapshots can be restored.\n`,
                event: 'db_restore_run',
                telemetry: { projectName },
                errorCode: 'SNAPSHOT_NOT_AVAILABLE',
                reason: 'snapshot-not-available',
                resultExtra: { dbIdentifier, region },
            });
        }
        const snapshotId = selected.DBSnapshotIdentifier;

        // Destructive-action confirmation (explicit --yes skips prompting).
        if (options.yes !== true && options.yes !== 'true') {
            if (headless) {
                s.stop(color.yellow('Confirmation required.'));
                return failCommand({
                    message: '\n✖ Restoring requires confirmation. Re-run with --yes.\n',
                    event: 'db_restore_run',
                    telemetry: { projectName },
                    errorCode: 'CONFIRMATION_REQUIRED',
                    reason: 'confirmation-required',
                    resultExtra: { dbIdentifier, region },
                });
            }
            s.stop('Snapshot selected.');
            console.log(color.yellow('\n⚠ This will replace your database on the next apply.'));
            console.log(`  Setting ${color.cyan('snapshot_identifier')} on ${color.cyan(resourceLabel)} restores ${color.cyan(snapshotId)} but permanently discards`);
            console.log(`  everything written after the snapshot (this project sets ${color.cyan('skip_final_snapshot = true')}).`);
            console.log(`  Back up first with ${color.green('npx grada-run db backup')} if you need the current data.\n`);
            const confirmed = await confirm({
                message: `Restore ${dbIdentifier} from snapshot ${snapshotId}?`,
                initialValue: false,
            });
            if (confirmed !== true) {
                cancel('Cancelled. terraform/database.tf was not modified.');
                return { ok: false, reason: 'cancelled', dbIdentifier, region };
            }
        } else {
            s.stop('Snapshot selected.');
        }

        const updated = upsertSnapshotIdentifier(hclContent, snapshotId, isCluster ? 'aws_rds_cluster' : 'aws_db_instance');
        fsSync.writeFileSync(databaseTf, updated, 'utf8');
        console.log(color.green(`\n✅ terraform/database.tf now pins snapshot_identifier = "${snapshotId}".`));
        console.log(`  Run ${color.green('npx grada-run apply')} to restore the database.`);
        console.log(color.dim('  Keep snapshot_identifier in place afterwards so future applies stay no-op.\n'));
        await trackSuccess('db_restore_run', { projectName, db_kind: isCluster ? 'cluster' : 'instance' });
        outro(color.green('Done.'));
        return { ok: true, snapshotId };
    } catch (error) {
        if (isAuthError(error)) {
            await trackAwsFailure('db_restore_run', error, { projectName });
            handleAuthErrorBranch(error, s, options);
            return { ok: false, reason: 'error', dbIdentifier, region };
        }
        try { s.stop(color.red('❌ Db restore failed.')); } catch { /* spinner already stopped */ }
        return failAwsError({
            event: 'db_restore_run',
            error,
            telemetry: { projectName },
            reason: 'error',
            resultExtra: { dbIdentifier, region },
        });
    }
}

export default runDbRestore;
