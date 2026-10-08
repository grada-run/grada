// Migration-flows harness (roadmap: Migration Guide Deep Review). Tier-0
// style: real `bin/cli.js` headless runs with CI_MOCK_AWS — no AWS
// credentials, no deploys. Each flow mirrors its guide in
// apps/docs/src/content/docs/migrations/ (or guides/docker-compose.md):
// if a run contradicts the guide, either the CLI or the guide is wrong,
// and this suite is the tiebreaker.
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

beforeAll(() => {
    assertPrerequisites();
});

function validateTerraform(dir) {
    runTerraform(['init', '-backend=false'], { cwd: path.join(dir, 'terraform'), env });
    runTerraform(['validate'], { cwd: path.join(dir, 'terraform'), env });
}

function readTf(dir, file = 'main.tf') {
    return fs.readFileSync(path.join(dir, 'terraform', file), 'utf-8');
}

describe('Migrations: Vercel Next.js redirects', () => {
    function writeVercelRedirects(dir) {
        fs.writeFileSync(path.join(dir, 'vercel.json'), JSON.stringify({
            redirects: [
                { source: '/old/(.*)', destination: '/new', permanent: true },
                { source: '/tmp', destination: '/soon', permanent: false },
            ],
        }));
    }

    function nextFixture(dir, { standalone = true } = {}) {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { next: '15.0.0' } }));
        fs.writeFileSync(path.join(dir, 'next.config.js'), standalone ? "module.exports = { output: 'standalone' };\n" : 'module.exports = {};\n');
        writeVercelRedirects(dir);
    }

    function staticRedirectFixture(dir) {
        // --target static rejects container frameworks, so the static leg of
        // the redirect-skip flow needs a static-site app carrying vercel.json.
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { vite: '6.0.0' } }));
        writeVercelRedirects(dir);
    }

    it('translates redirects into ALB listener rules on ecs', async () => {
        await withTmpDir('mig-nextjs-ecs', async (dir) => {
            nextFixture(dir);
            const init = runCli(['init', '--target', 'ecs', '--headless'], { cwd: dir, env });
            expect(init.status).toBe(0);
            const networkTf = readTf(dir, 'network.tf');
            expect(networkTf).toContain('aws_lb_listener_rule');
            expect(networkTf).toContain('vercel_redirect_0');
            expect(networkTf).toContain('vercel_redirect_1');
            expect(networkTf).toContain('"/old/*"');
            expect(networkTf).toContain('HTTP_301');
            expect(networkTf).toContain('HTTP_302');
            validateTerraform(dir);
        });
    });

    it('skips redirects with the documented remedy on lambda and static', async () => {
        const legs = [
            { target: 'lambda', remedy: 'API Gateway routes', fixture: nextFixture },
            { target: 'static', remedy: 'CloudFront Functions', fixture: staticRedirectFixture },
        ];
        for (const { target, remedy, fixture } of legs) {
            await withTmpDir(`mig-nextjs-${target}`, async (dir) => {
                fixture(dir);
                const init = runCli(['init', '--target', target, '--headless'], { cwd: dir, env, capture: true });
                expect(init.status).toBe(0);
                expect(init.output).toContain('no ALB listener rules to translate them into');
                expect(init.output).toContain(remedy);
                for (const file of fs.readdirSync(path.join(dir, 'terraform'))) {
                    if (file.endsWith('.tf')) expect(readTf(dir, file)).not.toContain('vercel_redirect_');
                }
                validateTerraform(dir);
            });
        }
    });

    it('warns when output standalone is missing', async () => {
        await withTmpDir('mig-nextjs-standalone', async (dir) => {
            nextFixture(dir, { standalone: false });
            const init = runCli(['init', '--target', 'ecs', '--headless'], { cwd: dir, env, capture: true });
            expect(init.status).toBe(0);
            expect(init.output).toContain("missing \"output: 'standalone'\"");
            expect(init.output).toContain('migrations/nextjs-vercel-to-aws.md');
        });
    });
});

describe('Migrations: Vercel Astro adapter', () => {
    it('warns on the Vercel adapter and links the guide', async () => {
        await withTmpDir('mig-astro', async (dir) => {
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { astro: '5.0.0' } }));
            fs.writeFileSync(path.join(dir, 'astro.config.mjs'), "import vercel from '@astrojs/vercel/serverless';\nexport default { output: 'server', adapter: vercel() };\n");
            const init = runCli(['init', '--target', 'ecs', '--headless'], { cwd: dir, env, capture: true });
            expect(init.status).toBe(0);
            expect(init.output).toContain('locked into the Vercel adapter');
            expect(init.output).toContain('migrations/astro-vercel-to-aws.md');
            validateTerraform(dir);
        });
    });
});

describe('Migrations: Vercel SvelteKit adapter', () => {
    it('warns on the Vercel/Auto adapter and links the guide', async () => {
        await withTmpDir('mig-sveltekit', async (dir) => {
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { '@sveltejs/kit': '2.0.0' } }));
            fs.writeFileSync(path.join(dir, 'svelte.config.js'), "import adapter from '@sveltejs/adapter-auto';\nexport default { kit: { adapter: adapter() } };\n");
            const init = runCli(['init', '--target', 'ecs', '--headless'], { cwd: dir, env, capture: true });
            expect(init.status).toBe(0);
            expect(init.output).toContain('locked into the Vercel/Auto adapter');
            expect(init.output).toContain('migrations/sveltekit-vercel-to-aws.md');
            validateTerraform(dir);
        });
    });
});

describe('Migrations: Heroku Procfile + Postgres', () => {
    function herokuFixture(dir) {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { express: '4.0.0' } }));
        fs.writeFileSync(path.join(dir, 'Procfile'), 'web: node index.js\nworker: node worker.js\n');
    }

    function staticWorkerFixture(dir) {
        // --target static rejects container frameworks, so the static leg of
        // the worker-skip flow pairs a static-site app with a Procfile worker.
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { vite: '6.0.0' } }));
        fs.writeFileSync(path.join(dir, 'Procfile'), 'web: npm run preview\nworker: node worker.js\n');
    }

    it('renders the worker service on ecs', async () => {
        await withTmpDir('mig-heroku-ecs', async (dir) => {
            herokuFixture(dir);
            const init = runCli(['init', '--target', 'ecs', '--headless'], { cwd: dir, env });
            expect(init.status).toBe(0);
            const workerTf = readTf(dir, 'worker.tf');
            expect(workerTf).toContain('command = ["node","worker.js"]');
            validateTerraform(dir);
        });
    });

    it('skips the worker with a warning on lambda and static', async () => {
        const legs = [
            { target: 'lambda', detail: 'no ECS worker service', fixture: herokuFixture },
            { target: 'static', detail: 'S3 + CloudFront', fixture: staticWorkerFixture },
        ];
        for (const { target, detail, fixture } of legs) {
            await withTmpDir(`mig-heroku-${target}`, async (dir) => {
                fixture(dir);
                const init = runCli(['init', '--target', target, '--headless'], { cwd: dir, env, capture: true });
                expect(init.status).toBe(0);
                expect(init.output).toContain('Skipping the background worker');
                expect(init.output).toContain(detail);
                expect(fs.existsSync(path.join(dir, 'terraform', 'worker.tf'))).toBe(false);
                validateTerraform(dir);
            });
        }
    });

    it('pins the db import source interface the guide relies on', async () => {
        await withTmpDir('mig-heroku-dbimport', async (dir) => {
            const missing = runCli(['db', 'import', '--headless'], { cwd: dir, env, capture: true });
            expect(missing.status).toBe(1);
            expect(missing.output).toContain('Pass --file <path> or --from <url>');
            const both = runCli(['db', 'import', '--file', 'a.sql', '--from', 'postgres://x', '--headless'], { cwd: dir, env, capture: true });
            expect(both.status).toBe(1);
            expect(both.output).toContain('exactly one import source');
            // Live streaming (--from <heroku-url>) needs real AWS + a database
            // and stays Tier-1/manual; the guide flow builds on this surface.
        });
    });
});

describe('Migrations: Docker Compose sidecars', () => {
    function composeFixture(dir) {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { express: '4.0.0' } }));
        fs.writeFileSync(path.join(dir, 'docker-compose.yml'), [
            'services:',
            '  web:',
            '    image: myapp:latest',
            '    ports: ["4567:4567"]',
            '    environment:',
            '      API_URL: https://api.example.com',
            '    command: node server.js',
            '  redis:',
            '    image: redis:7-alpine',
            '  postgres:',
            '    image: postgres:16',
            '    environment:',
            '      POSTGRES_PASSWORD: secret',
            '',
        ].join('\n'));
    }

    it('co-locates sidecars and honors the web port on ecs', async () => {
        await withTmpDir('mig-compose-ecs', async (dir) => {
            composeFixture(dir);
            const init = runCli(['init', '--target', 'ecs', '--headless'], { cwd: dir, env });
            expect(init.status).toBe(0);
            const mainTf = readTf(dir);
            expect(mainTf).toContain('"redis"');
            expect(mainTf).toContain('"postgres"');
            expect(mainTf).toContain('4567');
            expect(mainTf).toContain('API_URL');
            expect(mainTf).toContain('command = ["node","server.js"]');
            validateTerraform(dir);
        });
    });

    it('injects env, keeps the command, and skips sidecars on lambda', async () => {
        await withTmpDir('mig-compose-lambda', async (dir) => {
            composeFixture(dir);
            const init = runCli(['init', '--target', 'lambda', '--headless'], { cwd: dir, env, capture: true });
            expect(init.status).toBe(0);
            expect(init.output).toContain('Skipping 2 Docker Compose sidecar(s) (redis, postgres)');
            const mainTf = readTf(dir);
            expect(mainTf).not.toContain('"redis"');
            expect(mainTf).toContain('API_URL');
            expect(mainTf).toContain('image_config');
            validateTerraform(dir);
        });
    });

    it('ignores compose entirely on static', async () => {
        await withTmpDir('mig-compose-static', async (dir) => {
            composeFixture(dir);
            const init = runCli(['init', '--framework', 'static', '--target', 'static', '--headless'], { cwd: dir, env });
            expect(init.status).toBe(0);
            expect(fs.existsSync(path.join(dir, 'Dockerfile'))).toBe(false);
            expect(readTf(dir)).toContain('aws_cloudfront_distribution');
            validateTerraform(dir);
        });
    });
});

describe('Migrations: static export gating', () => {
    it('rejects container frameworks on --target static', async () => {
        await withTmpDir('mig-static-reject', async (dir) => {
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { express: '4.0.0' } }));
            const result = runCli(['init', '--target', 'static', '--headless'], { cwd: dir, env, capture: true });
            expect(result.status).toBe(1);
            expect(result.output).toContain('--target static only supports static-site frameworks');
            expect(result.output).not.toMatch(/^\s+at\s/m);
            expect(fs.existsSync(path.join(dir, 'terraform'))).toBe(false);
        });
    });

    it('scaffolds a Vite app on --target static', async () => {
        await withTmpDir('mig-static-vite', async (dir) => {
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { vite: '6.0.0' } }));
            const init = runCli(['init', '--target', 'static', '--headless'], { cwd: dir, env });
            expect(init.status).toBe(0);
            expect(fs.existsSync(path.join(dir, 'Dockerfile'))).toBe(false);
            expect(readTf(dir)).toContain('aws_cloudfront_distribution');
            const deployYml = fs.readFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'utf-8');
            expect(deployYml).toContain('aws s3 sync');
            validateTerraform(dir);
        });
    });
});

describe('Migrations: static-export admission', () => {
    it("admits Next.js output:'export' on --target static with BUILD_DIR out", async () => {
        await withTmpDir('mig-static-nextexport', async (dir) => {
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { next: '15.0.0' } }));
            fs.writeFileSync(path.join(dir, 'next.config.js'), "module.exports = { output: 'export' };\n");
            const init = runCli(['init', '--target', 'static', '--headless'], { cwd: dir, env, capture: true });
            expect(init.status).toBe(0);
            // No container is rendered, so the standalone slimming warning
            // must stay silent (guide: "Static exports skip this").
            expect(init.output).not.toContain("output: 'standalone'");
            expect(fs.existsSync(path.join(dir, 'Dockerfile'))).toBe(false);
            expect(readTf(dir)).toContain('aws_cloudfront_distribution');
            const deployYml = fs.readFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'utf-8');
            expect(deployYml).toContain('BUILD_DIR: out');
            validateTerraform(dir);
        });
    });

    it('admits SvelteKit adapter-static on --target static with BUILD_DIR build', async () => {
        await withTmpDir('mig-static-svelte', async (dir) => {
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { '@sveltejs/kit': '2.0.0' } }));
            fs.writeFileSync(path.join(dir, 'svelte.config.js'), "import adapter from '@sveltejs/adapter-static';\nexport default { kit: { adapter: adapter() } };\n");
            const init = runCli(['init', '--target', 'static', '--headless'], { cwd: dir, env, capture: true });
            expect(init.status).toBe(0);
            // adapter-static is the supported shape: no adapter warning.
            expect(init.output).not.toContain('locked into');
            expect(fs.existsSync(path.join(dir, 'Dockerfile'))).toBe(false);
            expect(readTf(dir)).toContain('aws_cloudfront_distribution');
            const deployYml = fs.readFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'utf-8');
            expect(deployYml).toContain('BUILD_DIR: build');
            validateTerraform(dir);
        });
    });
});

describe('Migrations: target switching with backup', () => {
    it('backs up, regenerates, and swaps the file set', async () => {
        await withTmpDir('mig-switch', async (dir) => {
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { vite: '6.0.0' } }));
            const first = runCli(['init', '--target', 'ecs', '--headless'], { cwd: dir, env });
            expect(first.status).toBe(0);
            expect(fs.existsSync(path.join(dir, 'Dockerfile'))).toBe(true);
            fs.appendFileSync(path.join(dir, 'terraform', 'main.tf'), '\n# hand edit\n');

            // Hand edits are protected: a headless re-run refuses instead of
            // silently regenerating over them.
            const refused = runCli(['init', '--target', 'static', '--headless'], { cwd: dir, env, capture: true });
            expect(refused.status).toBe(1);
            expect(refused.output).toContain('were modified since generation');
            expect(refused.output).toContain('--force');
            expect(fs.existsSync(path.join(dir, 'Dockerfile'))).toBe(true);
            expect(fs.readdirSync(dir).some((e) => e.includes('.bak.'))).toBe(false);

            const second = runCli(['init', '--target', 'static', '--headless', '--force'], { cwd: dir, env });
            expect(second.status).toBe(0);
            const entries = fs.readdirSync(dir);
            expect(entries.some((e) => e.startsWith('terraform.bak.'))).toBe(true);
            expect(entries.some((e) => e.startsWith('Dockerfile.bak.'))).toBe(true);
            expect(fs.existsSync(path.join(dir, 'Dockerfile'))).toBe(false);
            const mainTf = readTf(dir);
            expect(mainTf).toContain('aws_cloudfront_distribution');
            expect(mainTf).not.toContain('# hand edit');
            const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
            expect(gitignore).toContain('*.bak.*');
            validateTerraform(dir);
        });
    });
});
