import color from 'picocolors';
import { failCommand, isProgrammaticCall } from '../utils/command.js';
import { guardComputeTarget } from '../utils/resolvers.js';
import { normalizeOptions, normalizeArgv } from '../utils/args.js';
import { runDbConnect, parseDbArgs } from './db/connect.js';
import { runDbMigrate, parseDbMigrateArgs } from './db/migrate.js';
import { runDbBackup, parseDbBackupArgs } from './db/backup.js';
import { runDbRestore, parseDbRestoreArgs } from './db/restore.js';
import { runDbEnableVector, parseDbEnableVectorArgs } from './db/enable-vector.js';
import { runDbImport, parseDbImportArgs } from './db/import.js';

// Dispatcher + re-export barrel for the `db` subcommands. Existing imports
// of `../src/commands/db.js` (bin/cli.js, tests) keep working unchanged.
export { runDbConnect, parseDbArgs } from './db/connect.js';
export {
    isValidPort,
    buildConnectionString,
    formatConnectionInfo,
    buildSsmArgs,
    DEFAULT_LOCAL_PORT,
    MASKED_PASSWORD,
    dbCommand,
} from './db/connect.js';
export { runDbMigrate, parseDbMigrateArgs } from './db/migrate.js';
export { runDbBackup, parseDbBackupArgs } from './db/backup.js';
export { runDbRestore, parseDbRestoreArgs, upsertSnapshotIdentifier } from './db/restore.js';
export { runDbEnableVector, parseDbEnableVectorArgs, buildVectorExtensionCommand } from './db/enable-vector.js';
export { runDbImport, parseDbImportArgs, classifyImportFile, requiredClientBinaries, buildTargetClientCommand, buildSourceDumpCommand } from './db/import.js';
export { resolveDbIdentifier, resolveDbClusterIdentifier, findDbInstance, findDbCluster, findDbTarget, generateSnapshotId, isValidSnapshotId } from '../utils/rds.js';
export { pickRuntimeContainer } from '../utils/ecs.js';
export { detectMigrationCommand } from '../utils/detector.js';

export const DB_SUBCOMMANDS = ['connect', 'migrate', 'backup', 'restore', 'enable-vector', 'import'];

function printDbUsage() {
    console.log('Usage:');
    console.log('  grada db connect [--port <local-port>] [--show-credentials] [--workspace <name>] [--region <region>] [--cluster <name>] [--service <name>]');
    console.log('  grada db migrate [--cmd <command>] [--task-def <task-def>] [--timeout <seconds>] [--setup-ci] [--project-name <name>] [--workspace <name>] [--region <region>] [--cluster <name>] [--service <name>] [--container <name>]');
    console.log('  grada db backup [--id <snapshot-id>] [--timeout <seconds>] [--no-wait] [--project-name <name>] [--workspace <name>] [--region <region>] [--db-identifier <id>]');
    console.log('  grada db restore [<snapshot-id>] [--yes] [--project-name <name>] [--workspace <name>] [--region <region>] [--db-identifier <id>]');
    console.log('  grada db enable-vector [--task-def <task-def>] [--timeout <seconds>] [--project-name <name>] [--workspace <name>] [--region <region>] [--cluster <name>] [--service <name>] [--container <name>]');
    console.log('  grada db import (--file <path> | --from <url>) [--yes] [--project-name <name>] [--workspace <name>] [--region <region>] [--db-identifier <id>]');
}

export async function runDb(argv = [], extraOptions = {}) {
    const args = normalizeArgv(argv);
    const extra = normalizeOptions(extraOptions);
    if (args[0] === 'db') args.shift();
    const subcommand = args[0] && !String(args[0]).startsWith('-') ? args[0] : undefined;

    // Static sites provision no database, so every subcommand would fail
    // obscurely downstream (SSM/RDS lookups with nothing to find). Guard
    // once at the dispatcher — before any parsing side effects — instead
    // of repeating the check in all six runners.
    if (DB_SUBCOMMANDS.includes(subcommand)) {
        const targetGuard = guardComputeTarget({
            cwd: extra.cwd ?? process.cwd(),
            command: `db ${subcommand}`,
            supported: ['ecs', 'lambda'],
            hint: 'Static sites provision no database — static sites needing data need an API backend.',
        });
        if (targetGuard) {
            return failCommand({
                noExit: isProgrammaticCall(extra),
                message: targetGuard.message,
                hint: targetGuard.hint,
                event: 'db_run',
                telemetry: { subcommand },
                errorCode: targetGuard.errorCode,
                reason: targetGuard.reason,
                resultExtra: { subcommand },
            });
        }
    }

    if (subcommand === 'connect') {
        return runDbConnect({ ...parseDbArgs(argv), ...extra });
    }
    if (subcommand === 'migrate') {
        return runDbMigrate({ ...parseDbMigrateArgs(argv), ...extra });
    }
    if (subcommand === 'backup') {
        return runDbBackup({ ...parseDbBackupArgs(argv), ...extra });
    }
    if (subcommand === 'restore') {
        return runDbRestore({ ...parseDbRestoreArgs(argv), ...extra });
    }
    if (subcommand === 'enable-vector') {
        return runDbEnableVector({ ...parseDbEnableVectorArgs(argv), ...extra });
    }
    if (subcommand === 'import') {
        return runDbImport({ ...parseDbImportArgs(argv), ...extra });
    }

    return failCommand({
        print: () => {
            if (subcommand === undefined) {
                console.log(color.yellow('\n⚠ Missing db subcommand.'));
            } else {
                console.log(color.red(`\n✖ Unknown db subcommand "${subcommand}".`));
            }
            console.log('');
            printDbUsage();
            console.log('');
        },
        event: 'db_run',
        telemetry: {},
        errorCode: 'UNKNOWN_DB_SUBCOMMAND',
        reason: 'unknown-db-subcommand',
    });
}

export default runDbConnect;
