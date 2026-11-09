// Tier 2 E2E: live service acceptance against real AWS (nightly/manual only).
// Provisions every addon capability, then proves both resource existence
// (runner SDK assertions) and task IAM/VPC connectivity (in-container and
// simulated assertions). Skips gracefully without credentials. Validated in
// CI, not locally.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import {
    SQSClient,
    SendMessageCommand,
    ReceiveMessageCommand,
    ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import {
    ECSClient,
    DescribeServicesCommand,
    DescribeTaskDefinitionCommand,
    RegisterTaskDefinitionCommand,
} from '@aws-sdk/client-ecs';
import fs from 'node:fs';
import path from 'node:path';
import {
    e2eEnv,
    assertPrerequisites,
    assertImageBuildPrereqs,
    adoptSharedOidcProvider,
    buildAndPushImage,
    makeTmpDir,
    removeDir,
    run,
    runCli,
    sleep,
    readBackendRegion,
    readTerraformOutput,
} from './helpers.js';
import { resolveCluster, resolveService } from '../../src/utils/resolvers.js';

const env = e2eEnv({ mockAws: false });

const PROJECT_NAME = 'grada-e2e-t2';
const E2E_DOMAIN = 'grada-e2e-dummy.com';
const PINNED_MODEL = 'anthropic.claude-3-sonnet-20240229-v1:0';
const FROM_ADDRESS = `noreply@${E2E_DOMAIN}`;

// Fixture app: a Node project whose real dependencies (pg, ioredis) survive
// the Dockerfile's `npm ci --omit=dev`. index.js keeps framework detection
// and the image build valid; verify-vpc.js is the payload `grada run`
// executes inside the VPC (never served over HTTP, so no Express needed).
const FIXTURE_PACKAGE_JSON = {
    name: 'tier2-fixture',
    version: '1.0.0',
    private: true,
    dependencies: { pg: '^8.0.0', ioredis: '^5.0.0' },
};

const FIXTURE_INDEX_JS = `// Tier 2 fixture entrypoint (keeps the Node build valid; the suite's
// assertions run through verify-vpc.js via \`grada run\`, not this server).
console.log('Tier 2 fixture image built.');
`;

const FIXTURE_VERIFY_VPC_JS = `// Tier 2 VPC probe: executed by \`grada run\` inside the task network.
// DATABASE_URL is guaranteed by the runner (synthesized from DB_* when the
// task definition lacks it); REDIS_URL comes from the db:redis addon.
const { Client } = require('pg');
const Redis = require('ioredis');

(async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const result = await pg.query('SELECT 1 AS ok');
    if (result.rows[0].ok !== 1) throw new Error('RDS SELECT 1 mismatch');
    await pg.end();
    console.log('RDS: SELECT 1 ok');

    const redis = new Redis(process.env.REDIS_URL);
    await redis.set('grada-e2e-tier2', 'ok');
    const value = await redis.get('grada-e2e-tier2');
    if (value !== 'ok') throw new Error('Redis SET/GET mismatch');
    await redis.quit();
    console.log('Redis: SET/GET ok');
})().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
});
`;

const POLL_INTERVAL_MS = 10000;
const POLL_BUDGET_MS = 5 * 60 * 1000;
const SQS_RECEIVE_WAIT_SECONDS = 5;
const SQS_MAX_RECEIVES = 3;

// Retry an async probe until it yields a value (anything but null,
// undefined, or false) or the shared budget runs out. Unifies the
// eventually-consistent waits (CDN origin fetch, DLQ redrive).
async function pollUntil({ label, fn }) {
    const deadline = Date.now() + POLL_BUDGET_MS;
    for (; ;) {
        const result = await fn();
        if (result !== null && result !== undefined && result !== false) return result;
        if (Date.now() >= deadline) {
            throw new Error(`${label} timed out after ${POLL_BUDGET_MS / 1000}s`);
        }
        await sleep(POLL_INTERVAL_MS);
    }
}

// Serial execution is mandatory (ordered lifecycle); the whole suite is
// skipped without credentials. (Vitest 5 cannot chain .serial.skipIf.)
describe.skipIf(!process.env.AWS_ACCESS_KEY_ID)('Tier 2: live service acceptance', () => {
    let dir;
    let region;
    let taskDefArn;
    let tornDown = false;
    let suiteFailed = false;

    beforeAll(() => {
        assertPrerequisites();
        assertImageBuildPrereqs('Tier 2');
        dir = makeTmpDir('tier2-live');
    });

    // Safety net: destroy the stack when the suite crashes before (or inside)
    // the teardown step. The guard flag skips the re-run when teardown
    // already succeeded; a failed destroy preserves the workspace for the
    // workflow-level destroy -> gc fallback instead of throwing.
    afterAll(() => {
        if (!tornDown) {
            const destroy = runCli(['destroy', '--headless', '--yes', '--allow-data-loss'], { cwd: dir, env });
            if (destroy.status === 0) {
                tornDown = true;
            } else {
                console.log(`Tier 2 destroy failed; workspace preserved for the job fallback: ${dir}`);
                return;
            }
        }
        if (suiteFailed) {
            console.log(`Tier 2 workspace preserved for debugging: ${dir}`);
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

    it('init scaffolds the project with all addons', async () => {
        await step(async () => {
            fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(FIXTURE_PACKAGE_JSON, null, 2)}\n`);
            fs.writeFileSync(path.join(dir, 'index.js'), FIXTURE_INDEX_JS);
            fs.writeFileSync(path.join(dir, 'verify-vpc.js'), FIXTURE_VERIFY_VPC_JS);

            // Explicit --framework: the fixture carries no framework marker
            // (pg/ioredis are not detected), so detection must not decide.
            const init = runCli(['init', '--target', 'ecs', '--headless', '--framework', 'node', '--needsDatabase', '--db-engine', 'postgres',
                '--with', 'db:redis,queue:sqs,storage:s3,email:ses,ai:bedrock,db:dynamodb',
                '--domain', E2E_DOMAIN, '--project-name', PROJECT_NAME, '--model', PINNED_MODEL], { cwd: dir, env });
            expect(init.status).toBe(0);
            // Read the region before any other assertion: an early failure
            // must not poison later steps with an undefined region.
            region = readBackendRegion(dir);
            expect(fs.existsSync(path.join(dir, 'terraform', 'main.tf'))).toBe(true);
            expect(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf-8'))
                .toContain('CMD ["node", "index.js"]');

            // The Tier-2 account hosts a permanent OIDC provider (shared
            // with Tier 1), so adopt it instead of creating one — AWS
            // allows a single provider per account.
            adoptSharedOidcProvider(dir);
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
            const apply = runCli(['apply', '--headless', '--auto-approve'], { cwd: dir, env });
            expect(apply.status).toBe(0);
        });
    });

    it('push fixture image and register task definition revision', async () => {
        await step(async () => {
            // `apply` only provisions the (empty) ECR repository — the test
            // builds and pushes the fixture image itself, mirroring the
            // generated deploy.yml (build -> push :latest).
            const { image } = buildAndPushImage({ dir, env, region });

            // Register a new revision of the service's task definition with
            // only the image swapped: the container name, env vars, secrets,
            // and IAM roles must stay byte-identical so `grada run` maps the
            // revision. The slow service rollout is skipped on purpose —
            // the ephemeral task runs this revision directly.
            const ecs = new ECSClient({ region });
            const cluster = resolveCluster({}, dir);
            const service = resolveService({}, dir);
            const services = await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }));
            const currentTaskDef = services.services?.[0]?.taskDefinition;
            expect(currentTaskDef).toBeTruthy();

            const described = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: currentTaskDef }));
            const revision = { ...described.taskDefinition };
            delete revision.taskDefinitionArn;
            delete revision.revision;
            delete revision.status;
            delete revision.registeredAt;
            delete revision.registeredBy;
            delete revision.compatibilities;
            const containerName = revision.containerDefinitions?.[0]?.name;
            expect(containerName).toBeTruthy();
            revision.containerDefinitions = (revision.containerDefinitions || []).map((container) => ({
                ...container,
                image,
            }));

            const registered = await ecs.send(new RegisterTaskDefinitionCommand(revision));
            taskDefArn = registered.taskDefinition?.taskDefinitionArn;
            expect(taskDefArn).toBeTruthy();
            expect(registered.taskDefinition?.containerDefinitions?.[0]?.name).toBe(containerName);
        });
    });

    it('S3 presigned upload is served via CloudFront', async () => {
        await step(async () => {
            const s3 = new S3Client({ region });
            const bucket = readTerraformOutput(dir, 's3_bucket_name', env);
            const cdn = readTerraformOutput(dir, 's3_cdn_domain', env);
            const key = `tier2-${Date.now()}.txt`;
            const body = 'tier2-service-acceptance';

            const putUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
            const upload = await fetch(putUrl, { method: 'PUT', body });
            expect(upload.status).toBe(200);

            // First edge GET triggers the origin fetch; back off and retry.
            const served = await pollUntil({
                label: 'CloudFront GET',
                fn: async () => {
                    const response = await fetch(`https://${cdn}/${key}`);
                    return response.status === 200 ? await response.text() : null;
                },
            });
            expect(served).toBe(body);
        });
    });

    it('DynamoDB put/get round-trips', async () => {
        await step(async () => {
            const dynamo = new DynamoDBClient({ region });
            const table = readTerraformOutput(dir, 'dynamodb_table_name', env);
            const id = `tier2-${Date.now()}`;

            const put = await dynamo.send(new PutItemCommand({
                TableName: table,
                Item: { id: { S: id }, payload: { S: 'service-acceptance' } },
            }));
            expect(put.$metadata.httpStatusCode).toBe(200);

            const got = await dynamo.send(new GetItemCommand({
                TableName: table,
                Key: { id: { S: id } },
            }));
            expect(got.Item?.payload?.S).toBe('service-acceptance');
        });
    });

    it('SQS redrives to the DLQ after max receives', async () => {
        await step(async () => {
            const sqs = new SQSClient({ region });
            const queueUrl = readTerraformOutput(dir, 'sqs_queue_url', env);
            const dlqUrl = readTerraformOutput(dir, 'sqs_dlq_url', env);
            const payload = `tier2-${Date.now()}`;

            await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: payload }));

            // Drain the source queue so the message redrives immediately
            // instead of after the full visibility timeout. The loop reads
            // until empty (bounded past maxReceiveCount) rather than
            // counting receives: AWS moves the message once receives pass
            // the threshold, and any visibility reset may race the async
            // redrive and throw on a stale receipt handle — tolerated.
            for (let attempt = 1; attempt <= SQS_MAX_RECEIVES + 2; attempt++) {
                const received = await sqs.send(new ReceiveMessageCommand({
                    QueueUrl: queueUrl,
                    WaitTimeSeconds: SQS_RECEIVE_WAIT_SECONDS,
                }));
                const handle = received.Messages?.[0]?.ReceiptHandle;
                if (!handle) break;
                await sqs.send(new ChangeMessageVisibilityCommand({
                    QueueUrl: queueUrl,
                    ReceiptHandle: handle,
                    VisibilityTimeout: 0,
                })).catch(() => {});
            }

            const found = await pollUntil({
                label: 'DLQ redrive',
                fn: async () => {
                    const dlq = await sqs.send(new ReceiveMessageCommand({
                        QueueUrl: dlqUrl,
                        WaitTimeSeconds: SQS_RECEIVE_WAIT_SECONDS,
                    }));
                    return dlq.Messages?.[0]?.Body ?? null;
                },
            });
            expect(found).toBe(payload);
        });
    });

    it('grada run reaches RDS and Redis', async () => {
        await step(async () => {
            // Fail here (not inside AWS): spawnSync coerces an undefined
            // task-def ARN to the literal "--task-def undefined".
            expect(taskDefArn).toBeTruthy();
            // --cmd stays last: it greedily consumes the next token even
            // when it looks like a flag.
            const result = runCli(['run', '--headless', '--task-def', taskDefArn, '--cmd', 'node verify-vpc.js'], { cwd: dir, env });
            expect(result.status).toBe(0);
        });
    });

    it('SES SendEmail simulates Allowed for the task role', async () => {
        await step(async () => {
            // Simulation (not a real send) sidesteps the DKIM roadblock: the
            // dummy domain never verifies. The policy gates on FromAddress,
            // so the context entry is what turns the verdict Allowed.
            const iam = new IAMClient({ region });
            const roleArn = readTerraformOutput(dir, 'ecs_task_role_arn', env);
            const verdict = await iam.send(new SimulatePrincipalPolicyCommand({
                PolicySourceArn: roleArn,
                ActionNames: ['ses:SendEmail'],
                ResourceArns: ['*'],
                ContextEntries: [{
                    ContextKeyName: 'ses:FromAddress',
                    ContextKeyValues: [FROM_ADDRESS],
                    ContextKeyType: 'string',
                }],
            }));
            expect(verdict.EvaluationResults?.[0]?.EvalDecision).toBe('allowed');
        });
    });

    it('Bedrock InvokeModel simulates Allowed for the task role', async () => {
        await step(async () => {
            // Simulation sidesteps the account-level model-access grant: no
            // Anthropic access needed to prove the policy boundary. The
            // policy pins the foundation-model ARN, so the resource must be
            // passed explicitly.
            const iam = new IAMClient({ region });
            const roleArn = readTerraformOutput(dir, 'ecs_task_role_arn', env);
            const verdict = await iam.send(new SimulatePrincipalPolicyCommand({
                PolicySourceArn: roleArn,
                ActionNames: ['bedrock:InvokeModel'],
                ResourceArns: [`arn:aws:bedrock:${region}::foundation-model/${PINNED_MODEL}`],
            }));
            expect(verdict.EvaluationResults?.[0]?.EvalDecision).toBe('allowed');
        });
    });

    it('destroy tears everything down', async () => {
        await step(async () => {
            const destroy = runCli(['destroy', '--headless', '--yes', '--allow-data-loss'], { cwd: dir, env });
            expect(destroy.status).toBe(0);
            tornDown = true;
        });
    });
});
