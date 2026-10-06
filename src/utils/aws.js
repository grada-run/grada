import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { S3Client, CreateBucketCommand, PutBucketVersioningCommand, PutBucketTaggingCommand } from '@aws-sdk/client-s3';
import { DeleteBucketCommand, ListObjectVersionsCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { spawnSync } from 'child_process';
import color from 'picocolors';

export const AWS_CLI_INSTALL_URL = 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html';
export const AWS_CLI_CACHE_TTL_MS = 5000;

export const TROUBLESHOOTING_URL = 'https://github.com/grada-run/grada/blob/main/apps/docs/src/content/docs/guides/aws-credentials.md';

let cachedAwsCliResult = null;

export function resetAwsCliCache() {
    cachedAwsCliResult = null;
}

function checkAwsCli(runSync) {
    try {
        const result = runSync('aws', ['--version'], { stdio: 'ignore' });
        if (result && typeof result.status === 'number') return result.status === 0;
        if (result && result.error) return false;
        return true;
    } catch {
        return false;
    }
}

export function hasAwsCli(options = {}) {
    // Custom implementations (injected by tests) always execute directly so
    // they never read or pollute the shared cache.
    if (options.spawnSyncImpl !== undefined) {
        return checkAwsCli(options.spawnSyncImpl);
    }
    const now = Date.now();
    if (cachedAwsCliResult && cachedAwsCliResult.expiresAt > now) {
        return cachedAwsCliResult.value;
    }
    const value = checkAwsCli(spawnSync);
    cachedAwsCliResult = { value, expiresAt: now + AWS_CLI_CACHE_TTL_MS };
    return value;
}

// AWS SDK errors that mean "credentials expired or invalid" rather than a
// command-specific failure. Single definition shared by every command's
// catch block.
export function isAuthError(error) {
    return !!error && (error.name === 'UnrecognizedClientException' || error.name === 'ExpiredTokenException');
}

// The shared auth-failure branch for command catch blocks: prints the
// credential-recovery hint (and exits). Returns true when the error was an
// auth failure that has been fully handled — the caller should `return` its
// own auth result immediately. Call only after tracking failure telemetry,
// matching the order every catch block uses today.
export function handleAuthErrorBranch(error, clackSpinner = null, options = {}) {
    if (!isAuthError(error)) return false;
    handleAwsAuthError(error, clackSpinner, options);
    return true;
}

// Returns an injected mock client when it quacks like an SDK client,
// otherwise constructs the real one. Single definition for the
// options-injection pattern every AWS command uses for testability.
export function resolveClient(injected, ClientClass, clientOptions = {}) {
    if (injected && typeof injected.send === 'function') return injected;
    return new ClientClass(clientOptions);
}

export function handleAwsAuthError(error, clackSpinner = null, options = {}) {
    if (clackSpinner) {
        clackSpinner.stop(color.red('❌ AWS session expired or invalid credentials.'));
    }
    if (!hasAwsCli(options)) {
        console.log(color.red('\n✖ AWS CLI not found.'));
        console.log(`  Install the AWS CLI: ${color.blue(color.underline(AWS_CLI_INSTALL_URL))}`);
        console.log(`  Then run ${color.cyan('aws sso login')} (or ${color.cyan('aws configure')}) and try again.`);
    } else {
        console.log(color.yellow('\n⚠️  AWS Session Expired / Invalid Credentials'));
        console.log(`Run ${color.cyan('aws sso login')} or ${color.cyan('aws configure')} to refresh your credentials.`);
    }
    console.log(color.blue(`\n📘 Troubleshooting Guide: ${color.underline(TROUBLESHOOTING_URL)}\n`));
    process.exit(1);
    return;
}

export async function checkAwsCredentials(region) {
    const resolvedRegion = region || process.env.AWS_REGION || 'us-east-2';
    if (process.env.CI_MOCK_AWS === 'true') {
        return { accountId: '123456789012', awsAccountId: '123456789012', region: resolvedRegion };
    }
    const stsClient = new STSClient({ region: resolvedRegion });
    const { Account } = await stsClient.send(new GetCallerIdentityCommand({}));
    return { accountId: Account, awsAccountId: Account, region: resolvedRegion };
}

export async function provisionStateBucket(region, projectName) {
    if (process.env.CI_MOCK_AWS === 'true') {
        return { awsAccountId: '123456789012', stateBucketName: 'mock-tf-state-bucket' };
    }
    const stsClient = new STSClient({ region });
    let awsAccountId;

    // 1. Get AWS Account ID
    const { Account } = await stsClient.send(new GetCallerIdentityCommand({}));
    awsAccountId = Account;

    // 2. Format Bucket Name
    let stateBucketName = `${projectName}-tfstate-${awsAccountId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (stateBucketName.length > 63) {
        stateBucketName = stateBucketName.substring(0, 63).replace(/-$/, '');
    }

    // 3. Create S3 Bucket & Enable Versioning
    const s3Client = new S3Client({ region });
    try {
        await s3Client.send(new CreateBucketCommand({
            Bucket: stateBucketName,
            CreateBucketConfiguration: region === 'us-east-1' ? undefined : { LocationConstraint: region }
        }));

        await s3Client.send(new PutBucketTaggingCommand({
            Bucket: stateBucketName,
            Tagging: {
                TagSet: [
                    { Key: "ManagedBy", Value: "grada" }
                ]
            }
        }));

        await s3Client.send(new PutBucketVersioningCommand({
            Bucket: stateBucketName,
            VersioningConfiguration: { Status: 'Enabled' }
        }));
    } catch (error) {
        // Ignore if the bucket already exists and is owned by the user
        if (error.name !== 'BucketAlreadyOwnedByYou') {
            throw error;
        }
    }

    return { awsAccountId, stateBucketName };
}

export async function teardownStateBucket(region, bucketName) {
    if (process.env.CI_MOCK_AWS === 'true') {
        return true;
    }
    const client = new S3Client({ region });

    try {
        // 1. Fetch all object versions and delete markers
        const listCommand = new ListObjectVersionsCommand({ Bucket: bucketName });
        const { Versions, DeleteMarkers } = await client.send(listCommand);

        const objectsToDelete = [];
        if (Versions) objectsToDelete.push(...Versions.map(v => ({ Key: v.Key, VersionId: v.VersionId })));
        if (DeleteMarkers) objectsToDelete.push(...DeleteMarkers.map(v => ({ Key: v.Key, VersionId: v.VersionId })));

        // 2. Delete all contents if any exist
        if (objectsToDelete.length > 0) {
            const deleteCommand = new DeleteObjectsCommand({
                Bucket: bucketName,
                Delete: { Objects: objectsToDelete }
            });
            await client.send(deleteCommand);
        }

        // 3. Delete the now-empty bucket
        const deleteBucketCommand = new DeleteBucketCommand({ Bucket: bucketName });
        await client.send(deleteBucketCommand);

        return true;
    } catch (error) {
        if (error.name === 'NoSuchBucket') return true; // Already deleted
        throw error;
    }
}