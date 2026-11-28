import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTmpDirTracker } from './helpers/tmpdir.js';
import { mockConfirm } from './helpers/clack.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runQueue, QUEUE_SUBCOMMANDS } from '../src/commands/queue.js';
import { runQueueRedrive, parseQueueRedriveArgs } from '../src/commands/queue/redrive.js';
import { safeSuffixedName } from '../src/utils/resolvers.js';

const { MockGetQueueUrlCommand, MockGetQueueAttributesCommand, MockStartMessageMoveTaskCommand } = vi.hoisted(() => {
    const cmd = () => vi.fn(function (input) { Object.assign(this, input); });
    return {
        MockGetQueueUrlCommand: cmd(),
        MockGetQueueAttributesCommand: cmd(),
        MockStartMessageMoveTaskCommand: cmd(),
    };
});

vi.mock('@aws-sdk/client-sqs', () => ({
    SQSClient: vi.fn(function () { this.send = vi.fn(); }),
    GetQueueUrlCommand: MockGetQueueUrlCommand,
    GetQueueAttributesCommand: MockGetQueueAttributesCommand,
    StartMessageMoveTaskCommand: MockStartMessageMoveTaskCommand,
}));

const tmp = createTmpDirTracker();

function makeTmp() {
    return tmp.makeTmp('queue-test-');
}

beforeEach(() => {
    tmp.reset();
    vi.clearAllMocks();
});

afterEach(() => {
    tmp.cleanup();
});

function writeTree(dir, project) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'terraform', 'main.tf'),
        `locals {\n  app_name = "${project}\${local.env_suffix}"\n}\n`
    );
    fs.writeFileSync(path.join(dir, 'terraform', 'sqs.tf'), 'resource "aws_sqs_queue" "main" {}\n');
}

function mockClient(handler) {
    return { send: vi.fn(handler) };
}

// In-memory SQS: URLs/ARNs derived from names, configurable DLQ depth.
function sqsMock({ depth = '3' } = {}) {
    const urls = [];
    const moves = [];
    const client = mockClient(async (cmd) => {
        if (cmd.SourceArn) {
            moves.push({ SourceArn: cmd.SourceArn, DestinationArn: cmd.DestinationArn });
            return { TaskHandle: 'move-task-handle-1' };
        }
        if (cmd.AttributeNames) {
            const arn = `arn:aws:sqs:us-east-2:123456789012:${cmd.QueueUrl.split('/').pop()}`;
            const visible = cmd.QueueUrl.includes('-dlq') ? depth : '0';
            return { Attributes: { QueueArn: arn, ApproximateNumberOfMessagesVisible: visible } };
        }
        if (cmd.QueueName) {
            urls.push(cmd.QueueName);
            return { QueueUrl: `https://sqs.us-east-2.amazonaws.com/123456789012/${cmd.QueueName}` };
        }
        throw new Error(`unexpected SQS command: ${Object.keys(cmd).join(',')}`);
    });
    return { client, urls, moves };
}

function captureLog() {
    const output = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => { output.push(args.join(' ')); };
    console.error = (...args) => { output.push(args.join(' ')); };
    return { output, restore() { console.log = origLog; console.error = origError; } };
}

describe('queue dispatcher', () => {
    it('exposes redrive as the only subcommand', () => {
        expect(QUEUE_SUBCOMMANDS).toEqual(['redrive']);
    });

    it('prints usage on bare invocation without failing', async () => {
        const { output, restore } = captureLog();
        try {
            const result = await runQueue([]);
            expect(result.ok).toBe(true);
            expect(output.join('\n')).toMatch(/redrive/);
        } finally {
            restore();
        }
    });

    it('prints usage on --help without dispatching', async () => {
        const { output, restore } = captureLog();
        try {
            const result = await runQueue(['--help']);
            expect(result.ok).toBe(true);
            expect(output.join('\n')).toMatch(/Usage:/);
        } finally {
            restore();
        }
    });

    it('fails unknown subcommands with UNKNOWN_QUEUE_SUBCOMMAND', async () => {
        const { restore } = captureLog();
        try {
            const result = await runQueue(['frobnicate'], { isHeadless: true });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('unknown-queue-subcommand');
        } finally {
            restore();
        }
    });
});

describe('queue redrive args', () => {
    it('parses overrides and flags', () => {
        const options = parseQueueRedriveArgs(['redrive', '--region', 'eu-west-1', '--workspace', 'pr-3', '--yes']);
        expect(options).toMatchObject({ region: 'eu-west-1', workspace: 'pr-3', yes: true });
    });

    it('collects unknown flags for refusal', () => {
        const options = parseQueueRedriveArgs(['redrive', '--bogus']);
        expect(options.unknownFlags).toContain('--bogus');
    });
});

describe('Command: queue redrive (mocked SQS)', () => {
    it('lists every flag in the positionals error', async () => {
        const dir = makeTmp();
        writeTree(dir, 'myapp');
        const { output, restore } = captureLog();
        try {
            const result = await runQueueRedrive({ cwd: dir, isHeadless: true, unexpectedPositionals: ['oops'] });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('unexpected-positional-args');
            for (const flag of ['--project-name', '--workspace', '--region', '--yes']) {
                expect(output.join('\n')).toContain(flag);
            }
        } finally {
            restore();
        }
    });

    it('refuses unknown flags', async () => {
        const dir = makeTmp();
        writeTree(dir, 'myapp');
        const { restore } = captureLog();
        try {
            const result = await runQueueRedrive({ cwd: dir, isHeadless: true, unknownFlags: ['--bogus'] });
            expect(result.ok).toBe(false);
        } finally {
            restore();
        }
    });

    it('fails fast without terraform/sqs.tf', async () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "myapp${local.env_suffix}"\n}\n'
        );
        const { client } = sqsMock();
        const { restore } = captureLog();
        try {
            const result = await runQueueRedrive({ cwd: dir, isHeadless: true, sqsClient: client });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('sqs-tf-not-found');
            expect(client.send).not.toHaveBeenCalled();
        } finally {
            restore();
        }
    });

    it('fails when the queues do not exist yet', async () => {
        const dir = makeTmp();
        writeTree(dir, 'myapp');
        const err = new Error('missing');
        err.name = 'QueueDoesNotExist';
        const client = mockClient(() => Promise.reject(err));
        const { output, restore } = captureLog();
        try {
            const result = await runQueueRedrive({ cwd: dir, isHeadless: true, sqsClient: client });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('queue-not-found');
            expect(output.join('\n')).toMatch(/apply/);
        } finally {
            restore();
        }
    });

    it('reports an empty DLQ as success without starting a move', async () => {
        const dir = makeTmp();
        writeTree(dir, 'myapp');
        const { client, moves } = sqsMock({ depth: '0' });
        const { output, restore } = captureLog();
        try {
            const result = await runQueueRedrive({ cwd: dir, isHeadless: true, sqsClient: client, yes: true });
            expect(result.ok).toBe(true);
            expect(result.moved).toBe(0);
            expect(moves).toEqual([]);
            expect(output.join('\n')).toMatch(/empty/);
        } finally {
            restore();
        }
    });

    it('refuses without --yes when headless and messages await', async () => {
        const dir = makeTmp();
        writeTree(dir, 'myapp');
        const { client, moves } = sqsMock({ depth: '3' });
        const { restore } = captureLog();
        try {
            const result = await runQueueRedrive({ cwd: dir, isHeadless: true, sqsClient: client });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('confirmation-required');
            expect(moves).toEqual([]);
        } finally {
            restore();
        }
    });

    it('starts the move task DLQ to queue with --yes', async () => {
        const dir = makeTmp();
        writeTree(dir, 'myapp');
        const { client, moves } = sqsMock({ depth: '3' });
        const { restore } = captureLog();
        try {
            const result = await runQueueRedrive({ cwd: dir, isHeadless: true, sqsClient: client, yes: true });
            expect(result.ok).toBe(true);
            expect(result.taskHandle).toBe('move-task-handle-1');
            expect(moves).toEqual([{
                SourceArn: 'arn:aws:sqs:us-east-2:123456789012:myapp-dlq',
                DestinationArn: 'arn:aws:sqs:us-east-2:123456789012:myapp-queue',
            }]);
        } finally {
            restore();
        }
    });

    it('prompts interactively and honors the answer', async () => {
        const dir = makeTmp();
        writeTree(dir, 'myapp');
        const accepted = sqsMock({ depth: '2' });
        mockConfirm.mockResolvedValue(true);
        const first = captureLog();
        try {
            const result = await runQueueRedrive({ cwd: dir, headless: false, sqsClient: accepted.client });
            expect(result.ok).toBe(true);
            expect(accepted.moves).toHaveLength(1);
        } finally {
            first.restore();
        }
        const declined = sqsMock({ depth: '2' });
        mockConfirm.mockResolvedValue(false);
        const second = captureLog();
        try {
            const result = await runQueueRedrive({ cwd: dir, headless: false, sqsClient: declined.client });
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('cancelled');
            expect(declined.moves).toEqual([]);
        } finally {
            second.restore();
        }
    });

    it('resolves hashed queue names for over-cap app names', async () => {
        const dir = makeTmp();
        const project = `queue-heavy-project-name-that-is-far-too-long-for-plain-sqs-names`;
        writeTree(dir, project);
        const { client } = sqsMock({ depth: '1' });
        const { restore } = captureLog();
        try {
            const result = await runQueueRedrive({ cwd: dir, isHeadless: true, sqsClient: client, yes: true });
            expect(result.ok).toBe(true);
            const names = client.send.mock.calls.map(([cmd]) => cmd.QueueName).filter(Boolean);
            expect(names).toContain(safeSuffixedName(project, '-queue', 80));
            expect(names).toContain(safeSuffixedName(project, '-dlq', 80));
        } finally {
            restore();
        }
    });
});
