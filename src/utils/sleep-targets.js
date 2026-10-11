import fsSync from 'fs';
import path from 'path';
import { withProjectLock } from './file-lock.js';
import { readResourceSuffix } from './resolvers.js';

// Auxiliary sleep/wake targets driven through the AWS CLI: EventBridge
// Scheduler pause/resume and ECS Application Auto Scaling suspend/resume.
// The repo has no @aws-sdk/client-scheduler or
// @aws-sdk/client-application-auto-scaling dependency, and `doctor`
// already requires the AWS CLI — so these helpers shell out through an
// injectable `run` (spawnSync-shaped, mirroring drift.js `spawnSyncImpl`)
// instead of adding new npm packages. Every helper degrades to a skip
// reason; callers warn and continue so sleep/wake never fail on these.

// cron.tf renders `name = "${local.app_name}-cron-<slug>"` inside the
// schedule block. Resolves the live schedule name for an app prefix, or
// null when cron isn't configured (or the file was hand-edited past
// recognition). Scoped to the schedule block: the IAM role/policy above
// share the `-cron-` prefix, and an unscoped first match resolves
// `-cron-scheduler-role` — pausing a schedule that doesn't exist while
// the real one keeps firing (and Terraform plans ENABLED -> DISABLED).
export function readCronScheduleName(cwd, appPrefix) {
    let content;
    try {
        content = fsSync.readFileSync(path.join(cwd, 'terraform', 'cron.tf'), 'utf8');
    } catch {
        return null;
    }
    const blockStart = content.indexOf('resource "aws_scheduler_schedule"');
    if (blockStart < 0) return null;
    const match = /name\s*=\s*"\$\{local\.app_name\}-cron-([A-Za-z0-9-]+)"/.exec(content.slice(blockStart));
    if (!match) return null;
    return `${appPrefix}${readResourceSuffix(cwd)}-cron-${match[1]}`;
}

export function hasCronAddon(cwd) {
    return fsSync.existsSync(path.join(cwd, 'terraform', 'cron.tf'));
}

// The SQS queue-depth scaling target exists only when the queue addon was
// scaffolded alongside a worker service.
export function hasSqsWorkerScaling(cwd) {
    return fsSync.existsSync(path.join(cwd, 'terraform', 'sqs.tf'))
        && fsSync.existsSync(path.join(cwd, 'terraform', 'worker.tf'));
}

export function hasRedisAddon(cwd) {
    return fsSync.existsSync(path.join(cwd, 'terraform', 'redis.tf'));
}

// Scaffold files younger than this are treated as a write still in
// flight (racing or crashed `add`), not a settled tree.
export const SCAFFOLD_FRESHNESS_MS = 15000;

// Every scaffold file sleep consults. main.tf is deliberately excluded:
// init always leaves it fresh, and db-addon races are caught by the
// lock probe below instead.
const SCAFFOLD_FILES = ['cron.tf', 'sqs.tf', 'worker.tf', 'redis.tf'];

// Detects an unfinished addon scaffold before sleep records a ledger for
// half-built IaC. Returns null when the tree is settled, otherwise
// `{ detail, telemetry }` with `telemetry.trigger` of `lock-held` |
// `fresh-file` | `unparseable-file`. Stale locks are taken over (crashed
// holders), never reported.
export async function detectScaffoldingInProgress(cwd, { nowMs = Date.now(), freshnessMs = SCAFFOLD_FRESHNESS_MS } = {}) {
    for (const scope of ['project', 'terraform']) {
        try {
            await withProjectLock(cwd, async () => {}, { scope, timeoutMs: 0 });
        } catch (error) {
            if (error?.code === 'FILE_LOCK_TIMEOUT') {
                return {
                    detail: `another grada command holds the ${scope} lock`,
                    telemetry: { trigger: 'lock-held', scope },
                };
            }
            throw error;
        }
    }
    for (const file of SCAFFOLD_FILES) {
        let stat = null;
        try {
            stat = fsSync.statSync(path.join(cwd, 'terraform', file));
        } catch {
            continue;
        }
        const ageMs = Math.max(0, nowMs - stat.mtimeMs);
        if (ageMs < freshnessMs) {
            return {
                detail: `terraform/${file} changed ${Math.max(1, Math.round(ageMs / 1000))}s ago`,
                telemetry: { trigger: 'fresh-file', file, age_ms: ageMs },
            };
        }
    }
    // Settled but unparseable: a crash mid-scaffold (or a hand edit past
    // recognition). Reported, never skipped silently.
    if (hasCronAddon(cwd) && !readCronScheduleName(cwd, 'probe')) {
        return {
            detail: 'terraform/cron.tf exists but its schedule name is unreadable',
            telemetry: { trigger: 'unparseable-file', file: 'cron.tf' },
        };
    }
    return null;
}

function tailLines(output, count = 5) {
    return String(output ?? '').split('\n').slice(-count).join('\n').trim();
}

// Fetches the full schedule document. Never throws: missing CLI,
// undeployed schedules, and parse failures all return skip reasons.
export function getSchedulerSchedule({ name, region, run }) {
    const res = run('aws', [
        'scheduler', 'get-schedule',
        '--name', name,
        '--region', region,
        '--output', 'json',
    ], { encoding: 'utf8' });
    if (res?.error?.code === 'ENOENT') return { ok: false, reason: 'cli-missing' };
    if (res?.status !== 0) {
        const detail = tailLines(res?.stderr || res?.stdout);
        if (/ResourceNotFound/i.test(detail)) return { ok: false, reason: 'not-deployed' };
        return { ok: false, reason: 'get-failed', detail };
    }
    try {
        return { ok: true, schedule: JSON.parse(res.stdout) };
    } catch {
        return { ok: false, reason: 'bad-response' };
    }
}

// UpdateSchedule is a full PUT replacement: the fetched document is passed
// back with only State flipped. Get-only fields (Arn, CreationDate,
// LastModificationDate) are dropped so --cli-input-json validates.
export function setSchedulerState({ name, enabled, region, run }) {
    const got = getSchedulerSchedule({ name, region, run });
    if (!got.ok) return got;
    const desired = enabled ? 'ENABLED' : 'DISABLED';
    if (got.schedule?.State === desired) return { ok: true, skipped: 'already' };
    const s = got.schedule;
    const payload = { Name: name, State: desired };
    for (const key of ['GroupName', 'ScheduleExpression', 'ScheduleExpressionTimezone',
        'FlexibleTimeWindow', 'Target', 'Description', 'StartDate', 'EndDate',
        'ActionAfterCompletion', 'KmsKeyArn']) {
        if (s[key] !== undefined && s[key] !== null) payload[key] = s[key];
    }
    const res = run('aws', [
        'scheduler', 'update-schedule',
        '--cli-input-json', JSON.stringify(payload),
        '--region', region,
        '--output', 'json',
    ], { encoding: 'utf8' });
    if (res?.error?.code === 'ENOENT') return { ok: false, reason: 'cli-missing' };
    if (res?.status !== 0) return { ok: false, reason: 'update-failed', detail: tailLines(res?.stderr || res?.stdout) };
    return { ok: true };
}

export function scalableTargetId(cluster, service) {
    return `service/${cluster}/${service}`;
}

// Suspends (sleep) or resumes (wake) worker auto-scaling. Min/max capacity
// are omitted so a registered target keeps its limits; unregistered
// targets (sqs.tf rendered while workerless) skip quietly.
export function setWorkerScalingSuspended({ cluster, service, suspended, region, run }) {
    const resourceId = scalableTargetId(cluster, service);
    const described = run('aws', [
        'application-autoscaling', 'describe-scalable-targets',
        '--service-namespace', 'ecs',
        '--resource-ids', resourceId,
        '--region', region,
        '--output', 'json',
    ], { encoding: 'utf8' });
    if (described?.error?.code === 'ENOENT') return { ok: false, reason: 'cli-missing' };
    if (described?.status !== 0) {
        return { ok: false, reason: 'describe-failed', detail: tailLines(described?.stderr || described?.stdout) };
    }
    let targets = [];
    try {
        targets = JSON.parse(described.stdout || '{}').ScalableTargets || [];
    } catch {
        return { ok: false, reason: 'bad-response' };
    }
    if (targets.length === 0) return { ok: false, reason: 'not-registered' };
    const state = targets[0].SuspendedState || {};
    const already = suspended
        ? state.DynamicScalingInSuspended === true && state.DynamicScalingOutSuspended === true && state.ScheduledScalingSuspended === true
        : state.DynamicScalingInSuspended !== true && state.DynamicScalingOutSuspended !== true && state.ScheduledScalingSuspended !== true;
    if (already) return { ok: true, skipped: 'already' };
    const v = suspended ? 'true' : 'false';
    const res = run('aws', [
        'application-autoscaling', 'register-scalable-target',
        '--service-namespace', 'ecs',
        '--scalable-dimension', 'ecs:service:DesiredCount',
        '--resource-id', resourceId,
        '--suspended-state', `DynamicScalingInSuspended=${v},DynamicScalingOutSuspended=${v},ScheduledScalingSuspended=${v}`,
        '--region', region,
    ], { encoding: 'utf8' });
    if (res?.error?.code === 'ENOENT') return { ok: false, reason: 'cli-missing' };
    if (res?.status !== 0) return { ok: false, reason: 'update-failed', detail: tailLines(res?.stderr || res?.stdout) };
    return { ok: true };
}
