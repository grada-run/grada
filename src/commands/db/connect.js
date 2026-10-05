import { RDSClient } from '@aws-sdk/client-rds';
import { ECSClient } from '@aws-sdk/client-ecs';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { spawn } from 'child_process';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackSuccess, trackFailure } from '../../core/telemetry.js';
import { failCommand, failProjectNotInitialized } from '../../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../../utils/args.js';
import { hasAwsCli, AWS_CLI_INSTALL_URL, handleAuthErrorBranch, resolveClient } from '../../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveCluster, resolveService, resolveAppName, resolveCwd } from '../../utils/resolvers.js';
import { findDbTarget, resolveDbIdentifier, resolveDbClusterIdentifier } from '../../utils/rds.js';
import {
    buildSsmArgs,
    fetchManagedDbCredentials,
    findJumpHostTarget,
} from '../../utils/db-tunnel.js';
import {
    hasSessionManagerPlugin,
    resolveContainer,
    printAwsCliGuidance,
    printSessionManagerGuidance,
    printNoTasksGuidance,
} from '../../utils/ecs.js';

// Re-exported so `db import` and existing barrel consumers share one builder.
export { buildSsmArgs };

// `db connect` wording for the shared ECS pre-flight guidance.
const printDbAwsCliGuidance = () => printAwsCliGuidance({
    commandName: 'db connect',
    purpose: 'to open a secure tunnel to your database',
});
const printDbSessionManagerGuidance = () => printSessionManagerGuidance({
    commandName: 'db connect',
    purpose: 'to securely tunnel to your database',
});
const printDbNoTasksGuidance = (service, cluster) => printNoTasksGuidance(
    service, cluster, 'to act as a jump host for the tunnel'
);

export const DEFAULT_LOCAL_PORT = '5432';
export const MASKED_PASSWORD = '********';

export function parseDbArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'db') args.shift();
    if (args[0] === 'connect') args.shift();
    const { options } = parseFlags(args, {
        string: ['port', 'region', 'cluster', 'service', 'workspace'],
        boolean: ['show-credentials'],
    });
    return options;
}

export function isValidPort(port) {
    if (typeof port !== 'string' || !/^\d+$/.test(port)) return false;
    const num = parseInt(port, 10);
    return num >= 1 && num <= 65535;
}

export function buildConnectionString({ username, password, localPort, dbName, showCredentials = false, scheme = 'postgresql' }) {
    // Percent-encode credentials ONLY for the URI: AWS-generated passwords can
    // contain characters like @ [ / : that break connection-string parsers.
    // The standalone Password: line stays unencoded so it can be copied verbatim.
    const secret = showCredentials ? encodeURIComponent(password) : MASKED_PASSWORD;
    return `${scheme}://${encodeURIComponent(username)}:${secret}@localhost:${localPort}/${dbName}`;
}

export function formatConnectionInfo({ localPort, dbName, username, password, showCredentials = false, scheme = 'postgresql' }) {
    const lines = [
        `  ${color.dim('Local Host:')} ${color.cyan('localhost')}`,
        `  ${color.dim('Local Port:')} ${color.cyan(localPort)}`,
        `  ${color.dim('Database:')} ${color.cyan(dbName)}`,
        `  ${color.dim('Username:')} ${color.cyan(username)}`,
        `  ${color.dim('Password:')} ${showCredentials ? color.yellow(password) : color.dim(MASKED_PASSWORD)}`,
        '',
        `  ${color.dim('Connection string:')}`,
        `  ${color.green(buildConnectionString({ username, password, localPort, dbName, showCredentials, scheme }))}`,
    ];
    if (!showCredentials) {
        lines.push(`  ${color.dim('Re-run with --show-credentials to reveal the password.')}`);
    }
    return lines.join('\n');
}

export function printNoDatabaseGuidance(dbIdentifier) {
    console.log(color.yellow('\n⚠ No database found.'));
    console.log(`  No RDS database named ${color.cyan(dbIdentifier)} exists in this environment.`);
    console.log('  This project was likely provisioned without a managed database.');
    console.log(`  Re-run ${color.green('npx grada-run')} and answer "Yes" to the database prompt, then ${color.green('npx grada-run apply')}.\n`);
}

export async function runDbConnect(input = {}) {
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
        // Namespaced project name so PR-preview workspaces resolve correctly.
        projectName = resolveProjectName(options, cwd);
        const appName = resolveAppName(projectName, options.workspace, cwd);
        const namespacedOptions = { ...options, projectName: appName };
        cluster = resolveCluster(namespacedOptions, cwd);
        service = resolveService(namespacedOptions, cwd);
        expectedContainer = resolveContainer(namespacedOptions, cwd);
        dbIdentifier = resolveDbIdentifier(options, cwd);
        dbClusterIdentifier = resolveDbClusterIdentifier(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'db_connect_run' });
    }
    const showCredentials = options.showCredentials === true || options.showCredentials === 'true';
    // An explicit --port wins; otherwise the local port defaults to the
    // remote database port once discovery completes below.
    const portOverride = typeof options.port === 'string' && options.port.trim()
        ? options.port.trim()
        : null;

    // Validate before any AWS client construction or child-process
    // pre-flight checks below: an invalid --port must fail fast instead of
    // blocking on external binaries (aws --version can take seconds).
    if (portOverride !== null && !isValidPort(portOverride)) {
        return failCommand({
            message: `\n✖ Invalid --port "${portOverride}". Use a number between 1 and 65535.\n`,
            event: 'db_connect_run',
            telemetry: { projectName, error_code: 'INVALID_PORT' },
            reason: 'invalid-port',
            resultExtra: { cluster, service, region },
        });
    }

    const rdsClient = resolveClient(options.rdsClient, RDSClient, { region });
    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });
    const secretsClient = resolveClient(options.secretsClient, SecretsManagerClient, { region });

    const spawnImpl = options.spawnImpl || spawn;
    const awsCliPresent = options.hasAwsCli ?? hasAwsCli({ spawnSyncImpl: options.spawnSyncImpl });
    const ssmPluginPresent = options.hasSsmPlugin ?? hasSessionManagerPlugin({ spawnSyncImpl: options.spawnSyncImpl });

    intro(color.bgCyan(color.black(' grada db 🛢️  ')));

    if (!awsCliPresent) {
        return failCommand({
            print: printDbAwsCliGuidance,
            event: 'db_connect_run',
            telemetry: { projectName, error_code: 'AWS_CLI_MISSING' },
            reason: 'aws-cli-missing',
            resultExtra: { cluster, service, region },
        });
    }

    if (!ssmPluginPresent) {
        return failCommand({
            print: printDbSessionManagerGuidance,
            event: 'db_connect_run',
            telemetry: { projectName, error_code: 'SSM_PLUGIN_MISSING' },
            reason: 'ssm-plugin-missing',
            resultExtra: { cluster, service, region },
        });
    }

    const s = spinner();
    s.start('Finding your database...');

    try {
        // 1. Find the RDS target (instance or Aurora cluster; shared lookup,
        // null when not provisioned).
        const target = await findDbTarget(rdsClient, { dbIdentifier, dbClusterIdentifier });

        if (!target) {
            s.stop();
            return failCommand({
                print: () => printNoDatabaseGuidance(dbIdentifier),
                event: 'db_connect_run',
                telemetry: { projectName, error_code: 'NO_DATABASE' },
                reason: 'no-database',
                resultExtra: { cluster, service, region },
            });
        }

        const dbHost = target.endpoint;
        const dbName = target.dbName;
        const secretArn = target.masterSecretArn;
        const remotePort = target.port || DEFAULT_LOCAL_PORT;
        const localPort = portOverride || remotePort;
        const scheme = target.engine === 'mysql' || target.engine === 'aurora-mysql' ? 'mysql' : 'postgresql';
        if (!dbHost || !dbName || !secretArn) {
            s.stop(color.red('Database details incomplete.'));
            return failCommand({
                message: `\n✖ The database ${color.cyan(target.id)} is missing its endpoint, name, or managed secret.`,
                event: 'db_connect_run',
                telemetry: { projectName, error_code: 'DB_DETAILS_INCOMPLETE' },
                reason: 'db-details-incomplete',
                resultExtra: { cluster, service, region },
            });
        }

        // 2. Fetch the managed credentials (never logged, never telemetered).
        s.message('Fetching database credentials...');
        const creds = await fetchManagedDbCredentials(secretsClient, secretArn);
        if (!creds) {
            s.stop(color.red('Could not read database credentials.'));
            return failCommand({
                message: '\n✖ The managed database secret did not contain a username and password.',
                event: 'db_connect_run',
                telemetry: { projectName, error_code: 'SECRET_MALFORMED' },
                reason: 'secret-malformed',
                resultExtra: { cluster, service, region },
            });
        }
        const { username, password } = creds;

        // 3. Find a running ECS task to act as the jump host.
        s.message('Finding a running container...');
        const jumpHost = await findJumpHostTarget(ecsClient, { cluster, service, expectedContainer });
        if (jumpHost.error === 'NO_RUNNING_TASKS') {
            s.stop(color.yellow('No running tasks.'));
            return failCommand({
                print: () => printDbNoTasksGuidance(service, cluster),
                event: 'db_connect_run',
                telemetry: { projectName, error_code: 'NO_RUNNING_TASKS' },
                reason: 'no-running-tasks',
                resultExtra: { cluster, service, region },
            });
        }
        if (jumpHost.error === 'NO_RUNTIME_ID') {
            s.stop(color.red('Container runtime ID unavailable.'));
            return failCommand({
                message: '\n✖ The running container did not report a runtime ID, so the tunnel cannot attach.',
                hint: 'Wait a moment for the task to stabilize, then try again.\n',
                event: 'db_connect_run',
                telemetry: { projectName, error_code: 'NO_RUNTIME_ID' },
                reason: 'no-runtime-id',
                resultExtra: { cluster, service, region },
            });
        }
        const { taskId, runtimeId } = jumpHost;

        s.stop(color.green('Tunnel details ready.'));
        console.log(formatConnectionInfo({ localPort, dbName, username, password, showCredentials, scheme }));
        console.log(color.dim(`\n  Opening a tunnel via ${jumpHost.containerName || expectedContainer} — press Ctrl+C to close.\n`));

        const ssmArgs = buildSsmArgs({
            cluster,
            taskId,
            runtimeId,
            dbHost,
            remotePort,
            localPort,
            region,
        });

        // Telemetry carries only non-sensitive fields. Credentials never leave this process
        // except to the terminal above and the local SSM session below.
        await trackSuccess('db_connect_run', { projectName, db_engine: target.engine || 'unknown', db_kind: target.kind });

        await new Promise((resolve) => {
            const child = spawnImpl('aws', ssmArgs, { stdio: 'inherit' });
            child.on('error', (err) => {
                console.log(color.red(`\n✖ Failed to start AWS CLI: ${err?.message || err}`));
                console.log(color.dim(`Install help: ${AWS_CLI_INSTALL_URL}`));
                resolve({ code: 1 });
            });
            child.on('close', (code) => resolve({ code: code ?? 0 }));
        }).then(async ({ code }) => {
            if (code === 0) {
                outro(color.green('Tunnel closed. 👋'));
            } else {
                console.log(color.yellow(`\nTunnel exited with code ${code}.`));
                console.log(color.dim('If the connection failed, ensure the Session Manager plugin is installed and your AWS session is fresh.'));
                outro(color.yellow('Db connect finished.'));
            }
        });

        return { ok: true, cluster, service, dbIdentifier, taskArn: jumpHost.taskArn, localPort, region };
    } catch (error) {
        // Only non-sensitive metadata is telemetered here. The password, username, and
        // connection string are never passed to trackEvent in any path.
        await trackFailure('db_connect_run', {
            projectName,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        if (handleAuthErrorBranch(error, s, options)) {
            return { ok: false, reason: 'error', cluster, service, region };
        }
        s.stop(color.red('❌ Db connect failed.'));
        return failCommand({
            message: `✖ ${error?.message || error}`,
            hint: 'Check your AWS credentials and region, then try again.',
            reason: 'error',
            resultExtra: { cluster, service, region },
        });
    }
}

// Convenience alias mirroring the CLI verb.
export const dbCommand = runDbConnect;

export default runDbConnect;
