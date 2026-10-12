import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackPromptsMockFactory } from './helpers/clack.js';
import { telemetryMockFactory } from './helpers/telemetry.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { generateTemplates } from '../src/utils/generator.js';
import { runAdd, runAddDatabase } from '../src/commands/add.js';
import { runDomain } from '../src/commands/domain.js';

vi.mock('@clack/prompts', () => clackPromptsMockFactory());
vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));

function commandExists(cmd) {
    try {
        return spawnSync(cmd, ['--version'], { stdio: 'pipe' }).status === 0;
    } catch {
        return false;
    }
}

// Fail fast with a helpful error when the prerequisite is missing (same
// contract as the e2e helpers: terraform is a declared test dependency).
function assertTerraform() {
    if (!commandExists('terraform')) {
        throw new Error(
            'terraform-fmt tests require the Terraform CLI on PATH (https://developer.hashicorp.com/terraform/install).'
        );
    }
}

function baseConfig(overrides = {}) {
    return {
        PROJECT_NAME: 'fmtmatrix',
        REGION: 'us-east-2',
        PORT: '3000',
        CPU: '256',
        MEMORY: '512',
        COMPUTE_TIER: 'Micro',
        ESTIMATED_COST: '30.00',
        STATE_BUCKET: 'fmtmatrix-bucket-123',
        AWS_ACCOUNT_ID: '123456789012',
        HEALTH_CHECK_PATH: '/health',
        DESIRED_COUNT: '1',
        DEPLOY_BRANCH: 'main',
        BUILD_DIR: '',
        finalFramework: 'nextjs',
        NEEDS_DATABASE: true,
        DB_ENGINE: 'postgres',
        DISABLE_DEFAULT_CI: false,
        PROCFILE: null,
        VERCEL_RULES: null,
        VERCEL_EDGE_ROUTING: '',
        DOCKER_COMPOSE: null,
        ENABLE_PR_PREVIEWS: false,
        TASK_COMMAND: '',
        WORKER_COMMAND: '',
        DB_ENV_VARS: '',
        COMPOSE_WEB_ENV_VARS: '',
        EXTRA_CONTAINERS: '',
        TASK_SECRETS: '',
        INITIAL_SECRET_MAP: '{\n  }',
        SAFE_ALB_NAME: 'fmtmatrix-alb',
        ...overrides,
    };
}

async function expectFmtClean(dir) {
    const check = spawnSync('terraform', ['fmt', '-check', '-recursive'], { cwd: dir, encoding: 'utf8' });
    if (check.status !== 0) {
        // NOTE: -check -diff displays without writing; bare -diff would
        // format the tree as a side effect and hide the failure.
        const diff = spawnSync('terraform', ['fmt', '-check', '-diff', '-recursive'], { cwd: dir, encoding: 'utf8' });
        throw new Error(
            `terraform fmt -check failed in ${dir}:\n${check.stdout}\n--- diff ---\n${(diff.stdout || '').slice(0, 4000)}`
        );
    }
}

describe('terraform fmt cleanliness', () => {
    let dirs;

    beforeEach(() => {
        assertTerraform();
        vi.clearAllMocks();
        dirs = [];
    });

    afterEach(async () => {
        // GRADA_FMT_KEEP=1 preserves rendered trees for manual inspection.
        if (process.env.GRADA_FMT_KEEP !== '1') {
            for (const dir of dirs) {
                await fs.promises.rm(dir, { recursive: true, force: true });
            }
        }
        vi.restoreAllMocks();
    });

    async function freshDir(prefix) {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
        dirs.push(dir);
        await fs.promises.mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
        return dir;
    }

    it('ecs + postgres + worker + previews + compose sidecars is fmt-clean', async () => {
        const dir = await freshDir('fmt-ecs-');
        await generateTemplates(dir, baseConfig({
            // Multi-element commands: single-element arrays have no comma
            // and can't catch non-canonical join spacing.
            PROCFILE: { web: ['node', 'server.js'], worker: ['node', './dist/worker.cjs'] },
            ENABLE_PR_PREVIEWS: true,
            DOCKER_COMPOSE: [
                { name: 'web', image: 'myapp:latest', port: 3000, build: { context: '.' }, environment: { APP_KEY: 'yes' } },
                { name: 'cache', image: 'myapp-cache:latest', port: null, build: null, environment: { CACHE_SIZE: '128' } },
            ],
        }));
        await expectFmtClean(dir);
    }, 60000);

    it('ecs + compose web/sidecar commands (no Procfile) is fmt-clean', async () => {
        const dir = await freshDir('fmt-compose-cmd-');
        await generateTemplates(dir, baseConfig({
            DOCKER_COMPOSE: [
                { name: 'web', image: 'myapp:latest', port: 3000, build: { context: '.' }, command: 'node --inspect server.js', environment: { APP_KEY: 'yes' } },
                { name: 'cache', image: 'redis:7', port: null, build: null, command: ['redis-server', '--appendonly', 'yes'], environment: {} },
            ],
        }));
        await expectFmtClean(dir);
    }, 60000);

    it('ecs + aurora + full addon matrix is fmt-clean', async () => {
        const dir = await freshDir('fmt-addons-');
        await generateTemplates(dir, baseConfig({ DB_ENGINE: 'aurora-postgresql' }));
        for (const capability of ['storage:s3', 'db:dynamodb', 'db:redis', 'queue:sqs', 'ai:bedrock']) {
            const result = await runAdd({ cwd: dir, capability, region: 'us-east-2' });
            expect(result.ok).toBe(true);
        }
        const ses = await runAdd({ cwd: dir, capability: 'email:ses', region: 'us-east-2', domain: 'example.com' });
        expect(ses.ok).toBe(true);
        const cron = await runAdd({
            cwd: dir, capability: 'cron', region: 'us-east-2',
            schedule: 'rate(1 hour)', cronCommand: 'node ./dist/cron.cjs',
        });
        expect(cron.ok).toBe(true);
        await expectFmtClean(dir);
    }, 120000);

    it('lambda + mysql + s3 + cron is fmt-clean', async () => {
        const dir = await freshDir('fmt-lambda-');
        await generateTemplates(dir, baseConfig({
            TARGET: 'lambda', NEEDS_DATABASE: true, DB_ENGINE: 'mysql',
            PROCFILE: { web: ['python', '-m', 'app'] },
            DOCKER_COMPOSE: [
                { name: 'web', image: 'myapp:latest', port: 3000, build: { context: '.' }, environment: { APP_KEY: 'yes' } },
            ],
        }));
        const s3 = await runAdd({ cwd: dir, capability: 'storage:s3', region: 'us-east-2' });
        expect(s3.ok).toBe(true);
        const cron = await runAdd({
            cwd: dir, capability: 'cron', region: 'us-east-2',
            schedule: 'rate(1 hour)', cronCommand: 'node ./dist/cron.cjs',
        });
        expect(cron.ok).toBe(true);
        await expectFmtClean(dir);
    }, 120000);

    it('lambda + compose command (no Procfile) is fmt-clean', async () => {
        const dir = await freshDir('fmt-lambda-cmd-');
        await generateTemplates(dir, baseConfig({
            TARGET: 'lambda',
            DOCKER_COMPOSE: [
                { name: 'web', image: 'myapp:latest', port: 3000, build: { context: '.' }, command: 'node server.js', environment: {} },
            ],
        }));
        await expectFmtClean(dir);
    }, 60000);

    it('static target is fmt-clean', async () => {
        const dir = await freshDir('fmt-static-');
        await generateTemplates(dir, baseConfig({
            TARGET: 'static', finalFramework: 'static', NEEDS_DATABASE: false, BUILD_DIR: 'dist',
        }));
        await expectFmtClean(dir);
    }, 60000);

    it('ecs without database + post-init db add + domain add is fmt-clean', async () => {
        const dir = await freshDir('fmt-nodb-');
        await generateTemplates(dir, baseConfig({ NEEDS_DATABASE: false }));
        await expectFmtClean(dir);
        const db = await runAddDatabase(
            { cwd: dir, projectName: 'fmtmatrix', region: 'us-east-2' },
            'db:postgres'
        );
        expect(db.ok).toBe(true);
        const domain = await runDomain({ cwd: dir, subcommand: 'add', domain: 'example.com', zoneId: 'Z1234567890ABC' });
        expect(domain.ok).toBe(true);
        await expectFmtClean(dir);
    }, 120000);
});
