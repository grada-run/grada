import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock AWS SDK: S3 (teardownStateBucket constructs its own client) ---
const { mockS3Send, MockS3Client } = vi.hoisted(() => {
    const send = vi.fn();
    return {
        mockS3Send: send,
        MockS3Client: vi.fn(function () {
            this.send = send;
        }),
    };
});

function mockCommand(name) {
    return vi.fn(function (input) {
        this.commandName = name;
        this.input = input;
        Object.assign(this, input);
    });
}

vi.mock('@aws-sdk/client-s3', () => ({
    S3Client: MockS3Client,
    CreateBucketCommand: mockCommand('CreateBucketCommand'),
    PutBucketTaggingCommand: mockCommand('PutBucketTaggingCommand'),
    PutBucketVersioningCommand: mockCommand('PutBucketVersioningCommand'),
    ListObjectVersionsCommand: mockCommand('ListObjectVersionsCommand'),
    DeleteObjectsCommand: mockCommand('DeleteObjectsCommand'),
    DeleteBucketCommand: mockCommand('DeleteBucketCommand'),
    ListMultipartUploadsCommand: mockCommand('ListMultipartUploadsCommand'),
    AbortMultipartUploadCommand: mockCommand('AbortMultipartUploadCommand'),
}));

import { teardownStateBucket, drainBucketObjects } from '../src/utils/aws.js';

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CI_MOCK_AWS;
});

function versions(page, count, keyPrefix = 'terraform.tfstate') {
    return Array.from({ length: count }, (_, i) => ({
        Key: `${keyPrefix}-p${page}-${i}`,
        VersionId: `v${page}-${i}`,
    }));
}

describe('S26: paginated bucket teardown (R14)', () => {
    it('lists to exhaustion and chunks deletes at 1000 keys', async () => {
        const pages = [
            { Versions: versions(0, 1000), IsTruncated: true, NextKeyMarker: 'k0', NextVersionIdMarker: 'v0' },
            { Versions: versions(1, 1000), IsTruncated: true, NextKeyMarker: 'k1', NextVersionIdMarker: 'v1' },
            { Versions: versions(2, 500), DeleteMarkers: [{ Key: ' Terraform.tfstate'.trim(), VersionId: 'dm1' }], IsTruncated: false },
        ];
        let listCalls = 0;
        mockS3Send.mockImplementation(async (command) => {
            if (command.commandName === 'ListObjectVersionsCommand') return pages[listCalls++];
            if (command.commandName === 'DeleteObjectsCommand') return { Deleted: command.input.Delete.Objects };
            if (command.commandName === 'DeleteBucketCommand') return {};
            if (command.commandName === 'ListMultipartUploadsCommand') return { Uploads: [], IsTruncated: false };
            throw new Error(`unexpected S3 command: ${command.commandName}`);
        });
        const result = await teardownStateBucket('us-east-2', 'myapp-tfstate-1');
        expect(listCalls).toBe(3);
        const deletes = mockS3Send.mock.calls.filter(([c]) => c.commandName === 'DeleteObjectsCommand');
        expect(deletes).toHaveLength(3);
        for (const [command] of deletes) {
            expect(command.input.Delete.Objects.length).toBeLessThanOrEqual(1000);
        }
        const deletedKeys = deletes.flatMap(([c]) => c.input.Delete.Objects.map((o) => o.Key));
        expect(deletedKeys).toHaveLength(2501);
        expect(mockS3Send.mock.calls.some(([c]) => c.commandName === 'DeleteBucketCommand')).toBe(true);
        expect(result).toMatchObject({ deleted: 2501, bucket: 'myapp-tfstate-1' });
        expect(result.remaining).toEqual([]);
    });

    it('keeps NoSuchBucket as a silent true', async () => {
        mockS3Send.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NoSuchBucket' }));
        await expect(teardownStateBucket('us-east-2', 'missing')).resolves.toBe(true);
    });

    it('returns a residual inventory when the bucket delete fails', async () => {
        mockS3Send.mockImplementation(async (command) => {
            if (command.commandName === 'ListObjectVersionsCommand') return { Versions: [], IsTruncated: false };
            if (command.commandName === 'DeleteBucketCommand') throw new Error('BucketNotEmpty');
            if (command.commandName === 'ListMultipartUploadsCommand') return { Uploads: [], IsTruncated: false };
            return {};
        });
        const result = await teardownStateBucket('us-east-2', 'stubborn').catch((err) => err);
        // Either a precise residual object or the raw error: never silent success.
        if (result === true) throw new Error('expected a residual inventory or a throw, got silent true');
    });
});

describe('drainBucketObjects (pre-destroy bucket drain)', () => {
    const client = () => ({ send: mockS3Send });
    const noUploads = { Uploads: [], IsTruncated: false };

    function listCalls(name) {
        return mockS3Send.mock.calls.filter(([command]) => command.commandName === name);
    }

    it('drains versions and markers across pages, chaining markers', async () => {
        const pages = [
            { Versions: versions(0, 1000), IsTruncated: true, NextKeyMarker: 'k0', NextVersionIdMarker: 'v0' },
            { Versions: versions(1, 100), DeleteMarkers: [{ Key: 'gone', VersionId: 'dm1' }], IsTruncated: false },
        ];
        let listCallsCount = 0;
        mockS3Send.mockImplementation(async (command) => {
            if (command.commandName === 'ListObjectVersionsCommand') return pages[listCallsCount++];
            if (command.commandName === 'DeleteObjectsCommand') return { Deleted: command.input.Delete.Objects };
            if (command.commandName === 'ListMultipartUploadsCommand') return noUploads;
            throw new Error(`unexpected S3 command: ${command.commandName}`);
        });
        const result = await drainBucketObjects({ s3Client: client(), bucket: 'myapp-storage-123' });
        expect(result.failed).toEqual([]);
        expect(result.deleted).toBe(1101);
        // Second page resumes where the first stopped (the >1000-key case).
        expect(listCalls('ListObjectVersionsCommand')[1][0].input).toMatchObject({
            KeyMarker: 'k0', VersionIdMarker: 'v0',
        });
        // Deletes go out in 1000-key batches.
        expect(listCalls('DeleteObjectsCommand')).toHaveLength(2);
        expect(listCalls('DeleteObjectsCommand')[0][0].input.Delete.Objects).toHaveLength(1000);
    });

    it('aborts in-flight multipart uploads across pages', async () => {
        const uploadPages = [
            { Uploads: [{ Key: 'big.zip', UploadId: 'u1' }], IsTruncated: true, NextKeyMarker: 'big.zip', NextUploadIdMarker: 'u1' },
            { Uploads: [{ Key: 'huge.tar', UploadId: 'u2' }], IsTruncated: false },
        ];
        let uploadCalls = 0;
        const aborted = [];
        mockS3Send.mockImplementation(async (command) => {
            if (command.commandName === 'ListObjectVersionsCommand') return { Versions: [], IsTruncated: false };
            if (command.commandName === 'ListMultipartUploadsCommand') return uploadPages[uploadCalls++];
            if (command.commandName === 'AbortMultipartUploadCommand') {
                aborted.push(command.input);
                return {};
            }
            throw new Error(`unexpected S3 command: ${command.commandName}`);
        });
        const result = await drainBucketObjects({ s3Client: client(), bucket: 'myapp-storage-123' });
        expect(result.failed).toEqual([]);
        expect(aborted).toEqual([
            expect.objectContaining({ Bucket: 'myapp-storage-123', Key: 'big.zip', UploadId: 'u1' }),
            expect.objectContaining({ Bucket: 'myapp-storage-123', Key: 'huge.tar', UploadId: 'u2' }),
        ]);
        expect(listCalls('ListMultipartUploadsCommand')[1][0].input).toMatchObject({
            KeyMarker: 'big.zip', UploadIdMarker: 'u1',
        });
    });

    it('tolerates uploads that vanish mid-drain (completed concurrently)', async () => {
        mockS3Send.mockImplementation(async (command) => {
            if (command.commandName === 'ListObjectVersionsCommand') return { Versions: [], IsTruncated: false };
            if (command.commandName === 'ListMultipartUploadsCommand') {
                return { Uploads: [{ Key: 'race.zip', UploadId: 'gone' }], IsTruncated: false };
            }
            if (command.commandName === 'AbortMultipartUploadCommand') {
                throw Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
            }
            throw new Error(`unexpected S3 command: ${command.commandName}`);
        });
        const result = await drainBucketObjects({ s3Client: client(), bucket: 'myapp-storage-123' });
        expect(result.failed).toEqual([]);
    });

    it('makes no delete calls for an already-empty bucket', async () => {
        mockS3Send.mockImplementation(async (command) => {
            if (command.commandName === 'ListObjectVersionsCommand') return { Versions: [], IsTruncated: false };
            if (command.commandName === 'ListMultipartUploadsCommand') return noUploads;
            throw new Error(`unexpected S3 command: ${command.commandName}`);
        });
        const result = await drainBucketObjects({ s3Client: client(), bucket: 'myapp-storage-123' });
        expect(result).toEqual({ deleted: 0, failed: [] });
        expect(listCalls('DeleteObjectsCommand')).toHaveLength(0);
        expect(listCalls('AbortMultipartUploadCommand')).toHaveLength(0);
    });

    it('surfaces per-key delete errors instead of claiming success', async () => {
        mockS3Send.mockImplementation(async (command) => {
            if (command.commandName === 'ListObjectVersionsCommand') {
                return { Versions: [{ Key: 'locked', VersionId: 'v1' }], IsTruncated: false };
            }
            if (command.commandName === 'DeleteObjectsCommand') {
                return { Deleted: [], Errors: [{ Key: 'locked', Code: 'AccessDenied', Message: 'denied' }] };
            }
            if (command.commandName === 'ListMultipartUploadsCommand') return noUploads;
            throw new Error(`unexpected S3 command: ${command.commandName}`);
        });
        const result = await drainBucketObjects({ s3Client: client(), bucket: 'myapp-storage-123' });
        expect(result.deleted).toBe(0);
        expect(result.failed).toEqual([{ key: 'locked', reason: 'denied' }]);
    });

    it('throws NoSuchBucket for a missing bucket (callers map it to already-gone)', async () => {
        mockS3Send.mockImplementation(async (command) => {
            if (command.commandName === 'ListObjectVersionsCommand') {
                throw Object.assign(new Error('nope'), { name: 'NoSuchBucket' });
            }
            throw new Error(`unexpected S3 command: ${command.commandName}`);
        });
        await expect(drainBucketObjects({ s3Client: client(), bucket: 'already-gone' }))
            .rejects.toMatchObject({ name: 'NoSuchBucket' });
    });
});
