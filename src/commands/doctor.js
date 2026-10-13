import fs from 'fs';
import path from 'path';
import { intro, outro, spinner } from '@clack/prompts';
import color from 'picocolors';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { checkDependency } from '../utils/system.js';
import { checkAwsCredentials, TROUBLESHOOTING_URL } from '../utils/aws.js';
import { readLastRunMarker, isInterruptedMarker } from '../utils/terraform.js';
import { readTerraformOidcTrust } from '../utils/resolvers.js';
import { parseStateBucketBackend } from '../utils/terraform-metadata.js';
import { normalizeOptions, parseFlags, normalizeArgv } from '../utils/args.js';
import { trackEvent, flushTelemetry, detectCiProvider, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';

// Checks are data: `{ id, label, scope, severity, run, hint }`.
// - scope `toolchain` always runs; scope `project` runs only inside a
//   grada project (terraform/ present), otherwise reported as skipped.
// - severity `fail` flips the verdict red; `warn` prints yellow and only
//   flips its own telemetry flag (the aws_cli downgrade pattern).
// - run(ctx) resolves to a boolean or `{ ok, skipped?, detailLines? }`
//   and must never throw (runCheckSafe degrades throws to red).
// Only the stable IDs below ever reach telemetry — never paths,
// identities, bucket names, holder info, or error text.
export const DOCTOR_CHECKS = [
    { id: 'terraform', label: 'Terraform', scope: 'toolchain', severity: 'fail', run: () => dedupedCheckDependency('terraform'), hint: (platform) => installHint('terraform', platform) },
    { id: 'aws_cli', label: 'AWS CLI', scope: 'toolchain', severity: 'fail', run: () => dedupedCheckDependency('aws'), hint: (platform) => installHint('aws_cli', platform) },
    { id: 'aws_auth', label: 'AWS Credentials', scope: 'toolchain', severity: 'fail', run: () => checkAwsAuthSafe(), hint: () => installHint('aws_auth') },
    { id: 'docker', label: 'Docker', scope: 'toolchain', severity: 'fail', run: () => dedupedCheckDependency('docker'), hint: (platform) => installHint('docker', platform) },
    { id: 'git', label: 'Git', scope: 'toolchain', severity: 'fail', run: () => dedupedCheckDependency('git'), hint: (platform) => installHint('git', platform) },
];

export const PROJECT_CHECKS = [
    { id: 'state_lock', label: 'Terraform state lock', scope: 'project', severity: 'fail', run: checkStateLock, hint: () => 'If no apply is running, release it with: terraform force-unlock <lock-id> (find the holder via grada doctor --deep).' },
    { id: 'interrupted_run', label: 'Interrupted Terraform run', scope: 'project', severity: 'warn', run: checkInterruptedRun, hint: () => 'Review the last apply/destroy output before trusting applied state; the next run overwrites the marker.' },
    { id: 'oidc_trust_scope', label: 'OIDC trust scope', scope: 'project', severity: 'warn', run: checkOidcTrustScope, hint: () => 'Re-scope with: npx grada-run init --github-repo owner/name (or edit the sub claim in terraform/oidc.tf).' },
];

const INSTALL_HINTS = {
    terraform: {
        default: 'Install via Homebrew: brew install terraform',
        linux: 'Install via the HashiCorp apt repo: https://developer.hashicorp.com/terraform/install',
        win32: 'Install via winget: winget install Hashicorp.Terraform',
    },
    aws_cli: {
        default: 'Install via Homebrew: brew install awscli',
        linux: 'Install AWS CLI v2 for Linux: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
        win32: 'Install via winget: winget install Amazon.AWSCLI',
    },
    docker: {
        default: 'Install via Homebrew: brew install docker',
        linux: 'Install Docker Engine for your distro: https://docs.docker.com/engine/install/',
        win32: 'Install via winget: winget install Docker.DockerDesktop',
    },
    git: {
        default: 'Install via Homebrew: brew install git',
        linux: 'Install via your package manager: sudo apt-get install -y git (Debian/Ubuntu) or sudo dnf install -y git (RHEL/Fedora)',
        win32: 'Install via winget: winget install Git.Git',
    },
    // Platform-independent: expired SSO tokens and missing profiles fail
    // identically everywhere, and the recovery is the same CLI command.
    // Points at the credentials guide like every other auth failure does.
    aws_auth: {
        default: `Your AWS credentials are expired or missing. Run \`aws sso login\` or \`aws configure\` to refresh them. Guide: ${TROUBLESHOOTING_URL}`,
    },
};

export function installHint(checkId, platform = process.platform) {
    const hints = INSTALL_HINTS[checkId];
    if (!hints) return '';
    if (platform === 'linux' && hints.linux) return hints.linux;
    if (platform === 'win32' && hints.win32) return hints.win32;
    return hints.default;
}

const CI_HINTS = {
    terraform: '💡 Hint: Running in CI? Ensure Terraform is installed (e.g., via `hashicorp/setup-terraform` in GitHub Actions).',
    aws_cli: '💡 Hint: Running in CI? Ensure the AWS CLI is installed and credentials are configured.',
    aws_auth: '💡 Hint: Running in CI? Ensure AWS credentials are configured (e.g., via `aws-actions/configure-aws-credentials`).',
};

// CI-specific guidance for failed checks. Only Terraform and AWS CLI have
// CI hints; anything else — or a non-CI environment — returns ''.
export function ciHint(checkId, env = process.env) {
    if (!env.CI) return '';
    return CI_HINTS[checkId] || '';
}

// Deduplicates concurrent in-flight binary checks by binary name so parallel
// runDoctor() invocations share child processes instead of multiplying them.
// Entries are removed on settle, so sequential calls always run fresh checks.
const inFlightChecks = new Map();

function dedupedCheckDependency(binary) {
    if (!inFlightChecks.has(binary)) {
        inFlightChecks.set(
            binary,
            checkDependency(binary).finally(() => {
                inFlightChecks.delete(binary);
            })
        );
    }
    return inFlightChecks.get(binary);
}

// Ceiling for the live credential probe. Enterprise SSO wrappers
// (credential_process helpers, blackholed IMDS endpoints) can hang the
// SDK's credential chain indefinitely — the race below converts any such
// hang into a clean `false` instead of a wedged `doctor` run.
export const AWS_AUTH_TIMEOUT_MS = 15000;

// SDK equivalent of `aws sts get-caller-identity`: ok only when active,
// valid credentials resolve (honors CI_MOCK_AWS like every other caller).
// Never throws, never hangs past AWS_AUTH_TIMEOUT_MS, and never surfaces
// identity or error text — missing credentials, EACCES, and even
// non-Error rejections collapse to ok:false, while a hung credential
// chain additionally reports timedOut:true so telemetry can tell "no
// credentials" apart from "the SDK hung" (IMDS blackholes, SSO wrappers).
async function checkAwsAuthSafe(timeoutMs = AWS_AUTH_TIMEOUT_MS) {
    let timer = null;
    try {
        return await Promise.race([
            Promise.resolve()
                .then(() => checkAwsCredentials())
                .then(
                    () => ({ ok: true, timedOut: false }),
                    () => ({ ok: false, timedOut: false })
                ),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
                if (timer && typeof timer.unref === 'function') timer.unref();
            }),
        ]);
    } catch {
        return { ok: false, timedOut: false };
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

// Project check: a `.tflock` object in the state bucket means the next
// apply/destroy would fail on a held lock — report it instead of green.
// Skips (never fails) without a parseable backend or when the bucket is
// unreachable: missing credentials already fail aws_auth, and a missing
// bucket cannot hold a lock. Holder identity stays in stdout (and only
// under --deep — it costs an extra S3 read).
async function checkStateLock({ cwd, s3Client, deep }) {
    let backend = '';
    try {
        backend = fs.readFileSync(path.join(cwd, 'terraform', 'backend.tf'), 'utf8');
    } catch {
        return { ok: true, skipped: 'no backend.tf' };
    }
    const { bucket, region } = parseStateBucketBackend(backend);
    if (!bucket) return { ok: true, skipped: 'unparseable backend' };
    const keyMatch = backend.match(/key\s*=\s*"([^"]+)"/);
    const stateKey = keyMatch ? keyMatch[1] : 'terraform.tfstate';
    const client = s3Client ?? new S3Client({ region: region ?? 'us-east-2' });
    let contents;
    try {
        const resp = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: stateKey }));
        contents = resp.Contents || [];
    } catch (error) {
        if (error?.name === 'NoSuchBucket') return { ok: true, note: 'state bucket absent' };
        return { ok: true, skipped: 'state bucket unreachable' };
    }
    const lockKey = contents
        .map((entry) => entry.Key)
        .find((key) => typeof key === 'string' && key.endsWith('.tflock'));
    if (!lockKey) return { ok: true };
    const detailLines = [`Lock file ${lockKey} is present in the state bucket.`];
    if (deep) {
        try {
            const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: lockKey }));
            const text = typeof obj.Body?.transformToString === 'function'
                ? await obj.Body.transformToString()
                : '';
            const info = JSON.parse(text);
            const who = info.Who ?? info.who ?? 'unknown holder';
            const operation = info.Operation ?? info.operation ?? 'unknown operation';
            const created = info.Created ?? info.created ?? 'unknown time';
            detailLines.push(`Held by ${who} (${operation}, since ${created}).`);
        } catch {
            // The lock itself is the finding; holder detail is best-effort.
        }
    }
    return { ok: false, detailLines };
}

// Project check: a leftover interrupted/running marker means the last
// Terraform run never settled. Warning-grade (apply proceeds with its own
// warning): surfaces yellow without flipping the verdict red.
// Project check: an open `repo:*` OIDC trust lets any GitHub repo's
// Actions assume the deploy role. Warning-grade (pre-fix trees render it
// by default): surfaces yellow without flipping the verdict red.
function checkOidcTrustScope({ cwd }) {
    const trust = readTerraformOidcTrust(cwd);
    if (trust === null) return { ok: true, skipped: 'no oidc.tf trust found' };
    if (trust !== 'repo:*') return { ok: true };
    return {
        ok: false,
        detailLines: ['CI trust is open (repo:*): any repo\'s Actions can assume the deploy role — re-scope before going live.'],
    };
}

function checkInterruptedRun({ cwd }) {
    const marker = readLastRunMarker(cwd);
    if (!isInterruptedMarker(marker)) return { ok: true };
    const command = typeof marker.command === 'string' ? marker.command : 'terraform';
    const startedAt = typeof marker.startedAt === 'string' ? marker.startedAt : 'unknown time';
    return {
        ok: false,
        detailLines: [`Last ${command} run ${marker.status} at ${startedAt} — review before trusting applied state.`],
    };
}

export function parseDoctorArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'doctor') args.shift();
    const { options } = parseFlags(args, { boolean: ['deep'] });
    return { deep: false, ...options };
}

// One check that can neither throw nor reject: a synchronous spawn
// failure (or any future checkDependency regression) degrades to a red
// cell instead of rejecting the Promise.all and killing the run before
// telemetry compiles.
async function runCheckSafe(check, ctx) {
    try {
        const outcome = await check.run(ctx);
        if (outcome && typeof outcome === 'object' && !Array.isArray(outcome)) {
            return { ...check, ...outcome };
        }
        return { ...check, ok: outcome === true };
    } catch {
        return { ...check, ok: false };
    }
}

// A lone failure names itself: missing binaries as MISSING_<ID>, dead
// credentials as AWS_CLI_UNCONFIGURED, a held lock as STATE_LOCK_HELD.
// reason mirrors error_code in kebab-case per the failCommand/spec convention.
export function singleCheckFailure(checkId) {
    if (checkId === 'aws_auth') {
        return { error_code: 'AWS_CLI_UNCONFIGURED', reason: 'aws-cli-unconfigured' };
    }
    if (checkId === 'state_lock') {
        return { error_code: 'STATE_LOCK_HELD', reason: 'state-lock-held' };
    }
    return {
        error_code: `MISSING_${checkId.toUpperCase()}`,
        reason: `missing-${checkId.replace(/_/g, '-')}`,
    };
}

// Enterprise downgrade note: when the AWS CLI binary is missing but live
// SDK credentials resolve (SSO tools/wrappers without `aws` on PATH),
// doctor stays green — core provisioning works, only CLI-shell-out
// features (SSM tunnels) are unavailable.
export const AWS_CLI_DOWNGRADE_NOTE = 'AWS CLI is missing, but active AWS SDK credentials were found. Core deployments will work, but SSM tunnels (`grada db connect`, `grada exec`) will be unavailable until the AWS CLI is installed.';

const PROJECT_SKIPPED_NOTE = 'Project checks skipped (no terraform/ directory — run from a grada project to include state checks).';

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runDoctor(input = {}) {
    setActiveCommandName('doctor');
    try {
        return await runDoctorMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runDoctorMain(input = {}) {
    const options = normalizeOptions(input);
    const cwd = options.cwd ? path.resolve(String(options.cwd)) : process.cwd();
    const deep = options.deep === true || options.deep === 'true';
    const ctx = { cwd, s3Client: options.s3Client ?? null, deep };

    intro(color.bgCyan(color.black(' grada ☁️  ')));

    const startMs = Date.now();
    const s = spinner();
    s.start('Running pre-flight checks...');

    const results = await Promise.all(DOCTOR_CHECKS.map((check) => runCheckSafe(check, ctx)));

    // Project phase: runs only inside a grada project. A bare toolchain
    // run outside any project reports the skip instead of implying the
    // (unexamined) project is healthy.
    const projectSkipped = !fs.existsSync(path.join(cwd, 'terraform'));
    const projectResults = projectSkipped
        ? []
        : await Promise.all(PROJECT_CHECKS.map((check) => runCheckSafe(check, ctx)));

    s.stop('Pre-flight checks complete.\n');

    const printStatus = (result) => {
        const icon = result.ok ? color.green('✅') : color.red('❌');
        const message = result.ok ? `${result.label} (✓)` : `${result.label} (✗)`;
        console.log(`   ${icon} ${message}`);
        if (!result.ok) {
            console.log(`      ┌─ Try: ${color.dim(typeof result.hint === 'function' ? result.hint() : installHint(result.id))}`);
            const hint = ciHint(result.id);
            if (hint) {
                console.log(`      └─ ${hint}`);
            }
        }
    };

    const printSkipped = (result) => {
        console.log(`   ${color.dim('○')} ${color.dim(`${result.label} (skipped: ${result.skipped})`)}`);
    };

    const printWarning = (result) => {
        console.log(`   ${color.yellow('⚠️')} ${result.label} (⚠)`);
        for (const line of result.detailLines || []) {
            console.log(`      └─ ${color.dim(line)}`);
        }
    };

    const ranProject = projectResults.filter((result) => !result.skipped);
    const failedGrade = (result) => !result.ok && result.severity !== 'warn';
    const passedChecks = [...results, ...ranProject].filter((result) => result.ok).map((result) => result.id);
    const failedChecks = [...results, ...ranProject].filter((result) => !result.ok).map((result) => result.id);

    // Enterprise downgrade: a missing `aws` binary with live SDK credentials
    // is a warning, not a failure — the SDK path provisions fine. Applies
    // only when aws_cli is the SOLE failure; anything else failing alongside
    // keeps the red verdict. Telemetry keeps check_aws_cli: false (honest
    // per-check state) while success flips true.
    const awsAuthOk = results.some((check) => check.id === 'aws_auth' && check.ok);
    const cliDowngraded = failedChecks.length === 1 && failedChecks[0] === 'aws_cli' && awsAuthOk;
    const failGradeFailed = [...results, ...ranProject].some(failedGrade);
    const success = !failGradeFailed || cliDowngraded;

    // Two-section layout: host-machine toolchain first, then project state.
    // The grouping is load-bearing for readability — without it the skipped
    // project note reads as a trailing tool item and the lock/interrupted
    // lines read as host checks.
    console.log(color.bold('System Environment:'));
    for (const check of results) {
        if (check.id === 'aws_cli' && cliDowngraded) {
            console.log(`   ${color.yellow('⚠️')} ${check.label} (⚠)`);
            console.log(`      └─ ${color.dim(AWS_CLI_DOWNGRADE_NOTE)}`);
        } else {
            printStatus(check);
        }
    }

    console.log(color.bold('\nProject State:'));
    if (projectSkipped) {
        console.log(`   ${color.dim(`○ ${PROJECT_SKIPPED_NOTE}`)}`);
    } else {
        for (const result of projectResults) {
            if (result.skipped) {
                printSkipped(result);
            } else if (!result.ok && result.severity === 'warn') {
                printWarning(result);
            } else {
                printStatus(result);
                for (const line of result.detailLines || []) {
                    console.log(`      └─ ${color.dim(line)}`);
                }
            }
        }
    }

    if (success) {
        outro(projectSkipped
            ? color.green('System checks passed — project checks were skipped (no terraform/ directory found).')
            : color.green('Your system is 100% ready to provision and deploy! 🚀'));
    } else if (failedChecks.length === 1 && failedChecks[0] === 'aws_auth') {
        outro(color.yellow('Please refresh your AWS credentials before running the provisioning tool.'));
    } else {
        outro(color.yellow('Please install the missing dependencies before running the provisioning tool.'));
    }

    // Per-check booleans on every run so PostHog can slice green runs by
    // individual check health (repeated green `doctor` runs that precede
    // failures elsewhere become visible). Keys derive from the stable
    // check ids — never paths or error text. (cli_version and
    // node_version ride along as universal base props in trackEvent.)
    // Skipped checks are omitted: neither pass nor fail.
    const checkFlags = Object.fromEntries(
        [...results, ...ranProject].map((check) => [`check_${check.id}`, check.ok])
    );
    // One failure names itself (MISSING_TERRAFORM, AWS_CLI_UNCONFIGURED,
    // STATE_LOCK_HELD); several keep the aggregate code. Downgraded and
    // warning-grade runs carry no error fields — success:true with a false
    // per-check flag IS the signal.
    const failureProps = !success
        ? (failedChecks.length === 1
            ? singleCheckFailure(failedChecks[0])
            : { error_code: 'DOCTOR_CHECKS_FAILED', reason: 'doctor-checks-failed' })
        : {};

    // Telemetry is the last thing that may run and the first thing that
    // must never fail the command: a deleted cwd or a sync fetch throw
    // would otherwise turn green checks into a red crash with no event.
    try {
        trackEvent('doctor_run', {
            success,
            // Wall-clock cost of the checks plus whether the credential
            // probe hit its timeout: a green run that took 14s and a red
            // run that failed fast look identical without these two.
            duration_ms: Date.now() - startMs,
            auth_timed_out: results.some((check) => check.id === 'aws_auth' && check.timedOut === true),
            project_checks_skipped: projectSkipped,
            ...checkFlags,
            ...failureProps,
            passed_checks: passedChecks,
            failed_checks: failedChecks,
            total_failed: failedChecks.length,
            ci_provider: detectCiProvider(),
        });
        await flushTelemetry();
    } catch {
        // The checks already printed; losing one event beats crashing.
    }
}
