import { RDSClient } from '@aws-sdk/client-rds';
import { ECSClient } from '@aws-sdk/client-ecs';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { spawn } from 'child_process';
import fsSync from 'node:fs';
import { createReadStream } from 'node:fs';
import zlib from 'node:zlib';
import color from 'picocolors';
import { intro, outro, spinner, select, text, password, confirm, cancel, isCancel } from '@clack/prompts';
import { trackSuccess, trackFailure } from '../../core/telemetry.js';
import { failCommand, failProjectNotInitialized } from '../../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../../utils/args.js';
import { hasAwsCli, AWS_CLI_INSTALL_URL, handleAuthErrorBranch, resolveClient } from '../../utils/aws.js';
import {
    resolveRegion,
    resolveProjectName,
    resolveCluster,
    resolveService,
    resolveAppName,
    resolveHeadless,
    resolveCwd,
} from '../../utils/resolvers.js';
import { findDbTarget, resolveDbIdentifier, resolveDbClusterIdentifier } from '../../utils/rds.js';
import {
    buildSsmArgs,
    fetchManagedDbCredentials,
    findJumpHostTarget,
    waitForTcpPort,
    getFreeLocalPort,
    redactUri,
    parseSourceUri,
    findMissingBinaries,
} from '../../utils/db-tunnel.js';
import {
    hasSessionManagerPlugin,
    resolveContainer,
    printAwsCliGuidance,
    printSessionManagerGuidance,
    printNoTasksGuidance,
} from '../../utils/ecs.js';
import { printNoDatabaseGuidance } from './connect.js';

export const DEFAULT_TUNNEL_TIMEOUT_MS = 30000;
export const DEFAULT_TUNNEL_POLL_INTERVAL_MS = 500;
// Grace period between SIGTERM and SIGKILL when tearing down the tunnel.
export const TUNNEL_SIGKILL_TIMEOUT_MS = 2000;

export function parseDbImportArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'db') args.shift();
    if (args[0] === 'import') args.shift();
    const { options, rest } = parseFlags(args, {
        string: [
            { name: 'file', key: 'file' },
            { name: 'from', key: 'from' },
            { name: 'db-identifier', key: 'dbIdentifier' },
            { name: 'project-name', key: 'projectName' },
            { name: 'region', key: 'region' },
            { name: 'workspace', key: 'workspace' },
        ],
        boolean: ['headless', 'yes', 'force'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0) options.unexpectedPositionals = positionals;
    return options;
}

// Classifies an import file by extension: 'dump' (Postgres custom
// archive), 'gzip' (.sql.gz / .gz), or 'sql' (plain text, the default for
// unknown extensions). Pure and unit-tested.
export function classifyImportFile(filePath) {
    const lower = String(filePath || '').toLowerCase();
    if (lower.endsWith('.dump')) return 'dump';
    if (lower.endsWith('.gz')) return 'gzip';
    return 'sql';
}

// Local client binaries required for an import: `{ targetScheme: 'mysql'
// | 'postgresql', source: { type: 'file', kind } | { type: 'url', scheme
// } }`. Pure and unit-tested.
export function requiredClientBinaries({ targetScheme, source }) {
    if (source.type === 'url') {
        return targetScheme === 'mysql' ? ['mysqldump', 'mysql'] : ['pg_dump', 'psql'];
    }
    if (source.kind === 'dump') return ['pg_restore'];
    return targetScheme === 'mysql' ? ['mysql'] : ['psql'];
}

export function clientInstallHint(missing) {
    const lines = missing.map((bin) => {
        if (bin === 'mysql' || bin === 'mysqldump') {
            return `  ${bin}: brew install mysql-client (then add $(brew --prefix mysql-client)/bin to PATH)`;
        }
        return `  ${bin}: brew install libpq (then add $(brew --prefix libpq)/bin to PATH)`;
    });
    return `Install the missing database client tools:\n${lines.join('\n')}\n`;
}

// Target-side client invocation: `{ bin, args }` (file path included for
// pg_restore). Passwords travel via process env, never argv. Pure.
export function buildTargetClientCommand({ targetScheme, localPort, username, dbName, fileKind, filePath }) {
    if (targetScheme === 'mysql') {
        return {
            bin: 'mysql',
            args: ['-h', '127.0.0.1', '-P', String(localPort), '-u', username, dbName],
        };
    }
    if (fileKind === 'dump') {
        return {
            bin: 'pg_restore',
            args: ['--no-owner', '--no-acl', '--no-password', '-h', '127.0.0.1', '-p', String(localPort), '-U', username, '-d', dbName, filePath],
        };
    }
    return {
        bin: 'psql',
        args: ['-h', '127.0.0.1', '-p', String(localPort), '-U', username, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-q', '--no-password'],
    };
}

// Source-side dump invocation for `--from`. Passwords travel via process
// env (`PGPASSWORD` / `MYSQL_PWD`), never argv. Pure and unit-tested.
export function buildSourceDumpCommand(source) {
    if (source.scheme === 'mysql') {
        const args = ['-h', source.host, '-P', String(source.port)];
        if (source.user) args.push('-u', source.user);
        args.push(source.database);
        return { bin: 'mysqldump', args };
    }
    const args = ['--no-owner', '--no-acl', '--no-password', '-h', source.host, '-p', String(source.port)];
    if (source.user) args.push('-U', source.user);
    args.push('-d', source.database);
    return { bin: 'pg_dump', args };
}

function targetEnv(targetScheme, password) {
    if (targetScheme === 'mysql') {
        return { ...process.env, MYSQL_PWD: password };
    }
    // RDS/Aurora enforces `rds.force_ssl = 1` by default: require TLS for
    // psql/pg_restore unless the caller already pinned a PGSSLMODE.
    return { ...process.env, PGPASSWORD: password, PGSSLMODE: process.env.PGSSLMODE || 'require' };
}

function waitForExit(child) {
    return new Promise((resolve) => {
        child.once('error', (error) => resolve({ code: 1, error }));
        child.once('close', (code) => resolve({ code: code ?? 0 }));
    });
}

function printDbNoTasksGuidance(service, cluster) {
    printNoTasksGuidance(service, cluster, 'to act as a jump host for the import tunnel');
}

export async function runDbImport(input = {}) {
    const options = normalizeOptions(input);
    let cwd;
    let region;
    let projectName;
    let cluster;
    let service;
    let expectedContainer;
    let dbIdentifier;
    let dbClusterIdentifier;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
        const appName = resolveAppName(projectName, options.workspace, cwd);
        const namespacedOptions = { ...options, projectName: appName };
        cluster = resolveCluster(namespacedOptions, cwd);
        service = resolveService(namespacedOptions, cwd);
        expectedContainer = resolveContainer(namespacedOptions, cwd);
        dbIdentifier = resolveDbIdentifier(options, cwd);
        dbClusterIdentifier = resolveDbClusterIdentifier(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'db_import_run' });
    }
    const headless = resolveHeadless(options);

    intro(color.bgCyan(color.black(' grada db import 📥 ')));

    if (Array.isArray(options.unexpectedPositionals) && options.unexpectedPositionals.length > 0) {
        return failCommand({
            message: `\n✖ Unexpected argument "${options.unexpectedPositionals[0]}". Use --file <path> or --from <url>.\n`,
            event: 'db_import_run',
            telemetry: { projectName },
            errorCode: 'UNEXPECTED_POSITIONAL_ARGS',
            reason: 'unexpected-positional-args',
            resultExtra: { cluster, service, region },
        });
    }

    // 1. Source selection: exactly one of --file / --from.
    let file = typeof options.file === 'string' && options.file.trim() ? options.file.trim() : null;
    let from = typeof options.from === 'string' && options.from.trim() ? options.from.trim() : null;
    if (file && from) {
        return failCommand({
            message: '\n✖ Pass exactly one import source: --file <path> or --from <url>, not both.\n',
            event: 'db_import_run',
            telemetry: { projectName },
            errorCode: 'INVALID_IMPORT_SOURCE',
            reason: 'invalid-import-source',
            resultExtra: { cluster, service, region },
        });
    }
    if (!file && !from && headless) {
        return failCommand({
            message: '\n✖ No import source given. Pass --file <path> or --from <url>.\n',
            event: 'db_import_run',
            telemetry: { projectName },
            errorCode: 'INVALID_IMPORT_SOURCE',
            reason: 'invalid-import-source',
            resultExtra: { cluster, service, region },
        });
    }
    if (!file && !from) {
        const kind = await select({
            message: 'Import source:',
            options: [
                { value: 'file', label: 'Local SQL/dump file' },
                { value: 'from', label: 'Remote database URL' },
            ],
        });
        if (isCancel(kind)) {
            cancel('Cancelled.');
            return { ok: false, reason: 'cancelled', cluster, service, region };
        }
        if (kind === 'file') {
            const answer = await text({ message: 'Path to the SQL/dump file:' });
            if (isCancel(answer) || !String(answer || '').trim()) {
                cancel('Cancelled.');
                return { ok: false, reason: 'cancelled', cluster, service, region };
            }
            file = String(answer).trim();
        } else {
            // Masked: URLs usually embed the source password.
            const answer = await password({ message: 'Source database URL:' });
            if (isCancel(answer) || !String(answer || '').trim()) {
                cancel('Cancelled.');
                return { ok: false, reason: 'cancelled', cluster, service, region };
            }
            from = String(answer).trim();
        }
    }

    let source;
    if (from) {
        const parsed = parseSourceUri(from);
        if (!parsed) {
            return failCommand({
                message: `\n✖ Invalid --from "${redactUri(from)}". Use a postgresql:// or mysql:// URL with a database name.\n`,
                event: 'db_import_run',
                telemetry: { projectName },
                errorCode: 'INVALID_SOURCE_URI',
                reason: 'invalid-source-uri',
                resultExtra: { cluster, service, region },
            });
        }
        source = { type: 'url', ...parsed, redacted: redactUri(from) };
    } else {
        // Verified before any AWS API call.
        let readable = false;
        try {
            readable = fsSync.existsSync(file)
                && fsSync.statSync(file).isFile();
            if (readable) fsSync.accessSync(file, fsSync.constants.R_OK);
        } catch {
            readable = false;
        }
        if (!readable) {
            return failCommand({
                message: `\n✖ Import file not found or unreadable: ${file}.\n`,
                event: 'db_import_run',
                telemetry: { projectName },
                errorCode: 'IMPORT_FILE_NOT_FOUND',
                reason: 'import-file-not-found',
                resultExtra: { cluster, service, region },
            });
        }
        source = { type: 'file', path: file, kind: classifyImportFile(file) };
    }

    const rdsClient = resolveClient(options.rdsClient, RDSClient, { region });
    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });
    const secretsClient = resolveClient(options.secretsClient, SecretsManagerClient, { region });
    const spawnImpl = options.spawnImpl || spawn;
    const spawnSyncImpl = options.spawnSyncImpl;
    const waitForTunnelImpl = options.waitForTunnelImpl
        || ((host, port) => waitForTcpPort(host, port, {
            timeoutMs: options.tunnelTimeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS,
            pollIntervalMs: options.tunnelPollIntervalMs ?? DEFAULT_TUNNEL_POLL_INTERVAL_MS,
        }));

    // 2. Target discovery (shared lookup: instance or Aurora cluster).
    const target = await findDbTarget(rdsClient, { dbIdentifier, dbClusterIdentifier });
    if (!target) {
        return failCommand({
            print: () => printNoDatabaseGuidance(dbIdentifier),
            event: 'db_import_run',
            telemetry: { projectName, source: source.type, error_code: 'NO_DATABASE' },
            reason: 'no-database',
            resultExtra: { cluster, service, region },
        });
    }
    const targetIsMysql = target.engine === 'mysql' || target.engine === 'aurora-mysql';
    const targetScheme = targetIsMysql ? 'mysql' : 'postgresql';
    if (!target.endpoint || !target.dbName || !target.masterSecretArn) {
        return failCommand({
            message: `\n✖ The database ${color.cyan(target.id)} is missing its endpoint, name, or managed secret.`,
            event: 'db_import_run',
            telemetry: { projectName, source: source.type, error_code: 'DB_DETAILS_INCOMPLETE' },
            reason: 'db-details-incomplete',
            resultExtra: { cluster, service, region },
        });
    }
    if (source.type === 'file' && source.kind === 'dump' && targetIsMysql) {
        return failCommand({
            message: '\n✖ Cannot restore a Postgres custom-format archive (.dump) into MySQL. Export plain SQL instead.\n',
            event: 'db_import_run',
            telemetry: { projectName, source: source.type },
            errorCode: 'UNSUPPORTED_IMPORT_FORMAT',
            reason: 'unsupported-import-format',
            resultExtra: { cluster, service, region },
        });
    }

    // 3. Local preflight: AWS CLI, Session Manager plugin, db clients.
    if (!hasAwsCli({ spawnSyncImpl })) {
        return failCommand({
            print: () => printAwsCliGuidance({ commandName: 'db import' }),
            event: 'db_import_run',
            telemetry: { projectName, source: source.type, error_code: 'AWS_CLI_MISSING' },
            reason: 'aws-cli-missing',
            resultExtra: { cluster, service, region },
        });
    }
    if (!hasSessionManagerPlugin({ spawnSyncImpl })) {
        return failCommand({
            print: () => printSessionManagerGuidance({ commandName: 'db import' }),
            event: 'db_import_run',
            telemetry: { projectName, source: source.type, error_code: 'SSM_PLUGIN_MISSING' },
            reason: 'ssm-plugin-missing',
            resultExtra: { cluster, service, region },
        });
    }
    const missingBinaries = findMissingBinaries(
        requiredClientBinaries({ targetScheme, source }),
        { spawnSyncImpl }
    );
    if (missingBinaries.length > 0) {
        return failCommand({
            message: `\n✖ Missing database client tools: ${missingBinaries.join(', ')}.`,
            hint: clientInstallHint(missingBinaries),
            event: 'db_import_run',
            telemetry: { projectName, source: source.type, error_code: 'MISSING_DB_CLIENT_BINARY' },
            reason: 'missing-db-client-binary',
            resultExtra: { cluster, service, region },
        });
    }

    // 4. Confirmation (destructive write to the remote database).
    const skipConfirm = options.yes === true || options.yes === 'true'
        || options.force === true || options.force === 'true';
    const sourceLabel = source.type === 'file' ? source.path : source.redacted;
    if (!skipConfirm && headless) {
        return failCommand({
            message: '\n✖ Refusing to import without confirmation in non-interactive mode. Re-run with --yes.\n',
            event: 'db_import_run',
            telemetry: { projectName, source: source.type },
            errorCode: 'CONFIRMATION_REQUIRED',
            reason: 'confirmation-required',
            resultExtra: { cluster, service, region },
        });
    }
    if (!skipConfirm) {
        const confirmed = await confirm({
            message: `Import ${sourceLabel} into ${target.id}? This writes to the remote database.`,
        });
        if (isCancel(confirmed) || !confirmed) {
            cancel('Cancelled.');
            return { ok: false, reason: 'cancelled', cluster, service, region };
        }
    }

    // 5. Credentials + jump host (shared tunnel discovery).
    const s = spinner();
    s.start('Opening import tunnel...');
    const creds = await fetchManagedDbCredentials(secretsClient, target.masterSecretArn);
    if (!creds) {
        s.stop(color.red('Could not read database credentials.'));
        return failCommand({
            message: '\n✖ The managed database secret did not contain a username and password.',
            event: 'db_import_run',
            telemetry: { projectName, source: source.type, error_code: 'SECRET_MALFORMED' },
            reason: 'secret-malformed',
            resultExtra: { cluster, service, region },
        });
    }
    const jumpHost = await findJumpHostTarget(ecsClient, { cluster, service, expectedContainer });
    if (jumpHost.error === 'NO_RUNNING_TASKS') {
        s.stop(color.yellow('No running tasks.'));
        return failCommand({
            print: () => printDbNoTasksGuidance(service, cluster),
            event: 'db_import_run',
            telemetry: { projectName, source: source.type, error_code: 'NO_RUNNING_TASKS' },
            reason: 'no-running-tasks',
            resultExtra: { cluster, service, region },
        });
    }
    if (jumpHost.error === 'NO_RUNTIME_ID') {
        s.stop(color.red('Container runtime ID unavailable.'));
        return failCommand({
            message: '\n✖ The running container did not report a runtime ID, so the tunnel cannot attach.',
            hint: 'Wait a moment for the task to stabilize, then try again.\n',
            event: 'db_import_run',
            telemetry: { projectName, source: source.type, error_code: 'NO_RUNTIME_ID' },
            reason: 'no-runtime-id',
            resultExtra: { cluster, service, region },
        });
    }

    // 6. Background tunnel on an ephemeral loopback port (never 5432/3306,
    // which may already serve a local database).
    const allocatePort = options.allocatePortImpl || getFreeLocalPort;
    const localPort = await allocatePort();
    const ssmArgs = buildSsmArgs({
        cluster,
        taskId: jumpHost.taskId,
        runtimeId: jumpHost.runtimeId,
        dbHost: target.endpoint,
        remotePort: target.port || (targetIsMysql ? '3306' : '5432'),
        localPort: String(localPort),
        region,
    });
    const tunnel = spawnImpl('aws', ssmArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    let tunnelStderr = '';
    try {
        tunnel.stderr?.on('data', (chunk) => {
            tunnelStderr = (tunnelStderr + String(chunk)).slice(-4000);
        });
    } catch {
        // Best-effort diagnostics only.
    }
    const killTunnel = () => {
        if (!tunnel) return;
        // Detach stdio first: `aws ssm start-session` spawns a
        // session-manager-plugin grandchild that inherits the pipes, so our
        // handles stay open (and hold Node's event loop, hanging the CLI
        // after `Done.`) until they are destroyed.
        for (const stream of [tunnel.stdin, tunnel.stdout, tunnel.stderr]) {
            try { stream?.removeAllListeners?.(); } catch { /* best-effort */ }
            try { stream?.destroy?.(); } catch { /* best-effort */ }
        }
        try { tunnel.unref?.(); } catch { /* best-effort */ }
        // Escalate SIGTERM -> SIGKILL so the plugin is never orphaned. The
        // timer is unref'd so cleanup itself can never hold the event loop.
        const stillAlive = () => tunnel.exitCode == null && tunnel.signalCode == null;
        try {
            if (typeof tunnel.kill === 'function' && stillAlive()) {
                tunnel.kill('SIGTERM');
                const escalation = setTimeout(() => {
                    try {
                        if (stillAlive()) tunnel.kill('SIGKILL');
                    } catch { /* best-effort */ }
                }, options.tunnelSigkillTimeoutMs ?? TUNNEL_SIGKILL_TIMEOUT_MS);
                escalation.unref?.();
            }
        } catch {
            // Best-effort: the tunnel is a background child.
        }
    };
    const onSigint = () => {
        killTunnel();
        process.exit(130);
    };
    process.once('SIGINT', onSigint);

    try {
        s.message('Waiting for the tunnel...');
        const ready = await waitForTunnelImpl('127.0.0.1', localPort);
        if (!ready || ready.timedOut) {
            s.stop(color.red('Tunnel did not come up.'));
            const tail = tunnelStderr.trim() ? `\n  Tunnel output: ${tunnelStderr.trim().split('\n').pop()}` : '';
            return failCommand({
                message: `\n✖ The SSM tunnel did not accept connections within ${Math.round((options.tunnelTimeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS) / 1000)}s.${tail}\n`,
                event: 'db_import_run',
                telemetry: { projectName, source: source.type, error_code: 'TUNNEL_TIMEOUT' },
                reason: 'tunnel-timeout',
                resultExtra: { cluster, service, region },
            });
        }
        s.stop(color.green('Tunnel ready. Importing...'));

        const targetCmd = buildTargetClientCommand({
            targetScheme,
            localPort,
            username: creds.username,
            dbName: target.dbName,
            fileKind: source.type === 'file' ? source.kind : null,
            filePath: source.type === 'file' ? source.path : null,
        });

        if (source.type === 'url') {
            const dump = buildSourceDumpCommand(source);
            const dumpChild = spawnImpl(dump.bin, dump.args, {
                stdio: ['ignore', 'pipe', 'inherit'],
                env: source.scheme === 'mysql'
                    ? { ...process.env, MYSQL_PWD: source.password }
                    : { ...process.env, PGPASSWORD: source.password, PGSSLMODE: process.env.PGSSLMODE || 'require' },
            });
            const importChild = spawnImpl(targetCmd.bin, targetCmd.args, {
                stdio: ['pipe', 'inherit', 'inherit'],
                env: targetEnv(targetScheme, creds.password),
            });
            dumpChild.stdout.pipe(importChild.stdin);
            const [dumpResult, importResult] = await Promise.all([
                waitForExit(dumpChild),
                waitForExit(importChild),
            ]);
            if (dumpResult.code !== 0) {
                return failCommand({
                    message: `\n✖ Source dump failed with exit code ${dumpResult.code}${dumpResult.error ? `: ${dumpResult.error.message}` : ''}.\n`,
                    event: 'db_import_run',
                    telemetry: { projectName, source: source.type, error_code: 'IMPORT_FAILED' },
                    reason: 'import-failed',
                    resultExtra: { cluster, service, region },
                });
            }
            if (importResult.code !== 0) {
                return failCommand({
                    message: `\n✖ Import failed with exit code ${importResult.code}${importResult.error ? `: ${importResult.error.message}` : ''}.\n`,
                    event: 'db_import_run',
                    telemetry: { projectName, source: source.type, error_code: 'IMPORT_FAILED' },
                    reason: 'import-failed',
                    resultExtra: { cluster, service, region },
                });
            }
        } else if (source.kind === 'dump') {
            const child = spawnImpl(targetCmd.bin, targetCmd.args, {
                stdio: ['ignore', 'inherit', 'inherit'],
                env: targetEnv(targetScheme, creds.password),
            });
            const result = await waitForExit(child);
            if (result.code !== 0) {
                return failCommand({
                    message: `\n✖ pg_restore failed with exit code ${result.code}${result.error ? `: ${result.error.message}` : ''}.\n`,
                    event: 'db_import_run',
                    telemetry: { projectName, source: source.type, error_code: 'IMPORT_FAILED' },
                    reason: 'import-failed',
                    resultExtra: { cluster, service, region },
                });
            }
        } else {
            const child = spawnImpl(targetCmd.bin, targetCmd.args, {
                stdio: ['pipe', 'inherit', 'inherit'],
                env: targetEnv(targetScheme, creds.password),
            });
            const fileStream = createReadStream(source.path);
            const input = source.kind === 'gzip' ? fileStream.pipe(zlib.createGunzip()) : fileStream;
            input.on('error', (error) => {
                try { child.stdin.destroy(error); } catch { /* handled below */ }
            });
            input.pipe(child.stdin);
            const result = await waitForExit(child);
            if (result.code !== 0) {
                return failCommand({
                    message: `\n✖ Import failed with exit code ${result.code}${result.error ? `: ${result.error.message}` : ''}.\n`,
                    event: 'db_import_run',
                    telemetry: { projectName, source: source.type, error_code: 'IMPORT_FAILED' },
                    reason: 'import-failed',
                    resultExtra: { cluster, service, region },
                });
            }
        }

        console.log(color.green('\n✅ Import complete.'));
        await trackSuccess('db_import_run', { projectName, source: source.type, target_engine: target.engine || 'unknown' });
        outro(color.green('Done.'));
        return { ok: true, source: source.type, targetId: target.id };
    } catch (error) {
        await trackFailure('db_import_run', {
            projectName,
            source: source?.type,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        if (handleAuthErrorBranch(error, s, options)) {
            return { ok: false, reason: 'error', cluster, service, region };
        }
        try { s.stop(color.red('❌ Db import failed.')); } catch { /* spinner already stopped */ }
        return failCommand({
            message: `✖ ${error?.message || error}`,
            hint: 'Check your AWS credentials and region, then try again.',
            reason: 'error',
            resultExtra: { cluster, service, region },
        });
    } finally {
        killTunnel();
        process.removeListener('SIGINT', onSigint);
    }
}

export default runDbImport;
