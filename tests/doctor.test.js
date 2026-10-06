import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackPromptsMockFactory, mockOutro } from './helpers/clack.js';
import { telemetryMockFactory } from './helpers/telemetry.js';
import { runDoctor, installHint, ciHint, singleCheckFailure, DOCTOR_CHECKS } from '../src/commands/doctor.js';
import { checkDependency } from '../src/utils/system.js';
import { checkAwsCredentials } from '../src/utils/aws.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';

vi.mock('../src/utils/system.js', () => ({
    checkDependency: vi.fn(),
}));

vi.mock('../src/utils/aws.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, checkAwsCredentials: vi.fn() };
});

vi.mock('@clack/prompts', () => clackPromptsMockFactory());

vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));

const realPlatform = process.platform;

function setPlatform(platform) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function mockBinaries({ terraform = true, aws = true, docker = true, git = true, auth = true } = {}) {
    const availability = { terraform, aws, docker, git };
    vi.mocked(checkDependency).mockImplementation(async (binary) => availability[binary] ?? false);
    vi.mocked(checkAwsCredentials).mockImplementation(async () => {
        if (!auth) throw Object.assign(new Error('ExpiredToken: The security token included in the request is expired'), { name: 'ExpiredTokenException' });
        return { accountId: '123456789012', region: 'us-east-2' };
    });
}

function captureLog() {
    const output = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        output.push(args.join(' '));
    });
    return { output, restore: () => spy.mockRestore() };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockBinaries();
});

afterEach(() => {
    setPlatform(realPlatform);
});

describe('installHint', () => {
    it('returns Homebrew hints by default', () => {
        expect(installHint('terraform', 'darwin')).toContain('brew install terraform');
        expect(installHint('terraform', 'freebsd')).toContain('brew install terraform');
    });

    it('returns platform-aware Linux hints without Homebrew', () => {
        setPlatform('linux');
        expect(installHint('terraform')).not.toContain('brew');
        expect(installHint('terraform')).toContain('hashicorp.com');
        expect(installHint('aws_cli')).toContain('docs.aws.amazon.com');
        expect(installHint('docker')).toContain('docs.docker.com');
        expect(installHint('git')).toContain('apt-get');
        expect(installHint('git')).toContain('dnf');
    });

    it('returns winget hints on native Windows', () => {
        setPlatform('win32');
        expect(installHint('terraform')).toBe('Install via winget: winget install Hashicorp.Terraform');
        expect(installHint('aws_cli')).toBe('Install via winget: winget install Amazon.AWSCLI');
        expect(installHint('docker')).toBe('Install via winget: winget install Docker.DockerDesktop');
        expect(installHint('git')).toBe('Install via winget: winget install Git.Git');
    });

    it('returns empty string for unknown check IDs', () => {
        expect(installHint('nope')).toBe('');
    });
});

describe('ciHint', () => {
    const savedCI = process.env.CI;

    afterEach(() => {
        if (savedCI === undefined) delete process.env.CI;
        else process.env.CI = savedCI;
    });

    it('returns CI-specific hints for terraform and aws_cli when CI is set', () => {
        process.env.CI = 'true';
        expect(ciHint('terraform')).toBe(
            '💡 Hint: Running in CI? Ensure Terraform is installed (e.g., via `hashicorp/setup-terraform` in GitHub Actions).'
        );
        expect(ciHint('aws_cli')).toBe(
            '💡 Hint: Running in CI? Ensure the AWS CLI is installed and credentials are configured.'
        );
    });

    it('returns empty string when CI is unset', () => {
        delete process.env.CI;
        expect(ciHint('terraform')).toBe('');
        expect(ciHint('aws_cli')).toBe('');
    });

    it('returns empty string for checks without a CI hint, even in CI', () => {
        process.env.CI = 'true';
        expect(ciHint('docker')).toBe('');
        expect(ciHint('git')).toBe('');
        expect(ciHint('nope')).toBe('');
    });

    it('returns a credentials hint for aws_auth when CI is set', () => {
        process.env.CI = 'true';
        expect(ciHint('aws_auth')).toContain('aws-actions/configure-aws-credentials');
        delete process.env.CI;
        expect(ciHint('aws_auth')).toBe('');
    });
});

describe('singleCheckFailure', () => {
    it('maps underscored check IDs to SCREAMING error codes and kebab reasons', () => {
        expect(singleCheckFailure('aws_cli')).toEqual({ error_code: 'MISSING_AWS_CLI', reason: 'missing-aws-cli' });
        expect(singleCheckFailure('terraform')).toEqual({ error_code: 'MISSING_TERRAFORM', reason: 'missing-terraform' });
        expect(singleCheckFailure('aws_auth')).toEqual({ error_code: 'AWS_CLI_UNCONFIGURED', reason: 'aws-cli-unconfigured' });
    });
});

describe('runDoctor', () => {
    it('reports all passing checks with empty failed arrays', async () => {
        const { output, restore } = captureLog();
        try {
            await runDoctor();
            expect(trackEvent).toHaveBeenCalledWith(
                'doctor_run',
                expect.objectContaining({
                    success: true,
                    check_terraform: true,
                    check_aws_cli: true,
                    check_aws_auth: true,
                    check_docker: true,
                    check_git: true,
                    passed_checks: ['terraform', 'aws_cli', 'aws_auth', 'docker', 'git'],
                    failed_checks: [],
                    total_failed: 0,
                })
            );
            const [, successProps] = vi.mocked(trackEvent).mock.calls[0];
            expect(successProps).not.toHaveProperty('error_code');
            expect(successProps).not.toHaveProperty('reason');
            expect(flushTelemetry).toHaveBeenCalled();
            expect(output.join('\n')).not.toContain('Try:');
        } finally {
            restore();
        }
    });

    it('reports failed checks by stable ID with no sensitive data', async () => {
        mockBinaries({ terraform: false, aws: true, docker: false, git: true });
        const { output, restore } = captureLog();
        try {
            await runDoctor();
            expect(trackEvent).toHaveBeenCalledWith(
                'doctor_run',
                expect.objectContaining({
                    success: false,
                    error_code: 'DOCTOR_CHECKS_FAILED',
                    reason: 'doctor-checks-failed',
                    check_terraform: false,
                    check_aws_cli: true,
                    check_aws_auth: true,
                    check_docker: false,
                    check_git: true,
                    passed_checks: ['aws_cli', 'aws_auth', 'git'],
                    failed_checks: ['terraform', 'docker'],
                    total_failed: 2,
                })
            );
            const [event, props] = vi.mocked(trackEvent).mock.calls[0];
            expect(event).toBe('doctor_run');
            expect(JSON.stringify(props)).not.toMatch(/[0-9]{12}|arn:aws|\/home\/|\/Users\/|Error/);
            expect(output.join('\n')).toContain('Try:');
        } finally {
            restore();
        }
    });

    it('names the single missing binary in error_code and reason', async () => {
        mockBinaries({ terraform: false, aws: true, docker: true, git: true });
        const { restore } = captureLog();
        try {
            await runDoctor();
            expect(trackEvent).toHaveBeenCalledWith(
                'doctor_run',
                expect.objectContaining({
                    success: false,
                    error_code: 'MISSING_TERRAFORM',
                    reason: 'missing-terraform',
                    check_terraform: false,
                    check_aws_cli: true,
                    failed_checks: ['terraform'],
                    total_failed: 1,
                })
            );
        } finally {
            restore();
        }
    });

    it('downgrades a lone missing aws binary to a warning when SDK auth succeeds', async () => {
        mockBinaries({ terraform: true, aws: false, docker: true, git: true, auth: true });
        const { output, restore } = captureLog();
        try {
            await runDoctor();
            expect(trackEvent).toHaveBeenCalledWith(
                'doctor_run',
                expect.objectContaining({
                    success: true,
                    check_aws_cli: false,
                    check_aws_auth: true,
                    failed_checks: ['aws_cli'],
                })
            );
            const [, props] = vi.mocked(trackEvent).mock.calls[0];
            expect(props).not.toHaveProperty('error_code');
            expect(props).not.toHaveProperty('reason');
            const text = output.join('\n');
            expect(text).toContain('AWS CLI (⚠)');
            expect(text).toContain('active AWS SDK credentials were found');
            expect(text).toContain('grada db connect');
            expect(text).not.toContain('AWS CLI (✗)');
            expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining('100% ready'));
        } finally {
            restore();
        }
    });

    it('keeps the red verdict when aws_cli fails alongside anything else', async () => {
        mockBinaries({ terraform: false, aws: false, docker: true, git: true, auth: true });
        const { output, restore } = captureLog();
        try {
            await runDoctor();
            expect(trackEvent).toHaveBeenCalledWith(
                'doctor_run',
                expect.objectContaining({
                    success: false,
                    error_code: 'DOCTOR_CHECKS_FAILED',
                    failed_checks: ['terraform', 'aws_cli'],
                })
            );
            expect(output.join('\n')).toContain('AWS CLI (✗)');
            expect(output.join('\n')).not.toContain('active AWS SDK credentials were found');
        } finally {
            restore();
        }
    });

    it('reports expired credentials with recovery guidance and no leaked details', async () => {
        mockBinaries({ auth: false });
        const { output, restore } = captureLog();
        try {
            await runDoctor();
            expect(trackEvent).toHaveBeenCalledWith(
                'doctor_run',
                expect.objectContaining({
                    success: false,
                    error_code: 'AWS_CLI_UNCONFIGURED',
                    reason: 'aws-cli-unconfigured',
                    check_aws_cli: true,
                    check_aws_auth: false,
                    failed_checks: ['aws_auth'],
                    total_failed: 1,
                })
            );
            const text = output.join('\n');
            expect(text).toContain('AWS Credentials (✗)');
            expect(text).toContain('aws sso login');
            expect(text).toContain('aws-credentials.md');
            expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining('refresh your AWS credentials'));
            // The SDK rejection (token details, exception names, account
            // IDs) must reach neither the terminal nor the payload — only
            // the static recovery guidance and stable IDs may appear.
            expect(text).not.toContain('ExpiredTokenException');
            expect(text).not.toContain('security token included');
            const [, props] = vi.mocked(trackEvent).mock.calls[0];
            expect(JSON.stringify(props)).not.toMatch(/ExpiredToken|123456789012|arn:aws/);
        } finally {
            restore();
        }
    });

    it('prints Linux install hints on Linux and brew hints elsewhere', async () => {
        mockBinaries({ terraform: false, aws: true, docker: true, git: true });

        setPlatform('linux');
        const linuxRun = captureLog();
        try {
            await runDoctor();
            expect(linuxRun.output.join('\n')).toContain('hashicorp.com');
            expect(linuxRun.output.join('\n')).not.toContain('brew install terraform');
        } finally {
            linuxRun.restore();
        }

        vi.clearAllMocks();
        mockBinaries({ terraform: false, aws: true, docker: true, git: true });
        setPlatform('darwin');
        const macRun = captureLog();
        try {
            await runDoctor();
            expect(macRun.output.join('\n')).toContain('brew install terraform');
        } finally {
            macRun.restore();
        }
    });

    it('exposes the four binary checks plus the credentials probe', () => {
        expect(DOCTOR_CHECKS.map((check) => check.id)).toEqual(['terraform', 'aws_cli', 'aws_auth', 'docker', 'git']);
    });

    it('reports the detected CI provider without disturbing check order', async () => {
        const saved = process.env.GITHUB_ACTIONS;
        process.env.GITHUB_ACTIONS = 'true';
        const { restore } = captureLog();
        try {
            await runDoctor();
            expect(trackEvent).toHaveBeenCalledWith(
                'doctor_run',
                expect.objectContaining({
                    passed_checks: ['terraform', 'aws_cli', 'aws_auth', 'docker', 'git'],
                    failed_checks: [],
                    ci_provider: 'github_actions',
                })
            );
        } finally {
            restore();
            if (saved === undefined) delete process.env.GITHUB_ACTIONS;
            else process.env.GITHUB_ACTIONS = saved;
        }
    });

    it('appends CI hints to failed terraform/aws checks when running in CI', async () => {
        mockBinaries({ terraform: false, aws: false, docker: true, git: true });
        const savedCI = process.env.CI;
        process.env.CI = 'true';
        const { output, restore } = captureLog();
        try {
            await runDoctor();
            const text = output.join('\n');
            expect(text).toContain('hashicorp/setup-terraform');
            expect(text).toContain('Ensure the AWS CLI is installed and credentials are configured.');
        } finally {
            restore();
            if (savedCI === undefined) delete process.env.CI;
            else process.env.CI = savedCI;
        }
    });

    it('omits CI hints outside CI and for passing checks', async () => {
        mockBinaries({ terraform: false, aws: false, docker: true, git: true });
        const savedCI = process.env.CI;
        delete process.env.CI;
        const { output, restore } = captureLog();
        try {
            await runDoctor();
            expect(output.join('\n')).not.toContain('Running in CI?');
        } finally {
            restore();
            if (savedCI === undefined) delete process.env.CI;
            else process.env.CI = savedCI;
        }

        vi.clearAllMocks();
        mockBinaries();
        process.env.CI = 'true';
        const passingRun = captureLog();
        try {
            await runDoctor();
            expect(passingRun.output.join('\n')).not.toContain('Running in CI?');
        } finally {
            passingRun.restore();
            if (savedCI === undefined) delete process.env.CI;
            else process.env.CI = savedCI;
        }
    });

    it('deduplicates concurrent runs to one spawn per binary, then runs fresh sequentially', async () => {
        // Deferred mock so all 5 runs overlap while checks are in flight.
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        vi.mocked(checkDependency).mockImplementation(async () => {
            await gate;
            return true;
        });
        const { restore } = captureLog();
        try {
            const runs = Promise.all([runDoctor(), runDoctor(), runDoctor(), runDoctor(), runDoctor()]);
            await Promise.resolve();
            release();
            await runs;
            expect(vi.mocked(checkDependency)).toHaveBeenCalledTimes(4);

            vi.mocked(checkDependency).mockImplementation(async () => true);
            await runDoctor();
            expect(vi.mocked(checkDependency)).toHaveBeenCalledTimes(8);
        } finally {
            restore();
        }
    });
});
