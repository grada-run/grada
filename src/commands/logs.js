import { CloudWatchLogsClient, FilterLogEventsCommand, DescribeLogStreamsCommand } from '@aws-sdk/client-cloudwatch-logs';
import color from 'picocolors';
import { trackEvent, flushTelemetry, trackSuccess, trackFailure } from '../core/telemetry.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { isAuthError, handleAuthErrorBranch, resolveClient } from '../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveLogGroup, resolveCwd, isComputeTarget } from '../utils/resolvers.js';
import { failProjectNotInitialized } from '../utils/command.js';
import { sleep } from '../utils/system.js';

export const DEFAULT_TAIL_LINES = 50;
export const DEFAULT_SINCE = '1h';
export const FOLLOW_POLL_INTERVAL_MS = 2000;
export const ERROR_KEYWORDS = ['ERROR', 'FATAL', 'Exception', 'fail', '500', '502'];

const ERROR_PATTERN = /ERROR|FATAL|Exception|fail|500|502/i;
const HIGHLIGHT_ERROR_PATTERN = /error|fatal|exception|fail|5\d\d/i;
const WARN_PATTERN = /warn/i;

const SINCE_RE = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/i;
const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 };

export function resolveServiceName(options = {}, cwd = process.cwd()) {
    for (const key of ['service', 'serviceName', 'container']) {
        if (typeof options[key] === 'string' && options[key].trim()) {
            return options[key].trim();
        }
    }
    return resolveProjectName(options, cwd);
}

export function hasExplicitService(options = {}) {
    return ['service', 'serviceName', 'container'].some(
        (key) => typeof options[key] === 'string' && options[key].trim()
    );
}

export function normalizeTailLines(value) {
    const n = typeof value === 'string' && value.trim() === '' ? NaN : parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_TAIL_LINES;
    return n;
}

export function parseSinceDuration(input) {
    if (input === undefined || input === null || input === '') return UNIT_MS.h;
    if (typeof input === 'number' && Number.isFinite(input)) return Math.max(0, input * 1000);
    const match = String(input).trim().match(SINCE_RE);
    if (!match) return UNIT_MS.h;
    const amount = parseInt(match[1], 10);
    const unit = (match[2] || 's').toLowerCase()[0];
    return amount * (UNIT_MS[unit] || UNIT_MS.h);
}

// Alias kept for convenience; both names are part of the public surface.
export const parseSince = parseSinceDuration;

export function isErrorLine(line) {
    return ERROR_PATTERN.test(String(line ?? ''));
}

// Alias kept for convenience.
export const matchesErrorFilter = isErrorLine;

export function extractTaskId(logStreamName) {
    if (!logStreamName) return '';
    const parts = String(logStreamName).split('/');
    return parts[parts.length - 1] || '';
}

export function formatLogLine(event = {}) {
    const timestamp = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString();
    const taskId = extractTaskId(event.logStreamName);
    const message = String(event.message ?? '').replace(/\n$/, '');
    let body = message;
    if (HIGHLIGHT_ERROR_PATTERN.test(message)) {
        body = color.red(message);
    } else if (WARN_PATTERN.test(message)) {
        body = color.yellow(message);
    }
    return taskId ? `${color.dim(timestamp)} ${color.dim(taskId)} ${body}` : `${color.dim(timestamp)} ${body}`;
}

// Alias kept for convenience.
export const formatLogEvent = formatLogLine;

export function parseLogsArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'logs') args.shift();
    const { options, rest } = parseFlags(args, {
        string: ['since', 'region'],
        number: ['tail'],
        bareBoolean: ['follow', 'error'],
        alias: { f: 'follow' },
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0) options.service = positionals[0];
    return options;
}

function eventKey(event) {
    if (event.eventId) return `id:${event.eventId}`;
    return `${event.timestamp}:${event.message}`;
}

export function isNotFoundError(error) {
    return error && (
        error.name === 'ResourceNotFoundException' ||
        /log group .* (does not exist|not found|cannot be found)/i.test(error.message || '')
    );
}

// CloudWatch log stream for one container run. Mirrors the `awslogs`
// configuration in `templates/terraform/main.tf` (`stream-prefix "ecs"`):
// `<prefix>/<container-name>/<task-id>`. Inverse of `extractTaskId`.
export function buildLogStreamName(containerName, taskId, prefix = 'ecs') {
    return `${prefix}/${containerName}/${taskId}`;
}

function printMissingLogGroupGuidance(logGroup, service, region) {
    const prefix = `/${String(logGroup).split('/').filter(Boolean).slice(0, 2).join('/')}/`;
    console.log(color.yellow(`\n⚠ No log group found for "${service}" (expected ${logGroup}).`));
    console.log(color.dim(`List matching groups with: aws logs describe-log-groups --log-group-name-prefix "${prefix}" --region ${region}`));
}

export async function runLogs(input = {}) {
    const options = normalizeOptions(input);
    let cwd;
    let region;
    let service;
    let logGroup;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        service = resolveServiceName(options, cwd);
        logGroup = resolveLogGroup(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'logs_streamed' });
    }
    const tail = normalizeTailLines(options.tail ?? options.tailLines ?? options.lines);
    const follow = Boolean(options.follow ?? options.f);
    const onlyErrors = Boolean(options.error ?? options.onlyErrors ?? options.filterErrors);
    // Lambda stream names are date/request-id based, not container names, so
    // a service stream-prefix filter would hide every event on that target.
    const isLambda = isComputeTarget(cwd, 'lambda');
    const explicitService = hasExplicitService(options) && !isLambda;

    const sinceRaw = options.since ?? options.sinceDuration ?? (follow ? undefined : DEFAULT_SINCE);
    const startTime = sinceRaw === undefined ? undefined : Date.now() - parseSinceDuration(sinceRaw);

    const pollIntervalMs = options.pollIntervalMs ?? FOLLOW_POLL_INTERVAL_MS;
    const maxPolls = options.maxPolls ?? (follow ? Infinity : 1);

    if (process.env.CI_MOCK_AWS === 'true' && !options.logsClient && !options.client) {
        const mocked = ['INFO service started', 'ERROR mocked failure for offline mode'];
        const visible = onlyErrors ? mocked.filter(isErrorLine) : mocked;
        for (const line of visible.slice(-tail)) console.log(formatLogLine({ timestamp: Date.now(), message: line }));
        return { logs: visible.slice(-tail), logGroup, region, service, mocked: true };
    }

    const logsClient = resolveClient(options.logsClient ?? options.client ?? options.cloudwatchClient, CloudWatchLogsClient, { region });

    let stopped = false;
    const onSigint = () => {
        stopped = true;
        console.log(color.dim('\nStopped following logs.'));
    };
    if (follow) process.once('SIGINT', onSigint);

    try {
        try {
            await logsClient.send(new DescribeLogStreamsCommand({ logGroupName: logGroup, limit: 1 }));
        } catch (verifyError) {
            if (isAuthError(verifyError)) throw verifyError;
            if (isNotFoundError(verifyError)) {
                printMissingLogGroupGuidance(logGroup, service, region);
                return { logs: [], logGroup, region, service };
            }
            // Any other verification failure is non-fatal: the fetch below is authoritative.
        }

        const seen = new Set();
        const collected = [];
        let nextToken;
        let polls = 0;
        let firstPoll = true;

        do {
            const input = { logGroupName: logGroup, limit: Math.min(Math.max(tail, 1), 10000) };
            if (startTime !== undefined) input.startTime = startTime;
            if (explicitService) input.logStreamNamePrefix = service;
            if (nextToken) input.nextToken = nextToken;

            const resp = await logsClient.send(new FilterLogEventsCommand(input));
            if (resp.nextToken) nextToken = resp.nextToken;

            if (seen.size > 5000) seen.clear();

            let fresh = (resp.events || []).filter((e) => {
                const key = eventKey(e);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            if (onlyErrors) fresh = fresh.filter((e) => isErrorLine(e.message));
            if (firstPoll) fresh = fresh.slice(-tail);

            for (const event of fresh) {
                console.log(formatLogLine(event));
                collected.push(String(event.message ?? ''));
            }

            firstPoll = false;
            polls += 1;
            if (!follow || stopped || polls >= maxPolls) break;
            await sleep(pollIntervalMs);
        } while (true);

        if (collected.length === 0) {
            console.log(color.cyan(`\nℹ Waiting for logs...`));
            console.log(`  The log group "${logGroup}" exists, but no application logs have been written yet.`);
            console.log(`  This is perfectly normal immediately after running 'apply' while the container boots.`);
            console.log(`  Try again in a minute, or run ${color.green('npx grada-run logs -f')} to watch the stream live.\n`);
        }

        await trackSuccess('logs_streamed', {
            projectName: resolveProjectName(options, cwd),
            is_following: follow,
            filtered_errors: onlyErrors,
            tail_lines: tail
        });

        return { logs: collected, logGroup, region, service };
    } catch (error) {

        await trackFailure('logs_streamed', {
            projectName: resolveProjectName(options, cwd),
            error_type: error.name || 'UNKNOWN'
        });

        if (handleAuthErrorBranch(error, null, options)) {
            return { logs: [], logGroup, region, service };
        }
        if (isNotFoundError(error)) {
            printMissingLogGroupGuidance(logGroup, service, region);
            return { logs: [], logGroup, region, service };
        }

        throw error;
    } finally {
        if (follow) process.removeListener('SIGINT', onSigint);
    }
}

// Convenience alias mirroring the CLI verb.
export const logsCommand = runLogs;

export default runLogs;
