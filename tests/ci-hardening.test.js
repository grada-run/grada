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
