import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackMocks as clack } from './helpers/clack.js';
import { checkStateAdoption, stateKeyExists, deleteStateKey, STATE_KEY } from '../src/utils/state-adoption.js';
import { trackEvent } from '../src/core/telemetry.js';


// Silence telemetry so tests never hit the network.

function fakeS3(handler) {
    return { send: vi.fn(handler) };
}

function notFoundError() {
    return Object.assign(new Error('Not Found'), { name: 'NotFound' });
}

describe('state-adoption: key probe', () => {
    it('targets the backend state key', () => {
        expect(STATE_KEY).toBe('state/terraform.tfstate');
    });

    it('returns true when HeadObject finds the key', async () => {
        const s3 = fakeS3(async () => ({}));
        await expect(stateKeyExists({ s3, bucket: 'bkt' })).resolves.toBe(true);
        expect(s3.send.mock.calls[0][0].constructor.name).toBe('HeadObjectCommand');
        expect(s3.send.mock.calls[0][0].input).toMatchObject({ Bucket: 'bkt', Key: STATE_KEY });
    });

    it.each(['NotFound', 'NoSuchKey'])('returns false on %s (absent key or delete-marker top)', async (name) => {
        const s3 = fakeS3(async () => { throw Object.assign(new Error(name), { name }); });
        await expect(stateKeyExists({ s3, bucket: 'bkt' })).resolves.toBe(false);
    });

    it('returns false on a 404 status code', async () => {
        const s3 = fakeS3(async () => {
            throw Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
        });
        await expect(stateKeyExists({ s3, bucket: 'bkt' })).resolves.toBe(false);
    });

    it('rethrows unexpected errors instead of silently adopting', async () => {
        const s3 = fakeS3(async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied' }); });
        await expect(stateKeyExists({ s3, bucket: 'bkt' })).rejects.toThrow('denied');
    });

    it('deletes the state key on wipe', async () => {
        const s3 = fakeS3(async () => ({}));
        await deleteStateKey({ s3, bucket: 'bkt' });
        expect(s3.send.mock.calls[0][0].constructor.name).toBe('DeleteObjectCommand');
        expect(s3.send.mock.calls[0][0].input).toMatchObject({ Bucket: 'bkt', Key: STATE_KEY });
    });
});

describe('state-adoption: gate', () => {
    let exitSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        clack.mockConfirm.mockResolvedValue(false);
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
    });

    afterEach(() => {
        exitSpy.mockRestore();
    });

    function baseInput(overrides = {}) {
        return {
            s3: fakeS3(async () => { throw notFoundError(); }),
            bucket: 'myapp-tfstate-123456789012',
            isFreshTree: true,
            isHeadless: true,
            adoptState: false,
            ...overrides,
        };
    }

    it('proceeds silently when the key is absent', async () => {
        const result = await checkStateAdoption(baseInput());
        expect(result).toBeNull();
        expect(trackEvent).not.toHaveBeenCalledWith('state_adoption_prompted', expect.anything());
        expect(clack.mockSelect).not.toHaveBeenCalled();
    });

    it('skips the probe on non-fresh trees (re-init owns its state)', async () => {
        const s3 = fakeS3(async () => ({}));
        const result = await checkStateAdoption(baseInput({ s3, isFreshTree: false }));
        expect(result).toBeNull();
        expect(s3.send).not.toHaveBeenCalled();
    });

    it('skips the probe when --adopt-state pre-consents', async () => {
        const s3 = fakeS3(async () => ({}));
        const result = await checkStateAdoption(baseInput({ s3, adoptState: true }));
        expect(result).toBeNull();
        expect(s3.send).not.toHaveBeenCalled();
    });

    it('skips the probe without an S3 client (offline / mocked provisioning)', async () => {
        const result = await checkStateAdoption(baseInput({ s3: null }));
        expect(result).toBeNull();
        expect(clack.mockSelect).not.toHaveBeenCalled();
    });

    it('refuses headless runs with STATE_ALREADY_EXISTS and the --adopt-state hatch', async () => {
        const s3 = fakeS3(async () => ({}));
        const result = await checkStateAdoption(baseInput({ s3 }));
        expect(result).toMatchObject({
            errorCode: 'STATE_ALREADY_EXISTS',
            reason: 'state-already-exists',
            event: 'cli-error',
            useErrorStream: true,
        });
        expect(result.hint).toContain('--adopt-state');
        expect(trackEvent).toHaveBeenCalledWith('state_adoption_prompted', {});
        expect(clack.mockSelect).not.toHaveBeenCalled();
        expect(clack.mockConfirm).not.toHaveBeenCalled();
    });

    it('adopts on the interactive adopt choice', async () => {
        const s3 = fakeS3(async () => ({}));
        clack.mockSelect.mockResolvedValue('adopt');
        const result = await checkStateAdoption(baseInput({ s3, isHeadless: false }));
        expect(result).toBeNull();
        expect(trackEvent).toHaveBeenCalledWith('state_adoption_prompted', {});
        expect(trackEvent).toHaveBeenCalledWith('state_adoption_accepted', {});
        const options = clack.mockSelect.mock.calls[0][0].options.map((o) => o.value);
        expect(options).toEqual(['adopt', 'rename', 'wipe']);
    });

    it('aborts with rename guidance on the interactive rename choice', async () => {
        const s3 = fakeS3(async () => ({}));
        clack.mockSelect.mockResolvedValue('rename');
        await checkStateAdoption(baseInput({ s3, isHeadless: false }));
        expect(clack.mockCancel).toHaveBeenCalledWith(expect.stringContaining('Rename the project'));
        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(trackEvent).not.toHaveBeenCalledWith('state_adoption_accepted', expect.anything());
    });

    it('wipes the key after an explicit confirmation', async () => {
        const s3 = fakeS3(async (cmd) => {
            if (cmd.constructor.name === 'HeadObjectCommand') return {};
            return {};
        });
        clack.mockSelect.mockResolvedValue('wipe');
        clack.mockConfirm.mockResolvedValue(true);
        const result = await checkStateAdoption(baseInput({ s3, isHeadless: false }));
        expect(result).toBeNull();
        const verbs = s3.send.mock.calls.map((call) => call[0].constructor.name);
        expect(verbs).toContain('DeleteObjectCommand');
        expect(trackEvent).toHaveBeenCalledWith('state_adoption_wiped', {});
    });

    it('aborts without deleting when wipe is declined', async () => {
        const s3 = fakeS3(async () => ({}));
        clack.mockSelect.mockResolvedValue('wipe');
        clack.mockConfirm.mockResolvedValue(false);
        await checkStateAdoption(baseInput({ s3, isHeadless: false }));
        const verbs = s3.send.mock.calls.map((call) => call[0].constructor.name);
        expect(verbs).not.toContain('DeleteObjectCommand');
        expect(exitSpy).toHaveBeenCalled();
        expect(trackEvent).not.toHaveBeenCalledWith('state_adoption_wiped', expect.anything());
    });

    it('aborts when the prompt is cancelled', async () => {
        const s3 = fakeS3(async () => ({}));
        clack.mockSelect.mockResolvedValue(Symbol('cancel'));
        await checkStateAdoption(baseInput({ s3, isHeadless: false }));
        expect(clack.mockCancel).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalled();
    });
});
