import {
    DescribeTasksCommand,
    DescribeTaskDefinitionCommand,
    RunTaskCommand,
    StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { FilterLogEventsCommand, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import color from 'picocolors';
import path from 'path';
import { outro } from '@clack/prompts';
import { fetchActiveService, pickRuntimeContainer } from './ecs.js';
import { sleep, pollUntil, parseTimeoutSeconds } from './system.js';
import { truncateSpinnerText } from './spinner-text.js';
import { isNotFoundError, buildLogStreamName } from '../commands/logs.js';
import { failCommand, failNamedContainerMissing } from './command.js';
import { trackEvent, trackSuccess } from '../core/telemetry.js';
import { readFileSafe } from './resolvers.js';
import { isNpmShimCommand, dockerfileStripsNpmShims, ormMappedHintSegment } from './detector.js';

export const DEFAULT_RUNNER_POLL_INTERVAL_MS = 2000;
export const DEFAULT_RUNNER_FLUSH_MAX_POLLS = 6;
export const DEFAULT_RUNNER_FLUSH_INTERVAL_MS = 1000;

function capNoun(noun) {
    const text = String(noun || 'migration');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

// Identity keys for one log line. FilterLogEvents results carry `eventId`
// but GetLogEvents results do not, so every line registers its
// timestamp:message fingerprint (present in both APIs) plus its `eventId`
// when it has one — the final head-flush then never reprints live lines.
function eventKeys(event) {
    const keys = [`${event.timestamp ?? ''}:${event.message ?? ''}`];
    if (event.eventId) keys.push(`id:${event.eventId}`);
    return keys;
}

function printNewEvents(events, seen) {
    if (seen.size > 5000) seen.clear();
    for (const event of events || []) {
        const keys = eventKeys(event);
        if (keys.some((key) => seen.has(key))) continue;
        for (const key of keys) seen.add(key);
        console.log(String(event.message ?? '').replace(/\n$/, ''));
    }
}

// Live tail: FilterLogEvents scoped to the single task stream. `startTime`
// is deliberately omitted — the stream is unique per task run, so there is
// nothing stale to exclude and local clock skew can never drop early lines.
async function fetchNewLogEvents({ logsClient, logGroupName, logStreamName, seen }) {
    let events = [];
    try {
        const resp = await logsClient.send(new FilterLogEventsCommand({
            logGroupName,
            logStreamNames: [logStreamName],
        }));
        events = resp.events || [];
    } catch (error) {
        // The stream does not exist until the container starts emitting.
        if (isNotFoundError(error)) return;
        throw error;
    }
    printNewEvents(events, seen);
}

// Final flush: GetLogEvents reads the exact stream from the head, catching
// anything the live tail missed (Fargate ingestion lags several seconds on
// sub-second commands). Shares the `seen` set so lines print exactly once.
async function flushRemainingLogs({ logsClient, logGroupName, logStreamName, seen }) {
    let nextToken;
    for (;;) {
        let resp;
        try {
            resp = await logsClient.send(new GetLogEventsCommand({
                logGroupName,
                logStreamName,
                startFromHead: true,
                ...(nextToken ? { nextToken } : {}),
            }));
        } catch (error) {
            if (isNotFoundError(error)) return;
            throw error;
        }
        printNewEvents(resp.events, seen);
        const forward = resp.nextForwardToken;
        if (!forward || forward === nextToken) return;
        nextToken = forward;
    }
}

// Runs a one-off Fargate task from the service's task definition, streams
// its CloudWatch logs live, and resolves with the container outcome.
// Shared by `db migrate` and `db enable-vector` so the RunTask / poll /
// log-streaming / SIGINT lifecycle lives in exactly one place.
//
// Outcomes (the spinner is left running on failure paths so the caller can
// stop it with command-specific wording before reporting):
//   { ok: true, taskArn, exitCode, stoppedReason }
//   { ok: false, code: 'ECS_SERVICE_NOT_FOUND' }
//   { ok: false, code: 'NO_VPC_CONFIG' }
//   { ok: false, code: 'CONTAINER_NOT_FOUND', targetTaskDef, available: [names] }
//   { ok: false, code: 'RUN_TASK_FAILED', reason }
//   { ok: false, code: 'TIMEOUT', taskArn } (task stop attempted best-effort)
//   { ok: false, code: 'NAMED_CONTAINER_MISSING', taskArn, containerName, available, stoppedReason }
//
// `command` is the container override: either the array itself or a builder
// `(containerDef) => string[]` invoked with the selected task-definition
// container (so callers can synthesize env-dependent commands without a
// second DescribeTaskDefinition call).
export async function runEphemeralEcsTask({
    ecsClient,
    logsClient,
    cluster,
    service,
    containerName,
    taskDef = null,
    command,
    startedBy,
    logGroupName,
    timeoutMs,
    timeoutSeconds,
    pollIntervalMs = DEFAULT_RUNNER_POLL_INTERVAL_MS,
    maxFlushPolls = DEFAULT_RUNNER_FLUSH_MAX_POLLS,
    flushIntervalMs = DEFAULT_RUNNER_FLUSH_INTERVAL_MS,
    spinner = null,
    taskNoun = 'migration',
}) {
    const label = capNoun(taskNoun);
    let taskArn = null;
    const onSigint = () => {
        if (taskArn) {
            ecsClient.send(new StopTaskCommand({
                cluster,
                task: taskArn,
                reason: 'Cancelled by user via SIGINT',
            })).catch(() => {});
        }
        process.exit(130);
    };

    const serviceDesc = await fetchActiveService(ecsClient, cluster, service);
    if (!serviceDesc) {
        return { ok: false, code: 'ECS_SERVICE_NOT_FOUND' };
    }

    const vpcConfig = serviceDesc.networkConfiguration?.awsvpcConfiguration;
    const subnets = vpcConfig?.subnets || [];
    const securityGroups = vpcConfig?.securityGroups || [];
    if (subnets.length === 0 || securityGroups.length === 0) {
        return { ok: false, code: 'NO_VPC_CONFIG' };
    }
    // Mirror the service's own placement; the generated service uses
    // public subnets with ENABLED, custom private-subnet services inherit
    // their own value instead of a hard-coded default.
    const assignPublicIp = vpcConfig.assignPublicIp || 'ENABLED';

    const targetTaskDef = (typeof taskDef === 'string' && taskDef.trim())
        ? taskDef.trim()
        : serviceDesc.taskDefinition;
    const taskDefResp = await ecsClient.send(
        new DescribeTaskDefinitionCommand({ taskDefinition: targetTaskDef })
    );
    const selected = pickRuntimeContainer(taskDefResp.taskDefinition, containerName);
    if (!selected || selected.name !== containerName) {
        return {
            ok: false,
            code: 'CONTAINER_NOT_FOUND',
            targetTaskDef,
            available: (taskDefResp.taskDefinition?.containerDefinitions || []).map((c) => c.name),
        };
    }

    // Stream coordinates from the task definition itself so custom log
    // drivers, groups, and stream prefixes always match the live tail.
    let groupName = logGroupName;
    const logOptions = selected.logConfiguration?.options || {};
    if (typeof logOptions['awslogs-group'] === 'string' && logOptions['awslogs-group']) {
        groupName = logOptions['awslogs-group'];
    }
    let logStreamPrefix = 'ecs';
    if (typeof logOptions['awslogs-stream-prefix'] === 'string' && logOptions['awslogs-stream-prefix']) {
        logStreamPrefix = logOptions['awslogs-stream-prefix'];
    }
    const overrideCommand = typeof command === 'function' ? command(selected) : command;
    const runResp = await ecsClient.send(new RunTaskCommand({
        cluster,
        taskDefinition: targetTaskDef,
        launchType: 'FARGATE',
        networkConfiguration: { awsvpcConfiguration: { subnets, securityGroups, assignPublicIp } },
        startedBy,
        overrides: { containerOverrides: [{ name: containerName, command: overrideCommand }] },
    }));
    taskArn = runResp.tasks?.[0]?.taskArn || null;
    if (!taskArn || (runResp.failures || []).length > 0) {
        const failureReason = runResp.failures?.[0]?.reason || 'no task ARN returned';
        taskArn = null;
        return { ok: false, code: 'RUN_TASK_FAILED', reason: failureReason };
    }
    const taskId = taskArn.split('/').pop();
    const logStreamName = buildLogStreamName(containerName, taskId, logStreamPrefix);
    const seen = new Set();

    // Registered immediately so Ctrl+C aborts even while provisioning;
    // the task line itself prints once the spinner stops (below) so the
    // two never share a terminal line.
    process.once('SIGINT', onSigint);

    let finalTask = null;
    let streaming = false;
    let lastPhase = null;
    const shortTaskId = taskId.slice(0, 8);
    const phaseMessage = (status) => {
        if (status === 'PROVISIONING' || status === 'PENDING' || status === 'ACTIVATING') {
            return `Starting ${taskNoun} task (${status}, ${shortTaskId})...`;
        }
        return `Waiting on Fargate task (${status}, ${shortTaskId})...`;
    };
    // Strict by name only — never the containers[0] fallback: a sidecar
    // finishing first must not end the run early.
    const matchContainerStrict = (task) => {
        const list = task?.containers || [];
        return list.find((c) => c.name === containerName) || null;
    };
    try {
        const outcome = await pollUntil({
            intervalMs: pollIntervalMs,
            timeoutMs,
            onTick: async () => {
                await fetchNewLogEvents({ logsClient, logGroupName: groupName, logStreamName, seen });
                const descResp = await ecsClient.send(
                    new DescribeTasksCommand({ cluster, tasks: [taskArn] })
                );
                const task = (descResp.tasks || [])[0] || null;
                const status = task?.lastStatus;
                const match = matchContainerStrict(task);
                const containerDone = !!match
                    && match.lastStatus === 'STOPPED'
                    && typeof match.exitCode === 'number';
                if ((task && status === 'STOPPED') || containerDone) {
                    // Flush CloudWatch (retrying while nothing has printed
                    // yet: Fargate ingestion lags several seconds), then
                    // stop the task if Fargate has not already done so.
                    for (let attempt = 0; ; attempt++) {
                        await flushRemainingLogs({ logsClient, logGroupName: groupName, logStreamName, seen });
                        if (seen.size > 0 || attempt + 1 >= maxFlushPolls) break;
                        await sleep(flushIntervalMs);
                    }
                    if (task?.lastStatus !== 'STOPPED') {
                        try {
                            await ecsClient.send(new StopTaskCommand({
                                cluster,
                                task: taskArn,
                                reason: `${label} container finished; stopping task`,
                            }));
                        } catch {
                            // Best-effort: the result below is authoritative.
                        }
                    }
                    if (!streaming) spinner?.stop(`${label} task stopped.`);
                    return { done: true, value: task };
                }
                if (status === 'RUNNING' && !streaming) {
                    streaming = true;
                    spinner?.stop(color.green(`${label} container running. Streaming logs...`));
                    console.log(color.dim(`  task ${taskId} — press Ctrl+C to abort and stop the remote task.\n`));
                } else if (!streaming && status && status !== lastPhase) {
                    lastPhase = status;
                    spinner?.message(truncateSpinnerText(phaseMessage(status)));
                }
                return { done: false };
            },
        });
        if (outcome.timedOut) {
            try {
                await ecsClient.send(new StopTaskCommand({
                    cluster,
                    task: taskArn,
                    reason: `${label} timed out after ${timeoutSeconds}s`,
                }));
            } catch {
                // Best-effort: the timeout below is authoritative.
            }
            return { ok: false, code: 'TIMEOUT', taskArn };
        }
        finalTask = outcome.value;
    } finally {
        process.removeListener('SIGINT', onSigint);
    }

    const containers = finalTask?.containers || [];
    const match = containers.find((c) => c.name === containerName) || null;
    if (!match) {
        // Strict by name only — never the containers[0] fallback: a
        // sidecar's exit 0 must not masquerade as the named container's.
        return {
            ok: false,
            code: 'NAMED_CONTAINER_MISSING',
            taskArn,
            containerName,
            available: containers.map((c) => c.name),
            stoppedReason: finalTask?.stoppedReason || 'unknown',
        };
    }
    const exitCode = match.exitCode;
    const stoppedReason = match.reason || finalTask?.stoppedReason || 'unknown';
    return { ok: true, taskArn, exitCode, stoppedReason };
}

// Sniffs the URL scheme from discrete credentials. Explicit values win;
// when DB_ENGINE/DB_PORT are secrets-sourced (valueFrom, values unknown
// to the CLI) the reference text is sniffed for engine/port hints
// instead. Indeterminate stays postgresql (back-compat).
function sniffRunnerScheme(entries, values) {
    const engine = values.get('DB_ENGINE');
    if (typeof engine === 'string' && engine !== '') {
        return /mysql|maria/i.test(engine) ? 'mysql' : 'postgresql';
    }
    const port = values.get('DB_PORT');
    if (typeof port === 'string' && port !== '') {
        return port === '3306' ? 'mysql' : 'postgresql';
    }
    const refs = entries.map((entry) => entry?.valueFrom).filter((ref) => typeof ref === 'string').join('\n');
    if (/mysql|maria|3306/i.test(refs)) return 'mysql';
    return 'postgresql';
}

// Runtime userinfo encoder for the synthesized URL: node sees
// only shell references, never the values, so the encoding ladder ships
// inside the script — node (encodeURIComponent) → sed (the URL-breaking
// subset: %, ?, #, @, :, /) → warned raw. Quoting alone cannot save a
// `?` or `#` in the password: the URL parser (not the shell) is what
// breaks, so the shell refs must be encoded, not quoted.
function buildEncodedUrlExport({ scheme, defaultPort, defaultName }) {
    const nodeEncode = `node -e 'var s="${scheme}",a=process.argv.slice(1);console.log(s+"://"+encodeURIComponent(a[0])+":"+encodeURIComponent(a[1])+"@"+a[2]+":"+a[3]+"/"+a[4])' "$_u" "$_p" "$_h" "$_o" "$_n"`;
    const sedEncode = `printf '${scheme}://%s:%s@%s:%s/%s' "$(_grada_enc "$_u")" "$(_grada_enc "$_p")" "$_h" "$_o" "$_n"`;
    const rawEncode = `printf '${scheme}://%s:%s@%s:%s/%s' "$_u" "$_p" "$_h" "$_o" "$_n"`;
    return `_grada_db_url() { _u="\${DB_USER}"; _p="\${DB_PASSWORD}"; _h="\${DB_HOST}"; _o="\${DB_PORT:-${defaultPort}}"; _n="\${DB_NAME:-${defaultName}}"; `
        + `if command -v node >/dev/null 2>&1; then ${nodeEncode}; `
        + `elif command -v sed >/dev/null 2>&1; then _grada_enc() { printf '%s' "$1" | sed -e 's/%/%25/g' -e 's/?/%3F/g' -e 's/#/%23/g' -e 's/@/%40/g' -e 's/:/%3A/g' -e 's|/|%2F|g'; }; ${sedEncode}; `
        + `else echo "grada: warning: DATABASE_URL built without userinfo encoding (no node or sed in image)" >&2; ${rawEncode}; fi; }; `
        + `if [ -z "\${DATABASE_URL:-}" ]; then export DATABASE_URL="$(_grada_db_url)"; fi`;
}

// Builds the container override command for an ephemeral runner task. When
// the task definition provides discrete `DB_*` credentials but no
// `DATABASE_URL`, the command exports a runtime-synthesized URL (from the
// container's own environment, so secrets never cross the RunTask API
// call) before running the user's command. Pure and unit-tested.
export function buildRunnerCommand(resolvedCmd, containerDef) {
    const cmd = String(resolvedCmd ?? '');
    const environment = Array.isArray(containerDef?.environment) ? containerDef.environment : [];
    const secrets = Array.isArray(containerDef?.secrets) ? containerDef.secrets : [];
    const entries = [...environment, ...secrets];
    const names = new Set(entries.map((entry) => entry?.name));
    if (names.has('DATABASE_URL')) return ['sh', '-c', cmd];
    if (!names.has('DB_HOST') || !names.has('DB_USER') || !names.has('DB_PASSWORD')) {
        return ['sh', '-c', cmd];
    }
    const values = new Map(entries.map((entry) => [entry?.name, entry?.value]));
    const scheme = sniffRunnerScheme(entries, values);
    // RDS/Aurora enforces `rds.force_ssl = 1` by default: require TLS for
    // synthesized postgres URLs so libpq-based migrations never fail on a
    // plaintext connection (MySQL clients ignore PGSSLMODE; leave them alone).
    const tlsPrefix = scheme === 'postgresql' ? 'export PGSSLMODE="${PGSSLMODE:-require}"; ' : '';
    const urlExport = buildEncodedUrlExport({
        scheme,
        defaultPort: scheme === 'mysql' ? '3306' : '5432',
        defaultName: scheme === 'mysql' ? 'mysql' : 'postgres',
    });
    return ['sh', '-c', `${tlsPrefix}${urlExport}; ${cmd}`];
}

// Validates `--timeout` for ephemeral-runner commands (`db migrate`,
// `run`): returns the seconds on success, or the failCommand result
// (printed, tracked, and exited) when invalid. Callers branch on
// `typeof result !== 'number'`.
export async function parseRunnerTimeout(timeoutRaw, defaultSeconds, { event, telemetry = {}, resultExtra = {} } = {}) {
    const timeoutSeconds = parseTimeoutSeconds(timeoutRaw, defaultSeconds);
    if (timeoutSeconds !== null) return timeoutSeconds;
    return failCommand({
        message: `\n✖ Invalid --timeout "${timeoutRaw}". Use a positive number of seconds (default ${defaultSeconds}).\n`,
        event,
        telemetry,
        errorCode: 'INVALID_TIMEOUT',
        reason: 'invalid-timeout',
        resultExtra,
    });
}

// Stripped-runner guard for ephemeral-runner commands: Grada's
// node-family images remove npm/npx/yarn from the runner stage, so an
// npm-shim command is a guaranteed `command not found` inside the task.
// Fail fast headless; warn loudly (and proceed) interactively. Fail-open
// when no Dockerfile is present — nothing to prove breakage against.
// Returns null to proceed, or the failCommand result when refusing.
export async function guardNpmStrippedRunner({
    resolvedCmd, cwd, headless, event, telemetry = {}, resultExtra = {},
    nodeExample = 'node ./dist/migrate.cjs',
}) {
    if (!isNpmShimCommand(resolvedCmd) || !dockerfileStripsNpmShims(readFileSafe(path.join(cwd, 'Dockerfile')))) {
        return null;
    }
    const ormHint = ormMappedHintSegment(cwd, '--cmd ');
    if (headless) {
        return failCommand({
            message: `\n✖ Refusing to run "${resolvedCmd}": your Dockerfile strips npm/npx from the runner image, so this command would fail with "command not found" inside the task.\n`,
            hint: `  Bundle a framework-compiled runner instead and re-run with an explicit node-based command, e.g. --cmd "${nodeExample}". Ensure your Dockerfile builds the bundle and copies it into the runner image${ormHint}.\n`,
            event,
            telemetry: { ...telemetry, error_code: 'NPM_CMD_STRIPPED_RUNNER' },
            errorCode: 'NPM_CMD_STRIPPED_RUNNER',
            reason: 'npm-cmd-stripped-runner',
            resultExtra,
        });
    }
    console.log(color.yellow(`⚠️  "${resolvedCmd}" starts with npm/npx but your Dockerfile strips those binaries from the runner image — this will fail with "command not found" unless you switch to a node-based command (e.g. "${nodeExample}"). Ensure your Dockerfile builds the bundle and copies it into the runner image.${ormHint}`));
    trackEvent('npm_cmd_stripped_runner', { ...telemetry });
    return null;
}

// Maps a runEphemeralEcsTask outcome to the caller's terminal result:
// stops the spinner with command-specific wording, prints, tracks, and
// exits via failCommand — or records success and returns the success
// object. `label` names the finished unit ("Migration succeeded."),
// `taskPhrase` names the placed unit ("the migration task cannot be
// placed"). Callers return this result directly.
export async function reportRunnerOutcome({
    outcome, spinner: s, event, telemetry = {},
    cluster, service, region,
    containerName, label, taskPhrase,
    timeoutSeconds, timeoutCode, timeoutReason,
    taskFailedCode, taskFailedReason,
}) {
    const resultExtra = { cluster, service, region };

    if (!outcome.ok && outcome.code === 'ECS_SERVICE_NOT_FOUND') {
        s.stop(color.yellow('Service not found.'));
        return failCommand({
            print: () => {
                console.log(`\n  The ECS service ${color.cyan(service)} does not exist or is inactive.`);
                console.log(`  Run ${color.green('npx grada-run apply')} to provision your infrastructure.\n`);
            },
            event,
            telemetry,
            errorCode: 'ECS_SERVICE_NOT_FOUND',
            reason: 'ecs-service-not-found',
            resultExtra,
        });
    }

    if (!outcome.ok && outcome.code === 'NO_VPC_CONFIG') {
        s.stop(color.red('Service has no VPC configuration.'));
        return failCommand({
            message: `\n✖ The ECS service ${color.cyan(service)} has no VPC network configuration, so the ${taskPhrase} cannot be placed.\n`,
            event,
            telemetry,
            errorCode: 'RUN_TASK_FAILED',
            reason: 'run-task-failed',
            resultExtra,
        });
    }

    if (!outcome.ok && outcome.code === 'CONTAINER_NOT_FOUND') {
        s.stop(color.red('Container not found.'));
        return failCommand({
            message: `\n✖ Container "${containerName}" does not exist in task definition "${outcome.targetTaskDef}".\n`,
            hint: `Override with --container <name>. Available: ${outcome.available.join(', ') || 'none'}\n`,
            event,
            telemetry,
            errorCode: 'CONTAINER_NOT_FOUND',
            reason: 'container-not-found',
            resultExtra,
        });
    }

    if (!outcome.ok && outcome.code === 'RUN_TASK_FAILED') {
        s.stop(color.red(`Failed to start ${taskPhrase}.`));
        return failCommand({
            message: `\n✖ ECS could not start the ${taskPhrase}: ${outcome.reason}.\n`,
            event,
            telemetry,
            errorCode: 'RUN_TASK_FAILED',
            reason: 'run-task-failed',
            resultExtra,
        });
    }
    if (!outcome.ok && outcome.code === 'NAMED_CONTAINER_MISSING') {
        return failNamedContainerMissing({
            spinner: s, outcome, cluster, service, region,
            event,
            telemetry,
            noun: label,
        });
    }
    if (!outcome.ok && outcome.code === 'TIMEOUT') {
        try { s.stop(color.yellow(`${label} timed out.`)); } catch { /* already stopped */ }
        return failCommand({
            message: `\n✖ ${label} timed out after ${timeoutSeconds}s. The task was stopped (best-effort); increase --timeout and retry.\n`,
            event,
            telemetry,
            errorCode: timeoutCode,
            reason: timeoutReason,
            resultExtra: { ...resultExtra, taskArn: outcome.taskArn },
        });
    }

    const exitCode = outcome.exitCode;
    const stoppedReason = outcome.stoppedReason;
    if (exitCode === 0) {
        // Owner pairs its own start/stop: the runner usually stops
        // first (idempotent no-op then), but success must never
        // depend on a callee for the spinner lifecycle.
        try { s.stop(color.green(`${label} succeeded.`)); } catch { /* already stopped */ }
        console.log(color.green(`\n✅ ${label} succeeded.`));
        await trackSuccess(event, { ...telemetry });
        outro(color.green('Done.'));
        return { ok: true, success: true, exitCode: 0, taskArn: outcome.taskArn };
    }
    const propagated = (typeof exitCode === 'number' && exitCode > 0) ? exitCode : 1;
    // The ECS stopped reason is the only diagnosis PostHog gets for a
    // failed task (exit codes alone can't distinguish image-pull from
    // command-not-found from task errors) — stamp it.
    const failureDetail = `${label} failed with exit code ${exitCode ?? 'unknown'}: ${stoppedReason}`;
    return failCommand({
        message: `\n✖ ${failureDetail}.\n`,
        event,
        telemetry,
        errorCode: taskFailedCode,
        extra: { exit_code: exitCode ?? -1, error_message: failureDetail },
        reason: taskFailedReason,
        resultExtra: { ...resultExtra, taskArn: outcome.taskArn },
        exitCode: propagated,
    });
}
