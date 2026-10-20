// Tier 1 E2E: full live lifecycle against real AWS (nightly/manual only).
// Skips gracefully without credentials. Validated in CI, not locally.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import path from 'node:path';
import {
    e2eEnv,
    assertPrerequisites,
    commandExists,
    makeTmpDir,
    removeDir,
    run,
    runCli,
    sleep,
    readBackendBucket,
    readBackendRegion,
    readTerraformOutput,
} from './helpers.js';

const env = e2eEnv({ mockAws: false });

// Minimal fixture app: an Express server the ALB can health-check. Written
// into the workspace before `init` so framework detection picks `node` and
// the lifecycle below deploys a bootable container instead of an empty dir.
const FIXTURE_PACKAGE_JSON = {
    name: 'tier1-fixture',
    version: '1.0.0',
    private: true,
    dependencies: { express: '4.21.2' },
};

const FIXTURE_INDEX_JS = `// Minimal Tier 1 fixture: Express server the ALB can health-check.
const express = require('express');

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

app.get('/', (req, res) => res.status(200).send('OK'));

app.listen(port, '0.0.0.0', () => {
    console.log(\`Tier 1 fixture listening on 0.0.0.0:\${port}\`);
});
`;
const STATUS_POLL_INTERVAL_MS = 15000;
const STATUS_POLL_BUDGET_MS = 6 * 60 * 1000;
const BUCKET_POLL_INTERVAL_MS = 10000;
const BUCKET_POLL_BUDGET_MS = 3 * 60 * 1000;

// Serial execution is mandatory (ordered lifecycle); the whole suite is
// skipped without credentials. (Vitest 5 cannot chain .serial.skipIf.)
describe.skipIf(!process.env.AWS_ACCESS_KEY_ID)('Tier 1: live lifecycle', () => {
    let dir;
    let suiteFailed = false;

    beforeAll(() => {
        assertPrerequisites();
        for (const cmd of ['docker', 'aws']) {
            if (!commandExists(cmd)) {
                throw new Error(
                    `Tier 1 E2E requires ${cmd} on PATH to build and push the fixture image.`
                );
            }
        }
        dir = makeTmpDir('tier1-live');
    });

    afterAll(() => {
        if (suiteFailed) {
            console.log(`Tier 1 workspace preserved for debugging: ${dir}`);
            return;
        }
        removeDir(dir);
    });

    async function step(fn) {
        try {
            await fn();
        } catch (error) {
            suiteFailed = true;
            throw error;
        }
    }

    it('init scaffolds the project', async () => {
        await step(async () => {
            fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(FIXTURE_PACKAGE_JSON, null, 2)}\n`);
            fs.writeFileSync(path.join(dir, 'index.js'), FIXTURE_INDEX_JS);

            const init = runCli(['init', '--target', 'ecs', '--headless'], { cwd: dir, env });
            expect(init.status).toBe(0);
            expect(fs.existsSync(path.join(dir, 'terraform', 'main.tf'))).toBe(true);
            // The fixture must resolve to the Node template (entrypoint
            // contract: CMD ["node", "index.js"]).
            expect(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf-8'))
                .toContain('CMD ["node", "index.js"]');
        });
    });

    it('install fixture dependencies', async () => {
        await step(async () => {
            const install = run('npm', ['install'], { cwd: dir, env });
            expect(install.status).toBe(0);
            // The Node Dockerfile runs `npm ci`, which requires the lockfile.
            expect(fs.existsSync(path.join(dir, 'package-lock.json'))).toBe(true);
        });
    });

    it('apply provisions infrastructure', async () => {
        await step(async () => {
            // The Tier-1 account hosts a permanent OIDC provider (shared
            // with the bedrock-sync role), so adopt it instead of creating
            // one — AWS allows a single provider per account.
            const oidcTfPath = path.join(dir, 'terraform', 'oidc.tf');
            const oidcTf = fs.readFileSync(oidcTfPath, 'utf-8');
            expect(oidcTf).toContain('variable "create_oidc_provider"');
            const adopted = oidcTf.replace(/default\s*=\s*true/, 'default     = false');
            expect(adopted).not.toBe(oidcTf);
            fs.writeFileSync(oidcTfPath, adopted);

            const apply = runCli(['apply', '--auto-approve'], { cwd: dir, env });
            expect(apply.status).toBe(0);
        });
    });

    it('push fixture image to ECR', async () => {
        await step(async () => {
            // `apply` only provisions the (empty) ECR repository on ECS
            // targets — Day-0 image seeding is Lambda-only — so the test
            // builds and pushes the fixture image itself, mirroring the
            // generated deploy.yml (build -> push :latest -> redeploy).
            const region = readBackendRegion(dir);
            const ecrUrl = readTerraformOutput(dir, 'ecr_repository_url', env);
            const image = `${ecrUrl}:latest`;
            const registry = ecrUrl.split('/')[0];

            const password = run('aws', ['ecr', 'get-login-password', '--region', region], { cwd: dir, env, capture: true });
            expect(password.status).toBe(0);

            const login = run('docker', ['login', '--username', 'AWS', '--password-stdin', registry], { cwd: dir, env, capture: true, input: password.stdout });
            expect(login.status).toBe(0);

            const build = run('docker', ['build', '-t', image, '.'], { cwd: dir, env });
            expect(build.status).toBe(0);

            const push = run('docker', ['push', image], { cwd: dir, env });
            expect(push.status).toBe(0);

            // The service was created against an empty repo; force a fresh
            // deployment now that :latest exists instead of waiting on the
            // scheduler's backoff.
            const project = path.posix.basename(ecrUrl).replace(/-repo$/, '');
            const deploy = run('aws', ['ecs', 'update-service', '--cluster', `${project}-cluster`, '--service', `${project}-service`, '--force-new-deployment', '--region', region], { cwd: dir, env });
            expect(deploy.status).toBe(0);
        });
    });

    it('status becomes healthy', async () => {
        await step(async () => {
            const deadline = Date.now() + STATUS_POLL_BUDGET_MS;
            let healthy = false;
            let lastOutput = '';
            while (Date.now() < deadline) {
                // --json exits 0 even when degraded, so the payload (not the
                // exit code) drives the loop; parse failures just mean "wait".
                const result = runCli(['status', '--json'], { cwd: dir, env, capture: true });
                lastOutput = result.output;
                try {
                    healthy = JSON.parse(result.stdout).healthy === true;
                } catch {
                    healthy = false;
                }
                if (healthy) break;
                await sleep(STATUS_POLL_INTERVAL_MS);
            }
            try {
                expect([healthy, lastOutput]).toEqual([true, expect.any(String)]);
            } catch (statusError) {
                // CI visibility: the poll loop timed out, so dump the
                // container and service diagnostics to the console before
                // failing. Both commands are synchronous (spawnSync) and
                // never throw on non-zero exit, so the original assertion
                // error is always the one that fails the test.
                console.log('Tier 1 status check failed: dumping CloudWatch logs and ECS diagnostics...');
                runCli(['logs', '--tail', '100'], { cwd: dir, env });
                runCli(['diagnose'], { cwd: dir, env });
                throw statusError;
            }

            const final = runCli(['status'], { cwd: dir, env });
            expect(final.status).toBe(0);
        });
    });

    it('destroy tears everything down', async () => {
        await step(async () => {
            const bucket = readBackendBucket(dir);
            const region = readBackendRegion(dir);

            const destroy = runCli(['destroy', '--yes'], { cwd: dir, env });
            expect(destroy.status).toBe(0);

            const s3 = new S3Client({ region });
            const deadline = Date.now() + BUCKET_POLL_BUDGET_MS;
            for (; ;) {
                try {
                    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
                } catch (error) {
                    if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) return;
                    throw error;
                }
                if (Date.now() >= deadline) {
                    throw new Error(`state bucket ${bucket} still exists after destroy`);
                }
                await sleep(BUCKET_POLL_INTERVAL_MS);
            }
        });
    });
});
