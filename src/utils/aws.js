import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { S3Client, CreateBucketCommand, PutBucketVersioningCommand, PutBucketTaggingCommand } from '@aws-sdk/client-s3';
import { DeleteBucketCommand, ListObjectVersionsCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { ListMultipartUploadsCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { spawnSync } from 'child_process';
import color from 'picocolors';
import { chunkArray } from './batch.js';
import { sanitizeProjectName } from './prompts.js';

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

// Single home for state-bucket naming: init, offline scaffolds, the
// offline checklist, and bucket recovery all format through here, so a
// raw basename (recovery) and a sanitized name (init) land on one bucket.
// Truncation cuts the project segment only — the old whole-string cut
// could sever the account suffix that makes the name unique.
export function formatStateBucketName(projectName, accountId) {
    const suffix = `-tfstate-${accountId}`;
    const room = Math.max(63 - suffix.length, 1);
    let project = sanitizeProjectName(projectName);
    if (project.length > room) project = project.substring(0, room).replace(/-+$/, '');
    if (project === '') project = 'app';
    return `${project}${suffix}`;
}

export async function provisionStateBucket(region, projectName) {
    if (process.env.CI_MOCK_AWS === 'true') {
        return { awsAccountId: '123456789012', stateBucketName: 'mock-tf-state-bucket', s3Client: null };
    }
    const stsClient = new STSClient({ region });
    let awsAccountId;

    // 1. Get AWS Account ID
    const { Account } = await stsClient.send(new GetCallerIdentityCommand({}));
    awsAccountId = Account;

    // 2. Format Bucket Name
    const stateBucketName = formatStateBucketName(projectName, awsAccountId);

    // 3. Create S3 Bucket & Enable Versioning
    const s3Client = new S3Client({ region });
    await createVersionedBucket(s3Client, stateBucketName, region);

    return { awsAccountId, stateBucketName, s3Client };
}

// Creates (or re-creates) one explicitly named state bucket with the same
// tagging + versioning provisionStateBucket applies. Recovery reads the
// bucket from backend.tf and lands here instead of re-deriving the name,
// which would miss on suffixed trees.
export async function ensureStateBucketExists({ region, bucket }) {
    if (process.env.CI_MOCK_AWS === 'true') {
        return { bucket, mocked: true };
    }
    const s3Client = new S3Client({ region });
    await createVersionedBucket(s3Client, bucket, region);
    return { bucket };
}

async function createVersionedBucket(s3Client, bucket, region) {
    try {
        await s3Client.send(new CreateBucketCommand({
            Bucket: bucket,
            CreateBucketConfiguration: region === 'us-east-1' ? undefined : { LocationConstraint: region }
        }));

        await s3Client.send(new PutBucketTaggingCommand({
            Bucket: bucket,
            Tagging: {
                TagSet: [
                    { Key: "ManagedBy", Value: "grada" }
                ]
            }
        }));

        await s3Client.send(new PutBucketVersioningCommand({
            Bucket: bucket,
            VersioningConfiguration: { Status: 'Enabled' }
        }));
    } catch (error) {
        // Ignore if the bucket already exists and is owned by the user
        if (error.name !== 'BucketAlreadyOwnedByYou') {
            throw error;
        }
    }
}

export async function teardownStateBucket(region, bucketName, options = {}) {
    if (process.env.CI_MOCK_AWS === 'true') {
        return { deleted: 0, remaining: [], bucket: bucketName, mocked: true };
    }
    const client = options.s3Client || new S3Client({ region });
    const retryDelayMs = options.retryDelayMs ?? 500;

    try {
        const { deleted, failed } = await drainBucketObjects({ s3Client: client, bucket: bucketName });

        // Delete the now-empty bucket, retrying transient failures.
        let bucketError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await client.send(new DeleteBucketCommand({ Bucket: bucketName }));
                bucketError = null;
                break;
            } catch (error) {
                if (error.name === 'NoSuchBucket') {
                    bucketError = null;
                    break;
                }
                bucketError = error;
                await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
            }
        }

        // A precise residual inventory instead of a boolean: callers
        // render what is left rather than punting to the AWS Console.
        const remaining = [...failed];
        if (bucketError) {
            remaining.push({ key: bucketName, reason: String(bucketError.message || bucketError) });
        }
        return { deleted, remaining, bucket: bucketName };
    } catch (error) {
        if (error.name === 'NoSuchBucket') return true; // Already deleted
        throw error;
    }
}

// Drains every object version, delete marker, and in-flight multipart
// upload from one bucket (the bucket itself is left in place for the
// caller to delete or hand to Terraform). Both listings paginate to
// exhaustion and deletes go out in 1000-key batches. Returns
// `{ deleted, failed }` — failed entries carry `{ key, reason }`.
// Throws NoSuchBucket for a missing bucket (callers map it to
// already-gone) and anything else fails loud: handing Terraform a
// non-empty bucket just moves the BucketNotEmpty failure downstream.
export async function drainBucketObjects({ s3Client, bucket: bucketName }) {
    // 1. List every object version and delete marker to exhaustion.
    const objectsToDelete = [];
    let keyMarker;
    let versionIdMarker;
    let truncated = true;
    while (truncated) {
        const listCommand = new ListObjectVersionsCommand({
            Bucket: bucketName,
            ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }),
        });
        const { Versions, DeleteMarkers, IsTruncated, NextKeyMarker, NextVersionIdMarker } = await s3Client.send(listCommand);
        if (Versions) objectsToDelete.push(...Versions.map(v => ({ Key: v.Key, VersionId: v.VersionId })));
        if (DeleteMarkers) objectsToDelete.push(...DeleteMarkers.map(v => ({ Key: v.Key, VersionId: v.VersionId })));
        truncated = IsTruncated === true;
        keyMarker = NextKeyMarker;
        versionIdMarker = NextVersionIdMarker;
    }

    // 2. Delete contents in 1000-key batches (the S3 per-request cap).
    let deleted = 0;
    const failed = [];
    for (const chunk of chunkArray(objectsToDelete, 1000)) {
        const deleteCommand = new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: chunk }
        });
        const response = await s3Client.send(deleteCommand);
        deleted += response?.Deleted?.length ?? chunk.length;
        for (const entry of response?.Errors || []) {
            failed.push({ key: entry.Key, reason: entry.Message || entry.Code || 'DeleteObjects error' });
        }
    }

    // 3. Abort in-flight multipart uploads (they block bucket deletion
    // too). Uploads that vanish mid-drain completed concurrently.
    let uploadKeyMarker;
    let uploadIdMarker;
    let uploadsTruncated = true;
    while (uploadsTruncated) {
        const uploadsCommand = new ListMultipartUploadsCommand({
            Bucket: bucketName,
            ...(uploadKeyMarker === undefined ? {} : { KeyMarker: uploadKeyMarker, UploadIdMarker: uploadIdMarker }),
        });
        const { Uploads, IsTruncated, NextKeyMarker, NextUploadIdMarker } = await s3Client.send(uploadsCommand);
        for (const upload of Uploads || []) {
            try {
                await s3Client.send(new AbortMultipartUploadCommand({
                    Bucket: bucketName, Key: upload.Key, UploadId: upload.UploadId,
                }));
                deleted += 1;
            } catch (error) {
                if (error?.name === 'NoSuchUpload') continue;
                failed.push({ key: upload.Key, reason: error?.message || error?.name || 'AbortMultipartUpload error' });
            }
        }
        uploadsTruncated = IsTruncated === true;
        uploadKeyMarker = NextKeyMarker;
        uploadIdMarker = NextUploadIdMarker;
    }

    return { deleted, failed };
}