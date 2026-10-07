// Alerts cross-target harness (specs/alerts-webhooks.md). Tier-0 style:
// real `bin/cli.js` headless runs with CI_MOCK_AWS — no credentials, no
// deploys. Every target × destination permutation must produce HCL that
// passes `terraform init -backend=false` + `terraform validate`.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    e2eEnv,
    assertPrerequisites,
    runCli,
    runTerraform,
    withTmpDir,
} from './helpers.js';

const env = e2eEnv({ mockAws: true });

const SLACK_URL = 'https://hooks.slack.com/services/T123/B456/xyz';

beforeAll(() => {
    assertPrerequisites();
});

function validateTerraform(dir) {
    runTerraform(['init', '-backend=false'], { cwd: path.join(dir, 'terraform'), env });
    runTerraform(['validate'], { cwd: path.join(dir, 'terraform'), env });
}

function readAlertsTf(dir) {
    return fs.readFileSync(path.join(dir, 'terraform', 'alerts.tf'), 'utf-8');
}

describe.each([
    { target: 'ecs', alarm: 'aws_cloudwatch_metric_alarm" "notify_5xx' },
    { target: 'lambda', alarm: 'aws_cloudwatch_metric_alarm" "notify_errors' },
    { target: 'static', alarm: 'aws_cloudwatch_metric_alarm" "notify_5xx_rate' },
])('Alerts: $target target', ({ target, alarm }) => {
    it('scaffolds email + webhook destinations with valid Terraform', async () => {
        await withTmpDir(`alerts-${target}`, async (dir) => {
            const init = runCli(['init', '--target', target, '--headless'], { cwd: dir, env });
            expect(init.status).toBe(0);

            const alerts = runCli(
                ['alerts', '--email', 'you@example.com', '--webhook', SLACK_URL, '--threshold', target === 'static' ? '2.5' : '7'],
                { cwd: dir, env },
            );
            expect(alerts.status).toBe(0);

            const tf = readAlertsTf(dir);
            expect(tf).toContain(alarm);
            expect(tf).toContain('aws_sns_topic_subscription" "email"');
            expect(tf).toContain('aws_lambda_function" "forwarder"');
            // The bearer URL must never be baked into the generated file.
            expect(tf).not.toContain(SLACK_URL);

            validateTerraform(dir);
        });
    });
});

describe('Alerts: headless defaults', () => {
    it('scaffolds the manual email path with no flags and valid Terraform', async () => {
        await withTmpDir('alerts-manual', async (dir) => {
            const init = runCli(['init', '--target', 'ecs', '--headless'], { cwd: dir, env });
            expect(init.status).toBe(0);

            // stdin is closed in e2e runs: no flags must scaffold without
            // prompting, never hang.
            const alerts = runCli(['alerts'], { cwd: dir, env, capture: true });
            expect(alerts.status).toBe(0);
            expect(alerts.stdout).toContain('aws sns subscribe');

            const tf = readAlertsTf(dir);
            expect(tf).toContain('aws_cloudwatch_metric_alarm" "notify_5xx"');
            expect(tf).not.toContain('aws_lambda_function" "forwarder"');

            validateTerraform(dir);
        });
    });
});
