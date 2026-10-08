#!/usr/bin/env node
import path from 'path';
import { mainStack } from '../src/commands/init.js';
import { destroyStack } from '../src/commands/destroy.js';
import { runDoctor } from '../src/commands/doctor.js';
import { pushSecrets, pullSecrets, auditSecrets } from '../src/commands/secrets.js';
import { ejectStack } from '../src/commands/eject.js';
import { applyStack, parseApplyArgs } from '../src/commands/apply.js';
import { runDiagnose } from '../src/commands/diagnose.js';
import { syncAi } from '../src/commands/sync-ai.js';
import { runLogs, parseLogsArgs } from '../src/commands/logs.js';
import { runStatus, parseStatusArgs } from '../src/commands/status.js';
import { runExec, parseExecArgs } from '../src/commands/exec.js';
import { runDb } from '../src/commands/db.js';
import { runRollback, parseRollbackArgs } from '../src/commands/rollback.js';
import { runGc, parseGcArgs } from '../src/commands/gc.js';
import { runAdd, parseAddArgs } from '../src/commands/add.js';
import { runDomain, parseDomainArgs } from '../src/commands/domain.js';
import { runSleep, parseSleepArgs } from '../src/commands/sleep.js';
import { runWake, parseWakeArgs } from '../src/commands/wake.js';
import { runDrift, parseDriftArgs } from '../src/commands/drift.js';
import { runAlerts, parseAlertsArgs } from '../src/commands/alerts.js';
import { runMcp, parseMcpArgs } from '../src/commands/mcp.js';
import { runTelemetry } from '../src/commands/telemetry.js';
import { parseCliArgs } from '../src/core/parser.js';

const HELP_TEXT = [
    'grada — Provision production-ready AWS infrastructure in seconds.',
    '',
    'Usage:',
    '  grada [command] [options]',
    '',
    'Commands:',
    '  init                 Provision infrastructure and CI/CD pipelines',
    '  apply                Apply infrastructure changes (--auto-approve, --force)',
    '  deploy               Alias of apply',
    '  destroy              Tear down infrastructure (--yes)',
    '  doctor               Run pre-flight dependency checks',
    '  logs [service]       Stream CloudWatch logs (--tail, -f/--follow, --error, --since, --region)',
    '  status               Service health dashboard (--region, --json, --watch)',
    '  rollback [rev]       Roll back ECS service to a previous task revision',
    '  exec                 Open an interactive shell in a running container (--cluster, --service, --container, --command, --region)',
    '  db connect           Open a secure local tunnel to your database (--port, --show-credentials, --workspace, --region)',
    '  db enable-vector     Enable the pgvector extension via a one-off ECS task (--task-def, --timeout)',
    '  db import            Import a SQL dump into your database (--file, --from, --yes)',
    '  db migrate           Run database migrations in a one-off ECS task (--cmd, --task-def, --timeout, --setup-ci)',
    '  db backup            Create an RDS snapshot checkpoint (--id, --timeout, --no-wait)',
    '  db restore           Restore the database from a snapshot ([snapshot-id], --yes)',
    '  gc                   Discover and delete orphaned ECR images, log groups, and Elastic IPs (--region)',
    '  sleep [env]          Scale ECS services to zero and stop RDS to save costs (--skip-db, --yes, --strict)',
    '  wake [env]           Start RDS and restore ECS desired counts (--skip-db, --no-wait, --strict)',
    '  drift                Detect Terraform drift locally or scaffold scheduled checks (--setup)',
    '  alerts               Scaffold SNS + alarm notifications for any target (--email, --webhook, --threshold, --force)',
    '  add <capability>     Provision a modular addon (storage:s3, db:dynamodb, db:redis, queue:sqs, ai:bedrock, email:ses, cron) [--model <id>, --list-models, --refresh]',
    '  domain add <domain>    Provision a custom domain with automated ACM TLS (--zone-id, --activate)',
    '  domain verify|status|remove  Activate, inspect, or remove the custom domain',
    '  secrets push         Push environment secrets',
    '  secrets pull         Pull environment secrets',
    '  secrets audit        Audit local vs remote secrets drift',
    '  eject                Eject to self-managed configs (--yes)',
    '  sync-ai              Sync AI assistant rules',
    '  mcp [--install <editor>] [--transport stdio|http]  Start the MCP server (stdio default; http serves /mcp for tunnels), or write IDE config (windsurf, zed, cursor, vscode, claude-desktop, gemini-cli)',
    '  telemetry off|on|status  Persistently disable, enable, or inspect anonymous usage telemetry',
    '',
    'Init options:',
    '  --target <ecs|lambda|static>  Compute architecture: always-on Fargate + ALB (~$31/mo flat, best for steady traffic), scale-to-zero Lambda + API Gateway ($0/mo idle, best for sporadic traffic), or zero-compute S3 + CloudFront (static sites only). Tradeoffs: Stack Architecture guide → Fargate vs Lambda.',
    '  --force  Re-run over modified files: back them up and regenerate (headless re-runs refuse without it)',
    '',
    'Global options:',
    '  --no-telemetry  Disable telemetry for this run only (persistent: grada telemetry off; every run: DO_NOT_TRACK=1)',
];

const rawArgs = process.argv.slice(2);
const parsed = parseCliArgs(rawArgs);

if (parsed.hasNoTelemetry) {
    process.env.DO_NOT_TRACK = '1';
}
process.env.CLI_COMMAND = parsed.baseCommand;

const { positionalArgs, isHeadless, isDryRun, isPreconfigured, autoApprove, yes: confirmYes, headlessOptions, initOptions } = parsed;

// Command aliases resolved before dispatch, so future aliases are one
// line. Telemetry keeps the literal typed command (parsed.baseCommand).
const COMMAND_ALIASES = { deploy: 'apply' };
const dispatchCommand = COMMAND_ALIASES[positionalArgs[0]] ?? positionalArgs[0];

function parseRegionFlag(args) {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--region' && i + 1 < args.length) return args[i + 1];
        if (args[i].startsWith('--region=')) return args[i].slice('--region='.length);
    }
    return undefined;
}

// Dispatch guard: every command promise ends here so an unexpected rejection
// prints the error and exits non-zero instead of surfacing as an unhandled
// rejection with a stack trace and an unpredictable exit code.
function runCommand(promise) {
    // Commands suppress process.exit for programmatic callers and stamp the
    // intended code onto the result instead — the CLI restores it here so
    // terminal exit codes never change.
    promise.then((result) => {
        if (result && result.ok === false && typeof result.exitCode === 'number') process.exit(result.exitCode);
    }).catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

if (positionalArgs[0] === 'secrets' && positionalArgs[1] === 'push') {
    const envFile = positionalArgs[2] || '.env';
    const projectName = path.basename(process.cwd());
    runCommand(pushSecrets(envFile, projectName, { isHeadless, region: parseRegionFlag(rawArgs) }));
} else if (positionalArgs[0] === 'secrets' && positionalArgs[1] === 'pull') {
    const envFile = positionalArgs[2] || '.env';
    const projectName = path.basename(process.cwd());
    runCommand(pullSecrets(envFile, projectName, { isHeadless, region: parseRegionFlag(rawArgs) }));
} else if (positionalArgs[0] === 'secrets' && positionalArgs[1] === 'audit') {
    const envFile = positionalArgs[2] || '.env';
    const projectName = path.basename(process.cwd());
    runCommand(auditSecrets(envFile, projectName, { region: parseRegionFlag(rawArgs) }));
} else if (dispatchCommand === 'apply') {
    runCommand(applyStack({ ...parseApplyArgs(rawArgs), isDryRun, ...(autoApprove ? { autoApprove: true } : {}), ...(isHeadless ? { isHeadless: true } : {}) }));
} else if (positionalArgs[0] === 'doctor') {
    runCommand(runDoctor());
} else if (positionalArgs[0] === 'destroy') {
    runCommand(destroyStack({ ...(confirmYes ? { yes: true } : {}), ...(isHeadless ? { isHeadless: true } : {}) }));
} else if (positionalArgs[0] === 'eject') {
    runCommand(ejectStack({ ...(confirmYes ? { yes: true } : {}), ...(isHeadless ? { isHeadless: true } : {}) }));
} else if (positionalArgs[0] === 'sync-ai') {
    runCommand(syncAi());
} else if (positionalArgs[0] === 'diagnose' || positionalArgs[0] === 'wtf') {
    runCommand(runDiagnose(headlessOptions));
} else if (positionalArgs[0] === 'logs') {
    runCommand(runLogs(parseLogsArgs(rawArgs)));
} else if (positionalArgs[0] === 'status') {
    runCommand(runStatus(parseStatusArgs(rawArgs)));
} else if (positionalArgs[0] === 'rollback') {
    runCommand(runRollback({ ...parseRollbackArgs(rawArgs), ...(isHeadless ? { isHeadless: true } : {}) }));
} else if (positionalArgs[0] === 'exec') {
    runCommand(runExec(parseExecArgs(rawArgs)));
} else if (positionalArgs[0] === 'db') {
    runCommand(runDb(rawArgs, { ...(isHeadless ? { isHeadless: true } : {}) }));
} else if (positionalArgs[0] === 'gc') {
    runCommand(runGc(parseGcArgs(rawArgs)));
} else if (positionalArgs[0] === 'add') {
    runCommand(runAdd(parseAddArgs(rawArgs)));
} else if (positionalArgs[0] === 'domain') {
    runCommand(runDomain(parseDomainArgs(rawArgs)));
} else if (positionalArgs[0] === 'sleep') {
    runCommand(runSleep({ ...parseSleepArgs(rawArgs), ...(isHeadless ? { isHeadless: true } : {}) }));
} else if (positionalArgs[0] === 'wake') {
    runCommand(runWake({ ...parseWakeArgs(rawArgs), ...(isHeadless ? { isHeadless: true } : {}) }));
} else if (positionalArgs[0] === 'drift') {
    runCommand(runDrift({ ...parseDriftArgs(rawArgs), ...(isHeadless ? { isHeadless: true } : {}) }));
} else if (positionalArgs[0] === 'alerts') {
    runCommand(runAlerts({ ...parseAlertsArgs(rawArgs), ...(isHeadless ? { isHeadless: true } : {}) }));
} else if (positionalArgs[0] === 'mcp') {
    runCommand(runMcp(parseMcpArgs(rawArgs)));
} else if (positionalArgs[0] === 'telemetry') {
    runCommand(runTelemetry({ subcommand: positionalArgs[1], ...(isHeadless ? { isHeadless: true } : {}) }));
} else if (positionalArgs[0] === 'help' || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log(HELP_TEXT.join('\n'));
} else {
    runCommand(mainStack({ isHeadless, isPreconfigured, headlessOptions, initOptions }));
}