// Structural hardening contract for the multi-stage Dockerfile templates.
//
// Snapshots pin exact template text; these assertions pin the security
// properties that must survive any template edit: multiple stages, a named
// runner, a non-root final user, and no package-manager installs past the
// last FROM (removal lines like `rm -rf .../npm` are allowed).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TEMPLATES_DIR = path.join(process.cwd(), 'templates', 'docker');
const HARDENED_TEMPLATES = ['node', 'python', 'django'];

function readTemplate(framework) {
    return fs.readFileSync(path.join(TEMPLATES_DIR, `${framework}.Dockerfile`), 'utf-8');
}

function runnerStage(content) {
    const lines = content.split('\n');
    let lastFromIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*FROM\s+/i.test(lines[i])) lastFromIdx = i;
    }
    return lines.slice(lastFromIdx + 1).join('\n');
}

describe('Dockerfile hardening (node, python, django)', () => {
    for (const framework of HARDENED_TEMPLATES) {
        it(`${framework}.Dockerfile uses a multi-stage build with a hardened runner`, () => {
            const content = readTemplate(framework);
            const fromLines = content.split('\n').filter((line) => /^\s*FROM\s+/i.test(line));
            expect(fromLines.length).toBeGreaterThanOrEqual(2);
            expect(fromLines[fromLines.length - 1]).toMatch(/\sAS\s+runner\s*$/i);

            const runner = runnerStage(content);
            const userLines = runner.split('\n').filter((line) => /^\s*USER\s+\S+/i.test(line));
            expect(userLines.length).toBeGreaterThanOrEqual(1);
            const finalUser = userLines[userLines.length - 1].trim().split(/\s+/)[1];
            expect(['root', '0']).not.toContain(finalUser);

            const installLines = runner.split('\n').filter((line) =>
                /\b(npm\s+(ci|install|i\b)|pip3?\s+install)\b/.test(line)
            );
            expect(installLines).toEqual([]);
        });
    }
});

describe('Nuxt template host/port binding (Nitro)', () => {
    it('nuxt.Dockerfile injects NITRO_HOST=0.0.0.0 and PORT so the ALB can reach the server', () => {
        const content = readTemplate('nuxt');
        // Nitro reads NITRO_HOST (not HOSTNAME, which is the Next.js var).
        expect(content).toMatch(/^\s*ENV\s+NITRO_HOST="?0\.0\.0\.0"?\s*$/m);
        expect(content).not.toMatch(/^\s*ENV\s+HOSTNAME=/m);
        expect(content).toMatch(/^\s*ENV\s+PORT=\{\{PORT\}\}\s*$/m);
    });
});

describe('Static template CVE patch (nginx-unprivileged)', () => {
    it('static.Dockerfile patches OS libs as root then drops back to nginx before COPY', () => {
        const content = readTemplate('static');
        const fromLines = content.split('\n').filter((line) => /^\s*FROM\s+/i.test(line));
        expect(fromLines.length).toBeGreaterThanOrEqual(2);

        const runner = runnerStage(content);
        expect(runner).toMatch(/apk\s+upgrade/i);

        const lines = runner.split('\n');
        const userIdxs = lines
            .map((line, idx) => (/^\s*USER\s+\S+/i.test(line) ? idx : -1))
            .filter((idx) => idx !== -1);
        expect(userIdxs.length).toBeGreaterThanOrEqual(2);
        const firstUser = lines[userIdxs[0]].trim().split(/\s+/)[1];
        expect(firstUser).toBe('root');
        const finalUser = lines[userIdxs[userIdxs.length - 1]].trim().split(/\s+/)[1];
        expect(['nginx', '101']).toContain(finalUser);

        const idxUpgrade = lines.findIndex((line) => /apk\s+upgrade/i.test(line));
        const idxCopy = lines.findIndex((line) => /^\s*COPY\s+/i.test(line));
        expect(idxUpgrade).toBeGreaterThan(userIdxs[0]);
        expect(userIdxs[userIdxs.length - 1]).toBeGreaterThan(idxUpgrade);
        expect(idxCopy).toBeGreaterThan(userIdxs[userIdxs.length - 1]);
    });
});

describe('stripped-runner list matches templates (drift guard)', () => {
    // frameworkUsesStrippedRunner drives the init-time npm/npx guard from a
    // hardcoded framework list (init renders its own Dockerfile, so the
    // framework template — not any existing file — is the right input).
    // This cross-check pins that list against template content in both
    // directions, so a template edit that adds or removes the npx strip
    // line fails loudly here instead of silently desyncing the guard.
    it('STRIPPED_RUNNER_FRAMEWORKS equals the set of templates that strip npx', async () => {
        const { STRIPPED_RUNNER_FRAMEWORKS, dockerfileStripsNpmShims } = await import('../src/utils/detector.js');
        const stripping = fs.readdirSync(TEMPLATES_DIR)
            .filter((file) => file.endsWith('.Dockerfile'))
            .map((file) => file.slice(0, -'.Dockerfile'.length))
            .filter((framework) => dockerfileStripsNpmShims(
                fs.readFileSync(path.join(TEMPLATES_DIR, `${framework}.Dockerfile`), 'utf-8')
            ))
            .sort();
        expect([...STRIPPED_RUNNER_FRAMEWORKS].sort()).toEqual(stripping);
    });

    it('SUPPORTED_FRAMEWORKS equals the set of Dockerfile templates', async () => {
        // Init fails fast on unknown --framework values; the accepted list
        // must stay exactly the set of renderable templates, or valid
        // frameworks get rejected (or invalid ones crash generation).
        const { SUPPORTED_FRAMEWORKS } = await import('../src/utils/detector.js');
        const templated = fs.readdirSync(TEMPLATES_DIR)
            .filter((file) => file.endsWith('.Dockerfile'))
            .map((file) => file.slice(0, -'.Dockerfile'.length))
            .sort();
        expect([...SUPPORTED_FRAMEWORKS].sort()).toEqual(templated);
    });
});
