import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { mockConfirm, mockOutro, mockSpinnerStart, mockSpinnerStop } from './helpers/clack.js';
import fs from 'fs/promises';
import path from 'path';
import { pushSecrets, pullSecrets, auditSecrets, resolveSecretsRegion, quoteEnvValue, diffSecretsEnvs } from '../src/commands/secrets.js';
import dotenv from 'dotenv';
import { trackEvent } from '../src/core/telemetry.js';

// 1. Use vi.hoisted() so these variables are available when vi.mock() runs at the top of the file
const { mockSend, MockSecretsManagerClient, MockUpdateSecretCommand, MockGetSecretValueCommand } = vi.hoisted(() => {
    const sendFn = vi.fn().mockResolvedValue({});
    return {
        mockSend: sendFn,
        MockSecretsManagerClient: vi.fn(function (config) {
            this.config = config;
            this.send = sendFn;
        }),
        MockUpdateSecretCommand: vi.fn(function (input) {
            Object.assign(this, input);
        }),
        MockGetSecretValueCommand: vi.fn(function (input) {
            Object.assign(this, input);
        })
    };
});

const { mockEcsSend, MockECSClient, MockUpdateServiceCommand } = vi.hoisted(() => {
    const ecsSendFn = vi.fn().mockResolvedValue({});
    return {
        mockEcsSend: ecsSendFn,
        MockECSClient: vi.fn(function (config) {
            this.config = config;
            this.send = ecsSendFn;
        }),
        MockUpdateServiceCommand: vi.fn(function (input) {
            Object.assign(this, input);
        }),
    };
});

// 2. Inject the hoisted mocks into the AWS SDK
vi.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: MockSecretsManagerClient,
    UpdateSecretCommand: MockUpdateSecretCommand,
    GetSecretValueCommand: MockGetSecretValueCommand
}));

vi.mock('@aws-sdk/client-ecs', () => ({
    ECSClient: MockECSClient,
    UpdateServiceCommand: MockUpdateServiceCommand,
}));

// 3. Mock @clack/prompts to prevent hangs on user input during testing

// 4. Mock telemetry to prevent real network calls during testing

describe('Secrets Push Command', () => {
    const originalCwd = process.cwd();
    const testDir = path.join(originalCwd, 'tests', '.tmp-secrets-env');

    beforeEach(async () => {
        // Create a fake project directory and step into it
        await fs.mkdir(path.join(testDir, 'terraform'), { recursive: true });
        process.chdir(testDir);
        mockConfirm.mockReset();
        mockConfirm.mockResolvedValue(false);
        mockEcsSend.mockReset();
        mockEcsSend.mockResolvedValue({});
    });

    afterEach(async () => {
        // Step back out, clean up the files, and reset mocks
        process.chdir(originalCwd);
        await fs.rm(testDir, { recursive: true, force: true });
        vi.clearAllMocks();
        mockSend.mockReset();
        mockSend.mockResolvedValue({}); // Reset to default success state
        mockEcsSend.mockReset();
        mockEcsSend.mockResolvedValue({});
    });

    it('reads .env, pushes to AWS, and writes secret_keys.json', async () => {
        // Setup: Create a fake .env and a fake backend.tf (to test region extraction)
        await fs.writeFile('.env', 'GITHUB_TOKEN=ghp_12345\nDB_PASS=supersecret');
        await fs.writeFile(path.join('terraform', 'backend.tf'), 'region = "us-east-2"');

        // Execute the CLI command
        await pushSecrets('.env', 'my-project');

        // Assert 1: Did we initialize the AWS client with the correct region from backend.tf?
        expect(MockSecretsManagerClient).toHaveBeenCalledWith({ region: 'us-east-2' });

        // Assert 2: Did we package the exact right payload for AWS?
        expect(MockUpdateSecretCommand).toHaveBeenCalledWith({
            SecretId: 'my-project-secrets',
            SecretString: JSON.stringify({ GITHUB_TOKEN: 'ghp_12345', DB_PASS: 'supersecret' })
        });

        // Assert 3: Did we write the keys to the local JSON file for Terraform to use?
        const keysPath = path.join('terraform', 'secret_keys.json');
        const keysContent = await fs.readFile(keysPath, 'utf-8');
        expect(JSON.parse(keysContent)).toEqual(['GITHUB_TOKEN', 'DB_PASS']);
    });

    it('addresses the suffixed vault on suffixed trees', async () => {
        await fs.writeFile('.env', 'GITHUB_TOKEN=ghp_12345\nDB_PASS=supersecret');
        await fs.writeFile(path.join('terraform', 'backend.tf'), 'region = "us-east-2"');
        await fs.writeFile(
            path.join('terraform', 'main.tf'),
            'locals {\n  grada_resource_suffix = "-a1b2c3"\n}\n'
        );

        await pushSecrets('.env', 'my-project');

        expect(MockUpdateSecretCommand).toHaveBeenCalledWith({
            SecretId: 'my-project-a1b2c3-secrets',
            SecretString: JSON.stringify({ GITHUB_TOKEN: 'ghp_12345', DB_PASS: 'supersecret' })
        });
    });

    it('handles a missing AWS vault (ResourceNotFoundException) gracefully', async () => {
        // Setup: GetSecretValue finds no vault (new vault path), then UpdateSecret also fails
        mockSend.mockRejectedValueOnce({ name: 'ResourceNotFoundException', message: 'Vault missing' });
        mockSend.mockRejectedValueOnce({ name: 'ResourceNotFoundException', message: 'Vault missing' });
        await fs.writeFile('.env', 'API_KEY=123');

        // We must mock process.exit so the test runner doesn't crash when the CLI tries to exit
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        // Execute
        await pushSecrets('.env', 'my-project');

        // Assert: Ensure the CLI caught the error and attempted a clean exit
        expect(exitSpy).toHaveBeenCalledWith(1);

        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });

    it('gracefully falls back to .env when envFilePath is undefined or omitted', async () => {
        // Create default .env file
        await fs.writeFile('.env', 'DATABASE_URL=postgres://localhost:5432/db');
        await fs.writeFile(path.join('terraform', 'backend.tf'), 'region = "us-east-1"');

        // Call pushSecrets with undefined/omitted argument
        await pushSecrets(undefined, 'my-project');

        // Verify it resolved .env properly and sent secrets
        expect(MockUpdateSecretCommand).toHaveBeenCalledWith({
            SecretId: 'my-project-secrets',
            SecretString: JSON.stringify({ DATABASE_URL: 'postgres://localhost:5432/db' })
        });
    });

    it('gracefully falls back to .env when envFilePath is passed as an object or invalid type', async () => {
        // Simulates Commander passing an options object as the first parameter
        await fs.writeFile('.env', 'STRIPE_KEY=sk_test_12345');
        await fs.writeFile(path.join('terraform', 'backend.tf'), 'region = "us-east-1"');

        // Call pushSecrets with an object
        await pushSecrets({}, 'my-project');

        expect(MockUpdateSecretCommand).toHaveBeenCalledWith({
            SecretId: 'my-project-secrets',
            SecretString: JSON.stringify({ STRIPE_KEY: 'sk_test_12345' })
        });
    });

    it('guards against CI injection and defaults to .env if the filename lacks a standard extension', async () => {
        // Setup default .env file
        await fs.writeFile('.env', 'CI_INJECTION_GUARD=success');
        await fs.writeFile(path.join('terraform', 'backend.tf'), 'region = "us-east-1"');

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        // Execute with "event" (simulating a GitHub Actions ${{ github.event_name }} bug)
        await pushSecrets('event', 'my-project');

        // Assert warning was printed and it successfully read from .env instead
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('does not look like a standard secrets file'));
        expect(MockUpdateSecretCommand).toHaveBeenCalledWith({
            SecretId: 'my-project-secrets',
            SecretString: JSON.stringify({ CI_INJECTION_GUARD: 'success' })
        });

        consoleSpy.mockRestore();
    });

    it('keeps the GitHub commit guidance and skips ECS restart when keys changed', async () => {
        await fs.writeFile('.env', 'NEW_KEY=abc\nOTHER=xyz');
        await fs.writeFile(path.join('terraform', 'backend.tf'), 'region = "us-east-1"');
        // Existing vault holds a different key set (addition + deletion)
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ OLD_KEY: '1', OTHER: 'old' }) });
        mockSend.mockResolvedValueOnce({});

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const result = await pushSecrets('.env', 'my-project');

        expect(MockGetSecretValueCommand).toHaveBeenCalledWith({ SecretId: 'my-project-secrets' });
        expect(MockUpdateSecretCommand).toHaveBeenCalledWith({
            SecretId: 'my-project-secrets',
            SecretString: JSON.stringify({ NEW_KEY: 'abc', OTHER: 'xyz' })
        });
        // Keys changed: instruct the user to commit secret_keys.json, do not prompt for ECS restart
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Commit this file and push to GitHub'));
        expect(mockConfirm).not.toHaveBeenCalled();
        expect(MockECSClient).not.toHaveBeenCalled();
        expect(mockEcsSend).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ keysChanged: true }));

        consoleSpy.mockRestore();
    });

    it('prompts for and triggers a rolling ECS restart when only values changed', async () => {
        await fs.writeFile('.env', 'API_KEY=newvalue\nDB_PASS=newsecret');
        await fs.writeFile(path.join('terraform', 'backend.tf'), 'region = "us-east-1"');
        // Existing vault holds the identical key set with older values
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'oldvalue', DB_PASS: 'oldsecret' }) });
        mockSend.mockResolvedValueOnce({});
        mockConfirm.mockResolvedValueOnce(true);

        const result = await pushSecrets('.env', 'my-project');

        expect(MockGetSecretValueCommand).toHaveBeenCalledWith({ SecretId: 'my-project-secrets' });
        expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Keys are unchanged. Trigger a rolling ECS restart to apply new values immediately?',
        }));
        expect(MockECSClient).toHaveBeenCalledWith({ region: 'us-east-1' });
        expect(MockUpdateServiceCommand).toHaveBeenCalledWith({
            cluster: 'my-project-cluster',
            service: 'my-project-service',
            forceNewDeployment: true,
        });
        expect(mockEcsSend).toHaveBeenCalledTimes(1);
        expect(mockSpinnerStart).toHaveBeenCalledWith('Triggering rolling ECS restart...');
        expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining('Rolling restart initiated'));
        expect(result).toEqual(expect.objectContaining({ keysChanged: false, restarted: true }));
    });

    it('skips the ECS restart when keys are identical but the user declines', async () => {
        await fs.writeFile('.env', 'API_KEY=newvalue');
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'oldvalue' }) });
        mockSend.mockResolvedValueOnce({});
        mockConfirm.mockResolvedValueOnce(false);

        const result = await pushSecrets('.env', 'my-project');

        expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Keys are unchanged. Trigger a rolling ECS restart to apply new values immediately?',
        }));
        expect(mockEcsSend).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ keysChanged: false }));
    });

    it('skips the ECS restart prompt in headless mode without hanging', async () => {
        await fs.writeFile('.env', 'API_KEY=newvalue');
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'oldvalue' }) });
        mockSend.mockResolvedValueOnce({});

        const result = await pushSecrets('.env', 'my-project', { isHeadless: true });

        expect(mockConfirm).not.toHaveBeenCalled();
        expect(mockEcsSend).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ keysChanged: false, restarted: false }));
        expect(trackEvent).toHaveBeenCalledWith('secrets_pushed', expect.objectContaining({
            keys_changed: false,
            ecs_restart: false,
            success: true,
        }));
    });

    it('treats a new vault (ResourceNotFoundException on fetch) as keys changed', async () => {
        await fs.writeFile('.env', 'FRESH_KEY=1');
        mockSend.mockRejectedValueOnce({ name: 'ResourceNotFoundException', message: 'missing' });
        mockSend.mockResolvedValueOnce({});

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const result = await pushSecrets('.env', 'my-project');

        expect(MockUpdateSecretCommand).toHaveBeenCalledWith({
            SecretId: 'my-project-secrets',
            SecretString: JSON.stringify({ FRESH_KEY: '1' })
        });
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Commit this file and push to GitHub'));
        expect(mockConfirm).not.toHaveBeenCalled();
        expect(mockEcsSend).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ keysChanged: true }));

        consoleSpy.mockRestore();
    });

    it('creates an empty .env file when missing and the user confirms', async () => {
        const originalCI = process.env.CI;
        delete process.env.CI;
        mockConfirm.mockResolvedValueOnce(true);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });

        try {
            await pushSecrets('.env', 'my-project');

            expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
                message: expect.stringContaining('Would you like to create an empty .env file'),
            }));
            const content = await fs.readFile('.env', 'utf-8');
            expect(content).toBe('# Add your environment variables here\n');
            expect(MockSecretsManagerClient).not.toHaveBeenCalled();
            expect(trackEvent).toHaveBeenCalledWith('secrets_pushed', expect.objectContaining({ reason: 'created_empty_file' }));
            expect(exitSpy).not.toHaveBeenCalled();
        } finally {
            consoleSpy.mockRestore();
            exitSpy.mockRestore();
            if (originalCI === undefined) delete process.env.CI;
            else process.env.CI = originalCI;
        }
    });

    it('does nothing when the user declines creating the .env file', async () => {
        const originalCI = process.env.CI;
        delete process.env.CI;
        mockConfirm.mockResolvedValueOnce(false);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });

        try {
            await pushSecrets('.env', 'my-project');

            expect(mockConfirm).toHaveBeenCalled();
            await expect(fs.readFile('.env', 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
            expect(MockSecretsManagerClient).not.toHaveBeenCalled();
            expect(exitSpy).not.toHaveBeenCalled();
        } finally {
            consoleSpy.mockRestore();
            exitSpy.mockRestore();
            if (originalCI === undefined) delete process.env.CI;
            else process.env.CI = originalCI;
        }
    });

    it('treats prompt cancellation like declining', async () => {
        const originalCI = process.env.CI;
        delete process.env.CI;
        mockConfirm.mockResolvedValueOnce(Symbol('cancel'));
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });

        try {
            await pushSecrets('.env', 'my-project');

            await expect(fs.readFile('.env', 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
            expect(MockSecretsManagerClient).not.toHaveBeenCalled();
            expect(exitSpy).not.toHaveBeenCalled();
        } finally {
            consoleSpy.mockRestore();
            exitSpy.mockRestore();
            if (originalCI === undefined) delete process.env.CI;
            else process.env.CI = originalCI;
        }
    });

    it('exits 1 without prompting when headless and the .env file is missing', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        try {
            await pushSecrets('.env', 'my-project', { isHeadless: true });

            expect(mockConfirm).not.toHaveBeenCalled();
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('In automated environments'));
            expect(trackEvent).toHaveBeenCalledWith('secrets_pushed', expect.objectContaining({ reason: 'missing_env_headless' }));
            expect(exitSpy).toHaveBeenCalledWith(1);
            await expect(fs.readFile('.env', 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            exitSpy.mockRestore();
            consoleSpy.mockRestore();
        }
    });

    it('exits 1 without prompting when CI is set even without the headless flag', async () => {
        const originalCI = process.env.CI;
        process.env.CI = 'true';
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        try {
            await pushSecrets('.env', 'my-project');

            expect(mockConfirm).not.toHaveBeenCalled();
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            exitSpy.mockRestore();
            consoleSpy.mockRestore();
            if (originalCI === undefined) delete process.env.CI;
            else process.env.CI = originalCI;
        }
    });
});

describe('Secrets Pull Command', () => {
    const originalCwd = process.cwd();
    const testDir = path.join(originalCwd, 'tests', '.tmp-secrets-pull-audit');

    beforeEach(async () => {
        await fs.mkdir(path.join(testDir, 'terraform'), { recursive: true });
        process.chdir(testDir);
        mockConfirm.mockReset();
        mockConfirm.mockResolvedValue(true);
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.rm(testDir, { recursive: true, force: true });
        vi.clearAllMocks();
        mockSend.mockReset();
        mockSend.mockResolvedValue({});
    });

    it('creates .env from remote payload when local file is missing', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'abc', DB_PASS: 'xyz' }) });
        await fs.writeFile(path.join('terraform', 'backend.tf'), 'region = "us-east-2"');

        const result = await pullSecrets('.env', 'my-project', { isHeadless: true });

        expect(MockGetSecretValueCommand).toHaveBeenCalledWith({ SecretId: 'my-project-secrets' });
        expect(MockSecretsManagerClient).toHaveBeenCalledWith({ region: 'us-east-2' });
        expect(mockConfirm).not.toHaveBeenCalled();

        const content = await fs.readFile('.env', 'utf-8');
        expect(content).toContain('API_KEY="abc"');
        expect(content).toContain('DB_PASS="xyz"');
        expect(result.synced).toBe(2);
        expect(mockSpinnerStart).toHaveBeenCalledWith('Fetching secrets from AWS...');
        expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining('Successfully synced 2 secrets to .env'));
        expect(trackEvent).toHaveBeenCalledWith('secrets_pull', expect.objectContaining({ variablesCount: 2 }));
    });

    it('asks to overwrite and applies remote values when confirm returns true', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'remote', NEW_KEY: 'new' }) });
        await fs.writeFile('.env', 'API_KEY=local\nLOCAL_ONLY=keep');
        mockConfirm.mockResolvedValueOnce(true);

        await pullSecrets('.env', 'my-project');

        expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Overwrite local values with remote'),
        }));
        const content = await fs.readFile('.env', 'utf-8');
        expect(content).toContain('API_KEY="remote"');
        expect(content).toContain('NEW_KEY="new"');
        expect(content).toContain('LOCAL_ONLY="keep"');
    });

    it('preserves local values for conflicts when confirm returns false', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'remote', NEW_KEY: 'new' }) });
        await fs.writeFile('.env', 'API_KEY=local\nLOCAL_ONLY=keep');
        mockConfirm.mockResolvedValueOnce(false);

        const result = await pullSecrets('.env', 'my-project');

        expect(result.overwritten).toBe(false);
        const content = await fs.readFile('.env', 'utf-8');
        expect(content).toContain('API_KEY="local"');
        expect(content).toContain('NEW_KEY="new"');
        expect(content).toContain('LOCAL_ONLY="keep"');
    });

    it('auto-overwrites conflicts in headless mode without prompting', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'remote' }) });
        await fs.writeFile('.env', 'API_KEY=local');

        await pullSecrets('.env', 'my-project', { isHeadless: true });

        expect(mockConfirm).not.toHaveBeenCalled();
        const content = await fs.readFile('.env', 'utf-8');
        expect(content).toContain('API_KEY="remote"');
    });

    it('defaults to .env when file argument is omitted', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ A: '1' }) });

        await pullSecrets(undefined, 'my-project', { isHeadless: true });

        const content = await fs.readFile('.env', 'utf-8');
        expect(content).toContain('A="1"');
    });

    it('handles missing remote vault by suggesting secrets push', async () => {
        mockSend.mockRejectedValueOnce({ name: 'ResourceNotFoundException', message: 'missing' });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        await pullSecrets('.env', 'my-project', { isHeadless: true });

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('secrets push'));

        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });
});

describe('Secrets Audit Command', () => {
    const originalCwd = process.cwd();
    const testDir = path.join(originalCwd, 'tests', '.tmp-secrets-pull-audit');

    beforeEach(async () => {
        await fs.mkdir(path.join(testDir, 'terraform'), { recursive: true });
        process.chdir(testDir);
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.rm(testDir, { recursive: true, force: true });
        vi.clearAllMocks();
        mockSend.mockReset();
        mockSend.mockResolvedValue({});
    });

    it('reports missing, mismatched, and untracked keys with drift count', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ SAME: '1', CHANGED: 'remote', ONLY_REMOTE: 'x' }) });
        await fs.writeFile('.env', 'SAME=1\nCHANGED=local\nONLY_LOCAL=y');
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const result = await auditSecrets('.env', 'my-project');

        expect(MockGetSecretValueCommand).toHaveBeenCalledWith({ SecretId: 'my-project-secrets' });
        expect(mockSpinnerStart).toHaveBeenCalledWith('Auditing local environment against AWS...');
        expect(result).toEqual({
            missingLocally: ['ONLY_REMOTE'],
            mismatched: ['CHANGED'],
            untrackedLocally: ['ONLY_LOCAL'],
            driftCount: 3,
        });
        expect(trackEvent).toHaveBeenCalledWith('secrets_audit', expect.objectContaining({ driftCount: 3 }));
        expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining('3 drifted variable(s)'));

        consoleSpy.mockRestore();
    });

    it('reports in-sync when local matches remote', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ A: '1' }) });
        await fs.writeFile('.env', 'A=1');
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const result = await auditSecrets('.env', 'my-project');

        expect(result.driftCount).toBe(0);
        expect(trackEvent).toHaveBeenCalledWith('secrets_audit', expect.objectContaining({ driftCount: 0 }));

        consoleSpy.mockRestore();
    });

    it('treats a missing local file as fully missing locally', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ A: '1', B: '2' }) });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const result = await auditSecrets('.env', 'my-project');

        expect(result.missingLocally).toEqual(['A', 'B']);
        expect(result.driftCount).toBe(2);

        consoleSpy.mockRestore();
    });

    it('handles missing remote vault by suggesting secrets push', async () => {
        mockSend.mockRejectedValueOnce({ name: 'ResourceNotFoundException', message: 'missing' });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        await auditSecrets('.env', 'my-project');

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('secrets push'));

        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });
});

describe('Secrets Region Resolution', () => {
    const originalCwd = process.cwd();
    const testDir = path.join(originalCwd, 'tests', '.tmp-secrets-region');
    let savedAwsRegion;
    let savedAwsDefaultRegion;

    beforeEach(async () => {
        await fs.mkdir(path.join(testDir, 'terraform'), { recursive: true });
        process.chdir(testDir);
        savedAwsRegion = process.env.AWS_REGION;
        savedAwsDefaultRegion = process.env.AWS_DEFAULT_REGION;
        delete process.env.AWS_REGION;
        delete process.env.AWS_DEFAULT_REGION;
        mockConfirm.mockReset();
        mockConfirm.mockResolvedValue(false);
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.rm(testDir, { recursive: true, force: true });
        if (savedAwsRegion === undefined) delete process.env.AWS_REGION;
        else process.env.AWS_REGION = savedAwsRegion;
        if (savedAwsDefaultRegion === undefined) delete process.env.AWS_DEFAULT_REGION;
        else process.env.AWS_DEFAULT_REGION = savedAwsDefaultRegion;
        vi.clearAllMocks();
        mockSend.mockReset();
        mockSend.mockResolvedValue({});
        mockEcsSend.mockReset();
        mockEcsSend.mockResolvedValue({});
    });

    it('prefers the explicit region option over env and files', async () => {
        process.env.AWS_REGION = 'eu-west-1';
        await fs.writeFile(path.join('terraform', 'backend.tf'), 'region = "ap-south-1"');
        expect(await resolveSecretsRegion({ region: 'us-west-2' })).toBe('us-west-2');
    });

    it('falls back through AWS_REGION then AWS_DEFAULT_REGION', async () => {
        process.env.AWS_REGION = 'eu-west-1';
        process.env.AWS_DEFAULT_REGION = 'ap-south-1';
        expect(await resolveSecretsRegion({})).toBe('eu-west-1');
        delete process.env.AWS_REGION;
        expect(await resolveSecretsRegion({})).toBe('ap-south-1');
    });

    it('reads the region from terraform/backend.tf and ignores placeholders', async () => {
        await fs.writeFile(path.join('terraform', 'backend.tf'), 'region = "eu-central-1"');
        expect(await resolveSecretsRegion({})).toBe('eu-central-1');
        await fs.writeFile(path.join('terraform', 'backend.tf'), 'region = "{{REGION}}"');
        expect(await resolveSecretsRegion({})).toBe('us-east-2');
    });

    it('falls back to us-east-2 and trims blank values', async () => {
        expect(await resolveSecretsRegion({})).toBe('us-east-2');
        process.env.AWS_REGION = '   ';
        expect(await resolveSecretsRegion({})).toBe('us-east-2');
        expect(await resolveSecretsRegion({ region: '  eu-west-1  ' })).toBe('eu-west-1');
    });

    it('pushSecrets builds the SDK client with the resolved default region', async () => {
        await fs.writeFile('.env', 'API_KEY=abc');
        await pushSecrets('.env', 'my-project');
        expect(MockSecretsManagerClient).toHaveBeenCalledWith({ region: 'us-east-2' });
    });

    it('pushSecrets honors an explicit region option', async () => {
        await fs.writeFile('.env', 'API_KEY=abc');
        await pushSecrets('.env', 'my-project', { region: 'eu-west-1' });
        expect(MockSecretsManagerClient).toHaveBeenCalledWith({ region: 'eu-west-1' });
    });

    it('pullSecrets builds the SDK client with the resolved default region', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'abc' }) });
        await pullSecrets('.env', 'my-project', { isHeadless: true });
        expect(MockSecretsManagerClient).toHaveBeenCalledWith({ region: 'us-east-2' });
    });

    it('auditSecrets builds the SDK client with the resolved default region', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ A: '1' }) });
        await fs.writeFile('.env', 'A=1');
        await auditSecrets('.env', 'my-project');
        expect(MockSecretsManagerClient).toHaveBeenCalledWith({ region: 'us-east-2' });
    });

    it('pushSecrets builds the ECS client with the resolved default region on restart', async () => {
        await fs.writeFile('.env', 'API_KEY=newvalue');
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'oldvalue' }) });
        mockSend.mockResolvedValueOnce({});
        mockConfirm.mockResolvedValueOnce(true);

        const result = await pushSecrets('.env', 'my-project');

        expect(result).toEqual(expect.objectContaining({ restarted: true }));
        expect(MockECSClient).toHaveBeenCalledWith({ region: 'us-east-2' });
    });

    it('tracks ENV_FILE_MISSING when headless and the .env file is absent', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        try {
            await pushSecrets('.env', 'my-project', { isHeadless: true });
            expect(trackEvent).toHaveBeenCalledWith('secrets_pushed', expect.objectContaining({
                success: false,
                error_code: 'ENV_FILE_MISSING',
            }));
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            exitSpy.mockRestore();
            consoleSpy.mockRestore();
        }
    });

    it('tracks REMOTE_SECRET_MALFORMED when the remote payload is not JSON', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: 'not-json{{{' });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        try {
            await pullSecrets('.env', 'my-project', { isHeadless: true });
            expect(trackEvent).toHaveBeenCalledWith('secrets_pull', expect.objectContaining({
                success: false,
                error_code: 'REMOTE_SECRET_MALFORMED',
            }));
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            exitSpy.mockRestore();
            consoleSpy.mockRestore();
        }
    });
});

describe('Secrets Push on --target lambda projects', () => {
    const originalCwd = process.cwd();
    const testDir = path.join(originalCwd, 'tests', '.tmp-secrets-lambda-env');

    beforeEach(async () => {
        await fs.mkdir(path.join(testDir, 'terraform'), { recursive: true });
        await fs.writeFile(
            path.join(testDir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "myapp${local.env_suffix}"\n}\nresource "aws_lambda_function" "app" {}\n'
        );
        process.chdir(testDir);
        mockConfirm.mockReset();
        mockConfirm.mockResolvedValue(false);
        mockEcsSend.mockReset();
        mockEcsSend.mockResolvedValue({});
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.rm(testDir, { recursive: true, force: true });
        vi.clearAllMocks();
        mockSend.mockReset();
        mockSend.mockResolvedValue({});
        mockEcsSend.mockReset();
        mockEcsSend.mockResolvedValue({});
    });

    it('skips the ECS restart prompt when keys are unchanged', async () => {
        await fs.writeFile('.env', 'API_KEY=new-value');
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'old-value' }) });
        mockSend.mockResolvedValueOnce({});

        const result = await pushSecrets('.env', 'myapp');

        expect(result).toEqual({ keysChanged: false, restarted: false });
        expect(mockConfirm).not.toHaveBeenCalled();
        expect(mockEcsSend).not.toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith('secrets_pushed', expect.objectContaining({
            keys_changed: false,
            ecs_restart: false,
            success: true,
        }));
    });
});

describe('Secrets Pull quoting', () => {
    it.each([
        // [value, expected output] — plain values keep the legacy double-quote style byte-identical
        ['abc', '"abc"'],
        ['', '""'],
        ["it's", '"it\'s"'],
        ['say "hi"', "'say \"hi\"'"],
        ['a`b', '"a`b"'],
        ['x\'y`z', '"x\'y`z"'],
        ['it\'s "quoted"', '`it\'s "quoted"`'],
        ['C:\\new\\dir', "'C:\\new\\dir'"],
        ['line1\nline2', '"line1\\nline2"'],
        ["it's\nmultiline", '"it\'s\\nmultiline"'],
        ['tab\there', '"tab\there"'],
        ['a#b', '"a#b"'],
        ['trailing\\', "'trailing\\'"],
        ['it\'s \\d regex', '"it\'s \\d regex"'],
        // unrepresentable under dotenv quoting: every style breaks
        ['a\'b"c`d', null],
        ['it\'s `code` \\notes', null],
    ])('quotes %p as %p', (value, expected) => {
        expect(quoteEnvValue(value)).toBe(expected);
    });

    it('falls back to backticks for apostrophes paired with literal backslash-n', () => {
        expect(quoteEnvValue('it\'s \\notes')).toBe('`it\'s \\notes`');
    });
});

describe('Secrets prototype-key handling', () => {
    it('treats inherited names as genuinely missing, untracked, or matching', () => {
        expect(diffSecretsEnvs({}, JSON.parse('{"__proto__":1}')).missingLocally).toEqual(['__proto__']);
        expect(diffSecretsEnvs(JSON.parse('{"toString":"x"}'), {}).untrackedLocally).toEqual(['toString']);
        expect(diffSecretsEnvs({ A: '1' }, JSON.parse('{"A":"1","toString":"x"}')).mismatched).toEqual([]);
    });
});

describe('Secrets Pull round-trip', () => {
    const originalCwd = process.cwd();
    const testDir = path.join(originalCwd, 'tests', '.tmp-secrets-roundtrip');

    beforeEach(async () => {
        await fs.mkdir(path.join(testDir, 'terraform'), { recursive: true });
        process.chdir(testDir);
        mockConfirm.mockReset();
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.rm(testDir, { recursive: true, force: true });
        vi.clearAllMocks();
        mockSend.mockReset();
        mockSend.mockResolvedValue({});
    });

    it('writes adversarial values that parse back identically', async () => {
        const remote = {
            PLAIN: 'abc',
            APOSTROPHE: "it's",
            QUOTED: 'say "hi"',
            BACKTICK: 'a`b',
            MIXED_BT: 'x\'y`z',
            MIXED_Q: 'it\'s "quoted"',
            WINPATH: 'C:\\new\\dir',
            MULTILINE: 'line1\nline2',
            HASH: 'a#b',
            REGEX: 'it\'s \\d regex',
            TRAILING_BS: 'trailing\\',
        };
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify(remote) });

        const result = await pullSecrets('.env', 'my-project', { isHeadless: true });

        expect(result.synced).toBe(Object.keys(remote).length);
        const content = await fs.readFile('.env', 'utf-8');
        expect(dotenv.parse(content)).toEqual(remote);
    });

    it('keeps inherited names like toString in the synced file', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ toString: 'x' }) });

        await pullSecrets('.env', 'my-project', { isHeadless: true });

        const content = await fs.readFile('.env', 'utf-8');
        expect(content).toContain('toString="x"');
        expect(dotenv.parse(content)).toEqual({ toString: 'x' });
    });

    it('refuses to write when the vault holds a __proto__ key', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: '{"__proto__":"pwn"}' });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        try {
            await pullSecrets('.env', 'my-project', { isHeadless: true });

            expect(exitSpy).toHaveBeenCalledWith(1);
            await expect(fs.readFile('.env', 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            exitSpy.mockRestore();
            logSpy.mockRestore();
        }
    });

    it('refuses to write when a value cannot round-trip, naming the key', async () => {
        await fs.writeFile('.env', 'KEEP=1\n');
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ KEEP: '1', BROKEN: 'a\'b"c`d' }) });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        try {
            await pullSecrets('.env', 'my-project', { isHeadless: true });

            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(await fs.readFile('.env', 'utf-8')).toBe('KEEP=1\n');
        } finally {
            exitSpy.mockRestore();
            logSpy.mockRestore();
        }
    });
});
