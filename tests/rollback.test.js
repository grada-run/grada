import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { createdSpinners } from './helpers/clack.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    DescribeServicesCommand,
    ListTaskDefinitionsCommand,
    DescribeTaskDefinitionCommand,
    UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import { runRollback, parseRollbackArgs, discoverEligibleRevisions } from '../src/commands/rollback.js';
import { resolveWorkspaceSuffix } from '../src/utils/resolvers.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';
import { select } from '@clack/prompts';
import { handleAwsAuthError } from '../src/utils/aws.js';



vi.mock('../src/utils/aws.js', () => ({
    hasAwsCli: vi.fn().mockReturnValue(true),
    handleAwsAuthError: vi.fn(),
    isAuthError: (error) => !!error && (error.name === 'UnrecognizedClientException' || error.name === 'ExpiredTokenException'),
    resolveClient: (injected, ClientClass, clientOptions = {}) =>
        (injected && typeof injected.send === 'function' ? injected : new ClientClass(clientOptions)),
    AWS_CLI_INSTALL_URL: 'https://example.invalid/aws-cli',
}));

const arn = (rev) => `arn:aws:ecs:us-east-2:123456789012:task-definition/myapp-task:${rev}`;

function activeService(rev, deployments = []) {
    return {
        serviceName: 'myapp-service',
        status: 'ACTIVE',
        taskDefinition: arn(rev),
        desiredCount: 1,
        runningCount: 1,
        deployments,
    };
}

function completedPrimary(rev) {
    return [{
        status: 'PRIMARY',
        taskDefinition: arn(rev),
        rolloutState: 'COMPLETED',
        runningCount: 1,
        desiredCount: 1,
    }];
}

function mockClient(handler) {
    return { send: vi.fn((command) => handler(command)) };
}

function baseOptions(overrides = {}) {
    return {
        projectName: 'myapp',
        cluster: 'myapp-cluster',
        service: 'myapp-service',
        region: 'us-east-2',
        pollIntervalMs: 1,
        timeoutMs: 50,
        isHeadless: true,
        ...overrides,
    };
}

describe('rollback: CLI args', () => {
    it('parses positional revision and all flags', () => {
        expect(parseRollbackArgs(['rollback', '12', '--cluster', 'c', '--service', 's', '--region', 'eu-west-1', '--workspace', 'pr-7', '--skip-wait'])).toEqual({
            revision: '12',
            cluster: 'c',
            service: 's',
            region: 'eu-west-1',
            workspace: 'pr-7',
            skipWait: true,
        });
    });

    it('supports = syntax, defaults skipWait to false, and accepts family:rev and ARN revisions', () => {
        expect(parseRollbackArgs(['rollback', '--cluster=c', '--service=s', '--region=us-west-2'])).toEqual({
            cluster: 'c',
            service: 's',
            region: 'us-west-2',
            skipWait: false,
        });
        expect(parseRollbackArgs(['rollback', 'myapp-task:12']).revision).toBe('myapp-task:12');
        expect(parseRollbackArgs(['rollback', arn(12)]).revision).toBe(arn(12));
        expect(parseRollbackArgs(['rollback'])).toEqual({ skipWait: false });
        expect(parseRollbackArgs([])).toEqual({ skipWait: false });
        expect(parseRollbackArgs(['rollback', '--skip-wait']).skipWait).toBe(true);
        expect(parseRollbackArgs(['rollback', '--skip-wait=true']).skipWait).toBe(true);
    });

    it('is wired into bin/cli.js', () => {
        const cliSource = fs.readFileSync(path.join(process.cwd(), 'bin', 'cli.js'), 'utf8');
        expect(cliSource).toContain('rollback');
        expect(cliSource).toContain('runRollback');
        expect(cliSource).toContain('parseRollbackArgs');
    });
});

describe('rollback: workspace resolution', () => {
    it('returns no suffix without a workspace', () => {
        expect(resolveWorkspaceSuffix({}, '/tmp')).toBe('');
        expect(resolveWorkspaceSuffix({ workspace: 'default' }, '/tmp')).toBe('');
    });

    it('appends an explicit --workspace flag', () => {
        expect(resolveWorkspaceSuffix({ workspace: 'pr-123' }, '/tmp')).toBe('-pr-123');
    });
});

describe('Command: rollback (mocked ECS)', () => {
    let exitSpy;
    let consoleSpy;
    let columnsDescriptor;
    const savedCi = process.env.CI;

    const spinnerMessages = () => createdSpinners.flatMap(
        (instance) => instance.message.mock.calls.map(([msg]) => msg)
    );

    beforeEach(() => {
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        createdSpinners.length = 0;
        delete process.env.CI;
        // Wide terminal: message-content assertions see uncut frames
        // (all fit 120); truncation itself is covered by the width
        // test below plus the helper units.
        columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
        Object.defineProperty(process.stdout, 'columns', { value: 131, configurable: true });
    });

    afterEach(() => {
        exitSpy.mockRestore();
        consoleSpy.mockRestore();
        if (columnsDescriptor) Object.defineProperty(process.stdout, 'columns', columnsDescriptor);
        else delete process.stdout.columns;
        if (savedCi === undefined) delete process.env.CI;
        else process.env.CI = savedCi;
        vi.clearAllMocks();
    });

    it('caps poll frames to the terminal width on long service names', async () => {
        const service = 's'.repeat(34);
        const inProgress = {
            services: [{
                ...activeService(14),
                serviceName: service,
                deployments: [{
                    status: 'PRIMARY',
                    taskDefinition: arn(12),
                    rolloutState: 'IN_PROGRESS',
                    runningCount: 1,
                    desiredCount: 2,
                    pendingCount: 1,
                    failedTasks: 2,
                }],
            }],
        };
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) {
                const calls = ecsClient.send.mock.calls.filter(([c]) => c instanceof DescribeServicesCommand).length;
                if (calls <= 2) return inProgress;
                return { services: [activeService(12, completedPrimary(12))] };
            }
            if (command instanceof DescribeTaskDefinitionCommand) {
                return { taskDefinition: { taskDefinitionArn: arn(12), family: 'myapp-task', revision: 12, status: 'ACTIVE' } };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        const result = await runRollback({ ...baseOptions({ service }), revision: '12', ecsClient });
        expect(result.ok).toBe(true);
        const messages = spinnerMessages();
        expect(messages.length).toBeGreaterThan(0);
        for (const msg of messages) {
            expect(Array.from(String(msg)).length).toBeLessThanOrEqual(120);
        }
        // The crashing-container frame exceeds the budget raw and is cut.
        expect(messages.some((msg) => String(msg).endsWith('...'))).toBe(true);
    });

    it('explicit numeric revision describes family:12, updates service, waits for COMPLETED', async () => {
        let describeCount = 0;
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) {
                describeCount += 1;
                return describeCount === 1
                    ? { services: [activeService(14)] }
                    : { services: [activeService(12, completedPrimary(12))] };
            }
            if (command instanceof DescribeTaskDefinitionCommand) {
                return { taskDefinition: { taskDefinitionArn: arn(12), family: 'myapp-task', revision: 12, status: 'ACTIVE' } };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        const result = await runRollback({ ...baseOptions(), revision: '12', ecsClient });

        const describeCall = ecsClient.send.mock.calls.find(
            ([cmd]) => cmd instanceof DescribeTaskDefinitionCommand
        );
        expect(describeCall[0].input).toEqual({ taskDefinition: 'myapp-task:12' });

        const updateCall = ecsClient.send.mock.calls.find(
            ([cmd]) => cmd instanceof UpdateServiceCommand
        );
        expect(updateCall[0].input).toEqual({
            cluster: 'myapp-cluster',
            service: 'myapp-service',
            taskDefinition: arn(12),
            forceNewDeployment: true,
        });

        expect(trackEvent).toHaveBeenCalledWith('rollback_run', {
            projectName: 'myapp',
            success: true,
            targetRevision: '12',
        });
        expect(flushTelemetry).toHaveBeenCalled();
        expect(result).toMatchObject({ ok: true, targetTaskDefArn: arn(12), targetRevision: '12' });
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('--skip-wait triggers UpdateService, skips polling, and tracks skipWait', async () => {
        let describeServicesCalls = 0;
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) {
                describeServicesCalls += 1;
                return { services: [activeService(14)] };
            }
            if (command instanceof DescribeTaskDefinitionCommand) {
                return { taskDefinition: { taskDefinitionArn: arn(12), family: 'myapp-task', revision: 12, status: 'ACTIVE' } };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        const result = await runRollback({ ...baseOptions(), revision: '12', skipWait: true, ecsClient });

        expect(describeServicesCalls).toBe(1);
        expect(trackEvent).toHaveBeenCalledWith('rollback_run', {
            projectName: 'myapp',
            success: true,
            targetRevision: '12',
            skipWait: true,
        });
        expect(result).toMatchObject({ ok: true, targetTaskDefArn: arn(12), targetRevision: '12' });
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('refuses an explicit revision from a foreign family without touching the service', async () => {
        const foreignArn = 'arn:aws:ecs:us-east-2:123456789012:task-definition/otherapp-task:3';
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) return { services: [activeService(14)] };
            if (command instanceof DescribeTaskDefinitionCommand) {
                return { taskDefinition: { taskDefinitionArn: foreignArn, family: 'otherapp-task', revision: 3, status: 'ACTIVE' } };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        await runRollback({ ...baseOptions(), revision: 'otherapp-task:3', ecsClient });

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('otherapp-task'));
        expect(ecsClient.send.mock.calls.some(([cmd]) => cmd instanceof UpdateServiceCommand)).toBe(false);
        expect(trackEvent).toHaveBeenCalledWith('rollback_run', {
            projectName: 'myapp',
            success: false,
            error_code: 'REVISION_FAMILY_MISMATCH',
            reason: 'revision-family-mismatch',
        });
    });

    it('names the family mismatch instead of the already-on-revision warning for same-number foreign refs', async () => {
        const foreignArn = 'arn:aws:ecs:us-east-2:123456789012:task-definition/otherapp-task:14';
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) return { services: [activeService(14)] };
            if (command instanceof DescribeTaskDefinitionCommand) {
                return { taskDefinition: { taskDefinitionArn: foreignArn, family: 'otherapp-task', revision: 14, status: 'ACTIVE' } };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        await runRollback({ ...baseOptions(), revision: 'otherapp-task:14', ecsClient });

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('otherapp-task'));
        expect(trackEvent).toHaveBeenCalledWith('rollback_run', expect.objectContaining({
            error_code: 'REVISION_FAMILY_MISMATCH',
        }));
    });

    it('still applies an explicit same-family revision given as family:rev', async () => {
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) {
                const calls = ecsClient.send.mock.calls.filter(([c]) => c instanceof DescribeServicesCommand).length;
                return calls <= 1
                    ? { services: [activeService(14)] }
                    : { services: [activeService(12, completedPrimary(12))] };
            }
            if (command instanceof DescribeTaskDefinitionCommand) {
                return { taskDefinition: { taskDefinitionArn: arn(12), family: 'myapp-task', revision: 12, status: 'ACTIVE' } };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        const result = await runRollback({ ...baseOptions(), revision: 'myapp-task:12', ecsClient });

        expect(result).toMatchObject({ ok: true, targetTaskDefArn: arn(12), targetRevision: '12' });
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('headless mode selects newest revision older than current (ignores newer undeployed rev)', async () => {
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) {
                const calls = ecsClient.send.mock.calls.filter(([c]) => c instanceof DescribeServicesCommand).length;
                return calls <= 1
                    ? { services: [activeService(14)] }
                    : { services: [activeService(13, completedPrimary(13))] };
            }
            if (command instanceof ListTaskDefinitionsCommand) {
                return { taskDefinitionArns: [arn(15), arn(14), arn(13), arn(12)] };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        const result = await runRollback({ ...baseOptions(), ecsClient });

        const updateCall = ecsClient.send.mock.calls.find(
            ([cmd]) => cmd instanceof UpdateServiceCommand
        );
        expect(updateCall[0].input.taskDefinition).toBe(arn(13));
        expect(result).toMatchObject({ ok: true, targetRevision: '13' });
    });

    it('CI-inferred headless without flags refuses instead of auto-picking', async () => {
        process.env.CI = 'true';
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) {
                const calls = ecsClient.send.mock.calls.filter(([c]) => c instanceof DescribeServicesCommand).length;
                return calls <= 1
                    ? { services: [activeService(14)] }
                    : { services: [activeService(13, completedPrimary(13))] };
            }
            if (command instanceof ListTaskDefinitionsCommand) {
                return { taskDefinitionArns: [arn(14), arn(13)] };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        const { isHeadless, ...withoutHeadless } = baseOptions();
        const result = await runRollback({ ...withoutHeadless, ecsClient });

        expect(select).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: false, reason: 'non-interactive' });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('rollback_run', expect.objectContaining({
            error_code: 'ROLLBACK_NON_INTERACTIVE',
            reason: 'non-interactive',
        }));
        expect(ecsClient.send.mock.calls.some(([cmd]) => cmd instanceof UpdateServiceCommand)).toBe(false);
    });

    it('refuses inferred-headless rollback without flags instead of auto-picking', async () => {
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) return { services: [activeService(14)] };
            if (command instanceof ListTaskDefinitionsCommand) {
                return { taskDefinitionArns: [arn(14), arn(13)] };
            }
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        const { isHeadless, ...withoutHeadless } = baseOptions();
        const result = await runRollback({ ...withoutHeadless, ecsClient });

        expect(result).toMatchObject({ ok: false, reason: 'non-interactive' });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('rollback_run', expect.objectContaining({
            error_code: 'ROLLBACK_NON_INTERACTIVE',
            reason: 'non-interactive',
        }));
        expect(select).not.toHaveBeenCalled();
        expect(ecsClient.send.mock.calls.some(([cmd]) => cmd instanceof UpdateServiceCommand)).toBe(false);
    });

    it('interactive mode prompts with shortened image tags and updates with the chosen ARN', async () => {
        vi.mocked(select).mockResolvedValue(arn(12));
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) {
                const calls = ecsClient.send.mock.calls.filter(([c]) => c instanceof DescribeServicesCommand).length;
                return calls <= 1
                    ? { services: [activeService(14)] }
                    : { services: [activeService(12, completedPrimary(12))] };
            }
            if (command instanceof ListTaskDefinitionsCommand) {
                return { taskDefinitionArns: [arn(13), arn(12), arn(11)] };
            }
            if (command instanceof DescribeTaskDefinitionCommand) {
                const rev = Number(command.input.taskDefinition.split(':').pop());
                return {
                    taskDefinition: {
                        taskDefinitionArn: arn(rev),
                        revision: rev,
                        status: 'ACTIVE',
                        containerDefinitions: [{ image: '123456789012.dkr.ecr.us-east-2.amazonaws.com/myapp:sha-abcdef' }],
                        registeredAt: new Date('2026-09-01T00:00:00.000Z'),
                    },
                };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        const result = await runRollback({ ...baseOptions(), isHeadless: false, ecsClient });

        expect(select).toHaveBeenCalledTimes(1);
        const promptArg = vi.mocked(select).mock.calls[0][0];
        expect(promptArg.message).toMatch(/roll back/i);
        expect(promptArg.options).toHaveLength(3);
        expect(promptArg.options[0].label).toContain('myapp:sha-abcdef');
        expect(promptArg.options[0].label).not.toContain('dkr.ecr');

        const updateCall = ecsClient.send.mock.calls.find(
            ([cmd]) => cmd instanceof UpdateServiceCommand
        );
        expect(updateCall[0].input.taskDefinition).toBe(arn(12));
        expect(result).toMatchObject({ ok: true, targetRevision: '12' });
    });

    it('interactive cancellation exits cleanly without error', async () => {
        vi.mocked(select).mockResolvedValue(Symbol.for('clack:cancel'));
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) return { services: [activeService(14)] };
            if (command instanceof ListTaskDefinitionsCommand) {
                return { taskDefinitionArns: [arn(13), arn(12)] };
            }
            if (command instanceof DescribeTaskDefinitionCommand) {
                return {
                    taskDefinition: {
                        taskDefinitionArn: arn(13),
                        revision: 13,
                        status: 'ACTIVE',
                        containerDefinitions: [{ image: 'myapp:latest' }],
                        registeredAt: new Date(),
                    },
                };
            }
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        const result = await runRollback({ ...baseOptions(), isHeadless: false, ecsClient });

        expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'cancelled' }));
        expect(exitSpy).not.toHaveBeenCalled();
        expect(ecsClient.send.mock.calls.some(([c]) => c instanceof UpdateServiceCommand)).toBe(false);
    });

    it('exits 1 with SERVICE_NOT_FOUND when the service is missing', async () => {
        const ecsClient = mockClient(() => ({ services: [] }));

        await runRollback({ ...baseOptions(), ecsClient });

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('rollback_run', {
            projectName: 'myapp',
            success: false,
            error_code: 'SERVICE_NOT_FOUND',
            reason: 'service-not-found',
        });
    });

    it('exits 1 with NO_PRIOR_REVISIONS when only the current revision exists', async () => {
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) return { services: [activeService(1)] };
            if (command instanceof ListTaskDefinitionsCommand) return { taskDefinitionArns: [arn(1)] };
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        await runRollback({ ...baseOptions(), ecsClient });

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('rollback_run', {
            projectName: 'myapp',
            success: false,
            error_code: 'NO_PRIOR_REVISIONS',
            reason: 'no-prior-revisions',
        });
    });

    it('exits 1 with REVISION_NOT_FOUND for a non-existent explicit revision', async () => {
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) return { services: [activeService(14)] };
            if (command instanceof DescribeTaskDefinitionCommand) {
                const error = new Error('Task definition not found');
                error.name = 'ClientException';
                throw error;
            }
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        await runRollback({ ...baseOptions(), revision: '99', ecsClient });

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('rollback_run', {
            projectName: 'myapp',
            success: false,
            error_code: 'REVISION_NOT_FOUND',
            reason: 'revision-not-found',
        });
    });

    it('exits 1 with ROLLOUT_FAILED when the deployment fails', async () => {
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) {
                const calls = ecsClient.send.mock.calls.filter(([c]) => c instanceof DescribeServicesCommand).length;
                if (calls <= 1) return { services: [activeService(14)] };
                return {
                    services: [activeService(13, [{
                        status: 'PRIMARY',
                        taskDefinition: arn(13),
                        rolloutState: 'FAILED',
                        runningCount: 0,
                        desiredCount: 1,
                    }])],
                };
            }
            if (command instanceof ListTaskDefinitionsCommand) {
                return { taskDefinitionArns: [arn(14), arn(13)] };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        await runRollback({ ...baseOptions(), ecsClient });

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('rollback_run', expect.objectContaining({
            success: false,
            error_code: 'ROLLOUT_FAILED',
            targetRevision: '13',
        }));
    });

    it('exits 1 with ROLLOUT_TIMEOUT when stabilization never completes', async () => {
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) {
                const calls = ecsClient.send.mock.calls.filter(([c]) => c instanceof DescribeServicesCommand).length;
                if (calls <= 1) return { services: [activeService(14)] };
                return {
                    services: [activeService(13, [{
                        status: 'PRIMARY',
                        taskDefinition: arn(13),
                        rolloutState: 'IN_PROGRESS',
                        runningCount: 0,
                        desiredCount: 1,
                    }])],
                };
            }
            if (command instanceof ListTaskDefinitionsCommand) {
                return { taskDefinitionArns: [arn(14), arn(13)] };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        await runRollback({ ...baseOptions(), timeoutMs: 10, ecsClient });

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('rollback_run', expect.objectContaining({
            success: false,
            error_code: 'ROLLOUT_TIMEOUT',
            targetRevision: '13',
        }));
    });

    it('tracks AUTH_EXPIRED before delegating to handleAwsAuthError', async () => {
        const authError = new Error('security token expired');
        authError.name = 'ExpiredTokenException';
        const ecsClient = mockClient(() => { throw authError; });

        await runRollback({ ...baseOptions(), ecsClient });

        expect(trackEvent).toHaveBeenCalledWith('rollback_run', {
            projectName: 'myapp',
            success: false,
            error_code: 'AUTH_EXPIRED',
        });
        expect(handleAwsAuthError).toHaveBeenCalledTimes(1);
        expect(trackEvent.mock.invocationCallOrder[0])
            .toBeLessThan(handleAwsAuthError.mock.invocationCallOrder[0]);
    });

    it('shows registering state when PRIMARY has not appeared yet, then resolves', async () => {
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) {
                const calls = ecsClient.send.mock.calls.filter(([c]) => c instanceof DescribeServicesCommand).length;
                if (calls <= 1) return { services: [activeService(14)] };
                if (calls === 2) return { services: [activeService(14, [])] };
                return { services: [activeService(13, completedPrimary(13))] };
            }
            if (command instanceof ListTaskDefinitionsCommand) {
                return { taskDefinitionArns: [arn(14), arn(13)] };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        const result = await runRollback({ ...baseOptions(), ecsClient });

        expect(result).toMatchObject({ ok: true, targetRevision: '13' });
        expect(spinnerMessages()[0]).toBe(
            'Rolling back myapp-service to revision 13... [0s] (registering deployment...)'
        );
    });

    it('shows standard provisioning progress while tasks boot', async () => {
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) {
                const calls = ecsClient.send.mock.calls.filter(([c]) => c instanceof DescribeServicesCommand).length;
                if (calls <= 1) return { services: [activeService(14)] };
                if (calls === 2) {
                    return {
                        services: [activeService(14, [{
                            status: 'PRIMARY',
                            taskDefinition: arn(13),
                            rolloutState: 'IN_PROGRESS',
                            runningCount: 0,
                            desiredCount: 1,
                            pendingCount: 1,
                        }])],
                    };
                }
                return { services: [activeService(13, completedPrimary(13))] };
            }
            if (command instanceof ListTaskDefinitionsCommand) {
                return { taskDefinitionArns: [arn(14), arn(13)] };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        const result = await runRollback({ ...baseOptions(), ecsClient });

        expect(result).toMatchObject({ ok: true, targetRevision: '13' });
        expect(spinnerMessages()).toContain(
            'Rolling back myapp-service to revision 13... [0s] (0/1 running, 1 pending)'
        );
    });

    it('shows draining progress when new tasks run while old ones drain', async () => {
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) {
                const calls = ecsClient.send.mock.calls.filter(([c]) => c instanceof DescribeServicesCommand).length;
                if (calls <= 1) return { services: [activeService(14)] };
                if (calls === 2) {
                    return {
                        services: [activeService(14, [
                            {
                                status: 'PRIMARY',
                                taskDefinition: arn(13),
                                rolloutState: 'IN_PROGRESS',
                                runningCount: 1,
                                desiredCount: 1,
                                pendingCount: 0,
                            },
                            {
                                status: 'ACTIVE',
                                taskDefinition: arn(14),
                                rolloutState: 'COMPLETED',
                                runningCount: 1,
                                desiredCount: 1,
                                pendingCount: 0,
                            },
                        ])],
                    };
                }
                return { services: [activeService(13, completedPrimary(13))] };
            }
            if (command instanceof ListTaskDefinitionsCommand) {
                return { taskDefinitionArns: [arn(14), arn(13)] };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        const result = await runRollback({ ...baseOptions(), ecsClient });

        expect(result).toMatchObject({ ok: true, targetRevision: '13' });
        expect(spinnerMessages()).toContain(
            'Rolling back myapp-service to revision 13... [0s] (1/1 running — draining previous tasks)'
        );
    });

    it('warns about crashing containers when tasks fail', async () => {
        const ecsClient = mockClient((command) => {
            if (command instanceof DescribeServicesCommand) {
                const calls = ecsClient.send.mock.calls.filter(([c]) => c instanceof DescribeServicesCommand).length;
                if (calls <= 1) return { services: [activeService(14)] };
                if (calls === 2) {
                    return {
                        services: [activeService(14, [{
                            status: 'PRIMARY',
                            taskDefinition: arn(13),
                            rolloutState: 'IN_PROGRESS',
                            runningCount: 0,
                            desiredCount: 1,
                            pendingCount: 0,
                            failedTasks: 2,
                        }])],
                    };
                }
                return { services: [activeService(13, completedPrimary(13))] };
            }
            if (command instanceof ListTaskDefinitionsCommand) {
                return { taskDefinitionArns: [arn(14), arn(13)] };
            }
            if (command instanceof UpdateServiceCommand) return {};
            throw new Error(`unexpected command ${command.constructor.name}`);
        });

        const result = await runRollback({ ...baseOptions(), ecsClient });

        expect(result).toMatchObject({ ok: true, targetRevision: '13' });
        expect(spinnerMessages()).toContain(
            'Rolling back myapp-service to revision 13... [0s] (0/1 running, 0 pending, 2 failed ⚠️ — container crashing)'
        );
    });
});

describe('rollback: fuzzer hardening', () => {
    let exitSpy;
    let consoleSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });

    it('routes unresolvable projects through PROJECT_NOT_INITIALIZED', async () => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => { throw new Error('deleted'); });
        try {
            const result = await runRollback(null);
            expect(result).toEqual({ ok: false, reason: 'project-not-initialized' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(trackEvent).toHaveBeenCalledWith('rollback_run', expect.objectContaining({
                success: false,
                error_code: 'PROJECT_NOT_INITIALIZED',
            }));
        } finally {
            cwdSpy.mockRestore();
        }
    });

    it.each([null, 42, true, { port: 'string' }])('parseRollbackArgs(%s) returns defaults', (bad) => {
        expect(parseRollbackArgs(bad)).toEqual({ skipWait: false });
    });
});

describe('rollback on --target lambda projects', () => {
    let exitSpy;
    let logSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        exitSpy.mockRestore();
        logSpy.mockRestore();
    });

    it('fails gracefully with the update-function-code redeploy path', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-lambda-test-'));
        try {
            fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'terraform', 'main.tf'),
                'locals {\n  app_name = "myapp${local.env_suffix}"\n}\nresource "aws_lambda_function" "app" {}\n'
            );
            const result = await runRollback({ cwd: dir });
            expect(result).toMatchObject({ ok: false, reason: 'lambda-target-unsupported' });
            expect(exitSpy).toHaveBeenCalledWith(3);
            const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
            expect(output).toContain('aws lambda update-function-code');
            expect(output).toContain('myapp-fn');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('names the suffixed function and repo on suffixed trees', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-lambda-test-'));
        try {
            fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'terraform', 'main.tf'),
                'locals {\n  grada_resource_suffix = "-a1b2c3"\n  app_name = "myapp${local.env_suffix}${local.grada_resource_suffix}"\n}\nresource "aws_lambda_function" "app" {}\n'
            );
            const result = await runRollback({ cwd: dir });
            expect(result).toMatchObject({ ok: false, reason: 'lambda-target-unsupported' });
            const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
            expect(output).toContain('myapp-a1b2c3-fn');
            expect(output).toContain('myapp-a1b2c3-repo');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('rollback on --target static projects', () => {
    let exitSpy;
    let logSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        exitSpy.mockRestore();
        logSpy.mockRestore();
    });

    it('fails cleanly with the push-to-redeploy pointer', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-static-test-'));
        try {
            fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'terraform', 'main.tf'),
                'locals {\n  app_name = "myapp"\n}\nresource "aws_cloudfront_distribution" "site" {}\n'
            );
            const result = await runRollback({ cwd: dir });
            expect(result).toMatchObject({ ok: false, reason: 'static-target-unsupported' });
            expect(exitSpy).toHaveBeenCalledWith(3);
            expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('push to redeploy');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('discoverEligibleRevisions', () => {
    it('returns ACTIVE revisions older than the deployed one, newest first', async () => {
        const ecsClient = mockClient((command) => {
            expect(command).toBeInstanceOf(ListTaskDefinitionsCommand);
            expect(command.input).toMatchObject({ familyPrefix: 'myapp-task', status: 'ACTIVE' });
            return { taskDefinitionArns: [arn(5), arn(4), arn(3)] };
        });
        await expect(discoverEligibleRevisions(ecsClient, 'myapp-task', 4)).resolves.toEqual([arn(3)]);
    });

    it('returns an empty list when only the current revision exists', async () => {
        const ecsClient = mockClient(() => ({ taskDefinitionArns: [arn(2)] }));
        await expect(discoverEligibleRevisions(ecsClient, 'myapp-task', 2)).resolves.toEqual([]);
    });
});
