import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { generateTemplates, resolveDocDest, isManagedDoc, MANAGED_DOC_FALLBACK, LEGACY_MANAGED_DOC_FALLBACK, injectLambdaAdapter, convertDatabaseTfForLambda, addRandomProvider } from '../src/utils/generator.js';

describe('Infrastructure Generator', () => {
    const testTargetDir = path.join(process.cwd(), 'tests', '.tmp-test-env');

    beforeAll(async () => {
        await fs.mkdir(testTargetDir, { recursive: true });
    });

    afterAll(async () => {
        await fs.rm(testTargetDir, { recursive: true, force: true });
    });

    const matrix = [
        // 1. Backend APIs & Monoliths
        { name: 'Django_Postgres', framework: 'django', needsDb: true, buildDir: '' },
        { name: 'Rails_Postgres', framework: 'rails', needsDb: true, buildDir: '' },
        { name: 'Go_Distroless', framework: 'go', needsDb: false, buildDir: '' },
        { name: 'FastAPI_Python', framework: 'python', needsDb: false, buildDir: '' },

        // 2. Frontend & Meta-Frameworks
        { name: 'NextJS_Standalone', framework: 'nextjs', needsDb: false, buildDir: '.next/standalone' },
        { name: 'Nuxt_SSR', framework: 'nuxt', needsDb: false, buildDir: '.output/server' },
        { name: 'Vite_Static_SPA', framework: 'static', needsDb: false, buildDir: 'dist' },
        { name: 'SvelteKit_Node', framework: 'svelte', needsDb: false, buildDir: 'build' },

        // 3. Migration Engines
        {
            name: 'Heroku_Procfile_Migration',
            framework: 'django',
            needsDb: true,
            buildDir: '',
            procfile: { web: ['gunicorn config.wsgi'], worker: ['celery -A config worker'] }
        },
        {
            name: 'Vercel_Edge_Migration',
            framework: 'nextjs',
            needsDb: false,
            buildDir: '.next/standalone',
            vercelRouting: '{"routes": [{"src": "/api/(.*)", "dest": "https://api.example.com/$1"}]}'
        },
        {
            name: 'Docker_Compose_Sidecars',
            framework: 'node',
            needsDb: false,
            buildDir: '',
            dockerCompose: [{ name: 'web', port: 3000 }, { name: 'redis', image: 'redis:alpine' }]
        },

        // 4. Multi-Engine RDS
        {
            name: 'MySQL_RDS',
            framework: 'node',
            needsDb: true,
            buildDir: '',
            dbEngine: 'mysql'
        },
        {
            name: 'Aurora_Serverless',
            framework: 'node',
            needsDb: true,
            buildDir: '',
            dbEngine: 'aurora-postgresql'
        }
    ];

    for (const tc of matrix) {
        it(`generates correct infrastructure, CI/CD, and Dockerfile for ${tc.name}`, async () => {
            await fs.rm(testTargetDir, { recursive: true, force: true }).catch(() => { });
            await fs.mkdir(path.join(testTargetDir, '.github', 'workflows'), { recursive: true });

            const dummyConfig = {
                PROJECT_NAME: `test-${tc.name.toLowerCase()}`,
                REGION: 'us-east-2',
                PORT: '8000',
                CPU: '256',
                MEMORY: '512',
                COMPUTE_TIER: 'Micro',
                ESTIMATED_COST: '30.00',
                STATE_BUCKET: 'test-bucket-123',
                AWS_ACCOUNT_ID: '123456789012',
                HEALTH_CHECK_PATH: '/health',
                DESIRED_COUNT: '1',
                DEPLOY_BRANCH: 'main',
                BUILD_DIR: tc.buildDir,
                finalFramework: tc.framework,
                NEEDS_DATABASE: tc.needsDb,
                // Older cases omit DB_ENGINE entirely, proving the generator
                // defaults to postgres when the key is absent.
                ...(tc.dbEngine ? { DB_ENGINE: tc.dbEngine } : {}),
                DJANGO_WSGI: tc.framework === 'django' ? 'gunicorn config.wsgi' : '',
                DISABLE_DEFAULT_CI: false,
                PROCFILE: tc.procfile || null,
                VERCEL_RULES: tc.vercelRouting ? { routes: [] } : null,
                VERCEL_EDGE_ROUTING: tc.vercelRouting || '',
                DOCKER_COMPOSE: tc.dockerCompose || null,
                ENABLE_PR_PREVIEWS: true,
                TASK_COMMAND: '',
                WORKER_COMMAND: '',
                DB_ENV_VARS: '',
                COMPOSE_WEB_ENV_VARS: '',
                EXTRA_CONTAINERS: '',
                TASK_SECRETS: '',
                INITIAL_SECRET_MAP: '{\n  }',
                SAFE_ALB_NAME: `test-alb`,
            };

            await generateTemplates(testTargetDir, dummyConfig);

            const mainTfPath = path.join(testTargetDir, 'terraform', 'main.tf');
            const networkTfPath = path.join(testTargetDir, 'terraform', 'network.tf');
            const databaseTfPath = path.join(testTargetDir, 'terraform', 'database.tf');
            const workerTfPath = path.join(testTargetDir, 'terraform', 'worker.tf');

            const deployYmlPath = path.join(testTargetDir, '.github', 'workflows', 'deploy.yml');
            const previewYmlPath = path.join(testTargetDir, '.github', 'workflows', 'preview.yml');
            const teardownYmlPath = path.join(testTargetDir, '.github', 'workflows', 'teardown.yml');

            const dockerfilePath = path.join(testTargetDir, 'Dockerfile');

            // Read contents (falling back to a string if they correctly don't exist)
            const mainTfContent = await fs.readFile(mainTfPath, 'utf-8').catch(() => 'FILE_NOT_FOUND');
            const networkTfContent = await fs.readFile(networkTfPath, 'utf-8').catch(() => 'FILE_NOT_FOUND');
            const databaseTfContent = await fs.readFile(databaseTfPath, 'utf-8').catch(() => 'FILE_NOT_FOUND');
            const workerTfContent = await fs.readFile(workerTfPath, 'utf-8').catch(() => 'FILE_NOT_FOUND');

            const deployYmlContent = await fs.readFile(deployYmlPath, 'utf-8').catch(() => 'FILE_NOT_FOUND');
            const previewYmlContent = await fs.readFile(previewYmlPath, 'utf-8').catch(() => 'FILE_NOT_FOUND');
            const teardownYmlContent = await fs.readFile(teardownYmlPath, 'utf-8').catch(() => 'FILE_NOT_FOUND');

            const dockerfileContent = await fs.readFile(dockerfilePath, 'utf-8').catch(() => 'FILE_NOT_FOUND');

            // ECS deployment circuit breaker safety net (Phase 10, Sprint 1)
            expect(mainTfContent).toContain('deployment_circuit_breaker');
            expect(mainTfContent).toMatch(/enable\s*=\s*true/);
            expect(mainTfContent).toMatch(/rollback\s*=\s*true/);
            // Code-only deploys register revisions outside Terraform; the
            // service must not revert task_definition on the next apply.
            expect(mainTfContent).toContain('ignore_changes = [task_definition]');

            // Each code push must register a new immutable task revision.
            expect(deployYmlContent).toContain('ECS_TASK_FAMILY');
            expect(deployYmlContent).toContain('register-task-definition');
            expect(deployYmlContent).toContain('--task-definition');

            // Snapshot everything
            expect(mainTfContent).toMatchSnapshot(`${tc.name} - main.tf`);
            expect(networkTfContent).toMatchSnapshot(`${tc.name} - network.tf`);
            expect(databaseTfContent).toMatchSnapshot(`${tc.name} - database.tf`);
            expect(workerTfContent).toMatchSnapshot(`${tc.name} - worker.tf`);

            expect(deployYmlContent).toMatchSnapshot(`${tc.name} - deploy.yml`);
            expect(previewYmlContent).toMatchSnapshot(`${tc.name} - preview.yml`);
            expect(teardownYmlContent).toMatchSnapshot(`${tc.name} - teardown.yml`);

            expect(dockerfileContent).toMatchSnapshot(`${tc.name} - Dockerfile`);
        });
    }
});

describe('worker.tf without a database', () => {
    const noDbWorkerDir = path.join(process.cwd(), 'tests', '.tmp-nodb-worker-env');

    afterAll(async () => {
        await fs.rm(noDbWorkerDir, { recursive: true, force: true });
    });

    it('renders no dangling comma and a count-safe image reference', async () => {
        await fs.rm(noDbWorkerDir, { recursive: true, force: true }).catch(() => { });
        await fs.mkdir(path.join(noDbWorkerDir, '.github', 'workflows'), { recursive: true });

        await generateTemplates(noDbWorkerDir, {
            PROJECT_NAME: 'test-nodb-worker',
            REGION: 'us-east-2',
            PORT: '8000',
            CPU: '256',
            MEMORY: '512',
            COMPUTE_TIER: 'Micro',
            ESTIMATED_COST: '30.00',
            STATE_BUCKET: 'test-bucket-123',
            AWS_ACCOUNT_ID: '123456789012',
            HEALTH_CHECK_PATH: '/health',
            DESIRED_COUNT: '1',
            DEPLOY_BRANCH: 'main',
            BUILD_DIR: '',
            finalFramework: 'node',
            NEEDS_DATABASE: false,
            DISABLE_DEFAULT_CI: false,
            PROCFILE: { web: ['node', 'index.js'], worker: ['npm', 'run', 'worker'] },
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
            SAFE_ALB_NAME: 'test-alb',
        });

        const workerTf = await fs.readFile(path.join(noDbWorkerDir, 'terraform', 'worker.tf'), 'utf-8');
        expect(workerTf).toContain('command = ["npm","run","worker"]');
        // Empty {{DB_ENV_VARS}} must not leave a comma before the array close.
        expect(workerTf).not.toMatch(/,\s*\]/);
        // Count-guarded ECR repo: use the shared local like main.tf does.
        expect(workerTf).toContain('${local.ecr_url}');
        expect(workerTf).not.toContain('aws_ecr_repository.app.repository_url');
    });
});

describe('database env vars render as bare HCL references', () => {
    const dbDir = path.join(process.cwd(), 'tests', '.tmp-db-refs-env');

    afterAll(async () => {
        await fs.rm(dbDir, { recursive: true, force: true });
    });

    it('emits DB_HOST and DB_NAME without deprecated "${...}" wrappers', async () => {
        await fs.rm(dbDir, { recursive: true, force: true }).catch(() => { });
        await fs.mkdir(path.join(dbDir, '.github', 'workflows'), { recursive: true });

        await generateTemplates(dbDir, {
            PROJECT_NAME: 'test-db-refs',
            REGION: 'us-east-2',
            PORT: '8000',
            CPU: '256',
            MEMORY: '512',
            COMPUTE_TIER: 'Micro',
            ESTIMATED_COST: '30.00',
            STATE_BUCKET: 'test-bucket-123',
            AWS_ACCOUNT_ID: '123456789012',
            HEALTH_CHECK_PATH: '/health',
            DESIRED_COUNT: '1',
            DEPLOY_BRANCH: 'main',
            BUILD_DIR: '',
            finalFramework: 'node',
            NEEDS_DATABASE: true,
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
            SAFE_ALB_NAME: 'test-alb',
        });

        const mainTf = await fs.readFile(path.join(dbDir, 'terraform', 'main.tf'), 'utf-8');
        // The container port is always injected so app code (node, nestjs,
        // svelte, go) can bind process.env.PORT / $PORT to the ALB target.
        expect(mainTf).toContain('{ "name": "PORT", "value": "8000" }');
        expect(mainTf).toContain('{ "name": "DB_HOST", "value": aws_db_instance.postgres.address }');
        expect(mainTf).toContain('{ "name": "DB_NAME", "value": aws_db_instance.postgres.db_name }');
        expect(mainTf).not.toContain('"${aws_db_instance.postgres.address}"');
        expect(mainTf).not.toContain('"${aws_db_instance.postgres.db_name}"');

        const databaseTf = await fs.readFile(path.join(dbDir, 'terraform', 'database.tf'), 'utf-8');
        expect(databaseTf).toContain('db_name  = replace(local.app_name, "-", "_")');
        expect(databaseTf).not.toContain('replace("${local.app_name}"');
    });
});

describe('multi-engine database generation', () => {
    const engineDir = path.join(process.cwd(), 'tests', '.tmp-db-engines-env');

    afterAll(async () => {
        await fs.rm(engineDir, { recursive: true, force: true });
    });

    async function generateWithEngine(dbEngine) {
        const dir = path.join(engineDir, String(dbEngine).replace(/[^a-z0-9]+/gi, '-'));
        await fs.rm(dir, { recursive: true, force: true }).catch(() => { });
        await fs.mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });

        await generateTemplates(dir, {
            PROJECT_NAME: 'test-db-engine',
            REGION: 'us-east-2',
            PORT: '3000',
            CPU: '256',
            MEMORY: '512',
            COMPUTE_TIER: 'Micro',
            ESTIMATED_COST: '30.00',
            STATE_BUCKET: 'test-bucket-123',
            AWS_ACCOUNT_ID: '123456789012',
            HEALTH_CHECK_PATH: '/health',
            DESIRED_COUNT: '1',
            DEPLOY_BRANCH: 'main',
            BUILD_DIR: '',
            finalFramework: 'node',
            NEEDS_DATABASE: true,
            DB_ENGINE: dbEngine,
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
            SAFE_ALB_NAME: 'test-alb',
        });
        return {
            mainTf: await fs.readFile(path.join(dir, 'terraform', 'main.tf'), 'utf-8'),
            databaseTf: await fs.readFile(path.join(dir, 'terraform', 'database.tf'), 'utf-8'),
        };
    }

    it('generates MySQL 8.0 on port 3306 with a DB_ENGINE marker', async () => {
        const { mainTf, databaseTf } = await generateWithEngine('mysql');
        expect(databaseTf).toContain('resource "aws_db_instance" "postgres"');
        expect(databaseTf).toContain('engine            = "mysql"');
        expect(databaseTf).toContain('engine_version    = "8.0"');
        expect(databaseTf).toContain('from_port       = 3306');
        expect(mainTf).toContain('{ "name": "DB_PORT", "value": "3306" }');
        expect(mainTf).toContain('{ "name": "DB_ENGINE", "value": "mysql" }');
        expect(mainTf).toContain('{ "name": "DB_HOST", "value": aws_db_instance.postgres.address }');
        // RDS MySQL db_name is alphanumeric-only: dashes are stripped, not underscored.
        expect(databaseTf).toContain('db_name  = replace(local.app_name, "-", "")');
        expect(databaseTf).not.toContain('replace(local.app_name, "-", "_")');
    });

    it('generates an Aurora Serverless v2 scale-to-zero cluster', async () => {
        const { mainTf, databaseTf } = await generateWithEngine('aurora-postgresql');
        expect(databaseTf).toContain('resource "aws_rds_cluster" "postgres"');
        expect(databaseTf).toContain('resource "aws_rds_cluster_instance" "postgres"');
        expect(databaseTf).toContain('engine             = "aurora-postgresql"');
        // engine_version is omitted on the cluster (AWS retires pinned minors like
        // 16.4); the instance inherits it from the cluster instead.
        expect(databaseTf).not.toContain('engine_version     = "16.4"');
        expect(databaseTf).toContain('engine_version     = aws_rds_cluster.postgres.engine_version');
        expect(databaseTf).toContain('instance_class     = "db.serverless"');
        expect(databaseTf).toContain('min_capacity             = 0');
        expect(databaseTf).toContain('max_capacity             = 2');
        expect(databaseTf).toContain('seconds_until_auto_pause = 300');
        expect(databaseTf).toContain('ignore_changes = [availability_zones]');
        expect(mainTf).toContain('{ "name": "DB_HOST", "value": aws_rds_cluster.postgres.endpoint }');
        expect(mainTf).toContain('{ "name": "DB_NAME", "value": aws_rds_cluster.postgres.database_name }');
        expect(mainTf).toContain('{ "name": "DB_ENGINE", "value": "aurora-postgresql" }');
        expect(mainTf).toContain('aws_rds_cluster.postgres.master_user_secret[0].secret_arn');
        // Aurora database_name is alphanumeric-only: dashes are stripped, not underscored.
        expect(databaseTf).toContain('database_name   = replace(local.app_name, "-", "")');
        expect(databaseTf).not.toContain('replace(local.app_name, "-", "_")');
    });
});

describe('Generator gitignore handling of secret_keys.json', () => {
    const gitignoreTargetDir = path.join(process.cwd(), 'tests', '.tmp-gitignore-env');

    const baseConfig = {
        PROJECT_NAME: 'test-gitignore',
        REGION: 'us-east-2',
        PORT: '8000',
        CPU: '256',
        MEMORY: '512',
        COMPUTE_TIER: 'Micro',
        ESTIMATED_COST: '30.00',
        STATE_BUCKET: 'test-bucket-123',
        AWS_ACCOUNT_ID: '123456789012',
        HEALTH_CHECK_PATH: '/health',
        DESIRED_COUNT: '1',
        DEPLOY_BRANCH: 'main',
        BUILD_DIR: '',
        finalFramework: 'node',
        NEEDS_DATABASE: false,
        DISABLE_DEFAULT_CI: false,
        PROCFILE: null,
        VERCEL_RULES: null,
        VERCEL_EDGE_ROUTING: '',
        DOCKER_COMPOSE: null,
        ENABLE_PR_PREVIEWS: true,
        TASK_COMMAND: '',
        WORKER_COMMAND: '',
        DB_ENV_VARS: '',
        COMPOSE_WEB_ENV_VARS: '',
        EXTRA_CONTAINERS: '',
        TASK_SECRETS: '',
        INITIAL_SECRET_MAP: '{\n  }',
        SAFE_ALB_NAME: 'test-alb',
    };

    afterAll(async () => {
        await fs.rm(gitignoreTargetDir, { recursive: true, force: true });
    });

    it('does not ignore terraform/secret_keys.json in a fresh .gitignore', async () => {
        await fs.rm(gitignoreTargetDir, { recursive: true, force: true }).catch(() => { });
        await fs.mkdir(path.join(gitignoreTargetDir, '.github', 'workflows'), { recursive: true });

        await generateTemplates(gitignoreTargetDir, baseConfig);

        const gitignore = await fs.readFile(path.join(gitignoreTargetDir, '.gitignore'), 'utf-8');
        const activeRules = gitignore.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
        expect(activeRules).not.toContain('terraform/secret_keys.json');
        // Sanity: genuinely sensitive/local files must still be ignored
        expect(gitignore).toContain('terraform/.terraform/');
        expect(gitignore).toContain('.env');

        const keysFile = await fs.readFile(path.join(gitignoreTargetDir, 'terraform', 'secret_keys.json'), 'utf-8');
        expect(keysFile).toBe('[]');
    });

    it('does not append a secret_keys.json ignore rule to an existing .gitignore', async () => {
        await fs.rm(gitignoreTargetDir, { recursive: true, force: true }).catch(() => { });
        await fs.mkdir(path.join(gitignoreTargetDir, '.github', 'workflows'), { recursive: true });
        await fs.writeFile(path.join(gitignoreTargetDir, '.gitignore'), 'node_modules/\n');

        await generateTemplates(gitignoreTargetDir, baseConfig);

        const gitignore = await fs.readFile(path.join(gitignoreTargetDir, '.gitignore'), 'utf-8');
        expect(gitignore).not.toContain('secret_keys.json');
        expect(gitignore).toContain('terraform/.terraform/');
    });
});

describe('Generator doc ownership & secret_keys preservation', () => {
    const docTargetDir = path.join(process.cwd(), 'tests', '.tmp-doc-ownership-env');

    const minimalConfig = {
        PROJECT_NAME: 'test-docs',
        REGION: 'us-east-2',
        PORT: '8000',
        CPU: '256',
        MEMORY: '512',
        COMPUTE_TIER: 'Micro',
        ESTIMATED_COST: '30.00',
        STATE_BUCKET: 'test-bucket-123',
        AWS_ACCOUNT_ID: '123456789012',
        HEALTH_CHECK_PATH: '/health',
        DESIRED_COUNT: '1',
        DEPLOY_BRANCH: 'main',
        BUILD_DIR: '',
        finalFramework: 'node',
        NEEDS_DATABASE: false,
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
        SAFE_ALB_NAME: 'test-alb',
    };

    const MANAGED_README = '# test-docs\n\n* **Estimated Monthly Cost:** ~$30.00/month\n';
    const USER_README = '# my cool app\n\nMy own docs.\n';
    const USER_DEPLOYMENT = '# my deploy notes\n\nCustom content.\n';

    beforeEach(async () => {
        await fs.rm(docTargetDir, { recursive: true, force: true }).catch(() => { });
        await fs.mkdir(docTargetDir, { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(docTargetDir, { recursive: true, force: true }).catch(() => { });
    });

    it('preserves previously pushed secret keys instead of resetting to []', async () => {
        await fs.mkdir(path.join(docTargetDir, 'terraform'), { recursive: true });
        await fs.writeFile(path.join(docTargetDir, 'terraform', 'secret_keys.json'), '["API_KEY"]');
        await generateTemplates(docTargetDir, minimalConfig);
        const keysFile = await fs.readFile(path.join(docTargetDir, 'terraform', 'secret_keys.json'), 'utf-8');
        expect(keysFile).toBe('["API_KEY"]');
    });

    it('creates an empty secret_keys.json when absent', async () => {
        await generateTemplates(docTargetDir, minimalConfig);
        const keysFile = await fs.readFile(path.join(docTargetDir, 'terraform', 'secret_keys.json'), 'utf-8');
        expect(keysFile).toBe('[]');
    });

    it('resolveDocDest never selects a user-owned file', async () => {
        expect(resolveDocDest(docTargetDir)).toBe('README.md');

        await fs.writeFile(path.join(docTargetDir, 'README.md'), USER_README);
        expect(resolveDocDest(docTargetDir)).toBe('DEPLOYMENT.md');

        await fs.writeFile(path.join(docTargetDir, 'DEPLOYMENT.md'), USER_DEPLOYMENT);
        expect(resolveDocDest(docTargetDir)).toBe(MANAGED_DOC_FALLBACK);

        await fs.writeFile(path.join(docTargetDir, MANAGED_DOC_FALLBACK), USER_DEPLOYMENT);
        expect(resolveDocDest(docTargetDir)).toBe(LEGACY_MANAGED_DOC_FALLBACK);

        await fs.writeFile(path.join(docTargetDir, LEGACY_MANAGED_DOC_FALLBACK), USER_DEPLOYMENT);
        expect(resolveDocDest(docTargetDir)).toBeNull();
    });

    it('resolveDocDest prefers updating managed docs in place', async () => {
        await fs.writeFile(path.join(docTargetDir, 'README.md'), MANAGED_README);
        expect(resolveDocDest(docTargetDir)).toBe('README.md');

        await fs.rm(path.join(docTargetDir, 'README.md'));
        await fs.writeFile(path.join(docTargetDir, 'README.md'), USER_README);
        await fs.writeFile(path.join(docTargetDir, 'DEPLOYMENT.md'), MANAGED_README);
        expect(resolveDocDest(docTargetDir)).toBe('DEPLOYMENT.md');
    });

    it('writes DEPLOYMENT.md for user READMEs and appends the notice exactly once', async () => {
        await fs.writeFile(path.join(docTargetDir, 'README.md'), USER_README);
        await generateTemplates(docTargetDir, minimalConfig);
        await generateTemplates(docTargetDir, minimalConfig);

        const readme = await fs.readFile(path.join(docTargetDir, 'README.md'), 'utf-8');
        expect(readme).toContain(USER_README.trim());
        expect(readme.match(/## 🚀 Deployment/g)).toHaveLength(1);
        expect(readme).toContain('./DEPLOYMENT.md');

        const deployment = await fs.readFile(path.join(docTargetDir, 'DEPLOYMENT.md'), 'utf-8');
        expect(deployment).toContain('Estimated Fixed Monthly Baseline:');
    });

    it('falls back to GRADA.md when README and DEPLOYMENT are user-owned', async () => {
        await fs.writeFile(path.join(docTargetDir, 'README.md'), USER_README);
        await fs.writeFile(path.join(docTargetDir, 'DEPLOYMENT.md'), USER_DEPLOYMENT);
        await generateTemplates(docTargetDir, minimalConfig);

        expect(await fs.readFile(path.join(docTargetDir, 'README.md'), 'utf-8')).toContain(USER_README.trim());
        expect(await fs.readFile(path.join(docTargetDir, 'DEPLOYMENT.md'), 'utf-8')).toBe(USER_DEPLOYMENT);
        const fallback = await fs.readFile(path.join(docTargetDir, MANAGED_DOC_FALLBACK), 'utf-8');
        expect(fallback).toContain('Estimated Fixed Monthly Baseline:');
        expect(isManagedDoc(fallback)).toBe(true);
    });

    it('keeps updating a managed legacy DEPLOY-STACK.md in place', async () => {
        await fs.writeFile(path.join(docTargetDir, 'README.md'), USER_README);
        await fs.writeFile(path.join(docTargetDir, 'DEPLOYMENT.md'), USER_DEPLOYMENT);
        await fs.writeFile(path.join(docTargetDir, MANAGED_DOC_FALLBACK), USER_DEPLOYMENT);
        await fs.writeFile(path.join(docTargetDir, LEGACY_MANAGED_DOC_FALLBACK), MANAGED_README);
        expect(resolveDocDest(docTargetDir)).toBe(LEGACY_MANAGED_DOC_FALLBACK);
        await generateTemplates(docTargetDir, minimalConfig);

        const legacy = await fs.readFile(path.join(docTargetDir, LEGACY_MANAGED_DOC_FALLBACK), 'utf-8');
        expect(legacy).toContain('Estimated Fixed Monthly Baseline:');
        expect(await fs.readFile(path.join(docTargetDir, MANAGED_DOC_FALLBACK), 'utf-8')).toBe(USER_DEPLOYMENT);
    });

    it('skips doc generation entirely when every candidate is user-owned', async () => {
        await fs.writeFile(path.join(docTargetDir, 'README.md'), USER_README);
        await fs.writeFile(path.join(docTargetDir, 'DEPLOYMENT.md'), USER_DEPLOYMENT);
        await fs.writeFile(path.join(docTargetDir, MANAGED_DOC_FALLBACK), USER_DEPLOYMENT);
        await fs.writeFile(path.join(docTargetDir, LEGACY_MANAGED_DOC_FALLBACK), USER_DEPLOYMENT);
        await generateTemplates(docTargetDir, minimalConfig);

        expect(await fs.readFile(path.join(docTargetDir, 'README.md'), 'utf-8')).toBe(USER_README);
        expect(await fs.readFile(path.join(docTargetDir, 'DEPLOYMENT.md'), 'utf-8')).toBe(USER_DEPLOYMENT);
        expect(await fs.readFile(path.join(docTargetDir, LEGACY_MANAGED_DOC_FALLBACK), 'utf-8')).toBe(USER_DEPLOYMENT);
    });

    it('updates a managed README in place without creating DEPLOYMENT.md', async () => {
        await fs.writeFile(path.join(docTargetDir, 'README.md'), MANAGED_README);
        await generateTemplates(docTargetDir, minimalConfig);

        const readme = await fs.readFile(path.join(docTargetDir, 'README.md'), 'utf-8');
        expect(readme).toContain('Estimated Fixed Monthly Baseline:');
        expect(readme).toContain('30.00');
        await expect(fs.stat(path.join(docTargetDir, 'DEPLOYMENT.md'))).rejects.toThrow();
    });
});
describe('Infrastructure Generator: --target lambda', () => {
    const lambdaTargetDir = path.join(process.cwd(), 'tests', '.tmp-test-env-lambda');

    beforeAll(async () => {
        await fs.mkdir(lambdaTargetDir, { recursive: true });
    });

    afterAll(async () => {
        await fs.rm(lambdaTargetDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        await fs.rm(lambdaTargetDir, { recursive: true, force: true });
        await fs.mkdir(lambdaTargetDir, { recursive: true });
    });

    function lambdaConfig(overrides = {}) {
        return {
            PROJECT_NAME: 'test-lambda',
            REGION: 'us-east-2',
            PORT: '3000',
            CPU: '256',
            MEMORY: '512',
            COMPUTE_TIER: 'Micro',
            ESTIMATED_COST: '0.80',
            STATE_BUCKET: 'test-bucket-123',
            AWS_ACCOUNT_ID: '123456789012',
            HEALTH_CHECK_PATH: '/',
            DESIRED_COUNT: '1',
            DEPLOY_BRANCH: 'main',
            BUILD_DIR: '',
            finalFramework: 'node',
            NEEDS_DATABASE: false,
            DB_ENGINE: 'postgres',
            DJANGO_WSGI: '',
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
            SAFE_ALB_NAME: 'test-lambda',
            TARGET: 'lambda',
            ...overrides,
        };
    }

    async function readTf(name) {
        return fs.readFile(path.join(lambdaTargetDir, 'terraform', name), 'utf-8');
    }

    it('writes the serverless topology with no ECS resources', async () => {
        await generateTemplates(lambdaTargetDir, lambdaConfig());

        const mainTf = await readTf('main.tf');
        expect(mainTf).toContain('resource "aws_lambda_function" "app"');
        expect(mainTf).toContain('image_uri     = "${local.ecr_url}:latest"');
        expect(mainTf).toContain('ignore_changes = [image_uri]');
        expect(mainTf).toContain('resource "aws_apigatewayv2_api" "main"');
        expect(mainTf).toContain('resource "aws_apigatewayv2_integration" "lambda"');
        expect(mainTf).toContain('resource "aws_lambda_permission" "apigw"');
        expect(mainTf).toContain('output "api_gateway_url"');
        expect(mainTf).not.toContain('aws_ecs_service');
        expect(mainTf).not.toContain('aws_lb');
        expect(mainTf).toContain('AWSLambdaVPCAccessExecutionRole');

        const cloudfrontTf = await readTf('cloudfront.tf');
        expect(cloudfrontTf).toContain('replace(aws_apigatewayv2_api.main.api_endpoint, "https://", "")');
        expect(cloudfrontTf).toContain('origin_protocol_policy = "https-only"');
        expect(cloudfrontTf).not.toContain('aws_lb.main.dns_name');

        const deployYml = await fs.readFile(path.join(lambdaTargetDir, '.github', 'workflows', 'deploy.yml'), 'utf-8');
        expect(deployYml).toContain('aws lambda update-function-code');
        expect(deployYml).toContain('aws lambda wait function-updated');
        expect(deployYml).toContain('--platform linux/amd64');
        expect(deployYml).not.toContain('Force ECS deployment');
    });

    it('never provisions worker.tf, even with a Procfile worker process', async () => {
        await generateTemplates(lambdaTargetDir, lambdaConfig({
            PROCFILE: { web: ['node', 'index.js'], worker: ['node', 'worker.js'] },
        }));
        await expect(fs.stat(path.join(lambdaTargetDir, 'terraform', 'worker.tf'))).rejects.toThrow();
    });

    it('maps Procfile web commands to image_config and omits it when empty', async () => {
        await generateTemplates(lambdaTargetDir, lambdaConfig({
            PROCFILE: { web: ['gunicorn', 'config.wsgi'] },
        }));
        const mainTf = await readTf('main.tf');
        expect(mainTf).toContain('image_config {');
        expect(mainTf).toContain('command = ["sh","-c","gunicorn config.wsgi"]');

        await fs.rm(lambdaTargetDir, { recursive: true, force: true });
        await generateTemplates(lambdaTargetDir, lambdaConfig());
        expect(await readTf('main.tf')).not.toContain('image_config');
    });

    it.each(['postgres', 'mysql', 'aurora-postgresql'])('wires VPC + env password for %s without Secrets Manager lookups', async (engine) => {
        await generateTemplates(lambdaTargetDir, lambdaConfig({ NEEDS_DATABASE: true, DB_ENGINE: engine }));

        const mainTf = await readTf('main.tf');
        expect(mainTf).toContain('vpc_config {');
        expect(mainTf).toContain('DB_PASSWORD = random_password.db_password.result');
        expect(mainTf).toContain('DB_USER = "dbadmin"');
        if (engine !== 'postgres') {
            expect(mainTf).toContain(`DB_ENGINE = "${engine}"`);
        }

        const databaseTf = await readTf('database.tf');
        expect(databaseTf).toContain('password = random_password.db_password.result');
        expect(databaseTf).toContain('resource "random_password" "db_password"');
        expect(databaseTf).not.toContain('manage_master_user_password');
        expect(databaseTf).not.toContain('rds_secret_access');

        const backendTf = await readTf('backend.tf');
        expect(backendTf).toContain('hashicorp/random');
    });

    it('leaves non-database functions outside the VPC', async () => {
        await generateTemplates(lambdaTargetDir, lambdaConfig());
        const mainTf = await readTf('main.tf');
        expect(mainTf).not.toContain('vpc_config');
        await expect(fs.stat(path.join(lambdaTargetDir, 'terraform', 'database.tf'))).rejects.toThrow();
        expect(await readTf('backend.tf')).not.toContain('hashicorp/random');
    });

    it('injects the Lambda Web Adapter into every framework Dockerfile', async () => {
        for (const framework of ['node', 'nestjs', 'nextjs', 'nuxt', 'svelte', 'python', 'django', 'rails', 'go', 'static']) {
            await fs.rm(lambdaTargetDir, { recursive: true, force: true });
            await generateTemplates(lambdaTargetDir, lambdaConfig({ finalFramework: framework }));
            const dockerfile = await fs.readFile(path.join(lambdaTargetDir, 'Dockerfile'), 'utf-8');
            expect(dockerfile).toContain('COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter');
            expect(dockerfile).toContain('ENV AWS_LWA_PORT=3000');
            // The adapter copy precedes any USER switch (root-owned /opt).
            const copyIdx = dockerfile.indexOf('/lambda-adapter /opt/extensions');
            const userIdx = dockerfile.search(/^\s*USER\s/m);
            if (userIdx !== -1) expect(copyIdx).toBeLessThan(userIdx);
            // Templates that already set PORT keep exactly one such line.
            expect(dockerfile.match(/^\s*ENV\s+PORT=/gm)).toHaveLength(1);
        }
    });

    it('drops ALB listener rules and sidecars while keeping compose env vars', async () => {
        await generateTemplates(lambdaTargetDir, lambdaConfig({
            VERCEL_RULES: { redirects: [{ source: '/old', destination: '/new', permanent: true }] },
            DOCKER_COMPOSE: [
                { name: 'web', port: 3000, environment: { COMPOSE_KEY: 'compose-val' } },
                { name: 'redis', image: 'redis:alpine', environment: {} },
            ],
        }));
        expect(await readTf('network.tf')).not.toContain('aws_lb_listener_rule');
        const mainTf = await readTf('main.tf');
        expect(mainTf).toContain('COMPOSE_KEY = "compose-val"');
    });

    it('generates the lambda PR preview workflow when opted in', async () => {
        await generateTemplates(lambdaTargetDir, lambdaConfig({ ENABLE_PR_PREVIEWS: true }));
        const previewYml = await fs.readFile(path.join(lambdaTargetDir, '.github', 'workflows', 'preview.yml'), 'utf-8');
        expect(previewYml).toContain('api_gateway_url');
        expect(previewYml).toContain('aws lambda update-function-code');
        expect(previewYml).not.toContain('alb_direct_url');
        await expect(fs.stat(path.join(lambdaTargetDir, '.github', 'workflows', 'teardown.yml'))).resolves.toBeTruthy();
    });
});

describe('Infrastructure Generator: --target static', () => {
    const staticTargetDir = path.join(process.cwd(), 'tests', '.tmp-test-env-static');

    beforeAll(async () => {
        await fs.mkdir(staticTargetDir, { recursive: true });
    });

    afterAll(async () => {
        await fs.rm(staticTargetDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        await fs.rm(staticTargetDir, { recursive: true, force: true });
        await fs.mkdir(staticTargetDir, { recursive: true });
    });

    function staticConfig(overrides = {}) {
        return {
            PROJECT_NAME: 'test-static',
            REGION: 'us-east-2',
            PORT: '8080',
            CPU: '256',
            MEMORY: '512',
            COMPUTE_TIER: 'Micro (0.25 vCPU, 512MB RAM)',
            ESTIMATED_COST: '0.00',
            STATE_BUCKET: 'test-bucket-123',
            AWS_ACCOUNT_ID: '123456789012',
            HEALTH_CHECK_PATH: '/',
            DESIRED_COUNT: '1',
            DEPLOY_BRANCH: 'main',
            BUILD_DIR: 'dist',
            finalFramework: 'static',
            NEEDS_DATABASE: false,
            DB_ENGINE: 'postgres',
            DJANGO_WSGI: '',
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
            SAFE_ALB_NAME: 'test-static',
            TARGET: 'static',
            ...overrides,
        };
    }

    async function readTf(name) {
        return fs.readFile(path.join(staticTargetDir, 'terraform', name), 'utf-8');
    }

    it('writes the S3 + CloudFront topology with no compute resources', async () => {
        await generateTemplates(staticTargetDir, staticConfig());

        const mainTf = await readTf('main.tf');
        expect(mainTf).toContain('resource "aws_s3_bucket" "site"');
        expect(mainTf).toContain('resource "aws_cloudfront_origin_access_control" "site"');
        expect(mainTf).toContain('resource "aws_cloudfront_distribution" "site"');
        expect(mainTf).toContain('output "cloudfront_distribution_id"');
        expect(mainTf).toContain('"${local.app_name}-cdn"');
        expect(mainTf).not.toContain('aws_ecs_service');
        expect(mainTf).not.toContain('aws_lambda_function');
        expect(mainTf).not.toContain('aws_lb');
        expect(mainTf).not.toContain('aws_db_instance');

        await expect(fs.stat(path.join(staticTargetDir, 'terraform', 'network.tf'))).rejects.toThrow();
        await expect(fs.stat(path.join(staticTargetDir, 'terraform', 'secrets.tf'))).rejects.toThrow();
        await expect(fs.stat(path.join(staticTargetDir, 'terraform', 'database.tf'))).rejects.toThrow();
        await expect(fs.stat(path.join(staticTargetDir, 'terraform', 'cloudfront.tf'))).rejects.toThrow();
        await expect(fs.stat(path.join(staticTargetDir, 'terraform', 'oidc.tf'))).resolves.toBeTruthy();
        await expect(fs.stat(path.join(staticTargetDir, 'terraform', 'backend.tf'))).resolves.toBeTruthy();
        await expect(fs.stat(path.join(staticTargetDir, 'Dockerfile'))).rejects.toThrow();
        await expect(fs.stat(path.join(staticTargetDir, '.dockerignore'))).rejects.toThrow();
    });

    it('deploys by syncing the build output instead of building images', async () => {
        await generateTemplates(staticTargetDir, staticConfig());

        const deployYml = await fs.readFile(path.join(staticTargetDir, '.github', 'workflows', 'deploy.yml'), 'utf-8');
        expect(deployYml).toContain('npm run build');
        expect(deployYml).toContain('aws s3 sync');
        expect(deployYml).toContain('test-static-site-123456789012');
        expect(deployYml).toContain('aws cloudfront create-invalidation');
        expect(deployYml).not.toContain('docker build');
        expect(deployYml).not.toContain('Force ECS deployment');
    });

    it('renders the static deployment doc with a zero baseline', async () => {
        await generateTemplates(staticTargetDir, staticConfig());

        const readme = await fs.readFile(path.join(staticTargetDir, 'README.md'), 'utf-8');
        expect(readme).toContain('private S3 bucket');
        expect(readme).toContain('Estimated Fixed Monthly Baseline:');
        expect(readme).toContain('~$0.00/month');
        expect(readme).not.toContain('ECS Fargate');
    });

    it('never provisions worker.tf or database.tf, even when requested', async () => {
        await generateTemplates(staticTargetDir, staticConfig({
            NEEDS_DATABASE: true,
            PROCFILE: { web: ['npm', 'run', 'build'], worker: ['node', 'worker.js'] },
            WORKER_COMMAND: 'command = ["node", "worker.js"]',
        }));

        await expect(fs.stat(path.join(staticTargetDir, 'terraform', 'worker.tf'))).rejects.toThrow();
        await expect(fs.stat(path.join(staticTargetDir, 'terraform', 'database.tf'))).rejects.toThrow();
    });

    it('skips PR preview workflows when opted in', async () => {
        await generateTemplates(staticTargetDir, staticConfig({ ENABLE_PR_PREVIEWS: true }));

        await expect(fs.stat(path.join(staticTargetDir, '.github', 'workflows', 'preview.yml'))).rejects.toThrow();
        await expect(fs.stat(path.join(staticTargetDir, '.github', 'workflows', 'teardown.yml'))).rejects.toThrow();
    });
});

describe('Lambda generator helpers', () => {
    it('injectLambdaAdapter inserts after the last FROM and skips duplicates', () => {
        const multiStage = 'FROM node:22 AS builder\nRUN build\nFROM node:22 AS runner\nUSER node\nCMD ["node"]\n';
        const injected = injectLambdaAdapter(multiStage, '3000');
        expect(injected.indexOf('/lambda-adapter /opt/extensions')).toBeGreaterThan(injected.lastIndexOf('FROM'));
        expect(injected.indexOf('/lambda-adapter /opt/extensions')).toBeLessThan(injected.indexOf('USER node'));

        const withPort = 'FROM node:22\nENV PORT=3000\nCMD ["node"]\n';
        expect(injectLambdaAdapter(withPort, '3000').match(/^\s*ENV\s+PORT=/gm)).toHaveLength(1);

        expect(injectLambdaAdapter('no from here', '3000')).toBe('no from here');
    });

    it('injectLambdaAdapter ignores builder-stage PORT when checking the runner', () => {
        // Builder ENV does not propagate: a PORT set only in the builder
        // must not suppress the runner-stage injection.
        const builderPortOnly = 'FROM node:22 AS builder\nENV PORT=3000\nRUN build\nFROM node:22 AS runner\nCMD ["node"]\n';
        const injected = injectLambdaAdapter(builderPortOnly, '3000');
        expect(injected.match(/^\s*ENV\s+PORT=/gm)).toHaveLength(2);
        // ...while a runner-stage PORT still suppresses the duplicate.
        const runnerPort = 'FROM node:22 AS builder\nRUN build\nFROM node:22 AS runner\nENV PORT=3000\nCMD ["node"]\n';
        expect(injectLambdaAdapter(runnerPort, '3000').match(/^\s*ENV\s+PORT=/gm)).toHaveLength(1);
    });

    it('convertDatabaseTfForLambda is a no-op without AWS-managed passwords', () => {
        expect(convertDatabaseTfForLambda('resource "x" "y" {}')).toBe('resource "x" "y" {}');
        expect(convertDatabaseTfForLambda(null)).toBe('');
    });

    it('convertDatabaseTfForLambda uses master_password for Aurora clusters', async () => {
        const aurora = await fs.readFile(path.join(process.cwd(), 'templates', 'terraform', 'database-aurora-postgresql.tf'), 'utf-8');
        const converted = convertDatabaseTfForLambda(aurora);
        expect(converted).toMatch(/^\s*master_password = random_password\.db_password\.result/m);
        expect(converted).not.toMatch(/^\s*password = random_password/m);
        expect(converted).not.toContain('manage_master_user_password');
        expect(converted).toContain('resource "random_password" "db_password"');
    });

    it('convertDatabaseTfForLambda keeps password for RDS instances', async () => {
        for (const tpl of ['database.tf', 'database-mysql.tf']) {
            const content = await fs.readFile(path.join(process.cwd(), 'templates', 'terraform', tpl), 'utf-8');
            const converted = convertDatabaseTfForLambda(content);
            expect(converted).toMatch(/^\s*password = random_password\.db_password\.result/m);
            expect(converted).not.toContain('master_password');
        }
    });

    it('addRandomProvider is idempotent and ignores foreign backends', () => {
        const backend = 'terraform {\n  required_providers {\n    aws = {}\n    tls = {\n      source  = "hashicorp/tls"\n      version = "~> 4.0"\n    }\n  }\n}\n';
        const once = addRandomProvider(backend);
        expect(once).toContain('hashicorp/random');
        expect(addRandomProvider(once)).toBe(once);
        expect(addRandomProvider('unrelated')).toBe('unrelated');
    });
});
