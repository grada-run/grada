import { ECSClient } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackSuccess, setActiveCommandName, resetActiveCommandName } from '../../core/telemetry.js';
import { failCommand, failAwsError, trackAwsFailure, failProjectNotInitialized, refuseUnknownFlags } from '../../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../../utils/args.js';
import { isAuthError, handleAuthErrorBranch, resolveClient } from '../../utils/aws.js';
import {
    resolveRegion,
    resolveProjectName,
    resolveCluster,
    resolveService,
    resolveLogGroup,
    resolveAppName,
    resolveCwd,
} from '../../utils/resolvers.js';
import { resolveContainer } from '../../utils/ecs.js';
import { runEphemeralEcsTask } from '../../utils/ecs-runner.js';
import { parseTimeoutSeconds } from '../../utils/system.js';
import { buildMigrationCommand } from './migrate.js';
import fsSync from 'fs';
import path from 'path';

export const DEFAULT_VECTOR_TIMEOUT_SECONDS = 600;
export const DEFAULT_VECTOR_POLL_INTERVAL_MS = 2000;
export const DEFAULT_VECTOR_FLUSH_MAX_POLLS = 6;
export const DEFAULT_VECTOR_FLUSH_INTERVAL_MS = 1000;

// Exit code when the container has no usable PostgreSQL client. The CLI
// maps it to install guidance (see NO_CLIENT_HINT).
export const VECTOR_NO_CLIENT_EXIT_CODE = 3;

const NO_CLIENT_HINT = 'Install a PostgreSQL client in your image (postgresql-client for psql, or the pg / @prisma/client / psycopg package) and retry.\n';

export function parseDbEnableVectorArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'db') args.shift();
    if (args[0] === 'enable-vector') args.shift();
    const { options, rest, unknown } = parseFlags(args, {
        string: [
            { name: 'cluster', key: 'cluster' },
            { name: 'service', key: 'service' },
            { name: 'container', key: 'container' },
            { name: 'task-def', key: 'taskDef' },
            { name: 'timeout', key: 'timeout' },
            { name: 'project-name', key: 'projectName' },
            { name: 'region', key: 'region' },
            { name: 'workspace', key: 'workspace' },
        ],
        boolean: ['headless', 'yes'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0) options.unexpectedPositionals = positionals;
    if (unknown.length > 0) options.unknownFlags = unknown;
    return options;
}

// Self-contained `sh` ladder that enables pgvector inside the ephemeral
// task without assuming any particular client binary. Tries, in order:
// psql → node (pg, then @prisma/client) → python (psycopg, psycopg2,
// asyncpg; Django projects carry psycopg under the hood) → diagnostic
// exit 3. Reads $DATABASE_URL (exported by the caller's command wrapper).
// RDS/Aurora enforces `rds.force_ssl = 1` by default, so every branch
// negotiates TLS: PGSSLMODE covers psql and the libpq-based drivers
// (psycopg/psycopg2), while node-postgres, Prisma, and asyncpg carry
// explicit opts (they don't read PGSSLMODE).
// Pure and unit-tested.
export function buildVectorExtensionCommand() {
    const lines = [
        'VECTOR_SQL="CREATE EXTENSION IF NOT EXISTS vector;"',
        'export PGSSLMODE="${PGSSLMODE:-require}"',
        'PYBIN="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"',
        'if command -v psql >/dev/null 2>&1; then',
        '  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "$VECTOR_SQL" -c "SELECT extversion FROM pg_extension WHERE extname = \'vector\';"',
        'elif command -v node >/dev/null 2>&1 && node -e "require.resolve(\'pg\')" >/dev/null 2>&1; then',
        '  node -e "const{Client}=require(\'pg\');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();await c.query(\'CREATE EXTENSION IF NOT EXISTS vector\');const r=await c.query(\\"SELECT extversion FROM pg_extension WHERE extname=\'vector\'\\");console.log(\'pgvector extension version: \'+(r.rows[0]&&r.rows[0].extversion));await c.end();})().catch(e=>{console.error(e&&e.message||e);process.exit(1);})"',
        'elif command -v node >/dev/null 2>&1 && node -e "require.resolve(\'@prisma/client\')" >/dev/null 2>&1; then',
        '  node -e "const{PrismaClient}=require(\'@prisma/client\');(async()=>{let U=process.env.DATABASE_URL;if(!/[?&]sslmode=/i.test(U))U+=U.includes(\'?\')?\'&sslmode=require\':\'?sslmode=require\';process.env.DATABASE_URL=U;const p=new PrismaClient();await p.\\$executeRawUnsafe(\'CREATE EXTENSION IF NOT EXISTS vector\');const r=await p.\\$queryRawUnsafe(\\"SELECT extversion FROM pg_extension WHERE extname=\'vector\'\\");console.log(\'pgvector extension ready: \'+JSON.stringify(r));await p.\\$disconnect();})().catch(e=>{console.error(e&&e.message||e);process.exit(1);})"',
        'elif [ -n "$PYBIN" ] && "$PYBIN" -c "import psycopg" >/dev/null 2>&1; then',
        '  "$PYBIN" -c "import os,psycopg;c=psycopg.connect(os.environ[\'DATABASE_URL\'],autocommit=True);c.execute(\'CREATE EXTENSION IF NOT EXISTS vector\');print(\'pgvector extension version:\',c.execute(\\"SELECT extversion FROM pg_extension WHERE extname=\'vector\'\\").fetchone()[0])"',
        'elif [ -n "$PYBIN" ] && "$PYBIN" -c "import psycopg2" >/dev/null 2>&1; then',
        '  "$PYBIN" -c "import os,psycopg2;c=psycopg2.connect(os.environ[\'DATABASE_URL\']);c.autocommit=True;cur=c.cursor();cur.execute(\'CREATE EXTENSION IF NOT EXISTS vector\');cur.execute(\\"SELECT extversion FROM pg_extension WHERE extname=\'vector\'\\");print(\'pgvector extension version:\',cur.fetchone()[0])"',
        'elif [ -n "$PYBIN" ] && "$PYBIN" -c "import asyncpg" >/dev/null 2>&1; then',
        '  "$PYBIN" -c "import os,asyncio,asyncpg',
        'async def __vector_setup():',
        '    c=await asyncpg.connect(os.environ[\'DATABASE_URL\'],ssl=\'require\')',
        '    await c.execute(\'CREATE EXTENSION IF NOT EXISTS vector\')',
        '    print(\'pgvector extension version:\',await c.fetchval(\\"SELECT extversion FROM pg_extension WHERE extname=\'vector\'\\"))',
        'asyncio.run(__vector_setup())"',
        'else',
        '  echo "grada: no PostgreSQL client found (need psql, pg/@prisma/client, or psycopg) to enable pgvector" >&2',
        `  exit ${VECTOR_NO_CLIENT_EXIT_CODE}`,
        'fi',
    ];
    return lines.join('\n');
}

function detectDatabaseEngine(cwd) {
    try {
        const databaseTf = path.join(cwd, 'terraform', 'database.tf');
        if (!fsSync.existsSync(databaseTf)) return { present: false, engine: 'unknown' };
        const hcl = fsSync.readFileSync(databaseTf, 'utf8');
        if (hcl.includes('resource "aws_rds_cluster"')) return { present: true, engine: 'aurora-postgresql' };
        if (/engine\s*=\s*"mysql"/.test(hcl)) return { present: true, engine: 'mysql' };
        return { present: true, engine: 'postgres' };
    } catch {
        return { present: false, engine: 'unknown' };
    }
}

function printPrismaVectorHint() {
    console.log(color.cyan('\n  💡 Prisma detected: enable the extension in prisma/schema.prisma:'));
    console.log(color.dim('    generator client { provider = "prisma-client-js"'));
    console.log(color.dim('      previewFeatures = ["postgresqlExtensions"] }'));
    console.log(color.dim('    datasource db { provider = "postgresql"'));
    console.log(color.dim('      extensions = [vector] }\n'));
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runDbEnableVector(input = {}) {
    setActiveCommandName('db_enable_vector');
    try {
        return await runDbEnableVectorMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runDbEnableVectorMain(input = {}) {
    const options = normalizeOptions(input);
    const unknownRefusal = await refuseUnknownFlags(options, { command: 'db enable-vector', event: 'db_enable_vector_run' });
    if (unknownRefusal) return unknownRefusal;
    const startTime = Date.now();
    let cwd;
    let region;
    let projectName;
    let cluster;
    let service;
    let containerName;
    let logGroupName;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
        const appName = resolveAppName(projectName, options.workspace, cwd);
        const namespacedOptions = { ...options, projectName: appName };
        cluster = resolveCluster(namespacedOptions, cwd);
        service = resolveService(namespacedOptions, cwd);
        containerName = resolveContainer(namespacedOptions, cwd);
        logGroupName = resolveLogGroup(namespacedOptions, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'db_enable_vector_run' });
    }
    // Accepted for script uniformity with the other db subcommands; this
    // command never prompts, so --yes only forces non-interactive mode.
    // --headless / --yes are accepted for script uniformity with the other
    // db subcommands, but this command never prompts: the task runs
    // unconditionally once the guards pass.
    intro(color.bgCyan(color.black(' grada db enable-vector 🧬 ')));

    if (Array.isArray(options.unexpectedPositionals) && options.unexpectedPositionals.length > 0) {
        return failCommand({
            message: `\n✖ Unexpected argument "${options.unexpectedPositionals[0]}". This command takes flags only: db enable-vector [--task-def <task-def>] [--timeout <seconds>].\n`,
            event: 'db_enable_vector_run',
            telemetry: { projectName },
            errorCode: 'UNEXPECTED_POSITIONAL_ARGS',
            reason: 'unexpected-positional-args',
            resultExtra: { cluster, service, region },
        });
    }

    const timeoutSeconds = parseTimeoutSeconds(options.timeout, DEFAULT_VECTOR_TIMEOUT_SECONDS);
    if (timeoutSeconds === null) {
        return failCommand({
            message: `\n✖ Invalid --timeout "${options.timeout}". Use a positive number of seconds (default ${DEFAULT_VECTOR_TIMEOUT_SECONDS}).\n`,
            event: 'db_enable_vector_run',
            telemetry: { projectName },
            errorCode: 'INVALID_TIMEOUT',
            reason: 'invalid-timeout',
            resultExtra: { cluster, service, region },
        });
    }

    // Engine & prerequisite guards (before any AWS calls).
    const { present: hasDatabaseTf, engine } = detectDatabaseEngine(cwd);
    if (hasDatabaseTf && engine === 'mysql') {
        return failCommand({
            message: '\n✖ pgvector requires PostgreSQL or Aurora PostgreSQL. This project provisions MySQL.\n',
            event: 'db_enable_vector_run',
            telemetry: { projectName, engine },
            errorCode: 'UNSUPPORTED_VECTOR_ENGINE',
            reason: 'unsupported-vector-engine',
            resultExtra: { cluster, service, region },
        });
    }
    if (!hasDatabaseTf) {
        const hasCluster = typeof options.cluster === 'string' && options.cluster.trim() !== '';
        const hasService = typeof options.service === 'string' && options.service.trim() !== '';
        if (!hasCluster && !hasService) {
            return failCommand({
                message: `\n✖ No database configured. Run ${color.green('npx grada-run')} with a managed PostgreSQL database first, or target a service explicitly with --cluster/--service.\n`,
                event: 'db_enable_vector_run',
                telemetry: { projectName },
                errorCode: 'NO_DATABASE_CONFIGURED',
                reason: 'no-database-configured',
                resultExtra: { cluster, service, region },
            });
        }
    }

    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });
    const logsClient = resolveClient(options.logsClient ?? options.cloudwatchClient, CloudWatchLogsClient, { region });
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_VECTOR_POLL_INTERVAL_MS;
    const maxFlushPolls = options.maxFlushPolls ?? DEFAULT_VECTOR_FLUSH_MAX_POLLS;
    const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_VECTOR_FLUSH_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? timeoutSeconds * 1000;

    const s = spinner();
    s.start('Starting vector task...');

    try {
        // The DATABASE_URL export prefix comes from the shared migrate
        // helper so discrete DB_* task definitions work unchanged.
        const vectorScript = buildVectorExtensionCommand();
        const outcome = await runEphemeralEcsTask({
            ecsClient,
            logsClient,
            cluster,
            service,
            containerName,
            taskDef: (typeof options.taskDef === 'string' && options.taskDef.trim()) ? options.taskDef.trim() : null,
            command: (containerDef) => buildMigrationCommand(vectorScript, containerDef),
            startedBy: 'grada-db-enable-vector',
            logGroupName,
            timeoutMs,
            timeoutSeconds,
            pollIntervalMs,
            maxFlushPolls,
            flushIntervalMs,
            spinner: s,
            taskNoun: 'vector',
        });

        if (!outcome.ok && outcome.code === 'ECS_SERVICE_NOT_FOUND') {
            s.stop(color.yellow('Service not found.'));
            return failCommand({
                print: () => {
                    console.log(`\n  The ECS service ${color.cyan(service)} does not exist or is inactive.`);
                    console.log(`  Run ${color.green('npx grada-run apply')} to provision your infrastructure.\n`);
                },
                event: 'db_enable_vector_run',
                telemetry: { projectName },
                errorCode: 'ECS_SERVICE_NOT_FOUND',
                reason: 'ecs-service-not-found',
                resultExtra: { cluster, service, region },
            });
        }

        if (!outcome.ok && outcome.code === 'NO_VPC_CONFIG') {
            s.stop(color.red('Service has no VPC configuration.'));
            return failCommand({
                message: `\n✖ The ECS service ${color.cyan(service)} has no VPC network configuration, so the vector task cannot be placed.\n`,
                event: 'db_enable_vector_run',
                telemetry: { projectName },
                errorCode: 'RUN_TASK_FAILED',
                reason: 'run-task-failed',
                resultExtra: { cluster, service, region },
            });
        }

        if (!outcome.ok && outcome.code === 'CONTAINER_NOT_FOUND') {
            s.stop(color.red('Container not found.'));
            return failCommand({
                message: `\n✖ Container "${containerName}" does not exist in task definition "${outcome.targetTaskDef}".\n`,
                hint: `Override with --container <name>. Available: ${outcome.available.join(', ') || 'none'}\n`,
                event: 'db_enable_vector_run',
                telemetry: { projectName },
                errorCode: 'CONTAINER_NOT_FOUND',
                reason: 'container-not-found',
                resultExtra: { cluster, service, region },
            });
        }

        if (!outcome.ok && outcome.code === 'RUN_TASK_FAILED') {
            s.stop(color.red('Failed to start vector task.'));
            return failCommand({
                message: `\n✖ ECS could not start the vector task: ${outcome.reason}.\n`,
                event: 'db_enable_vector_run',
                telemetry: { projectName },
                errorCode: 'RUN_TASK_FAILED',
                reason: 'run-task-failed',
                resultExtra: { cluster, service, region },
            });
        }

        if (!outcome.ok && outcome.code === 'TIMEOUT') {
            try { s.stop(color.yellow('Vector task timed out.')); } catch { /* already stopped */ }
            return failCommand({
                message: `\n✖ Vector task timed out after ${timeoutSeconds}s. The task was stopped (best-effort); increase --timeout and retry.\n`,
                event: 'db_enable_vector_run',
                telemetry: { projectName },
                errorCode: 'VECTOR_TIMEOUT',
                reason: 'vector-timeout',
                resultExtra: { cluster, service, region, taskArn: outcome.taskArn },
            });
        }

        const exitCode = outcome.exitCode;
        const stoppedReason = outcome.stoppedReason;
        if (exitCode === 0) {
            console.log(color.green('\n✅ pgvector extension enabled.'));
            try {
                const prismaSchema = path.join(cwd, 'prisma', 'schema.prisma');
                if (fsSync.existsSync(prismaSchema)) {
                    const schema = fsSync.readFileSync(prismaSchema, 'utf8');
                    if (!schema.includes('postgresqlExtensions')) printPrismaVectorHint();
                }
            } catch {
                // Best-effort hint only; the remote task already succeeded.
            }
            await trackSuccess('db_enable_vector_run', { projectName, duration_ms: Date.now() - startTime, engine });
            outro(color.green('Done.'));
            return { ok: true, taskArn: outcome.taskArn, engine };
        }
        const propagated = (typeof exitCode === 'number' && exitCode > 0) ? exitCode : 1;
        return failCommand({
            message: `\n✖ Vector task failed with exit code ${exitCode ?? 'unknown'}: ${stoppedReason}.\n`,
            hint: exitCode === VECTOR_NO_CLIENT_EXIT_CODE ? NO_CLIENT_HINT : null,
            event: 'db_enable_vector_run',
            telemetry: { projectName, engine },
            errorCode: 'VECTOR_TASK_FAILED',
            extra: { exit_code: exitCode ?? -1 },
            reason: 'vector-task-failed',
            resultExtra: { cluster, service, region, taskArn: outcome.taskArn },
            exitCode: propagated,
        });
    } catch (error) {
        if (isAuthError(error)) {
            await trackAwsFailure('db_enable_vector_run', error, { projectName });
            handleAuthErrorBranch(error, s, options);
            return { ok: false, reason: 'error', cluster, service, region };
        }
        try { s.stop(color.red('❌ Db enable-vector failed.')); } catch { /* spinner already stopped */ }
        return failAwsError({
            event: 'db_enable_vector_run',
            error,
            telemetry: { projectName },
            reason: 'error',
            resultExtra: { cluster, service, region },
        });
    }
}

export default runDbEnableVector;
