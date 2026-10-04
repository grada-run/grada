import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackPromptsMockFactory } from './helpers/clack.js';
import { telemetryMockFactory } from './helpers/telemetry.js';
import { createTmpDirTracker } from './helpers/tmpdir.js';
import fs from 'fs';
import path from 'path';
import { runAlerts, parseAlertsArgs, buildAlertsTf, ALERTS_TF_FILE } from '../src/commands/alerts.js';
import { trackEvent } from '../src/core/telemetry.js';

vi.mock('@clack/prompts', () => clackPromptsMockFactory());

vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));

const tmp = createTmpDirTracker();
let exitSpy;
let logSpy;

function writeMainTf(dir, { lambda = false, alb = true } = {}) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    const resources = [];
    if (lambda) resources.push('resource "aws_lambda_function" "app" {}');
    if (alb) resources.push('resource "aws_lb" "main" {}');
    fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), `${resources.join('\n')}\n`);
}

beforeEach(() => {
    tmp.reset();
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
});

afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    tmp.cleanup();
});

describe('parseAlertsArgs', () => {
    it('parses region, project-name, and force', () => {
        expect(parseAlertsArgs(['alerts', '--region', 'eu-west-1', '--force'])).toMatchObject({
            region: 'eu-west-1',
            force: true,
        });
        expect(parseAlertsArgs(['alerts'])).toEqual({});
    });

    it('collects unexpected positionals', () => {
        expect(parseAlertsArgs(['alerts', 'bogus']).unexpectedPositionals).toEqual(['bogus']);
    });
});

describe('buildAlertsTf', () => {
    it('wires a distinct notify alarm to the SNS topic', () => {
        const tf = buildAlertsTf({ projectName: 'myapp' });
        expect(tf).toContain('resource "aws_sns_topic" "alerts"');
        expect(tf).toContain('name = "myapp-alerts"');
        expect(tf).toContain('resource "aws_cloudwatch_metric_alarm" "notify_5xx"');
        expect(tf).toContain('alarm_name          = "myapp-5xx-notify"');
        expect(tf).toContain('metric_name         = "HTTPCode_Target_5XX_Count"');
        expect(tf).toContain('alarm_actions = [aws_sns_topic.alerts.arn]');
        expect(tf).toContain('LoadBalancer = aws_lb.main.arn_suffix');
    });
});

describe('Command: alerts (scaffold SNS + alarm)', () => {
    function alertOptions(dir, overrides = {}) {
        return { cwd: dir, projectName: 'myapp', region: 'us-east-2', ...overrides };
    }

    it('scaffolds alerts.tf and prints manual subscribe steps', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        const result = await runAlerts(alertOptions(dir));

        expect(result).toMatchObject({ ok: true, action: 'scaffold', file: ALERTS_TF_FILE });
        const written = fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8');
        expect(written).toContain('aws_sns_topic');
        expect(written).toContain('myapp-5xx-notify');
        const text = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
        expect(text).toContain('aws sns subscribe');
        expect(text).toContain('--protocol email');
        expect(exitSpy).not.toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith('alerts_run', expect.objectContaining({ success: true }));
    });

    it('refuses to overwrite without --force', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, ALERTS_TF_FILE), '# custom\n');
        const result = await runAlerts(alertOptions(dir));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('alerts-file-exists');
        expect(fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8')).toBe('# custom\n');
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('overwrites with --force', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, ALERTS_TF_FILE), '# custom\n');
        const result = await runAlerts(alertOptions(dir, { force: true }));

        expect(result.ok).toBe(true);
        expect(fs.readFileSync(path.join(dir, ALERTS_TF_FILE), 'utf8')).toContain('aws_sns_topic');
    });

    it('errors clearly on lambda targets', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir, { lambda: true, alb: false });
        const result = await runAlerts(alertOptions(dir));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('alerts-target-unsupported');
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(fs.existsSync(path.join(dir, ALERTS_TF_FILE))).toBe(false);
    });

    it('errors when the ALB resource is missing', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir, { alb: false });
        const result = await runAlerts(alertOptions(dir));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('alb-not-found');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('errors when terraform is not initialized', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        const result = await runAlerts(alertOptions(dir));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('terraform-not-initialized');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects unexpected positionals', async () => {
        const dir = tmp.makeTmp('alerts-test-');
        writeMainTf(dir);
        const result = await runAlerts(alertOptions(dir, { unexpectedPositionals: ['bogus'] }));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('unexpected-positional-args');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});
