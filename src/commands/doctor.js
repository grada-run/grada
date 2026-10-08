import { intro, outro, spinner } from '@clack/prompts';
import color from 'picocolors';
import { checkDependency } from '../utils/system.js';
import { checkAwsCredentials, TROUBLESHOOTING_URL } from '../utils/aws.js';
import { trackEvent, flushTelemetry, detectCiProvider, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';

// Stable snake_case identifiers for the pre-flight checks below. Binary
// entries probe `<binary> --version`; the aws_auth entry (binary: null)
// probes live credentials instead. Only these static IDs ever reach
// telemetry — never paths, identities, or error text.
export const DOCTOR_CHECKS = [
    { id: 'terraform', label: 'Terraform', binary: 'terraform' },
    { id: 'aws_cli', label: 'AWS CLI', binary: 'aws' },
    { id: 'aws_auth', label: 'AWS Credentials', binary: null },
    { id: 'docker', label: 'Docker', binary: 'docker' },
    { id: 'git', label: 'Git', binary: 'git' },
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

// One check that can neither throw nor reject: a synchronous spawn
// failure (or any future checkDependency regression) degrades to a red
// cell instead of rejecting the Promise.all and killing the run before
// telemetry compiles.
async function runCheckSafe(check) {
    try {
        if (check.binary) {
            return { ...check, ok: await dedupedCheckDependency(check.binary) };
        }
        const auth = await checkAwsAuthSafe();
        return { ...check, ok: auth.ok, timedOut: auth.timedOut };
    } catch {
        return { ...check, ok: false };
    }
}

// A lone failure names itself: missing binaries as MISSING_<ID>, dead
// credentials as AWS_CLI_UNCONFIGURED. reason mirrors error_code in
// kebab-case per the failCommand/spec convention.
export function singleCheckFailure(checkId) {
    if (checkId === 'aws_auth') {
        return { error_code: 'AWS_CLI_UNCONFIGURED', reason: 'aws-cli-unconfigured' };
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

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runDoctor() {
    setActiveCommandName('doctor');
    try {
        return await runDoctorMain();
    } finally {
        resetActiveCommandName();
    }
}

async function runDoctorMain() {
    intro(color.bgCyan(color.black(' grada ☁️  ')));

    const startMs = Date.now();
    const s = spinner();
    s.start('Running pre-flight checks...');

    const results = await Promise.all(DOCTOR_CHECKS.map(runCheckSafe));

    s.stop('Pre-flight checks complete.\n');

    const printStatus = (ok, label, fix, checkId) => {
        const icon = ok ? color.green('✅') : color.red('❌');
        const message = ok ? `${label} (✓)` : `${label} (✗)`;
        console.log(`   ${icon} ${message}`);
        if (!ok) {
            console.log(`      ┌─ Try: ${color.dim(fix)}`);
            const hint = ciHint(checkId);
            if (hint) {
                console.log(`      └─ ${hint}`);
            }
        }
    };

    const passedChecks = results.filter((check) => check.ok).map((check) => check.id);
    const failedChecks = results.filter((check) => !check.ok).map((check) => check.id);

    // Enterprise downgrade: a missing `aws` binary with live SDK credentials
    // is a warning, not a failure — the SDK path provisions fine. Applies
    // only when aws_cli is the SOLE failure; anything else failing alongside
    // keeps the red verdict. Telemetry keeps check_aws_cli: false (honest
    // per-check state) while success flips true.
    const awsAuthOk = results.some((check) => check.id === 'aws_auth' && check.ok);
    const cliDowngraded = failedChecks.length === 1 && failedChecks[0] === 'aws_cli' && awsAuthOk;
    const success = failedChecks.length === 0 || cliDowngraded;

    for (const check of results) {
        if (check.id === 'aws_cli' && cliDowngraded) {
            console.log(`   ${color.yellow('⚠️')} ${check.label} (⚠)`);
            console.log(`      └─ ${color.dim(AWS_CLI_DOWNGRADE_NOTE)}`);
        } else {
            printStatus(check.ok, check.label, installHint(check.id), check.id);
        }
    }

    if (success) {
        outro(color.green('Your system is 100% ready to provision and deploy! 🚀'));
    } else if (failedChecks.length === 1 && failedChecks[0] === 'aws_auth') {
        outro(color.yellow('Please refresh your AWS credentials before running the provisioning tool.'));
    } else {
        outro(color.yellow('Please install the missing dependencies before running the provisioning tool.'));
    }

    // Per-check booleans on every run so PostHog can slice green runs by
    // individual check health (repeated green `doctor` runs that precede
    // failures elsewhere become visible). Keys derive from the stable
    // DOCTOR_CHECKS ids — never paths or error text. (cli_version and
    // node_version ride along as universal base props in trackEvent.)
    const checkFlags = Object.fromEntries(
        results.map((check) => [`check_${check.id}`, check.ok])
    );
    // One failure names itself (MISSING_TERRAFORM, AWS_CLI_UNCONFIGURED);
    // several keep the aggregate code. Downgraded runs carry no error
    // fields — success:true with check_aws_cli:false IS the signal.
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
