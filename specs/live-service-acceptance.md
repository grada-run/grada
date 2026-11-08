# Specification: Live Service Acceptance (Tier 2 E2E Harness)

## 1. Context & Problem
Currently, Tier 0 (mocked) and Tier 1 (live lifecycle) tests prove that Grada generates valid Terraform and that AWS successfully provisions the infrastructure. However, they do not prove that the resulting IAM policies, Security Groups, and VPC routing actually allow application code to communicate with those services. 

To achieve complete confidence, we need a Tier 2 test harness that provisions every addon capability on real AWS, explicitly verifying both **resource existence/wiring** (from the outside) and **Task IAM permissions/VPC connectivity** (from the container's perspective). It must cleanly tear the stack down while strictly controlling execution limits.

## 2. Scope of Work
Implement a Node.js-based integration suite (`tests/e2e/tier2.e2e.test.js`) added as a new `tier2` job inside the existing `.github/workflows/e2e.yml`. The suite will scaffold a temporary project, provision all addons, deploy a custom fixture image task definition, run tiered assertions, and guarantee destruction of the infrastructure.

## 3. Implementation Details

1. **Lifecycle Orchestration (`tests/e2e/tier2.e2e.test.js`)**:
   - **Vitest Config & Deps:** Create `vitest.e2e.tier2.config.js` and a `test:e2e:tier2` npm script. Set a generous per-test `testTimeout` (45–60 minutes). Add `@aws-sdk/client-sqs`, `@aws-sdk/client-iam`, and `@aws-sdk/s3-request-presigner` to the project's `dependencies`.
   - **Prerequisites:** Mirror Tier 1's boilerplate (e.g., `skipIf` without AWS creds). **Runner IAM:** The CI runner's role must be updated to include data-plane permissions (Dynamo/SQS/S3) plus `iam:SimulatePrincipalPolicy`.
   - **Step 1 (Scaffold):** 
     - Run `grada init --target ecs --headless --needsDatabase --db-engine postgres --with db:redis,queue:sqs,storage:s3,email:ses,ai:bedrock,db:dynamodb --domain grada-e2e-dummy.com --project-name grada-e2e-t2 --model anthropic.claude-3-sonnet-20240229-v1:0`.
     - Seed a `verify-vpc.js` script into the fixture. Ensure `pg ^8.0.0` and `ioredis ^5.0.0` are injected as real dependencies so they survive `npm ci --omit=dev`.
     - *OIDC Fix:* Before applying, edit the scaffolded `oidc.tf` to set `create_oidc_provider = false` (mirroring Tier 1) so it doesn't fail trying to provision a duplicate account-level provider.
   - **Step 2 (Apply):** Execute `grada apply --headless --auto-approve`. Grada must output `ecs_task_role_arn` and `ecr_repository_url` for the test to read.
   - **Step 3 (Register Fixture Task Definition):** 
     - Execute `docker build/push` to push the fixture image to the ECR repository (using `ecr_repository_url`).
     - Fetch the current placeholder Task Definition JSON. Register a *new* Task Definition revision that swaps the placeholder image for the new fixture image URI. Ensure the **container name**, env vars, secrets, and IAM roles remain exactly identical so `grada run` can map it.
     - *Note:* We skip the slow `update-service` rollout wait. The ephemeral task will run this new revision directly.
   - **Step 4 (Teardown):** A final `it()` block that executes `grada destroy --headless --yes --allow-data-loss`.
   - **Safety Net:** Include an `afterAll` hook to run `destroy` if the suite crashes, but use a boolean guard flag so it skips if the teardown `it()` block already successfully executed.

2. **Runner-SDK Assertions (Resource Existence & Public Endpoints)**:
   - *These tests run using the CI runner's admin credentials to prove the resources exist and the data-plane is functional.*
   - **S3 & CloudFront:** Generate a presigned PUT URL via the AWS SDK. Use `fetch()` to upload a tiny text file. Read `s3_cdn_domain` via `readTerraformOutput`, prepend `https://`, and `GET` the file (implementing retry/backoff to account for CDN origin-fetch delays), asserting the contents.
   - **DynamoDB:** Perform a standard `PutItem` followed by a `GetItem` (default partition key is `id`). Assert the data matches.
   - **SQS & DLQ:** Enqueue a test message. To test the DLQ quickly, alternate `ReceiveMessage` and `ChangeMessageVisibility(VisibilityTimeout=0)` using the `ReceiptHandle` 3 times consecutively. *Crucial:* Wrap the 3rd `ChangeMessageVisibility` in a `try/catch` block, as it may throw if the message has already been async-redriven to the DLQ. Then poll the DLQ with retries and assert the message appears.

3. **Task IAM & VPC Assertions (Container Context)**:
   - *These tests prove the container's generated IAM role and VPC Security Groups allow outbound access.*
   - **RDS & Redis (VPC):** Execute `grada run --cmd "node verify-vpc.js" --headless --task-def <NEW_TASK_DEF_ARN>`. `DATABASE_URL` is natively synthesized by `grada run` (from `DB_*`), so the script just uses it and `REDIS_URL` to execute a `SELECT 1` and `SET/GET`. Assert the CLI command exits with code `0`.
   - **SES (IAM Policy):** Read `ecs_task_role_arn`. Using the AWS SDK `SimulatePrincipalPolicy` API, simulate `ses:SendEmail`. Pass `ResourceArns: ['*']` and `ContextEntries: [{ ContextKeyName: 'ses:FromAddress', ContextKeyValues: ['noreply@grada-e2e-dummy.com'], ContextKeyType: 'string' }]`. Assert the evaluation returns `Allowed`.
   - **Bedrock (IAM Policy):** Using `SimulatePrincipalPolicy` against the `ecs_task_role_arn`, simulate `bedrock:InvokeModel`. Pass `ResourceArns: ['arn:aws:bedrock:<region>::foundation-model/<pinned-model-id>']`. Assert it returns `Allowed`.

4. **GitHub Actions Workflow (`.github/workflows/e2e.yml`)**:
   - **Job Addition:** Add a `tier2` job triggering alongside `tier1` (schedule + manual dispatch only).
   - **Timeouts & Concurrency:** Set `timeout-minutes: 90`. Add concurrency group `grada-e2e-tier2` with `cancel-in-progress: false` (queues overlapping manual dispatches).
   - **GC Fallback (Workspace Scoped):** In the job's `always()` block, loop through any surviving workspace directories (e.g., `tier2-live-*`). For each directory, `cd` into it and run:
     1. `grada destroy --headless --yes --allow-data-loss`
     2. `grada gc --headless --yes`
     *(This ensures `gc` runs with the correct `terraform/` context to find the project name and suffix. If the test suite succeeded in tearing down, no directories will exist and this safely no-ops.)*

## 4. Acceptance Criteria
- `npm run test:e2e:tier2` sequentially scaffolds, applies, registers the fixture task definition, passes all Runner SDK and Task IAM assertions, and destroys the stack.
- The `destroy` step reliably executes even if an intermediate assertion `it()` block fails.
- SQS DLQ redrive is successfully tested with a `try/catch` around the 3rd visibility change to tolerate stale receipt handles.
- IAM boundaries for SES and Bedrock are successfully proven via `SimulatePrincipalPolicy`, incorporating the necessary context entries and scoped resource ARNs.
- The CI job correctly implements the 90-minute timeout, queuing concurrency group, and the workspace-scoped two-step `destroy` → `gc` fallback.