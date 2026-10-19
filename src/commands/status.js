import { spawnSync } from 'child_process';
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { CloudFrontClient, ListDistributionsCommand } from '@aws-sdk/client-cloudfront';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackEvent, flushTelemetry, trackSuccess, trackFailure, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { failCommand, failProjectNotInitialized, isProgrammaticCall } from '../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { handleAuthErrorBranch, resolveClient } from '../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveCwd, readTerraformComputeTarget, readResourceSuffix } from '../utils/resolvers.js';
import { runDiagnose } from './diagnose.js';
import { fetchGoldenSignals } from '../utils/golden-signals.js';
import { requireManagedTree } from '../utils/terraform-metadata.js';

export const DEGRADED_MESSAGE = '⚠️ Degraded state detected. Running automated diagnostics...';
export const STATUS_WATCH_INTERVAL_MS = 10000;

// Watch loop: repaint the dashboard every STATUS_WATCH_INTERVAL_MS until
// interrupted. Each tick is a fresh single pass with diagnose suppressed
// (watchMode) so a degraded service repaints instead of spamming
// diagnostics. `watchMaxTicks`/`watchSleepImpl` are test seams.
export async function runStatusWatch(input = {}) {
    const options = normalizeOptions(input);
    const maxTicks = options.watchMaxTicks ?? Infinity;
    const sleepFn = options.watchSleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let ticks = 0;
    for (;;) {
        console.clear();
        await runStatus({ ...options, watch: false, watchMode: true });
        ticks += 1;
        if (ticks >= maxTicks) return { ok: true, ticks };
        await sleepFn(STATUS_WATCH_INTERVAL_MS);
    }
}

export function parseStatusArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'status') args.shift();
    const { options } = parseFlags(args, {
        string: ['region'],
        bareBoolean: ['json', 'watch'],
    });
    return options;
}

function normalizeAlarm(alarm) {
    return {
        name: alarm.AlarmName || alarm.name || 'unknown',
        state: alarm.StateValue || alarm.state || 'UNKNOWN',
        reason: alarm.StateReason || alarm.reason,
    };
}

export function getServiceHealth(serviceDesc, alarms = []) {
    const desiredCount = serviceDesc?.desiredCount ?? 0;
    const runningCount = serviceDesc?.runningCount ?? 0;
    const pendingCount = serviceDesc?.pendingCount ?? 0;
    const status = serviceDesc?.status || 'UNKNOWN';
    const normalizedAlarms = (alarms || []).map(normalizeAlarm);
    const alarmed = normalizedAlarms.filter((a) => a.state === 'ALARM');
    const healthy = Boolean(serviceDesc) && runningCount >= desiredCount && alarmed.length === 0;
    return { serviceDesc: serviceDesc || null, desiredCount, runningCount, pendingCount, status, alarms: normalizedAlarms, alarmed, healthy };
}

export function formatAlarmBadge(state) {
    if (state === 'ALARM') return color.red('[ALARM]');
    if (state === 'OK') return color.green('[OK]');
    if (state === 'INSUFFICIENT_DATA') return color.yellow('[INSUFFICIENT_DATA]');
    return color.dim(`[${state}]`);
}

function formatReplicas(runningCount, desiredCount, pendingCount) {
    const summary = `${runningCount}/${desiredCount}`;
    let painted = summary;
    if (runningCount <= 0) painted = color.red(summary);
    else if (runningCount < desiredCount) painted = color.yellow(summary);
    else painted = color.green(summary);
    if (pendingCount > 0) painted += color.dim(` (${pendingCount} pending)`);
    return painted;
}

export function getLambdaHealth(configuration = {}) {
    const state = configuration.State || 'UNKNOWN';
    const lastUpdateStatus = configuration.LastUpdateStatus || 'UNKNOWN';
    const healthy = state === 'Active' && lastUpdateStatus === 'Successful';
    return { state, lastUpdateStatus, healthy };
}

function printLambdaDashboard({ functionName, configuration, health }) {
    console.log('');
    console.log(`  ${color.bold('Function:')} ${color.cyan(functionName)} ${health.state === 'Active' ? color.green('(ACTIVE)') : color.yellow(`(${health.state})`)}`);
    console.log(`  ${color.bold('Last update:')} ${health.lastUpdateStatus === 'Successful' ? color.green(health.lastUpdateStatus) : color.yellow(health.lastUpdateStatus)}`);
    if (configuration.LastModified) console.log(`  ${color.dim('Modified:')} ${configuration.LastModified}`);
    if (configuration.MemorySize) console.log(`  ${color.dim('Memory:')} ${configuration.MemorySize} MB ${color.dim(`(timeout ${configuration.Timeout ?? '?'}s)`)}`);
    if (configuration.Code?.ImageUri) console.log(`  ${color.dim('Image:')} ${configuration.Code.ImageUri.split('/').pop()}`);
    console.log('');
}

// --json failure envelope (status-local by design: teaching failCommand
// a json mode would reshape every command's programmatic results).
// --json emits exactly one JSON document on stdout, always — stderr
// stays silent too, since `error` already carries the message. The
// stamped exitCode preserves terminal exit codes via runCommand (json
// implies noExit, so nothing here exits directly); `ok: false`
// discriminates "couldn't check" from success/missing objects, which
// never carry `ok`. `error` is glyph-free: jq consumers must not strip
// terminal chrome.
function statusJsonError({ message, reason = null, extra = {} }) {
    const envelope = {
        ok: false,
        exitCode: 1,
        error: String(message ?? '').replace(/^\s*✖\s*/, '').trim(),
        reason,
        ...extra,
    };
    console.log(JSON.stringify(envelope, null, 2));
    return envelope;
}

// Lambda health via the AWS CLI (`get-function`), mirroring the ECS status
// flow above without adding an @aws-sdk/client-lambda dependency.
export async function runLambdaStatus(input = {}) {
    const options = normalizeOptions(input);
    const noExit = isProgrammaticCall(options);
    const cwd = options.cwd || process.cwd();
    const region = options.region;
    const projectName = options.projectName;
    const functionName = typeof options.functionName === 'string' && options.functionName.trim()
        ? options.functionName.trim()
        : `${projectName}${readResourceSuffix(cwd)}-fn`;
    const asJson = Boolean(options.json);
    const runSync = options.spawnSyncImpl || spawnSync;

    if (!asJson) intro(color.bgCyan(color.black(' grada status 📊 ')));

    const s = asJson ? null : spinner();
    if (s) s.start('Checking function health...');

    const res = runSync('aws', [
        'lambda', 'get-function',
        '--function-name', functionName,
        '--region', region,
        '--output', 'json',
    ], { encoding: 'utf8' });

    if (res?.error?.code === 'ENOENT') {
        if (s) s.stop(color.red('❌ Status check failed.'));
        await trackFailure('status_run', { projectName, error_code: 'AWS_CLI_MISSING' });
        const message = '✖ The AWS CLI is required for Lambda status checks.';
        if (asJson) return statusJsonError({ message, reason: 'aws-cli-missing', extra: { functionName, region } });
        return failCommand({
            noExit,
            message,
            hint: 'Install it from https://aws.amazon.com/cli/, then try again.',
            reason: 'aws-cli-missing',
            resultExtra: { functionName, region },
        });
    }

    if (res?.status !== 0) {
        const detail = String(res?.stderr || res?.stdout || '').trim();
        if (/ResourceNotFound/i.test(detail)) {
            if (s) s.stop(color.yellow('Function not found.'));
            const missing = { healthy: false, missing: true, function: null, signals: null, region, computeTarget: 'lambda' };

            await trackSuccess('status_run', { projectName, healthy: false, missing: true });

            // Missing is a state, not an error: print the same object
            // that's returned (single source), exit 0.
            if (asJson) {
                console.log(JSON.stringify(missing, null, 2));
                return missing;
            }
            console.log(`\n  The Lambda function ${color.cyan(functionName)} does not exist.`);
            console.log(`  Run ${color.green('npx grada-run apply')} to provision your infrastructure.\n`);

            if (options.watchMode) return { ...missing, watchMode: true };
            if (noExit) return missing;
            process.exit(0);
            return;
        }
        if (s) s.stop(color.red('❌ Status check failed.'));
        await trackFailure('status_run', { projectName, error_code: 'GET_FUNCTION_FAILED' });
        const message = `✖ ${detail || 'aws lambda get-function failed.'}`;
        if (asJson) return statusJsonError({ message, extra: { functionName, region } });
        return failCommand({
            noExit,
            message,
            hint: 'Check your AWS credentials and region, then try again.',
            resultExtra: { functionName, region },
        });
    }

    let configuration;
    try {
        configuration = JSON.parse(res.stdout || '{}').Configuration || {};
    } catch {
        if (s) s.stop(color.red('❌ Status check failed.'));
        await trackFailure('status_run', { projectName, error_code: 'BAD_RESPONSE' });
        const message = '✖ Could not parse the Lambda get-function response.';
        if (asJson) return statusJsonError({ message, extra: { functionName, region } });
        return failCommand({
            noExit,
            message,
            hint: 'Check your AWS CLI version, then try again.',
            resultExtra: { functionName, region },
        });
    }

    const health = getLambdaHealth(configuration);
    const payload = {
        function: {
            name: functionName,
            state: health.state,
            lastUpdateStatus: health.lastUpdateStatus,
            lastModified: configuration.LastModified,
            memorySize: configuration.MemorySize,
            timeout: configuration.Timeout,
            imageUri: configuration.Code?.ImageUri,
        },
        healthy: health.healthy,
        signals: null,
        region,
        computeTarget: 'lambda',
    };

    if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
        await trackSuccess('status_run', { projectName, healthy: health.healthy, json: true });
        return payload;
    }

    if (s) s.stop('Health check complete.\n');
    printLambdaDashboard({ functionName, configuration, health });

    if (!health.healthy) {
        console.log(color.yellow(DEGRADED_MESSAGE));
        await trackFailure('status_run', { projectName, healthy: false, degraded: true, reason: 'degraded' });
        if (options.watchMode) return { ...payload, watchMode: true };
        const diagnosis = await runDiagnose({ cwd, region });
        await failCommand({ exitCode: 1, noExit });
        return { ...payload, diagnosis };
    }

    outro(color.green('All systems healthy. ✅'));
    await trackSuccess('status_run', { projectName, healthy: true });
    return payload;
}

// Static-site health via CloudFront. The generated distribution carries a
// `${project}-cdn` comment, which is the discovery key — no local
// Terraform state required. Degraded means "still propagating", so there
// is no ECS-style diagnose handoff.
export async function runStaticStatus(input = {}) {
    const options = normalizeOptions(input);
    const noExit = isProgrammaticCall(options);
    const cwd = options.cwd || process.cwd();
    const region = options.region;
    const projectName = options.projectName;
    const comment = `${projectName}${readResourceSuffix(cwd)}-cdn`;
    const asJson = Boolean(options.json);
    const cloudFrontClient = resolveClient(options.cloudFrontClient, CloudFrontClient, { region });

    if (!asJson) intro(color.bgCyan(color.black(' grada status 📊 ')));

    const s = asJson ? null : spinner();
    if (s) s.start('Checking distribution status...');

    let distribution = null;
    try {
        // Default page (100 distributions) covers single-project accounts.
        const resp = await cloudFrontClient.send(new ListDistributionsCommand({}));
        const items = resp.DistributionList?.Items || [];
        distribution = items.find((item) => item.Comment === comment) || null;
    } catch (error) {
        const message = `✖ ${error?.message || error}`;
        // --json short-circuits every human branch below (auth guidance,
        // watch prose): the envelope is the whole output. Telemetry is
        // mirrored here so the shared call below stays untouched.
        if (asJson) {
            await trackFailure('status_run', {
                projectName,
                error_code: error?.name || 'UNKNOWN',
                error_message: error?.message,
            });
            return statusJsonError({ message, extra: { region } });
        }
        if (handleAuthErrorBranch(error, s, options)) {
            return { healthy: false, distribution: null, signals: null, region, computeTarget: 'static' };
        }
        if (s) s.stop(color.red('❌ Status check failed.'));
        if (options.watchMode) {
            console.log(color.red(`\n  ✖ ${error?.message || error} (retrying…)\n`));
            return { healthy: false, distribution: null, signals: null, region, computeTarget: 'static', watchMode: true };
        }
        await trackFailure('status_run', {
            projectName,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        return failCommand({
            noExit,
            message,
            hint: 'Check your AWS credentials and region, then try again.',
            resultExtra: { region },
        });
    }

    if (!distribution) {
        if (s) s.stop(color.yellow('Distribution not found.'));
        const missing = { healthy: false, missing: true, distribution: null, signals: null, region, computeTarget: 'static' };

        await trackSuccess('status_run', { projectName, healthy: false, missing: true });

        // Missing is a state, not an error: print the same object
        // that's returned (single source), exit 0.
        if (asJson) {
            console.log(JSON.stringify(missing, null, 2));
            return missing;
        }
        console.log(`\n  No CloudFront distribution found for ${color.cyan(comment)}.`);
        console.log(`  Run ${color.green('npx grada-run apply')} to provision your infrastructure.\n`);

        if (options.watchMode) return { ...missing, watchMode: true };
        if (noExit) return missing;
        process.exit(0);
        return;
    }

    const healthy = distribution.Status === 'Deployed';
    const payload = {
        distribution: {
            id: distribution.Id,
            status: distribution.Status,
            domainName: distribution.DomainName,
        },
        healthy,
        signals: null,
        region,
        computeTarget: 'static',
    };

    if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
        await trackSuccess('status_run', { projectName, healthy, json: true });
        return payload;
    }

    if (s) s.stop('Health check complete.\n');
    printStaticDashboard({ distribution: payload.distribution });

    if (!healthy) {
        console.log(color.yellow(`  Distribution is ${distribution.Status} — CloudFront changes propagate in a few minutes.\n`));
        await trackFailure('status_run', { projectName, healthy: false, degraded: true, reason: 'degraded' });
        if (options.watchMode) return { ...payload, watchMode: true };
        await failCommand({ exitCode: 1, noExit });
        return payload;
    }

    outro(color.green('All systems healthy. ✅'));
    await trackSuccess('status_run', { projectName, healthy: true });
    return payload;
}

function formatSignalCount(value) {
    if (value === null || value === undefined) return color.dim('n/a');
    return Math.round(value).toLocaleString('en-US');
}

function formatSignalPercent(value) {
    if (value === null || value === undefined) return color.dim('n/a');
    return `${value.toFixed(1)}%`;
}

function formatSignalMs(value) {
    if (value === null || value === undefined) return color.dim('n/a');
    return `${Math.round(value)}ms`;
}

function printStaticDashboard({ distribution }) {
    console.log('');
    console.log(`  ${color.bold('Distribution:')} ${color.cyan(distribution.id)} ${distribution.status === 'Deployed' ? color.green('(DEPLOYED)') : color.yellow(`(${distribution.status})`)}`);
    console.log(`  ${color.dim('URL:')} https://${distribution.domainName}`);
    console.log('');
}

function printDashboard({ serviceName, cluster, health, signals }) {
    console.log('');
    console.log(`  ${color.bold('Service:')} ${color.cyan(serviceName)} ${health.status === 'ACTIVE' ? color.green('(ACTIVE)') : color.yellow(`(${health.status})`)}`);
    console.log(`  ${color.dim('Cluster:')} ${cluster}`);
    console.log(`  ${color.bold('Replicas:')} ${formatReplicas(health.runningCount, health.desiredCount, health.pendingCount)}`);
    if (health.alarms.length === 0) {
        console.log(`  ${color.bold('Alarms:')} ${color.dim('No alarms configured.')}`);
    } else {
        console.log(`  ${color.bold('Alarms:')}`);
        for (const alarm of health.alarms) {
            console.log(`    ${formatAlarmBadge(alarm.state)} ${alarm.name}`);
        }
    }
    const { alb, ecs, db } = signals || {};
    if (!alb && !ecs && !db) {
        console.log(`  ${color.bold('Signals:')} ${color.dim('telemetry unavailable.')}`);
    } else {
        console.log(`  ${color.bold('Signals:')} ${color.dim('(last 15m)')}`);
        if (alb) console.log(`    ${color.dim('ALB:')} ${formatSignalCount(alb.requestCount)} req · ${formatSignalCount(alb.error5xxCount)} 5xx · p95 ${formatSignalMs(alb.latencyP95Ms)}`);
        if (ecs) console.log(`    ${color.dim('ECS:')} CPU ${formatSignalPercent(ecs.cpuPercent)} · Mem ${formatSignalPercent(ecs.memoryPercent)}`);
        if (db?.kind === 'cluster') console.log(`    ${color.dim('DB:')} ${db.capacityAcu ?? 'n/a'} ACU · ${formatSignalCount(db.connections)} conns`);
        else if (db) console.log(`    ${color.dim('DB:')} CPU ${formatSignalPercent(db.cpuPercent)} · ${formatSignalCount(db.connections)} conns`);
    }
    console.log('');
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runStatus(input = {}) {
    setActiveCommandName('status');
    try {
        return await runStatusMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runStatusMain(input = {}) {
    const options = normalizeOptions(input);
    const noExit = isProgrammaticCall(options);
    const asJson = Boolean(options.json);
    let cwd;
    let region;
    let projectName;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'status_run', noExit });
    }
    // Read-only status warns (never refuses) on ejected trees — except
    // under --json, where any prose would corrupt the single document.
    if (!asJson) await requireManagedTree({ cwd, command: 'status', options, mode: 'warn', noExit });
    const computeTarget = readTerraformComputeTarget(cwd);
    if (computeTarget === 'lambda') {
        return runLambdaStatus({ ...options, cwd, region, projectName });
    }
    if (computeTarget === 'static') {
        return runStaticStatus({ ...options, cwd, region, projectName });
    }
    const resourceSuffix = readResourceSuffix(cwd);
    const cluster = options.cluster || process.env.ECS_CLUSTER || `${projectName}${resourceSuffix}-cluster`;
    const serviceName = options.service || process.env.ECS_SERVICE || `${projectName}${resourceSuffix}-service`;
    const logGroup = options.logGroup || process.env.ECS_LOG_GROUP || `/ecs/${projectName}${resourceSuffix}`;

    // --watch repaints the human dashboard; --json stays a single shot.
    if (Boolean(options.watch) && !asJson) {
        return runStatusWatch({ ...options, cwd, region, projectName });
    }

    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });
    // Both key casings are accepted for backward compatibility; first wins.
    const cloudWatchClient = resolveClient(
        options.cloudWatchClient ?? options.cloudwatchClient, CloudWatchClient, { region }
    );

    if (!asJson) intro(color.bgCyan(color.black(' grada status 📊 ')));

    const s = asJson ? null : spinner();
    if (s) s.start('Checking service health...');

    try {
        const svcResp = await ecsClient.send(new DescribeServicesCommand({ cluster, services: [serviceName] }));
        const serviceDesc = (svcResp.services || [])[0] || null;

        if (!serviceDesc || serviceDesc.status === 'INACTIVE') {
            if (s) s.stop(color.yellow('Service not found.'));
            const missing = { healthy: false, missing: true, service: null, alarms: [], signals: null, region };

            await trackSuccess('status_run', { projectName, healthy: false, missing: true });

            // Missing is a state, not an error: print the same object
            // that's returned (single source), exit 0.
            if (asJson) {
                console.log(JSON.stringify(missing, null, 2));
                return missing;
            }
            console.log(`\n  The ECS service ${color.cyan(serviceName)} does not exist or is inactive.`);
            console.log(`  Run ${color.green('npx grada-run apply')} to provision your infrastructure.\n`);

            if (options.watchMode) return { ...missing, watchMode: true };
            if (noExit) return missing;
            process.exit(0);
            return;
        }

        const alarmsResp = await cloudWatchClient.send(new DescribeAlarmsCommand({ AlarmNamePrefix: projectName, MaxRecords: 100 }));
        const rawAlarms = [...(alarmsResp.MetricAlarms || []), ...(alarmsResp.CompositeAlarms || [])];

        const health = getServiceHealth(serviceDesc, rawAlarms);

        // Golden Signals are best-effort telemetry: any failure degrades
        // to null sections without failing the core health check.
        let signals = { alb: null, ecs: null, db: null };
        let signalsError = null;
        try {
            const fetched = await fetchGoldenSignals({
                projectName, region, cluster, service: serviceName,
                dbIdentifier: options.dbIdentifier,
                cloudWatchClient,
                elbClient: options.elbClient,
                rdsClient: options.rdsClient,
                cwd,
            });
            signals = { alb: fetched.alb, ecs: fetched.ecs, db: fetched.db };
            if (fetched.errors.length > 0) signalsError = fetched.errors;
        } catch (error) {
            signalsError = [`signals: ${error?.message || error}`];
        }

        const payload = {
            service: {
                name: serviceName,
                cluster,
                status: health.status,
                desiredCount: health.desiredCount,
                runningCount: health.runningCount,
                pendingCount: health.pendingCount,
            },
            alarms: health.alarms,
            signals,
            ...(signalsError ? { signalsError } : {}),
            healthy: health.healthy,
            region,
        };

        if (asJson) {
            console.log(JSON.stringify(payload, null, 2));
            await trackSuccess('status_run', { projectName, healthy: health.healthy, json: true });
            return payload;
        }

        if (s) s.stop('Health check complete.\n');
        printDashboard({ serviceName, cluster, health, signals });

        if (!health.healthy) {
            console.log(color.yellow(DEGRADED_MESSAGE));
            await trackFailure('status_run', { projectName, healthy: false, degraded: true, reason: 'degraded' });
            if (options.watchMode) return { ...payload, watchMode: true };
            const diagnosis = await runDiagnose({ cluster, region, logGroup });
            await failCommand({ exitCode: 1, noExit });
            return { ...payload, diagnosis };
        }

        outro(color.green('All systems healthy. ✅'));
        await trackSuccess('status_run', { projectName, healthy: true });
        return payload;
    } catch (error) {
        await trackFailure('status_run', {
            projectName,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        const message = `✖ ${error?.message || error}`;
        // --json short-circuits every human branch below (auth guidance,
        // watch prose): the envelope is the whole output.
        if (asJson) return statusJsonError({ message, extra: { service: serviceName, region } });
        if (handleAuthErrorBranch(error, s, options)) {
            return { healthy: false, service: null, alarms: [], signals: null, region };
        }

        if (s) s.stop(color.red('❌ Status check failed.'));
        if (options.watchMode) {
            console.log(color.red(`\n  ✖ ${error?.message || error} (retrying…)\n`));
            return { healthy: false, service: null, alarms: [], signals: null, region, watchMode: true };
        }
        return failCommand({
            noExit,
            message,
            hint: 'Check your AWS credentials and region, then try again.',
        });
    }
}

// Convenience alias mirroring the CLI verb.
export const statusCommand = runStatus;

export default runStatus;
