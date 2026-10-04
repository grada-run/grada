import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackPromptsMockFactory } from './helpers/clack.js';
import { telemetryMockFactory } from './helpers/telemetry.js';
import { createTmpDirTracker } from './helpers/tmpdir.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { load as loadYaml } from 'js-yaml';
import {
    runDrift,
    parseDriftArgs,
    extractRoleArn,
    extractPlanSummary,
    scaffoldDriftWorkflow,
} from '../src/commands/drift.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';

vi.mock('@clack/prompts', () => clackPromptsMockFactory());

vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));

const tmp = createTmpDirTracker();
let exitSpy;
let logSpy;

function makeTmp() {
    return tmp.makeTmp('drift-test-');
}

function writeDeployYml(dir, roleArn = 'arn:aws:iam::123456789012:role/myapp-github-actions-role') {
    const workflows = path.join(dir, '.github', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(
        path.join(workflows, 'deploy.yml'),
        `name: Deploy\njobs:\n  deploy:\n    steps:\n      - uses: anton-codes-iac/deploy-stack-action@v1\n        with:\n          role-to-assume: ${roleArn}\n`
    );
}

function writeMainTf(dir, region = 'us-east-2') {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'terraform', 'main.tf'),
        `provider "aws" {\n  region = "${region}"\n}\nlocals {\n  app_name = "myapp\${local.env_suffix}"\n}\n`
    );
}

beforeEach(() => {
    tmp.reset();
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    tmp.cleanup();
});

describe('parseDriftArgs', () => {
    it('parses flags and treats drift init as --setup', () => {
        expect(parseDriftArgs(['drift', '--setup', '--region', 'eu-west-1'])).toMatchObject({ setup: true, region: 'eu-west-1' });
        expect(parseDriftArgs(['drift', 'init']).setup).toBe(true);
        expect(parseDriftArgs(['drift']).setup).toBeUndefined();
    });

    it('collects unexpected positionals', () => {
        expect(parseDriftArgs(['drift', 'bogus']).unexpectedPositionals).toEqual(['bogus']);
    });

    it('drops --headless, which drift never reads', () => {
        const options = parseDriftArgs(['drift', '--setup', '--force', '--headless']);
        expect(options).toMatchObject({ setup: true, force: true });
        expect(options.headless).toBeUndefined();
    });
});

describe('extractRoleArn / extractPlanSummary', () => {
    it('finds the OIDC role ARN in deploy.yml', () => {
        expect(extractRoleArn('  role-to-assume: arn:aws:iam::1:role/x # comment')).toBe('arn:aws:iam::1:role/x');
        expect(extractRoleArn('no anchor here')).toBeNull();
    });

    it('condenses plan output to changes plus the summary', () => {
        const output = [
            'random log line',
            '# aws_lb.main will be updated',
            '  ~ dns_name = "a" -> "b"',
            '  + new = true',
            '  - old = true',
            'Plan: 0 to add, 1 to change, 0 to destroy.',
        ].join('\n');
        const summary = extractPlanSummary(output);
        expect(summary).not.toContain('random log line');
        expect(summary).toContain('# aws_lb.main will be updated');
        expect(summary).toContain('Plan: 0 to add, 1 to change, 0 to destroy.');
    });

    it('caps long summaries', () => {
        const output = Array.from({ length: 100 }, (_, i) => `  + line${i} = true`).join('\n');
        const summary = extractPlanSummary(output);
        expect(summary.split('\n')).toHaveLength(61);
        expect(summary).toContain('more lines');
    });
});

describe('scaffoldDriftWorkflow', () => {
    it('renders region and role ARN into valid workflow YAML', () => {
        const dir = makeTmp();
        const result = scaffoldDriftWorkflow(dir, { region: 'eu-west-1', roleArn: 'arn:aws:iam::1:role/x' });
        expect(result.ok).toBe(true);
        const content = fs.readFileSync(path.join(dir, '.github', 'workflows', 'drift.yml'), 'utf8');
        expect(content).toContain('AWS_REGION: eu-west-1');
        expect(content).toContain('role-to-assume: arn:aws:iam::1:role/x');
        expect(content).not.toContain('{{REGION}}');
        expect(content).not.toContain('{{ROLE_ARN}}');
        const parsed = loadYaml(content);
        expect(parsed.on.schedule).toEqual([{ cron: '0 6 * * *' }]);
        expect(parsed.on).toHaveProperty('workflow_dispatch');
        expect(parsed.permissions).toMatchObject({ 'id-token': 'write', contents: 'read', issues: 'write' });
        const steps = parsed.jobs.drift.steps;
        expect(steps.some((step) => step.uses === 'actions/github-script@v7')).toBe(true);
        expect(steps.some((step) => step.with?.terraform_wrapper === false)).toBe(true);
    });

    it('refuses to overwrite without --force', () => {
        const dir = makeTmp();
        scaffoldDriftWorkflow(dir, { region: 'us-east-2', roleArn: 'arn:aws:iam::1:role/x' });
        expect(scaffoldDriftWorkflow(dir, { region: 'us-east-2', roleArn: 'arn:aws:iam::1:role/y' }).reason).toBe('exists');
        const forced = scaffoldDriftWorkflow(dir, { region: 'us-east-2', roleArn: 'arn:aws:iam::1:role/y', force: true });
        expect(forced.ok).toBe(true);
        expect(fs.readFileSync(path.join(dir, '.github', 'workflows', 'drift.yml'), 'utf8')).toContain('role/y');
    });
});

describe('runDrift --setup', () => {
    it('scaffolds from the deploy workflow role ARN', async () => {
        const dir = makeTmp();
        writeDeployYml(dir);
        writeMainTf(dir);
        const result = await runDrift({ cwd: dir, setup: true });
        expect(result.ok).toBe(true);
        expect(result.file).toBe(path.join('.github', 'workflows', 'drift.yml'));
        expect(fs.existsSync(path.join(dir, '.github', 'workflows', 'drift.yml'))).toBe(true);
        expect(trackEvent).toHaveBeenCalledWith('drift_run', expect.objectContaining({ action: 'setup', success: true }));
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('soft-fails when the workflow exists without --force', async () => {
        const dir = makeTmp();
        writeDeployYml(dir);
        writeMainTf(dir);
        await runDrift({ cwd: dir, setup: true });
        const second = await runDrift({ cwd: dir, setup: true });
        expect(second).toMatchObject({ ok: false, reason: 'drift-workflow-exists' });
        expect(exitSpy).not.toHaveBeenCalled();
        const forced = await runDrift({ cwd: dir, setup: true, force: true });
        expect(forced.ok).toBe(true);
    });

    it('fails without a deploy workflow or role ARN', async () => {
        const missing = makeTmp();
        writeMainTf(missing);
        const noWorkflow = await runDrift({ cwd: missing, setup: true });
        expect(noWorkflow.reason).toBe('workflow-not-found');

        const noArn = makeTmp();
        writeMainTf(noArn);
        const workflows = path.join(noArn, '.github', 'workflows');
        fs.mkdirSync(workflows, { recursive: true });
        fs.writeFileSync(path.join(workflows, 'deploy.yml'), 'name: Deploy\n');
        const result = await runDrift({ cwd: noArn, setup: true });
        expect(result.reason).toBe('role-arn-not-found');
    });
});

describe('runDrift check mode', () => {
    function checkOptions(dir, planResult, initResult = { status: 0, stdout: '', stderr: '' }) {
        return {
            cwd: dir,
            spawnSyncImpl: vi.fn((bin, args) => {
                if (args[0] === 'init') return initResult;
                return planResult;
            }),
        };
    }

    it('reports clean on exit code 0', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runDrift(checkOptions(dir, { status: 0, stdout: 'No changes.', stderr: '' }));
        expect(result).toMatchObject({ ok: true, drift: false });
        expect(trackEvent).toHaveBeenCalledWith('drift_run', expect.objectContaining({ action: 'check', drift: false, success: true }));
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('reports DRIFT_DETECTED with exit code 2', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runDrift(checkOptions(dir, {
            status: 2,
            stdout: '# aws_lb.main will be updated\n  ~ x = 1\nPlan: 0 to add, 1 to change, 0 to destroy.',
            stderr: '',
        }));
        expect(result).toMatchObject({ ok: false, reason: 'drift-detected' });
        expect(exitSpy).toHaveBeenCalledWith(2);
        const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
        expect(output).toContain('Infrastructure drift detected');
        expect(output).toContain('Plan: 0 to add, 1 to change, 0 to destroy.');
    });

    it('fails on exit code 1 and on init failures', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const failed = await runDrift(checkOptions(dir, { status: 1, stdout: '', stderr: 'Error: boom' }));
        expect(failed.reason).toBe('terraform-plan-failed');

        const initFailed = await runDrift(checkOptions(dir, { status: 0, stdout: '', stderr: '' }, { status: 1, stdout: '', stderr: 'init no' }));
        expect(initFailed.reason).toBe('terraform-init-failed');
    });

    it('guides when terraform is missing or the project is uninitialized', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const enoent = await runDrift({ cwd: dir, spawnSyncImpl: () => ({ error: { code: 'ENOENT' } }) });
        expect(enoent.reason).toBe('terraform-not-installed');

        const bare = makeTmp();
        const uninit = await runDrift({ cwd: bare });
        expect(uninit.reason).toBe('terraform-not-initialized');
    });
});
