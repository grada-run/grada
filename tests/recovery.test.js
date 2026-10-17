import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { mockConfirm } from './helpers/clack.js';
import { createTmpDirTracker } from './helpers/tmpdir.js';
import fs from 'fs';
import path from 'path';


vi.mock('../src/utils/aws.js', () => ({
    provisionStateBucket: vi.fn().mockResolvedValue({
        awsAccountId: '123456789012',
        stateBucketName: 'mock-tf-state-bucket',
    }),
    ensureStateBucketExists: vi.fn().mockResolvedValue({ bucket: 'mock-tf-state-bucket' }),
}));

import { promptStateBucketRecovery, recreateStateBucket } from '../src/utils/recovery.js';
import { provisionStateBucket, ensureStateBucketExists } from '../src/utils/aws.js';
import { trackEvent } from '../src/core/telemetry.js';
import { confirm } from '@clack/prompts';

const tmp = createTmpDirTracker();

beforeEach(() => {
    tmp.reset();
    vi.clearAllMocks();
});

afterEach(() => {
    tmp.cleanup();
});

describe('promptStateBucketRecovery', () => {
    it('auto-approves without prompting', async () => {
        await expect(promptStateBucketRecovery({ autoApprove: true })).resolves.toBe(true);
        await expect(promptStateBucketRecovery({ autoApprove: 'true' })).resolves.toBe(true);
        expect(confirm).not.toHaveBeenCalled();
    });

    it('prompts with a state-loss warning and honors the answer', async () => {
        mockConfirm.mockResolvedValueOnce(true);
        await expect(promptStateBucketRecovery({})).resolves.toBe(true);
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('recreate the state bucket'),
        }));
        const message = vi.mocked(confirm).mock.calls[0][0].message;
        expect(message).toContain('unrecoverable');
        expect(message).toContain('out-of-band');

        mockConfirm.mockResolvedValueOnce(false);
        await expect(promptStateBucketRecovery({})).resolves.toBe(false);
    });

    it('treats a dismissed prompt as declined', async () => {
        mockConfirm.mockResolvedValueOnce(Symbol('clack:cancel'));
        await expect(promptStateBucketRecovery({})).resolves.toBe(false);
    });

    it('refuses loudly when headless without approval flags instead of prompting', async () => {
        // No-op exit so the refusal result returns instead of throwing.
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        try {
            const result = await promptStateBucketRecovery({ options: {}, projectName: 'myapp' });
            expect(result).toMatchObject({ ok: false, reason: 'non-interactive' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(trackEvent).toHaveBeenCalledWith(
                'infrastructure_applied',
                expect.objectContaining({ success: false, error_code: 'APPLY_NON_INTERACTIVE', reason: 'non-interactive' })
            );
            expect(confirm).not.toHaveBeenCalled();
        } finally {
            exitSpy.mockRestore();
        }
    });

    it('still prompts on a TTY without approval flags', async () => {
        mockConfirm.mockResolvedValueOnce(true);
        await expect(promptStateBucketRecovery({ options: { isHeadless: false }, projectName: 'myapp' })).resolves.toBe(true);
        expect(confirm).toHaveBeenCalledTimes(1);
    });
});

describe('recreateStateBucket', () => {
    const BACKEND_TF = [
        'backend "s3" {',
        '  bucket = "myapp-a1b2c3-tfstate-123456789012"',
        '  key    = "state/terraform.tfstate"',
        '  region = "us-east-2"',
        '}',
        '',
    ].join('\n');

    function writeBackend(tfDir, content = BACKEND_TF) {
        fs.mkdirSync(tfDir, { recursive: true });
        fs.writeFileSync(path.join(tfDir, 'backend.tf'), content);
    }

    it('wipes the stale .terraform cache and re-provisions the backend.tf bucket', async () => {
        const dir = tmp.makeTmp('recovery-');
        const tfDir = path.join(dir, 'terraform');
        fs.mkdirSync(path.join(tfDir, '.terraform'), { recursive: true });
        fs.writeFileSync(path.join(tfDir, '.terraform', 'cache'), 'stale');
        fs.writeFileSync(path.join(tfDir, 'main.tf'), '# keep me\n');
        writeBackend(tfDir);

        await recreateStateBucket({ tfDir, region: 'us-east-2' });

        expect(fs.existsSync(path.join(tfDir, '.terraform'))).toBe(false);
        expect(fs.existsSync(path.join(tfDir, 'main.tf'))).toBe(true);
        expect(ensureStateBucketExists).toHaveBeenCalledWith({
            region: 'us-east-2',
            bucket: 'myapp-a1b2c3-tfstate-123456789012',
        });
        // Recomputing the name from the project would land on the wrong
        // bucket for suffixed trees - the backend is the only source.
        expect(provisionStateBucket).not.toHaveBeenCalled();
    });

    it('prefers the backend region over the caller region', async () => {
        const dir = tmp.makeTmp('recovery-');
        const tfDir = path.join(dir, 'terraform');
        writeBackend(tfDir, BACKEND_TF.replace('region = "us-east-2"', 'region = "eu-west-1"'));

        await recreateStateBucket({ tfDir, region: 'us-east-2' });

        expect(ensureStateBucketExists).toHaveBeenCalledWith({
            region: 'eu-west-1',
            bucket: 'myapp-a1b2c3-tfstate-123456789012',
        });
    });

    it('fails loud when backend.tf names no bucket', async () => {
        const dir = tmp.makeTmp('recovery-');
        const tfDir = path.join(dir, 'terraform');
        writeBackend(tfDir, 'backend "s3" {\n  key = "state/terraform.tfstate"\n}\n');

        await expect(recreateStateBucket({ tfDir, region: 'us-east-2' }))
            .rejects.toThrow(/backend\.tf.*bucket/);
        expect(ensureStateBucketExists).not.toHaveBeenCalled();
    });

    it('provisions even without a stale cache and propagates failures', async () => {
        const dir = tmp.makeTmp('recovery-');
        const tfDir = path.join(dir, 'terraform');
        writeBackend(tfDir);
        await recreateStateBucket({ tfDir, region: 'us-east-2' });
        expect(ensureStateBucketExists).toHaveBeenCalledTimes(1);

        vi.mocked(ensureStateBucketExists).mockRejectedValueOnce(new Error('no creds'));
        await expect(recreateStateBucket({ tfDir, region: 'us-east-2' }))
            .rejects.toThrow('no creds');
    });
});
