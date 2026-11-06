import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { load as loadYaml } from 'js-yaml';
import { renderCiWorkflow, scaffoldPlanWorkflow, PLAN_WORKFLOW_FILE } from '../src/utils/ci-workflows.js';

function makeTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ci-workflows-test-'));
}

describe('scaffoldPlanWorkflow', () => {
    it('renders region and role ARN into valid workflow YAML', () => {
        const dir = makeTmp();
        const result = scaffoldPlanWorkflow(dir, { region: 'eu-west-1', roleArn: 'arn:aws:iam::1:role/x' });
        expect(result.ok).toBe(true);
        expect(result.path).toBe(path.join(dir, PLAN_WORKFLOW_FILE));
        const content = fs.readFileSync(path.join(dir, '.github', 'workflows', 'plan.yml'), 'utf8');
        expect(content).toContain('AWS_REGION: eu-west-1');
        expect(content).toContain('role-to-assume: arn:aws:iam::1:role/x');
        expect(content).not.toContain('{{REGION}}');
        expect(content).not.toContain('{{ROLE_ARN}}');
        const parsed = loadYaml(content);
        expect(parsed.on.pull_request_target.types).toEqual(['opened', 'synchronize', 'reopened']);
        expect(parsed.permissions).toMatchObject({ 'id-token': 'write', contents: 'read', 'pull-requests': 'write' });
    });

    it('refuses to overwrite without --force', () => {
        const dir = makeTmp();
        scaffoldPlanWorkflow(dir, { region: 'us-east-2', roleArn: 'arn:aws:iam::1:role/x' });
        expect(scaffoldPlanWorkflow(dir, { region: 'us-east-2', roleArn: 'arn:aws:iam::1:role/y' }).reason).toBe('exists');
        const forced = scaffoldPlanWorkflow(dir, { region: 'us-east-2', roleArn: 'arn:aws:iam::1:role/y', force: true });
        expect(forced.ok).toBe(true);
        expect(fs.readFileSync(path.join(dir, '.github', 'workflows', 'plan.yml'), 'utf8')).toContain('role/y');
    });
});

describe('renderCiWorkflow', () => {
    it('substitutes placeholders and writes through the shared core', () => {
        const dir = makeTmp();
        const templatePath = path.join(dir, 'tmpl.yml');
        fs.writeFileSync(templatePath, 'region: {{REGION}}\nrole: {{ROLE_ARN}}\n');
        const targetPath = path.join(dir, 'out', 'plan.yml');
        const result = renderCiWorkflow({ templatePath, region: 'r', roleArn: 'a', targetPath });
        expect(result.ok).toBe(true);
        expect(result.path).toBe(targetPath);
        expect(fs.readFileSync(targetPath, 'utf8')).toBe('region: r\nrole: a\n');
        expect(renderCiWorkflow({ templatePath, region: 'r', roleArn: 'a', targetPath }).reason).toBe('exists');
        expect(renderCiWorkflow({ templatePath, region: 'r', roleArn: 'b', targetPath, force: true }).ok).toBe(true);
        expect(fs.readFileSync(targetPath, 'utf8')).toContain('role: b');
    });
});
