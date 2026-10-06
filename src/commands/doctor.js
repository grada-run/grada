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

// SDK equivalent of `aws sts get-caller-identity`: true only when active,
// valid credentials resolve (honors CI_MOCK_AWS like every other caller).
// Never throws and never surfaces identity or error text — the caller only
// ever sees the boolean, so expired-token details cannot leak into output
// or telemetry.
async function checkAwsAuthSafe() {
    try {
        await checkAwsCredentials();
        return true;
    } catch {
        return false;
    }
}

// A lone failure names itself: missing binaries as MISSING_<ID>, dead
// credentials as AWS_CLI_UNCONFIGURED. reason mirrors error_code in
// kebab-case per the failCommand/spec convention.
function singleCheckFailure(checkId) {
    if (checkId === 'aws_auth') {
        return { error_code: 'AWS_CLI_UNCONFIGURED', reason: 'aws-cli-unconfigured' };
    }
    return {
        error_code: `MISSING_${checkId.toUpperCase()}`,
        reason: `missing-${checkId.replace(/_/g, '-')}`,
    };
}

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

    const s = spinner();
    s.start('Running pre-flight checks...');

    const results = await Promise.all(
        DOCTOR_CHECKS.map(async (check) => ({
            ...check,
            ok: check.binary ? await dedupedCheckDependency(check.binary) : await checkAwsAuthSafe(),
        }))
    );

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

    for (const check of results) {
        printStatus(check.ok, check.label, installHint(check.id), check.id);
    }

    const passedChecks = results.filter((check) => check.ok).map((check) => check.id);
    const failedChecks = results.filter((check) => !check.ok).map((check) => check.id);

    if (failedChecks.length === 0) {
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
    // several keep the aggregate code.
    const failureProps = failedChecks.length === 1
        ? singleCheckFailure(failedChecks[0])
        : { error_code: 'DOCTOR_CHECKS_FAILED', reason: 'doctor-checks-failed' };

    trackEvent('doctor_run', {
        success: failedChecks.length === 0,
        ...checkFlags,
        ...(failedChecks.length > 0 ? failureProps : {}),
        passed_checks: passedChecks,
        failed_checks: failedChecks,
        total_failed: failedChecks.length,
        ci_provider: detectCiProvider(),
    });
    await flushTelemetry();
}
