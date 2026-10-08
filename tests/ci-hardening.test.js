// CI hardening contract: scanners run on rendered output, containers run
// non-root, and accepted AWS cost trade-offs carry explicit Trivy ignores.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function readRepo(rel) {
    return fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
}

function finalStage(content) {
    const lines = content.split('\n');
    let lastFromIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*FROM\s+/i.test(lines[i])) lastFromIdx = i;
    }
    return lines.slice(lastFromIdx + 1).join('\n');
}

describe('CI scans rendered templates (not raw {{VARS}})', () => {
    for (const workflow of ['.github/workflows/test.yml', '.github/workflows/publish.yml']) {
        it(`${workflow} renders ecs+lambda+static then scans the rendered dirs`, () => {
            const yml = readRepo(workflow);
            expect(yml).toContain('mktemp -d');
            expect(yml).toContain('init --target ecs --headless');
            expect(yml).toContain('init --target lambda --headless');
            expect(yml).toContain('init --target static --headless');
            expect(yml).toContain('SCAN_ROOT/static/terraform');
            expect(yml).toContain('tflint');
            expect(yml).toContain("'config'");
            expect(yml).toContain("SCAN_ROOT }}/static'");
            // Must not scan the repo root / raw templates folder.
            expect(yml).not.toMatch(/tflint --recursive/);
            expect(yml).not.toMatch(/scan-dir:\s*['\"]?\.\s*['\"]?\s*$/m);
        });
    }
});

describe('Terraform is installed before grada renders (init shells to terraform fmt)', () => {
    for (const workflow of ['.github/workflows/test.yml', '.github/workflows/publish.yml']) {
        it(`${workflow} sets up Terraform ahead of the render step`, () => {
            const yml = readRepo(workflow);
            const setup = yml.indexOf('hashicorp/setup-terraform');
            const render = yml.indexOf('Render templates for IaC scanning');
            expect(setup).toBeGreaterThanOrEqual(0);
            expect(render).toBeGreaterThanOrEqual(0);
            expect(setup).toBeLessThan(render);
        });
    }

    it('iac-validation.yml installs Terraform in every scaffold job', () => {
        const yml = readRepo('.github/workflows/iac-validation.yml');
        // Split per job; the lambda job carries its scaffold commands in the
        // matrix block (textually before steps), so assert presence per job
        // rather than textual order within the job.
        const jobs = yml.split('runs-on: ubuntu-latest').slice(1);
        const scaffoldJobs = jobs.filter((job) => job.includes('bin/cli.js'));
        expect(scaffoldJobs.length).toBe(4);
        for (const job of scaffoldJobs) {
            expect(job).toContain('hashicorp/setup-terraform');
        }
    });
});

describe('Our own CI never emits telemetry (job-level DO_NOT_TRACK)', () => {
    for (const workflow of ['.github/workflows/test.yml', '.github/workflows/publish.yml', '.github/workflows/iac-validation.yml']) {
        it(`${workflow} silences every runner job above its steps`, () => {
            const yml = readRepo(workflow);
            const jobs = yml.split('runs-on: ubuntu-latest').slice(1);
            expect(jobs.length).toBeGreaterThan(0);
            for (const job of jobs) {
                const silenced = job.indexOf("DO_NOT_TRACK: '1'");
                const steps = job.indexOf('steps:');
                expect(silenced).toBeGreaterThanOrEqual(0);
                expect(silenced).toBeLessThan(steps);
            }
        });
    }
});

describe('Docker templates run as non-root (DS-0002)', () => {
    const dir = path.join(process.cwd(), 'templates', 'docker');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.Dockerfile'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
        it(`${file} ends its final stage as a non-root USER`, () => {
            const runner = finalStage(readRepo(`templates/docker/${file}`));
            const users = runner.split('\n').filter((l) => /^\s*USER\s+\S+/i.test(l));
            expect(users.length).toBeGreaterThanOrEqual(1);
            const finalUser = users[users.length - 1].trim().split(/\s+/)[1];
            expect(['root', '0']).not.toContain(finalUser);
        });
    }
});

describe('Terraform templates suppress accepted AWS trade-offs', () => {
    it('s3 addon ignores CMK (0132) and WAF (0011)', () => {
        const tf = readRepo('templates/terraform/addons/s3.tf');
        expect(tf).toContain('trivy:ignore:AVD-AWS-0132');
        expect(tf).toContain('trivy:ignore:AVD-AWS-0011');
    });

    it('static site ignores CMK (0132) and WAF (0011)', () => {
        const tf = readRepo('templates/terraform/static/main.tf');
        expect(tf).toContain('trivy:ignore:AVD-AWS-0132');
        expect(tf).toContain('trivy:ignore:AVD-AWS-0011');
    });

    it('Valkey replication group ignores at-rest (0045) and transit (0051) encryption', () => {
        const tf = readRepo('templates/terraform/addons/redis.tf');
        expect(tf).toContain('trivy:ignore:AVD-AWS-0045');
        expect(tf).toContain('trivy:ignore:AVD-AWS-0051');
    });
});

describe('Shift-left: local test:iac matches blocking CI scans', () => {
    it('package.json exposes the local IaC hook', () => {
        const pkg = JSON.parse(readRepo('package.json'));
        expect(pkg.scripts['test:iac']).toBe('node ./scripts/test-iac.js');
    });

    it('scripts/test-iac.js renders to /tmp/grada-iac-test and runs blocking Docker scans', () => {
        const script = readRepo('scripts/test-iac.js');
        expect(script).toContain('/tmp/grada-iac-test');
        expect(script).toContain('init --target ecs --headless');
        expect(script).toContain('aquasec/trivy');
        expect(script).toContain('config');
        expect(script).toContain('--exit-code 1 --severity HIGH,CRITICAL');
        expect(script).toContain('ghcr.io/terraform-linters/tflint');
    });

    it('scripts/test-iac.js also renders and scans the static target', () => {
        const script = readRepo('scripts/test-iac.js');
        expect(script).toContain('/tmp/grada-iac-test-static');
        expect(script).toContain('init --target static --headless');
        expect(script).toContain('test-app-static-base');
    });

    it('scripts/test-iac.js warns and exits 0 without Docker', () => {
        const script = readRepo('scripts/test-iac.js');
        expect(script).toContain('Docker is required to run test:iac locally');
        expect(script).toContain('process.exit(0)');
    });

    it('iac-validation.yml runs the same blocking Trivy config command', () => {
        const yml = readRepo('.github/workflows/iac-validation.yml');
        expect(yml).toContain('aquasec/trivy config --exit-code 1 --severity HIGH,CRITICAL');
    });
});
