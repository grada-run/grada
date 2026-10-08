import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackPromptsMockFactory, mockConfirm } from './helpers/clack.js';
import { createTmpDirTracker } from './helpers/tmpdir.js';
import fs from 'fs';
import path from 'path';

vi.mock('@clack/prompts', () => clackPromptsMockFactory());

vi.mock('../src/utils/aws.js', () => ({
    provisionStateBucket: vi.fn().mockResolvedValue({
        awsAccountId: '123456789012',
        stateBucketName: 'mock-tf-state-bucket',
    }),
}));

import { promptStateBucketRecovery, recreateStateBucket } from '../src/utils/recovery.js';
import { provisionStateBucket } from '../src/utils/aws.js';
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
});

describe('recreateStateBucket', () => {
    it('wipes the stale .terraform cache and re-provisions the bucket', async () => {
        const dir = tmp.makeTmp('recovery-');
        const tfDir = path.join(dir, 'terraform');
        fs.mkdirSync(path.join(tfDir, '.terraform'), { recursive: true });
        fs.writeFileSync(path.join(tfDir, '.terraform', 'cache'), 'stale');
        fs.writeFileSync(path.join(tfDir, 'main.tf'), '# keep me\n');

        await recreateStateBucket({ tfDir, region: 'us-east-2', projectName: 'myapp' });

        expect(fs.existsSync(path.join(tfDir, '.terraform'))).toBe(false);
        expect(fs.existsSync(path.join(tfDir, 'main.tf'))).toBe(true);
        expect(provisionStateBucket).toHaveBeenCalledWith('us-east-2', 'myapp');
    });

    it('provisions even without a stale cache and propagates failures', async () => {
        const dir = tmp.makeTmp('recovery-');
        const tfDir = path.join(dir, 'terraform');
        fs.mkdirSync(tfDir, { recursive: true });
        await recreateStateBucket({ tfDir, region: 'us-east-2', projectName: 'myapp' });
        expect(provisionStateBucket).toHaveBeenCalledWith('us-east-2', 'myapp');

        vi.mocked(provisionStateBucket).mockRejectedValueOnce(new Error('no creds'));
        await expect(recreateStateBucket({ tfDir, region: 'us-east-2', projectName: 'myapp' }))
            .rejects.toThrow('no creds');
    });
});
