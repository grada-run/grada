import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import color from 'picocolors';
import { classifyTerraformError } from './terraform-errors.js';
import { SLEEP_STATE_DIRNAME } from './sleep-state.js';

export const LAST_RUN_FILENAME = 'last-run.json';
// Generous per-phase ceiling: CloudFront teardown and Aurora provisioning
// legitimately take 15–20 minutes. Callers that need no ceiling pass
// timeoutMs: 0 explicitly.
export const DEFAULT_TERRAFORM_PHASE_TIMEOUT_MS = 30 * 60 * 1000;

export function lastRunMarkerPath(markerDir) {
    return path.join(markerDir, SLEEP_STATE_DIRNAME, LAST_RUN_FILENAME);
}

// Persists the lifecycle marker so a later apply/doctor can report an
// interrupted run. Marker writes must never break provisioning — every
// failure here degrades silently.
function writeMarker(markerDir, marker) {
    if (!markerDir) return;
    try {
        const markerPath = lastRunMarkerPath(markerDir);
        fs.mkdirSync(path.dirname(markerPath), { recursive: true });
        fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    } catch {
        // Telemetry-side state only; the terraform run owns the outcome.
    }
}

// Reads the last-run marker, or null when no run was recorded (or the
// marker is unreadable — a corrupt marker never blocks a new run).
export function readLastRunMarker(markerDir) {
    if (!markerDir) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(lastRunMarkerPath(markerDir), 'utf8'));
        if (parsed && typeof parsed === 'object') return parsed;
    } catch {
        // Fall through to null below.
    }
    return null;
}

// True when the marker describes a run that never settled: an explicit
// interrupt, or a `running` marker left behind by a killed process.
export function isInterruptedMarker(marker) {
    if (!marker || typeof marker !== 'object') return false;
    return marker.status === 'interrupted' || marker.status === 'running';
}

// Terraform summary lines worth pinning in the spinner even when later
// output would otherwise replace them.
const SUMMARY_LINE_RE = /^(Plan:|Apply complete!|Destroy complete!|No changes\.)/;

// Runs a terraform command while piping the latest stdout line into a
// @clack spinner. Resolves on exit 0; rejects with a structured error
// (`{ code, stderr, lockId? }` classified via terraform-errors.js)
// otherwise.
//
// The runner owns the child lifecycle: SIGINT/SIGTERM forward to the
// child (a second SIGINT escalates to SIGKILL, per Terraform
// convention), an optional phase timeout kills a wedged child, and a
// last-run marker records running/completed/failed/interrupted for the
// next command to report. `onStdoutLine` observes raw lines (used by
// getTerraformOutputs); listeners and timers are always released.
//
// Progress display: a live terminal rewrites one spinner line, but the
// spinner re-renders every ~80ms — wherever cursor movement isn't
// honored (piped output, log viewers) each tick becomes a line and
// quiet stretches repeat the same message dozens of times. Non-TTY
// runs therefore get deduped plain lines instead, and the caller's
// spinner is cleared so its tick doesn't spam behind them (the
// caller's later stop then becomes a silent no-op). `isTTY` overrides
// the terminal sniff for tests.
export function runTerraformCommand(args, cwd, spin, loadingPrefix, options = {}) {
    const { markerDir = null, timeoutMs = 0, onStdoutLine = null, isTTY = process.stdout?.isTTY } = options || {};
    const wantsProgress = spin && typeof spin.message === 'function';
    const live = isTTY === true && wantsProgress;
    let lastEmitted;
    const emit = (text) => {
        if (lastEmitted === text) return;
        lastEmitted = text;
        if (live) spin.message(text);
        else if (wantsProgress) console.log(text);
    };
    if (wantsProgress && !live && typeof spin.clear === 'function') spin.clear();
    return new Promise((resolve, reject) => {
        const child = spawn('terraform', args, { cwd });
        let errorOutput = '';
        let isDone = false;
        let sigintCount = 0;
        let timer = null;

        const startedAt = new Date().toISOString();
        writeMarker(markerDir, {
            status: 'running',
            command: 'terraform',
            args: [...args],
            pid: child.pid ?? null,
            startedAt,
        });

        const cleanup = () => {
            process.removeListener('SIGINT', onSigint);
            process.removeListener('SIGTERM', onSigterm);
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
        };

        const settleMarker = (status, extra = {}) => {
            writeMarker(markerDir, {
                status,
                command: 'terraform',
                args: [...args],
                pid: child.pid ?? null,
                startedAt,
                finishedAt: new Date().toISOString(),
                ...extra,
            });
        };

        const fail = (error) => {
            if (isDone) return;
            isDone = true;
            cleanup();
            settleMarker('failed');
            reject(error);
        };

        function onSigint() {
            if (isDone) return;
            sigintCount += 1;
            if (sigintCount === 1) {
                try {
                    child.kill('SIGINT');
                } catch {
                    // The child may already be gone; the close handler settles.
                }
                writeMarker(markerDir, {
                    status: 'interrupted',
                    command: 'terraform',
                    args: [...args],
                    pid: child.pid ?? null,
                    startedAt,
                });
            } else {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // Already gone; the close handler settles.
                }
            }
        }

        function onSigterm() {
            if (isDone) return;
            try {
                child.kill('SIGTERM');
            } catch {
                // Already gone; the close handler settles.
            }
            writeMarker(markerDir, {
                status: 'interrupted',
                command: 'terraform',
                args: [...args],
                pid: child.pid ?? null,
                startedAt,
            });
        }

        // Persistent (counted) SIGINT so a second Ctrl+C escalates to
        // SIGKILL; both listeners are always removed on settle.
        process.on('SIGINT', onSigint);
        process.on('SIGTERM', onSigterm);

        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            timer = setTimeout(() => {
                if (isDone) return;
                try {
                    child.kill('SIGTERM');
                } catch {
                    // Already gone.
                }
                isDone = true;
                cleanup();
                settleMarker('failed', { reason: 'timeout' });
                const error = new Error(
                    `Terraform ${args[0] || 'command'} timed out after ${timeoutMs}ms — the child was signalled to stop.`
                );
                error.code = 'TERRAFORM_TIMEOUT';
                error.stderr = errorOutput;
                reject(error);
            }, timeoutMs);
            if (timer && typeof timer.unref === 'function') timer.unref();
        }

        child.stdout.on('data', (data) => {
            if (isDone) return;
            const lines = data.toString().split('\n').filter(line => line.trim() !== '');
            if (typeof onStdoutLine === 'function') {
                for (const line of lines) onStdoutLine(line);
            }
            for (const line of lines) {
                const trimmed = line.trim();
                if (SUMMARY_LINE_RE.test(trimmed)) {
                    emit(`${loadingPrefix} - ${color.dim(trimmed)}`);
                }
            }
            if (lines.length > 0) {
                const latestLine = lines[lines.length - 1].trim();
                const display = latestLine.length > 120 ? latestLine.substring(0, 117) + '...' : latestLine;
                emit(`${loadingPrefix} - ${color.dim(display)}`);
            }
        });

        child.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        child.on('close', (code) => {
            if (isDone) return;
            isDone = true;
            cleanup();
            if (code === 0) {
                settleMarker('completed', { exitCode: code });
                resolve();
            } else {
                settleMarker('failed', { exitCode: code });
                const classified = classifyTerraformError(errorOutput);
                const error = new Error(errorOutput || `Terraform exited with code ${code}`);
                error.stderr = errorOutput;
                if (classified) {
                    error.code = classified.code;
                    if (classified.lockId) error.lockId = classified.lockId;
                }
                reject(error);
            }
        });

        child.on('error', (err) => {
            fail(err);
        });
    });
}

// Shared init preflight: no terraform verb except init runs first.
// `runTerraform` is the caller's runner (real command or injected mock).
// Upgrade defaults on for apply-style flows; destroy passes it off.
export async function ensureTerraformInit(tfDir, runTerraform, spin, options = {}) {
    const { upgrade = true, prefix = 'Initializing', lifecycleOpts = undefined } = options || {};
    const args = upgrade ? ['init', '-upgrade'] : ['init'];
    await runTerraform(args, tfDir, spin, prefix, lifecycleOpts);
}

// Pulls JSON outputs from Terraform. Never throws: unparseable output,
// non-zero exit, and spawn errors all resolve to an empty object.
export async function getTerraformOutputs(cwd) {
    let outputData = '';
    try {
        await runTerraformCommand(['output', '-json'], cwd, null, 'Reading outputs', {
            onStdoutLine: (line) => {
                outputData += `${line}\n`;
            },
        });
    } catch {
        return {};
    }
    try {
        return JSON.parse(outputData);
    } catch {
        return {};
    }
}

// Lists S3 bucket names Terraform manages (pre-destroy drain input).
// Parses `terraform show -json`, walking root + child modules for
// aws_s3_bucket resources. Never throws: unreadable state resolves to
// [] — either nothing is deployed, or destroy fails authoritatively
// on the next step anyway.
export async function getTerraformStateBuckets(cwd) {
    let outputData = '';
    try {
        await runTerraformCommand(['show', '-json'], cwd, null, 'Reading state', {
            onStdoutLine: (line) => {
                outputData += `${line}\n`;
            },
        });
    } catch {
        return [];
    }
    let parsed;
    try {
        parsed = JSON.parse(outputData);
    } catch {
        return [];
    }
    const buckets = [];
    const collectBuckets = (module) => {
        for (const resource of module?.resources || []) {
            if (resource?.type !== 'aws_s3_bucket') continue;
            const name = resource.values?.bucket || resource.values?.id;
            if (typeof name === 'string' && name !== '' && !buckets.includes(name)) buckets.push(name);
        }
        for (const child of module?.child_modules || []) collectBuckets(child);
    };
    collectBuckets(parsed?.values?.root_module);
    return buckets;
}

// Per-target outputs contract: the keys a healthy apply must return.
// Checked by apply's step 7 — a fully-empty map fails loud (partial
// state), missing keys warn (conservative start to avoid false
// positives on customized trees).
export const EXPECTED_OUTPUT_KEYS = {
    ecs: ['alb_direct_url', 'ecr_repository_url'],
    lambda: ['api_gateway_url', 'ecr_repository_url'],
    static: ['site_url'],
};

// Pure contract check over an outputs map: `{ empty, missing, expected,
// got }`. Unknown targets expect nothing (vacuously satisfied).
export function checkOutputsContract(outputs, computeTarget) {
    const expected = EXPECTED_OUTPUT_KEYS[computeTarget] ?? [];
    const got = outputs && typeof outputs === 'object' && !Array.isArray(outputs)
        ? Object.keys(outputs)
        : [];
    return {
        empty: got.length === 0,
        missing: expected.filter((key) => !got.includes(key)),
        expected,
        got,
    };
}
