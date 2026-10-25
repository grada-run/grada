import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import fs from 'fs';
import path from 'path';
import { confirm } from '@clack/prompts';
import { createTmpDirTracker } from './helpers/tmpdir.js';
import { mockConsoleTrio } from './helpers/console.js';

vi.mock('../src/utils/aws.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        checkAwsCredentials: vi.fn((...args) => actual.checkAwsCredentials(...args)),
        ensureStateBucketExists: vi.fn((...args) => actual.ensureStateBucketExists(...args)),
    };
});

vi.mock('../src/utils/terraform.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        runTerraformCommand: vi.fn().mockResolvedValue({ ok: true }),
    };
});

import { findUnreconciledFiles, isValidAccountId, PLACEHOLDER_ACCOUNT_ID } from '../src/utils/reconcile.js';
import { applyStack, parseApplyArgs, reconcileOfflineTree } from '../src/commands/apply.js';
import { checkAwsCredentials, ensureStateBucketExists } from '../src/utils/aws.js';
import { runTerraformCommand } from '../src/utils/terraform.js';
import { trackEvent } from '../src/core/telemetry.js';

const tmp = createTmpDirTracker();
const ACCOUNT = '123456789012';

function writeBackend(dir, bucket) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'terraform', 'backend.tf'),
        `terraform {\n  backend "s3" {\n    bucket = "${bucket}"\n    key    = "terraform.tfstate"\n    region = "us-east-2"\n  }\n}\n`
    );
}

function writeWorkflow(dir, name, account) {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, '.github', 'workflows', name),
        `jobs:\n  deploy:\n    steps:\n      - uses: aws-actions/configure-aws-credentials@v4\n        with:\n          role-to-assume: arn:aws:iam::${account}:role/myapp-deploy\n`
    );
}

function writeOfflineTree(dir) {
    writeBackend(dir, `myapp-tfstate-${PLACEHOLDER_ACCOUNT_ID}`);
    writeWorkflow(dir, 'deploy.yml', PLACEHOLDER_ACCOUNT_ID);
}

describe('findUnreconciledFiles', () => {
    it('lists backend + workflows still carrying the placeholder, sorted', () => {
        const dir = tmp.makeTmp('reconcile-');
        writeBackend(dir, `myapp-tfstate-${PLACEHOLDER_ACCOUNT_ID}`);
        writeWorkflow(dir, 'teardown.yml', PLACEHOLDER_ACCOUNT_ID);
        writeWorkflow(dir, 'deploy.yml', PLACEHOLDER_ACCOUNT_ID);

        expect(findUnreconciledFiles(dir)).toEqual([
            path.join('.github', 'workflows', 'deploy.yml'),
            path.join('.github', 'workflows', 'teardown.yml'),
            path.join('terraform', 'backend.tf'),
        ]);
    });

    it('lists exactly the remaining files on partial reconciliation', () => {
        const dir = tmp.makeTmp('reconcile-');
        writeBackend(dir, `myapp-tfstate-${ACCOUNT}`);
        writeWorkflow(dir, 'deploy.yml', PLACEHOLDER_ACCOUNT_ID);

        expect(findUnreconciledFiles(dir)).toEqual([path.join('.github', 'workflows', 'deploy.yml')]);
    });

    it('returns [] for clean trees and skips missing files without error', () => {
        const dir = tmp.makeTmp('reconcile-');
        writeBackend(dir, `myapp-tfstate-${ACCOUNT}`);
        writeWorkflow(dir, 'deploy.yml', ACCOUNT);
        expect(findUnreconciledFiles(dir)).toEqual([]);

        const empty = tmp.makeTmp('reconcile-');
        expect(findUnreconciledFiles(empty)).toEqual([]);
    });
});

describe('isValidAccountId', () => {
    it.each([
        ['123456789012', true],
        ['123', false],
        ['1234567890123', false],
        ['12345678901a', false],
        ['', false],
        [null, false],
        [undefined, false],
    ])('validates %j as %s', (value, expected) => {
        expect(isValidAccountId(value)).toBe(expected);
    });
});

describe('parseApplyArgs --account-id', () => {
    it('parses space and = forms', () => {
        expect(parseApplyArgs(['apply', '--account-id', ACCOUNT]).accountId).toBe(ACCOUNT);
        expect(parseApplyArgs(['apply', `--account-id=${ACCOUNT}`]).accountId).toBe(ACCOUNT);
    });
});

describe('reconcileOfflineTree', () => {
    let spies;
    let savedMockAws;

    beforeEach(() => {
        vi.clearAllMocks();
        spies = mockConsoleTrio();
        savedMockAws = process.env.CI_MOCK_AWS;
        process.env.CI_MOCK_AWS = 'true';
    });

    afterEach(() => {
        spies.restore();
        if (savedMockAws === undefined) delete process.env.CI_MOCK_AWS;
        else process.env.CI_MOCK_AWS = savedMockAws;
    });

    it('an explicit --account-id beats STS: ping verifies, flag resolves', async () => {
        const dir = tmp.makeTmp('reconcile-');
        writeOfflineTree(dir);

        const out = await reconcileOfflineTree({
            targetDir: dir,
            options: { accountId: ACCOUNT, autoApprove: true },
            projectName: 'myapp',
        });

        expect(out).toEqual({ proceed: true });
        // The ping verifies credentials (CI_MOCK would resolve ...010);
        // the stamped files prove the flag's ...012 won.
        expect(checkAwsCredentials).toHaveBeenCalledTimes(1);
        expect(trackEvent).toHaveBeenCalledWith('apply_reconciled', expect.objectContaining({
            account_source: 'flag',
            file_count: 2,
        }));
        expect(fs.readFileSync(path.join(dir, 'terraform', 'backend.tf'), 'utf8')).toContain(`myapp-tfstate-${ACCOUNT}`);
    });

    it('fails guided with nothing written when the flag-path ping fails', async () => {
        const dir = tmp.makeTmp('reconcile-');
        writeOfflineTree(dir);
        vi.mocked(checkAwsCredentials).mockRejectedValueOnce(Object.assign(new Error('no creds'), { name: 'CredentialsProviderError' }));

        const out = await reconcileOfflineTree({
            targetDir: dir,
            // spawnSyncImpl keeps the guidance hermetic: no real `aws`
            // spawn, which stalls this test on loaded CI runners.
            options: { accountId: ACCOUNT, autoApprove: true, spawnSyncImpl: () => ({ status: 0 }) },
            projectName: 'myapp',
        });

        expect(out.proceed).toBe(false);
        expect(trackEvent).toHaveBeenCalledWith('infrastructure_applied', expect.objectContaining({
            success: false,
            error_code: 'AWS_CREDENTIALS_MISSING',
        }));
        expect(findUnreconciledFiles(dir)).toHaveLength(2);
        expect(ensureStateBucketExists).not.toHaveBeenCalled();
    });

    it('an expired-credentials ensure failure stays guided and names convergence', async () => {
        const dir = tmp.makeTmp('reconcile-');
        writeOfflineTree(dir);
        vi.mocked(ensureStateBucketExists).mockRejectedValueOnce(Object.assign(new Error('expired'), { name: 'ExpiredTokenException' }));

        const out = await reconcileOfflineTree({
            targetDir: dir,
            options: { accountId: ACCOUNT, autoApprove: true, spawnSyncImpl: () => ({ status: 0 }) },
            projectName: 'myapp',
        });

        expect(out.proceed).toBe(false);
        expect(trackEvent).toHaveBeenCalledWith('infrastructure_applied', expect.objectContaining({
            success: false,
            error_code: 'AWS_CREDENTIALS_MISSING',
        }));
        expect(findUnreconciledFiles(dir)).toEqual([]);
    });

    it('a non-credential ensure failure fails loud with context, not a raw throw', async () => {
        const dir = tmp.makeTmp('reconcile-');
        writeOfflineTree(dir);
        vi.mocked(ensureStateBucketExists).mockRejectedValueOnce(Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' }));

        const out = await reconcileOfflineTree({
            targetDir: dir,
            options: { accountId: ACCOUNT, autoApprove: true },
            projectName: 'myapp',
        });

        expect(out.proceed).toBe(false);
        expect(out.result).toMatchObject({ ok: false });
        expect(trackEvent).toHaveBeenCalledWith('infrastructure_applied', expect.objectContaining({
            success: false,
            error_code: 'RECONCILE_BUCKET_FAILED',
        }));
    });

    it('rejects an invalid --account-id with INVALID_ACCOUNT_ID and writes nothing', async () => {
        const dir = tmp.makeTmp('reconcile-');
        writeOfflineTree(dir);
        const before = fs.readFileSync(path.join(dir, 'terraform', 'backend.tf'), 'utf8');

        const out = await reconcileOfflineTree({
            targetDir: dir,
            options: { accountId: 'abc', autoApprove: true },
            projectName: 'myapp',
        });

        expect(out.proceed).toBe(false);
        expect(out.result).toMatchObject({ ok: false });
        expect(trackEvent).toHaveBeenCalledWith('infrastructure_applied', expect.objectContaining({
            success: false,
            error_code: 'INVALID_ACCOUNT_ID',
        }));
        expect(fs.readFileSync(path.join(dir, 'terraform', 'backend.tf'), 'utf8')).toBe(before);
        expect(checkAwsCredentials).not.toHaveBeenCalled();
    });

    it('refuses non-interactive without approval and writes nothing', async () => {
        const dir = tmp.makeTmp('reconcile-');
        writeOfflineTree(dir);
        const savedCi = process.env.CI;
        process.env.CI = 'true';
        try {
            const out = await reconcileOfflineTree({ targetDir: dir, options: {}, projectName: 'myapp' });

            expect(out.proceed).toBe(false);
            expect(trackEvent).toHaveBeenCalledWith('infrastructure_applied', expect.objectContaining({
                success: false,
                error_code: 'RECONCILE_NON_INTERACTIVE',
            }));
            expect(findUnreconciledFiles(dir)).toHaveLength(2);
        } finally {
            if (savedCi === undefined) delete process.env.CI;
            else process.env.CI = savedCi;
        }
    });

    it('asks once interactively and proceeds on confirm', async () => {
        const dir = tmp.makeTmp('reconcile-');
        writeOfflineTree(dir);
        vi.mocked(confirm).mockResolvedValueOnce(true);

        const out = await reconcileOfflineTree({
            targetDir: dir,
            options: { isHeadless: false },
            projectName: 'myapp',
        });

        expect(out).toEqual({ proceed: true });
        expect(vi.mocked(confirm)).toHaveBeenCalledTimes(1);
        expect(findUnreconciledFiles(dir)).toEqual([]);
    });

    it('declining the reconcile confirm returns cancelled without exiting', async () => {
        const dir = tmp.makeTmp('reconcile-');
        writeOfflineTree(dir);
        vi.mocked(confirm).mockResolvedValueOnce(false);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
        try {
            const out = await reconcileOfflineTree({
                targetDir: dir,
                options: { isHeadless: false },
                projectName: 'myapp',
            });
            expect(out).toEqual({ proceed: false, result: { ok: false, reason: 'cancelled' } });
            expect(exitSpy).not.toHaveBeenCalled();
            expect(findUnreconciledFiles(dir)).toHaveLength(2);
        } finally {
            exitSpy.mockRestore();
        }
    });

    it('rewrite is idempotent: a second pass finds nothing and files are byte-identical', async () => {
        const dir = tmp.makeTmp('reconcile-');
        writeOfflineTree(dir);
        const options = { accountId: ACCOUNT, autoApprove: true };

        await reconcileOfflineTree({ targetDir: dir, options, projectName: 'myapp' });
        const backendAfterFirst = fs.readFileSync(path.join(dir, 'terraform', 'backend.tf'), 'utf8');
        const workflowAfterFirst = fs.readFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'utf8');

        expect(findUnreconciledFiles(dir)).toEqual([]);
        await reconcileOfflineTree({ targetDir: dir, options, projectName: 'myapp' });
        expect(fs.readFileSync(path.join(dir, 'terraform', 'backend.tf'), 'utf8')).toBe(backendAfterFirst);
        expect(fs.readFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'utf8')).toBe(workflowAfterFirst);
    });

    it('migrates a 0.40.17-era offline fixture to exact backend + ARN contents', async () => {
        const dir = tmp.makeTmp('reconcile-');
        writeBackend(dir, `myapp-tfstate-${PLACEHOLDER_ACCOUNT_ID}`);
        writeWorkflow(dir, 'deploy.yml', PLACEHOLDER_ACCOUNT_ID);

        await reconcileOfflineTree({
            targetDir: dir,
            options: { accountId: ACCOUNT, autoApprove: true },
            projectName: 'myapp',
        });

        expect(fs.readFileSync(path.join(dir, 'terraform', 'backend.tf'), 'utf8')).toBe(
            `terraform {\n  backend "s3" {\n    bucket = "myapp-tfstate-${ACCOUNT}"\n    key    = "terraform.tfstate"\n    region = "us-east-2"\n  }\n}\n`
        );
        expect(fs.readFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'utf8')).toBe(
            `jobs:\n  deploy:\n    steps:\n      - uses: aws-actions/configure-aws-credentials@v4\n        with:\n          role-to-assume: arn:aws:iam::${ACCOUNT}:role/myapp-deploy\n`
        );
        expect(ensureStateBucketExists).toHaveBeenCalledWith(expect.objectContaining({
            bucket: `myapp-tfstate-${ACCOUNT}`,
            region: 'us-east-2',
        }));
    });
});

describe('applyStack offline integration', () => {
    let spies;
    let savedMockAws;

    beforeEach(() => {
        vi.clearAllMocks();
        spies = mockConsoleTrio();
        savedMockAws = process.env.CI_MOCK_AWS;
        process.env.CI_MOCK_AWS = 'true';
    });

    afterEach(() => {
        spies.restore();
        if (savedMockAws === undefined) delete process.env.CI_MOCK_AWS;
        else process.env.CI_MOCK_AWS = savedMockAws;
    });

    it('an offline tree reconciles, then proceeds into the terraform flow', async () => {
        const dir = tmp.makeTmp('reconcile-');
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'myapp' }));
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), '# minimal offline fixture\n');
        writeBackend(dir, `myapp-tfstate-${PLACEHOLDER_ACCOUNT_ID}`);
        writeWorkflow(dir, 'deploy.yml', PLACEHOLDER_ACCOUNT_ID);
        const savedCwd = process.cwd();
        process.chdir(dir);
        try {
            await applyStack({ autoApprove: true, accountId: ACCOUNT });

            expect(findUnreconciledFiles(dir)).toEqual([]);
            expect(trackEvent).toHaveBeenCalledWith('apply_reconciled', expect.objectContaining({
                account_source: 'flag',
            }));
            expect(runTerraformCommand).toHaveBeenCalled();
        } finally {
            process.chdir(savedCwd);
        }
    });

    it('a reconciled tree never triggers the pre-step', async () => {
        const dir = tmp.makeTmp('reconcile-');
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'myapp' }));
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), '# minimal fixture\n');
        writeBackend(dir, `myapp-tfstate-${ACCOUNT}`);
        writeWorkflow(dir, 'deploy.yml', ACCOUNT);
        const savedCwd = process.cwd();
        process.chdir(dir);
        try {
            await applyStack({ autoApprove: true });

            expect(trackEvent).not.toHaveBeenCalledWith('apply_reconciled', expect.anything());
        } finally {
            process.chdir(savedCwd);
        }
    });
});
