import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackMocks as clack } from './helpers/clack.js';
import {
    runGc,
    parseGcArgs,
    filterUntaggedImages,
    filterUnattachedAddresses,
    discoverOrphanedResources,
    discoverDeepOrphans,
    discoverLiveVpcIds,
    deleteDiscoveredResources,
    chunkArray,
    ECR_BATCH_DELETE_LIMIT,
    CONFIRM_MESSAGE,
} from '../src/commands/gc.js';
import { trackEvent } from '../src/core/telemetry.js';

// --- Mock AWS SDK: ECR ---
const { mockEcrSend, MockECRClient, MockDescribeRepositoriesCommand, MockDescribeImagesCommand, MockBatchDeleteImageCommand } = vi.hoisted(() => {
    const send = vi.fn();
    const makeCommand = (name) =>
        vi.fn(function (input) {
            this.commandName = name;
            Object.assign(this, input);
        });
    return {
        mockEcrSend: send,
        MockECRClient: vi.fn(function () {
            this.send = send;
        }),
        MockDescribeRepositoriesCommand: makeCommand('DescribeRepositoriesCommand'),
        MockDescribeImagesCommand: makeCommand('DescribeImagesCommand'),
        MockBatchDeleteImageCommand: makeCommand('BatchDeleteImageCommand'),
    };
});

vi.mock('@aws-sdk/client-ecr', () => ({
    ECRClient: MockECRClient,
    DescribeRepositoriesCommand: MockDescribeRepositoriesCommand,
    DescribeImagesCommand: MockDescribeImagesCommand,
    BatchDeleteImageCommand: MockBatchDeleteImageCommand,
}));

// --- Mock AWS SDK: CloudWatch Logs ---
const { mockLogsSend, MockLogsClient, MockDescribeLogGroupsCommand, MockDeleteLogGroupCommand } = vi.hoisted(() => {
    const send = vi.fn();
    const makeCommand = (name) =>
        vi.fn(function (input) {
            this.commandName = name;
            Object.assign(this, input);
        });
    return {
        mockLogsSend: send,
        MockLogsClient: vi.fn(function () {
            this.send = send;
        }),
        MockDescribeLogGroupsCommand: makeCommand('DescribeLogGroupsCommand'),
        MockDeleteLogGroupCommand: makeCommand('DeleteLogGroupCommand'),
    };
});

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
    CloudWatchLogsClient: MockLogsClient,
    DescribeLogGroupsCommand: MockDescribeLogGroupsCommand,
    DeleteLogGroupCommand: MockDeleteLogGroupCommand,
}));

// --- Mock AWS SDK: EC2 ---
const { mockEc2Send, MockEC2Client, MockDescribeAddressesCommand, MockReleaseAddressCommand, MockDescribeVpcsCommand, MockDescribeSubnetsCommand } = vi.hoisted(() => {
    const send = vi.fn();
    const makeCommand = (name) =>
        vi.fn(function (input) {
            this.commandName = name;
            Object.assign(this, input);
        });
    return {
        mockEc2Send: send,
        MockEC2Client: vi.fn(function () {
            this.send = send;
        }),
        MockDescribeAddressesCommand: makeCommand('DescribeAddressesCommand'),
        MockReleaseAddressCommand: makeCommand('ReleaseAddressCommand'),
        MockDescribeVpcsCommand: makeCommand('DescribeVpcsCommand'),
        MockDescribeSubnetsCommand: makeCommand('DescribeSubnetsCommand'),
    };
});

vi.mock('@aws-sdk/client-ec2', () => ({
    EC2Client: MockEC2Client,
    DescribeAddressesCommand: MockDescribeAddressesCommand,
    ReleaseAddressCommand: MockReleaseAddressCommand,
    DescribeVpcsCommand: MockDescribeVpcsCommand,
    DescribeSubnetsCommand: MockDescribeSubnetsCommand,
}));

// --- Mock AWS SDK: ECS (preview liveness only) ---
const { mockEcsSend, MockECSClient, MockListClustersCommand, MockListServicesCommand, MockDescribeServicesCommand } = vi.hoisted(() => {
    const send = vi.fn();
    const makeCommand = (name) =>
        vi.fn(function (input) {
            this.commandName = name;
            Object.assign(this, input);
        });
    return {
        mockEcsSend: send,
        MockECSClient: vi.fn(function () {
            this.send = send;
        }),
        MockListClustersCommand: makeCommand('ListClustersCommand'),
        MockListServicesCommand: makeCommand('ListServicesCommand'),
        MockDescribeServicesCommand: makeCommand('DescribeServicesCommand'),
    };
});

vi.mock('@aws-sdk/client-ecs', () => ({
    ECSClient: MockECSClient,
    ListClustersCommand: MockListClustersCommand,
    ListServicesCommand: MockListServicesCommand,
    DescribeServicesCommand: MockDescribeServicesCommand,
}));

// --- Mock AWS SDK: Secrets Manager (deep scan only) ---
const { mockSecretsSend, MockSecretsClient, MockListSecretsCommand } = vi.hoisted(() => {
    const send = vi.fn();
    return {
        mockSecretsSend: send,
        MockSecretsClient: vi.fn(function () {
            this.send = send;
        }),
        MockListSecretsCommand: vi.fn(function (input) {
            this.commandName = 'ListSecretsCommand';
            Object.assign(this, input);
        }),
    };
});

vi.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: MockSecretsClient,
    ListSecretsCommand: MockListSecretsCommand,
}));

// --- Mock interactive prompts (controllable confirm) ---


const PROJECT = 'myapp';

function setupMixedDiscoveryFixtures() {
    mockEcrSend.mockImplementation(async (cmd) => {
        if (cmd instanceof MockDescribeRepositoriesCommand) {
            return {
                repositories: [
                    { repositoryName: `${PROJECT}-repo` },
                    { repositoryName: 'unrelated-repo' },
                ],
            };
        }
        if (cmd instanceof MockDescribeImagesCommand) {
            if (cmd.repositoryName === `${PROJECT}-repo`) {
                return {
                    imageDetails: [
                        { imageDigest: 'sha256:tagged', imageTags: ['latest'] },
                        { imageDigest: 'sha256:orphan1' },
                        { imageDigest: 'sha256:orphan2', imageTags: [] },
                    ],
                };
            }
            return { imageDetails: [] };
        }
        if (cmd instanceof MockBatchDeleteImageCommand) return { imageIds: cmd.imageIds };
        throw new Error(`Unexpected ECR command: ${cmd?.commandName}`);
    });

    mockLogsSend.mockImplementation(async (cmd) => {
        if (cmd instanceof MockDescribeLogGroupsCommand) {
            expect(cmd.logGroupNamePrefix).toBe(`/ecs/${PROJECT}-`);
            return {
                logGroups: [
                    { logGroupName: `/ecs/${PROJECT}-pr-123` },
                    { logGroupName: `/ecs/${PROJECT}-pr-456` },
                ],
            };
        }
        if (cmd instanceof MockDeleteLogGroupCommand) return {};
        throw new Error(`Unexpected Logs command: ${cmd?.commandName}`);
    });

    mockEc2Send.mockImplementation(async (cmd) => {
        if (cmd instanceof MockDescribeAddressesCommand) {
            return {
                Addresses: [
                    { PublicIp: '1.2.3.4', AllocationId: 'eipalloc-attached', AssociationId: 'eipassoc-1', InstanceId: 'i-123' },
                    { PublicIp: '5.6.7.8', AllocationId: 'eipalloc-orphan', Tags: [{ Key: 'GradaProject', Value: PROJECT }] },
                ],
            };
        }
        if (cmd instanceof MockReleaseAddressCommand) return {};
        throw new Error(`Unexpected EC2 command: ${cmd?.commandName}`);
    });

    mockEcsSend.mockImplementation(async (cmd) => {
        if (cmd instanceof MockListClustersCommand) {
            return { clusterArns: [`arn:aws:ecs:us-east-2:123:cluster/${PROJECT}-cluster`] };
        }
        if (cmd instanceof MockListServicesCommand) return { serviceArns: [] };
        throw new Error(`Unexpected ECS command: ${cmd?.commandName}`);
    });
}

function deleteCommandCalls() {
    const batchDeletes = MockBatchDeleteImageCommand.mock.calls.length;
    const logDeletes = MockDeleteLogGroupCommand.mock.calls.length;
    const releases = MockReleaseAddressCommand.mock.calls.length;
    return batchDeletes + logDeletes + releases;
}

beforeEach(() => {
    vi.clearAllMocks();
    setupMixedDiscoveryFixtures();
    delete process.env.AWS_REGION;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('gc: CLI args', () => {
    it('parses --region and --project-name', () => {
        expect(parseGcArgs(['gc', '--region', 'eu-west-1'])).toEqual({ region: 'eu-west-1' });
        expect(parseGcArgs(['gc', '--region=us-west-2'])).toEqual({ region: 'us-west-2' });
        expect(parseGcArgs(['gc'])).toEqual({});
    });

    it('parses --yes (explicit delete-confirm opt-in) and --deep', () => {
        // R23: --yes now auto-confirms the delete prompt explicitly; the
        // default no-flags path still prompts (pinned below in safety guards).
        expect(parseGcArgs(['gc', '--yes'])).toMatchObject({ yes: true });
        expect(parseGcArgs(['gc', '--yes', '--region', 'us-east-1'])).toMatchObject({ yes: true, region: 'us-east-1' });
        expect(parseGcArgs(['gc', '--deep'])).toMatchObject({ deep: true });
    });

    it('uses the spec confirmation wording', () => {
        expect(CONFIRM_MESSAGE).toContain('Are you sure you want to permanently delete these orphaned resources? (y/N)');
    });
});

describe('gc: orphan filters', () => {
    it('counts only untagged ECR images', () => {
        const images = [
            { imageDigest: 'sha256:a', imageTags: ['latest'] },
            { imageDigest: 'sha256:b' },
            { imageDigest: 'sha256:c', imageTags: [] },
        ];
        expect(filterUntaggedImages(images).map((i) => i.imageDigest)).toEqual(['sha256:b', 'sha256:c']);
    });

    it('counts only unattached Elastic IPs', () => {
        const addresses = [
            { PublicIp: '1.2.3.4', AssociationId: 'eipassoc-1' },
            { PublicIp: '5.6.7.8', AllocationId: 'eipalloc-2' },
        ];
        expect(filterUnattachedAddresses(addresses)).toHaveLength(1);
        expect(filterUnattachedAddresses(addresses)[0].PublicIp).toBe('5.6.7.8');
    });
});

describe('gc: dry-run discovery', () => {
    it('counts only orphaned resources across all three targets', async () => {
        clack.mockConfirm.mockResolvedValue(false);
        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });
        try {
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2', isHeadless: false });
            expect(result.untaggedImages).toHaveLength(2);
            expect(result.orphanedLogGroups).toHaveLength(2);
            expect(result.unattachedEips).toHaveLength(1);
            expect(result.totalCount).toBe(5);
            expect(result.deleted).toBe(false);
            const text = output.join('\n').replace(/\x1B\[[0-9;]*m/g, '');
            expect(text).toContain('Untagged ECR images: 2');
            expect(text).toContain('Orphaned log groups: 2');
            expect(text).toContain('Unattached Elastic IPs: 1');
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('ignores lookalike repos outside the exact project repo', async () => {
        const ecrSend = vi.fn(async (cmd) => {
            if (cmd instanceof MockDescribeRepositoriesCommand) {
                return {
                    repositories: [
                        { repositoryName: `${PROJECT}-repo` },
                        { repositoryName: `${PROJECT}-evil-repo` },
                    ],
                };
            }
            if (cmd instanceof MockDescribeImagesCommand) {
                return { imageDetails: [{ imageDigest: `sha256:orphan-${cmd.repositoryName}` }] };
            }
            throw new Error('unexpected');
        });
        const result = await discoverOrphanedResources({
            ecrClient: { send: ecrSend },
            logsClient: { send: mockLogsSend },
            ec2Client: { send: mockEc2Send },
            projectName: PROJECT,
        });
        expect(result.untaggedImages).toHaveLength(1);
        expect(result.untaggedImages[0].repositoryName).toBe(`${PROJECT}-repo`);
    });

    it('follows nextToken through paginated ECR responses', async () => {
        const ecrSend = vi.fn(async (cmd) => {
            if (cmd instanceof MockDescribeRepositoriesCommand) {
                if (cmd.nextToken === undefined) {
                    return { repositories: [{ repositoryName: `${PROJECT}-repo` }], nextToken: 'repos-page-2' };
                }
                return { repositories: [{ repositoryName: `${PROJECT}-evil-repo` }] };
            }
            if (cmd instanceof MockDescribeImagesCommand) {
                if (cmd.nextToken === undefined) {
                    return { imageDetails: [{ imageDigest: 'sha256:page1-orphan' }], nextToken: 'images-page-2' };
                }
                return { imageDetails: [{ imageDigest: 'sha256:page2-orphan' }] };
            }
            throw new Error('unexpected');
        });
        const result = await discoverOrphanedResources({
            ecrClient: { send: ecrSend },
            logsClient: { send: mockLogsSend },
            ec2Client: { send: mockEc2Send },
            projectName: PROJECT,
        });
        expect(result.untaggedImages).toHaveLength(2);
        const repoCalls = ecrSend.mock.calls.filter((call) => call[0] instanceof MockDescribeRepositoriesCommand);
        expect(repoCalls).toHaveLength(2);
        const imageCalls = ecrSend.mock.calls.filter((call) => call[0] instanceof MockDescribeImagesCommand);
        expect(imageCalls).toHaveLength(2);
        expect(imageCalls.every(([call]) => call.repositoryName === `${PROJECT}-repo`)).toBe(true);
    });

    it('excludes foreign-project lookalike log groups', async () => {
        const logsSend = vi.fn(async (cmd) => {
            if (cmd instanceof MockDescribeLogGroupsCommand) {
                return {
                    logGroups: [
                        { logGroupName: `/ecs/${PROJECT}-evil-pr-2` },
                        { logGroupName: `/ecs/${PROJECT}-pr-123` },
                    ],
                };
            }
            throw new Error('unexpected');
        });
        const result = await discoverOrphanedResources({
            ecrClient: { send: mockEcrSend },
            logsClient: { send: logsSend },
            ec2Client: { send: mockEc2Send },
            projectName: PROJECT,
        });
        expect(result.orphanedLogGroups.map((g) => g.logGroupName)).toEqual([`/ecs/${PROJECT}-pr-123`]);
    });

    it('excludes the live group on suffixed ECS trees', async () => {
        const logsSend = vi.fn(async (cmd) => {
            if (cmd instanceof MockDescribeLogGroupsCommand) {
                return {
                    logGroups: [
                        { logGroupName: `/ecs/${PROJECT}-a1b2c3` },
                        { logGroupName: `/ecs/${PROJECT}-pr-123-a1b2c3` },
                    ],
                };
            }
            throw new Error('unexpected');
        });
        const result = await discoverOrphanedResources({
            ecrClient: { send: mockEcrSend },
            logsClient: { send: logsSend },
            ec2Client: { send: mockEc2Send },
            projectName: PROJECT,
            resourceSuffix: '-a1b2c3',
            excludeLogGroup: `/ecs/${PROJECT}-a1b2c3`,
        });
        expect(result.orphanedLogGroups.map((g) => g.logGroupName)).toEqual([`/ecs/${PROJECT}-pr-123-a1b2c3`]);
    });

    it('honors the precomputed live-preview set during discovery', async () => {
        const logsSend = vi.fn(async (cmd) => {
            if (cmd instanceof MockDescribeLogGroupsCommand) {
                return {
                    logGroups: [
                        { logGroupName: `/ecs/${PROJECT}-pr-123` },
                        { logGroupName: `/ecs/${PROJECT}-pr-456` },
                    ],
                };
            }
            throw new Error('unexpected');
        });
        const result = await discoverOrphanedResources({
            ecrClient: { send: mockEcrSend },
            logsClient: { send: logsSend },
            ec2Client: { send: mockEc2Send },
            projectName: PROJECT,
            livePreviewGroups: new Set([`/ecs/${PROJECT}-pr-123`]),
        });
        expect(result.orphanedLogGroups.map((g) => g.logGroupName)).toEqual([`/ecs/${PROJECT}-pr-456`]);
    });

    it('proposes no preview groups when liveness is unknown', async () => {
        const logsSend = vi.fn(async (cmd) => {
            if (cmd instanceof MockDescribeLogGroupsCommand) {
                return { logGroups: [{ logGroupName: `/ecs/${PROJECT}-pr-123` }] };
            }
            throw new Error('unexpected');
        });
        const result = await discoverOrphanedResources({
            ecrClient: { send: mockEcrSend },
            logsClient: { send: logsSend },
            ec2Client: { send: mockEc2Send },
            projectName: PROJECT,
            previewLivenessUnknown: true,
        });
        expect(result.orphanedLogGroups).toHaveLength(0);
    });

    it('excludes log groups of running preview services end to end', async () => {
        mockEcsSend.mockImplementation(async (cmd) => {
            if (cmd instanceof MockListClustersCommand) {
                return {
                    clusterArns: [
                        `arn:aws:ecs:us-east-2:123:cluster/${PROJECT}-cluster`,
                        `arn:aws:ecs:us-east-2:123:cluster/${PROJECT}-pr-123-cluster`,
                    ],
                };
            }
            if (cmd instanceof MockListServicesCommand) {
                if (cmd.cluster === `${PROJECT}-pr-123-cluster`) {
                    return { serviceArns: [`arn:aws:ecs:us-east-2:123:service/${PROJECT}-pr-123-cluster/${PROJECT}-pr-123-service`] };
                }
                return { serviceArns: [] };
            }
            throw new Error('unexpected');
        });
        clack.mockConfirm.mockResolvedValue(false);
        const result = await runGc({ projectName: PROJECT, region: 'us-east-2', isHeadless: false });
        expect(result.orphanedLogGroups.map((g) => g.logGroupName)).toEqual([`/ecs/${PROJECT}-pr-456`]);
    });

    it('never proposes the live group on suffixed ECS trees end to end', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ecs-suffix-'));
        try {
            fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'terraform', 'main.tf'),
                'locals {\n  grada_resource_suffix = "-a1b2c3"\n}\nresource "aws_ecs_service" "app" {}\n'
            );
            mockLogsSend.mockImplementation(async (cmd) => {
                if (cmd instanceof MockDescribeLogGroupsCommand) {
                    return {
                        logGroups: [
                            { logGroupName: `/ecs/${PROJECT}-a1b2c3` },
                            { logGroupName: `/ecs/${PROJECT}-pr-9-a1b2c3` },
                        ],
                    };
                }
                if (cmd instanceof MockDeleteLogGroupCommand) return {};
                throw new Error(`Unexpected Logs command: ${cmd?.commandName}`);
            });
            clack.mockConfirm.mockResolvedValue(false);
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2', cwd: dir, isHeadless: false });
            expect(result.orphanedLogGroups.map((g) => g.logGroupName)).toEqual([`/ecs/${PROJECT}-pr-9-a1b2c3`]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('fails closed on preview groups (with a warning) when the service scan throws', async () => {
        mockEcsSend.mockRejectedValue(new Error('throttled'));
        clack.mockConfirm.mockResolvedValue(false);
        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });
        try {
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2', isHeadless: false });
            expect(result.orphanedLogGroups).toHaveLength(0);
            expect(output.join('\n')).toContain('could not be verified');
        } finally {
            consoleSpy.mockRestore();
        }
    });
});

describe('gc: safety guards', () => {
    it('never fires Delete commands when confirmation is rejected', async () => {
        clack.mockConfirm.mockResolvedValue(false);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2', isHeadless: false });
            expect(clack.mockConfirm).toHaveBeenCalledTimes(1);
            expect(result.deleted).toBe(false);
            expect(deleteCommandCalls()).toBe(0);
            expect(clack.mockCancel).toHaveBeenCalled();
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('treats a cancelled prompt as rejection', async () => {
        clack.mockConfirm.mockResolvedValue(Symbol.for('clack:cancel'));
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2', isHeadless: false });
            expect(result.deleted).toBe(false);
            expect(deleteCommandCalls()).toBe(0);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('deletes all discovered resources only after explicit confirmation', async () => {
        clack.mockConfirm.mockResolvedValue(true);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2', isHeadless: false });
            expect(result.deleted).toBe(true);
            expect(result.deletedImages).toBe(2);
            expect(result.deletedLogGroups).toBe(2);
            expect(result.releasedEips).toBe(1);
            expect(MockBatchDeleteImageCommand).toHaveBeenCalledWith(
                expect.objectContaining({ repositoryName: `${PROJECT}-repo` })
            );
            expect(MockDeleteLogGroupCommand).toHaveBeenCalledWith(
                expect.objectContaining({ logGroupName: `/ecs/${PROJECT}-pr-123` })
            );
            expect(MockReleaseAddressCommand).toHaveBeenCalledWith(
                expect.objectContaining({ AllocationId: 'eipalloc-orphan' })
            );
            // The attached EIP must never be released.
            const releasedIds = MockReleaseAddressCommand.mock.calls.map((c) => c[0].AllocationId);
            expect(releasedIds).not.toContain('eipalloc-attached');
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('names partial deletion failure instead of crashing raw', async () => {
        clack.mockConfirm.mockResolvedValue(true);
        const prev = mockEcrSend.getMockImplementation();
        mockEcrSend.mockImplementation(async (cmd) => {
            if (cmd instanceof MockBatchDeleteImageCommand) throw new Error('ECR boom');
            return prev(cmd);
        });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2', isHeadless: false });
            expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'gc-partial-delete-failed' }));
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(MockDeleteLogGroupCommand).toHaveBeenCalled();
            expect(trackEvent).toHaveBeenCalledWith('gc_run', expect.objectContaining({ success: false, error_code: 'GC_PARTIAL_DELETE_FAILED' }));
            const text = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
            expect(text).toContain('ECR boom');
            expect(text).not.toMatch(/at .*\(.*:\d+:\d+\)/);
        } finally {
            consoleSpy.mockRestore();
            exitSpy.mockRestore();
        }
    });

    it('refuses loudly when headless without approval flags instead of abandoning the delete prompt', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2' });
            expect(result).toEqual({ ok: false, reason: 'non-interactive' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(trackEvent).toHaveBeenCalledWith('gc_run', expect.objectContaining({
                success: false,
                error_code: 'GC_NON_INTERACTIVE',
                reason: 'non-interactive',
            }));
            expect(clack.mockConfirm).not.toHaveBeenCalled();
            expect(deleteCommandCalls()).toBe(0);
        } finally {
            exitSpy.mockRestore();
            consoleSpy.mockRestore();
        }
    });

    it('reports cleanly when nothing is orphaned without prompting', async () => {
        mockEcrSend.mockImplementation(async (cmd) => {
            if (cmd instanceof MockDescribeRepositoriesCommand) return { repositories: [] };
            throw new Error('unexpected');
        });
        mockLogsSend.mockImplementation(async (cmd) => {
            if (cmd instanceof MockDescribeLogGroupsCommand) return { logGroups: [] };
            throw new Error('unexpected');
        });
        mockEc2Send.mockImplementation(async (cmd) => {
            if (cmd instanceof MockDescribeAddressesCommand) return { Addresses: [] };
            throw new Error('unexpected');
        });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2' });
            expect(result.totalCount).toBe(0);
            expect(result.deleted).toBe(false);
            expect(clack.mockConfirm).not.toHaveBeenCalled();
            expect(deleteCommandCalls()).toBe(0);
        } finally {
            consoleSpy.mockRestore();
        }
    });
});

describe('gc: ECR batch-delete chunking', () => {
    it('exposes the 100-image AWS limit', () => {
        expect(ECR_BATCH_DELETE_LIMIT).toBe(100);
    });

    it('chunks arrays into batches of at most 100', () => {
        expect(chunkArray([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
        expect(chunkArray([], 100)).toEqual([]);
    });

    it('splits more than 100 untagged images into multiple BatchDelete requests', async () => {
        const untaggedImages = Array.from({ length: 250 }, (_, i) => ({
            repositoryName: `${PROJECT}-repo`,
            imageDigest: `sha256:orphan-${i}`,
        }));
        const ecrSend = vi.fn().mockResolvedValue({});
        const logsSend = vi.fn().mockResolvedValue({});
        const ec2Send = vi.fn().mockResolvedValue({});

        const summary = await deleteDiscoveredResources(
            { ecrClient: { send: ecrSend }, logsClient: { send: logsSend }, ec2Client: { send: ec2Send } },
            { untaggedImages, orphanedLogGroups: [], unattachedEips: [] }
        );

        expect(summary.deletedImages).toBe(250);
        expect(ecrSend).toHaveBeenCalledTimes(3);
        const batchSizes = ecrSend.mock.calls.map((call) => call[0].imageIds.length);
        expect(batchSizes).toEqual([100, 100, 50]);
        for (const call of ecrSend.mock.calls) {
            expect(call[0].imageIds.length).toBeLessThanOrEqual(100);
            expect(call[0].repositoryName).toBe(`${PROJECT}-repo`);
        }
        const sentDigests = ecrSend.mock.calls.flatMap((call) => call[0].imageIds.map((id) => id.imageDigest));
        expect(sentDigests).toHaveLength(250);
        expect(new Set(sentDigests).size).toBe(250);
    });

    it('excludes BatchDeleteImage failures from the deleted count', async () => {
        const untaggedImages = Array.from({ length: 10 }, (_, i) => ({
            repositoryName: `${PROJECT}-repo`,
            imageDigest: `sha256:orphan-${i}`,
        }));
        const ecrSend = vi.fn().mockResolvedValue({
            failures: [{ imageId: { imageDigest: 'sha256:orphan-3' }, failureCode: 'ImageNotFound', failureReason: 'not found' }],
        });

        const summary = await deleteDiscoveredResources(
            { ecrClient: { send: ecrSend }, logsClient: { send: vi.fn() }, ec2Client: { send: vi.fn() } },
            { untaggedImages, orphanedLogGroups: [], unattachedEips: [] }
        );

        expect(summary.deletedImages).toBe(9);
    });

    it('attempts every target and reports partial failure by name', async () => {
        const ecrSend = vi.fn().mockRejectedValue(new Error('ECR boom'));
        const logsSend = vi.fn().mockResolvedValue({});

        await expect(deleteDiscoveredResources(
            { ecrClient: { send: ecrSend }, logsClient: { send: logsSend }, ec2Client: { send: vi.fn() } },
            {
                untaggedImages: [{ repositoryName: `${PROJECT}-repo`, imageDigest: 'sha256:x' }],
                orphanedLogGroups: [{ logGroupName: '/ecs/x' }],
                unattachedEips: [],
            }
        )).rejects.toThrow(/partially failed/);
        expect(logsSend).toHaveBeenCalled();
    });

    it('sends exactly one request for 100 images', async () => {
        const untaggedImages = Array.from({ length: 100 }, (_, i) => ({
            repositoryName: `${PROJECT}-repo`,
            imageDigest: `sha256:orphan-${i}`,
        }));
        const ecrSend = vi.fn().mockResolvedValue({});

        const summary = await deleteDiscoveredResources(
            { ecrClient: { send: ecrSend }, logsClient: { send: vi.fn() }, ec2Client: { send: vi.fn() } },
            { untaggedImages, orphanedLogGroups: [], unattachedEips: [] }
        );

        expect(summary.deletedImages).toBe(100);
        expect(ecrSend).toHaveBeenCalledTimes(1);
        expect(ecrSend.mock.calls[0][0].imageIds).toHaveLength(100);
    });
});

describe('gc: fuzzer hardening', () => {
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
            const result = await runGc(null);
            expect(result).toEqual({ ok: false, reason: 'project-not-initialized' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(trackEvent).toHaveBeenCalledWith('gc_run', expect.objectContaining({
                success: false,
                error_code: 'PROJECT_NOT_INITIALIZED',
            }));
        } finally {
            cwdSpy.mockRestore();
        }
    });

    it.each([null, 42, true, { port: 'string' }])('parseGcArgs(%s) returns defaults', (bad) => {
        expect(parseGcArgs(bad)).toEqual({});
    });
});

describe('gc: lambda log group discovery', () => {
    it('scans the lambda prefix and never proposes the live function group', async () => {
        const seenPrefixes = [];
        const logsSend = vi.fn(async (cmd) => {
            if (cmd instanceof MockDescribeLogGroupsCommand) {
                seenPrefixes.push(cmd.logGroupNamePrefix);
                return {
                    logGroups: [
                        { logGroupName: `/aws/lambda/${PROJECT}-fn` },
                        { logGroupName: `/aws/lambda/${PROJECT}-pr-123-fn` },
                    ],
                };
            }
            throw new Error('unexpected');
        });
        const result = await discoverOrphanedResources({
            ecrClient: { send: mockEcrSend },
            logsClient: { send: logsSend },
            ec2Client: { send: mockEc2Send },
            projectName: PROJECT,
            logGroupPrefix: `/aws/lambda/${PROJECT}-`,
            isLambda: true,
            excludeLogGroup: `/aws/lambda/${PROJECT}-fn`,
        });
        expect(seenPrefixes).toEqual([`/aws/lambda/${PROJECT}-`]);
        expect(result.orphanedLogGroups.map((g) => g.logGroupName)).toEqual([`/aws/lambda/${PROJECT}-pr-123-fn`]);
    });

    it('excludes foreign-project lookalike lambda groups', async () => {
        const logsSend = vi.fn(async (cmd) => {
            if (cmd instanceof MockDescribeLogGroupsCommand) {
                return {
                    logGroups: [
                        { logGroupName: `/aws/lambda/${PROJECT}-evil-pr-2-fn` },
                        { logGroupName: `/aws/lambda/${PROJECT}-pr-123-fn` },
                    ],
                };
            }
            throw new Error('unexpected');
        });
        const result = await discoverOrphanedResources({
            ecrClient: { send: mockEcrSend },
            logsClient: { send: logsSend },
            ec2Client: { send: mockEc2Send },
            projectName: PROJECT,
            logGroupPrefix: `/aws/lambda/${PROJECT}-`,
            isLambda: true,
            excludeLogGroup: `/aws/lambda/${PROJECT}-fn`,
        });
        expect(result.orphanedLogGroups.map((g) => g.logGroupName)).toEqual([`/aws/lambda/${PROJECT}-pr-123-fn`]);
    });

    it('excludes the live function group with the rendered resource suffix', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-suffix-'));
        try {
            fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'terraform', 'main.tf'),
                'locals {\n  grada_resource_suffix = "-a1b2c3"\n}\nresource "aws_lambda_function" "app" {}\n'
            );
            mockLogsSend.mockImplementation(async (cmd) => {
                if (cmd instanceof MockDescribeLogGroupsCommand) {
                    return {
                        logGroups: [
                            { logGroupName: `/aws/lambda/${PROJECT}-a1b2c3-fn` },
                            { logGroupName: `/aws/lambda/${PROJECT}-pr-9-a1b2c3-fn` },
                        ],
                    };
                }
                if (cmd instanceof MockDeleteLogGroupCommand) return {};
                throw new Error(`Unexpected Logs command: ${cmd?.commandName}`);
            });
            clack.mockConfirm.mockResolvedValue(false);
            const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: '[]', stderr: '' }));
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2', cwd: dir, spawnSyncImpl, isHeadless: false });
            expect(result.orphanedLogGroups.map((g) => g.logGroupName)).toEqual([`/aws/lambda/${PROJECT}-pr-9-a1b2c3-fn`]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('excludes lambda preview groups whose function still exists', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-lambda-live-'));
        try {
            fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'terraform', 'main.tf'),
                'locals {\n  app_name = "myapp"\n}\nresource "aws_lambda_function" "app" {}\n'
            );
            mockLogsSend.mockImplementation(async (cmd) => {
                if (cmd instanceof MockDescribeLogGroupsCommand) {
                    return {
                        logGroups: [
                            { logGroupName: `/aws/lambda/${PROJECT}-pr-123-fn` },
                            { logGroupName: `/aws/lambda/${PROJECT}-pr-456-fn` },
                        ],
                    };
                }
                if (cmd instanceof MockDeleteLogGroupCommand) return {};
                throw new Error(`Unexpected Logs command: ${cmd?.commandName}`);
            });
            clack.mockConfirm.mockResolvedValue(false);
            const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: JSON.stringify([`${PROJECT}-pr-123-fn`]), stderr: '' }));
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2', cwd: dir, spawnSyncImpl, isHeadless: false });
            expect(spawnSyncImpl).toHaveBeenCalledWith('aws', expect.arrayContaining(['lambda', 'list-functions']), expect.anything());
            expect(result.orphanedLogGroups.map((g) => g.logGroupName)).toEqual([`/aws/lambda/${PROJECT}-pr-456-fn`]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('gc: AWS failure wrapping', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        output = [];
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });
    });

    afterEach(() => {
        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });

    it('wraps discovery failures in a clean message and exits 1 instead of throwing', async () => {
        const failure = new Error('socket hang up');
        failure.name = 'NetworkingError';
        mockEcrSend.mockRejectedValue(failure);

        const result = await runGc({ projectName: PROJECT, region: 'us-east-2' });
        expect(result.ok).toBe(false);
        const text = output.join('\n');
        expect(text).toContain('socket hang up');
        expect(text).toContain('credentials');
        expect(text).not.toContain('$metadata');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('wraps deep-scan failures the same way', async () => {
        const failure = new Error('socket hang up');
        failure.name = 'NetworkingError';
        mockEc2Send.mockImplementation(async (cmd) => {
            if (cmd instanceof MockDescribeAddressesCommand) return { Addresses: [] };
            if (cmd instanceof MockDescribeVpcsCommand) throw failure;
            throw new Error(`Unexpected EC2 command: ${cmd?.commandName}`);
        });
        mockSecretsSend.mockResolvedValue({ SecretList: [] });

        const result = await runGc({ projectName: PROJECT, region: 'us-east-2', deep: true });
        expect(result.ok).toBe(false);
        const text = output.join('\n');
        expect(text).toContain('socket hang up');
        expect(text).toContain('credentials');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('returns a structured failure without exiting when headless', async () => {
        mockEcrSend.mockRejectedValue(new Error('socket hang up'));

        const result = await runGc({ projectName: PROJECT, region: 'us-east-2', isHeadless: true });
        expect(result).toEqual(expect.objectContaining({ ok: false, exitCode: 1 }));
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('warns and reports VPCs as liveness-unknown when the shared enumeration fails', async () => {
        mockEcsSend.mockImplementation(async (cmd) => {
            if (cmd instanceof MockListClustersCommand) {
                const failure = new Error('socket hang up');
                failure.name = 'NetworkingError';
                throw failure;
            }
            throw new Error(`Unexpected ECS command: ${cmd?.commandName}`);
        });
        mockEc2Send.mockImplementation(async (cmd) => {
            if (cmd instanceof MockDescribeAddressesCommand) return { Addresses: [] };
            if (cmd instanceof MockDescribeVpcsCommand) {
                return {
                    Vpcs: [{
                        VpcId: 'vpc-maybe',
                        Tags: [
                            { Key: 'GradaProject', Value: PROJECT },
                            { Key: 'Name', Value: `${PROJECT}-pr-3-vpc` },
                        ],
                    }],
                };
            }
            throw new Error(`Unexpected EC2 command: ${cmd?.commandName}`);
        });
        mockSecretsSend.mockResolvedValue({ SecretList: [] });

        const result = await runGc({ projectName: PROJECT, region: 'us-east-2', deep: true });
        expect(result.ok).not.toBe(false);
        const text = output.join('\n');
        expect(text).toContain('VPC liveness could not be verified');
        expect(result.deep.reportOnly).toContainEqual({ kind: 'vpc', id: 'vpc-maybe', reason: 'liveness-unknown' });
        expect(trackEvent).toHaveBeenCalledWith('gc_deep_report', expect.objectContaining({
            vpc_liveness_unknown: true,
            vpc_deletable: 0,
        }));
    });

    it('enumerates clusters once and shares it between log-group and VPC liveness', async () => {
        mockEc2Send.mockImplementation(async (cmd) => {
            if (cmd instanceof MockDescribeAddressesCommand) return { Addresses: [] };
            if (cmd instanceof MockDescribeVpcsCommand) return { Vpcs: [] };
            throw new Error(`Unexpected EC2 command: ${cmd?.commandName}`);
        });
        mockSecretsSend.mockResolvedValue({ SecretList: [] });

        await runGc({ projectName: PROJECT, region: 'us-east-2', deep: true });
        const clusterCalls = mockEcsSend.mock.calls.filter(([cmd]) => cmd instanceof MockListClustersCommand);
        expect(clusterCalls).toHaveLength(1);
    });
});

describe('gc: deep VPC liveness', () => {
    const tagged = (vpcId, name) => ({
        VpcId: vpcId,
        Tags: [
            { Key: 'GradaProject', Value: PROJECT },
            { Key: 'Name', Value: name },
        ],
    });

    function deepCtx({ vpcs, clusters = null, services = [], subnets = [], isLambda = false, ecsImpl = null } = {}) {
        const clusterNames = clusters ?? [`${PROJECT}-cluster`];
        const ecsSend = ecsImpl ?? (async (cmd) => {
            if (cmd.commandName === 'ListClustersCommand') {
                return { clusterArns: clusterNames.map((c) => `arn:aws:ecs:us-east-2:123:cluster/${c}`) };
            }
            if (cmd.commandName === 'ListServicesCommand') {
                return { serviceArns: services.filter((s) => s.cluster === cmd.cluster).map((s) => s.arn) };
            }
            if (cmd.commandName === 'DescribeServicesCommand') {
                return { services: services.filter((s) => cmd.services.includes(s.arn)).map((s) => s.detail) };
            }
            throw new Error(`Unexpected ECS command: ${cmd?.commandName}`);
        });
        return {
            ec2Client: {
                send: vi.fn(async (cmd) => {
                    if (cmd.commandName === 'DescribeVpcsCommand') return { Vpcs: vpcs };
                    if (cmd.commandName === 'DescribeSubnetsCommand') {
                        return { Subnets: subnets.filter((s) => cmd.SubnetIds.includes(s.SubnetId)) };
                    }
                    throw new Error(`Unexpected EC2 command: ${cmd?.commandName}`);
                }),
            },
            ecsClient: { send: vi.fn(ecsSend) },
            secretsClient: { send: vi.fn(async () => ({ SecretList: [] })) },
            projectName: PROJECT,
            resourceSuffix: '',
            isLambda,
        };
    }

    it('excludes the stack VPC by Name with zero running services (asleep safe)', async () => {
        const found = await discoverDeepOrphans(deepCtx({
            vpcs: [tagged('vpc-stack', `${PROJECT}-vpc`), tagged('vpc-orphan', `${PROJECT}-pr-9-vpc`)],
        }));

        expect(found.unknown).toBe(false);
        expect(found.deletable).toEqual([{ kind: 'vpc', id: 'vpc-orphan' }]);
        expect(found.reportOnly).toContainEqual({ kind: 'vpc', id: 'vpc-stack', reason: 'live-excluded' });
    });

    it('treats desired-but-not-running services as live (crash loops count)', async () => {
        const found = await discoverDeepOrphans(deepCtx({
            vpcs: [tagged('vpc-preview', `${PROJECT}-pr-12-vpc`)],
            clusters: [`${PROJECT}-cluster`, `${PROJECT}-pr-12-cluster`],
            services: [{
                arn: 'arn:svc/pr-12',
                cluster: `${PROJECT}-pr-12-cluster`,
                detail: {
                    desiredCount: 1,
                    runningCount: 0,
                    networkConfiguration: { awsvpcConfiguration: { subnets: ['sub-1'] } },
                },
            }],
            subnets: [{ SubnetId: 'sub-1', VpcId: 'vpc-preview' }],
        }));

        expect(found.deletable).toEqual([]);
        expect(found.reportOnly).toContainEqual({ kind: 'vpc', id: 'vpc-preview', reason: 'live-excluded' });
    });

    it('proposes stale preview VPCs whose cluster runs nothing', async () => {
        const found = await discoverDeepOrphans(deepCtx({
            vpcs: [tagged('vpc-stale', `${PROJECT}-pr-9-vpc`)],
            clusters: [`${PROJECT}-cluster`, `${PROJECT}-pr-9-cluster`],
            services: [],
        }));

        expect(found.unknown).toBe(false);
        expect(found.deletable).toEqual([{ kind: 'vpc', id: 'vpc-stale' }]);
    });

    it('excludes live hand-made-workspace VPCs (non-pr-N clusters count)', async () => {
        const found = await discoverDeepOrphans(deepCtx({
            vpcs: [tagged('vpc-staging', `${PROJECT}-staging-vpc`)],
            clusters: [`${PROJECT}-cluster`, `${PROJECT}-staging-cluster`],
            services: [{
                arn: 'arn:svc/staging',
                cluster: `${PROJECT}-staging-cluster`,
                detail: {
                    desiredCount: 1,
                    runningCount: 1,
                    networkConfiguration: { awsvpcConfiguration: { subnets: ['sub-7'] } },
                },
            }],
            subnets: [{ SubnetId: 'sub-7', VpcId: 'vpc-staging' }],
        }));

        expect(found.unknown).toBe(false);
        expect(found.deletable).toEqual([]);
        expect(found.reportOnly).toContainEqual({ kind: 'vpc', id: 'vpc-staging', reason: 'live-excluded' });
    });

    it('still proposes stale hand-made-workspace VPCs whose cluster runs nothing', async () => {
        const found = await discoverDeepOrphans(deepCtx({
            vpcs: [tagged('vpc-stale-staging', `${PROJECT}-staging-vpc`)],
            clusters: [`${PROJECT}-cluster`, `${PROJECT}-staging-cluster`],
            services: [],
        }));

        expect(found.unknown).toBe(false);
        expect(found.deletable).toEqual([{ kind: 'vpc', id: 'vpc-stale-staging' }]);
    });

    it('skips zero-desired zero-running services', async () => {
        const { vpcIds, unknown } = await discoverLiveVpcIds({
            ecsClient: {
                send: vi.fn(async (cmd) => {
                    if (cmd.commandName === 'ListClustersCommand') {
                        return { clusterArns: [`arn:aws:ecs:us-east-2:123:cluster/${PROJECT}-cluster`] };
                    }
                    if (cmd.commandName === 'ListServicesCommand') return { serviceArns: ['arn:svc/idle'] };
                    return { services: [{ desiredCount: 0, runningCount: 0, networkConfiguration: { awsvpcConfiguration: { subnets: ['sub-9'] } } }] };
                }),
            },
            ec2Client: { send: vi.fn(async () => ({ Subnets: [] })) },
            projectName: PROJECT,
        });

        expect(unknown).toBe(false);
        expect([...vpcIds]).toEqual([]);
    });

    it('fails closed to report-only with unknown on ECS errors', async () => {
        const found = await discoverDeepOrphans(deepCtx({
            vpcs: [tagged('vpc-maybe', `${PROJECT}-pr-3-vpc`)],
            ecsImpl: async () => { throw new Error('socket hang up'); },
        }));

        expect(found.unknown).toBe(true);
        expect(found.deletable).toEqual([]);
        expect(found.reportOnly).toContainEqual({ kind: 'vpc', id: 'vpc-maybe', reason: 'liveness-unknown' });
    });

    it('on lambda skips the ECS walk: Name check only, no ECS calls', async () => {
        const ctx = deepCtx({
            vpcs: [tagged('vpc-stack', `${PROJECT}-vpc`), tagged('vpc-leftover', `${PROJECT}-pr-9-vpc`)],
            isLambda: true,
        });
        const found = await discoverDeepOrphans(ctx);

        expect(ctx.ecsClient.send).not.toHaveBeenCalled();
        expect(found.unknown).toBe(false);
        expect(found.deletable).toEqual([{ kind: 'vpc', id: 'vpc-leftover' }]);
        expect(found.reportOnly).toContainEqual({ kind: 'vpc', id: 'vpc-stack', reason: 'live-excluded' });
    });
});
