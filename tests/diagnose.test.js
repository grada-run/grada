import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { stripVTControlCharacters } from 'node:util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDiagnose, runLambdaDiagnose, pickMostRecentTask, extractTaskIdFromArn, formatAge, parseTaskDefinitionRef } from '../src/commands/diagnose.js';
import { trackEvent } from '../src/core/telemetry.js';
import { outro } from '@clack/prompts';

// Mock the AWS SDK clients (no real credentials needed)
const {
    mockEcsSend,
    mockLogsSend,
    MockECSClient,
    MockListTasksCommand,
    MockDescribeTasksCommand,
    MockLogsClient,
    MockFilterLogEventsCommand
} = vi.hoisted(() => {
    const ecsSend = vi.fn();
    const logsSend = vi.fn();
    return {
        mockEcsSend: ecsSend,
        mockLogsSend: logsSend,
        MockECSClient: vi.fn(function () {
            this.send = ecsSend;
        }),
        MockListTasksCommand: vi.fn(function (input) {
            Object.assign(this, input);
        }),
        MockDescribeTasksCommand: vi.fn(function (input) {
            Object.assign(this, input);
        }),
        MockLogsClient: vi.fn(function () {
            this.send = logsSend;
        }),
        MockFilterLogEventsCommand: vi.fn(function (input) {
            Object.assign(this, input);
        })
    };
});

vi.mock('@aws-sdk/client-ecs', () => {
    return {
        ECSClient: MockECSClient,
        DescribeTasksCommand: MockDescribeTasksCommand,
        ListTasksCommand: MockListTasksCommand
    };
});

vi.mock('@aws-sdk/client-cloudwatch-logs', () => {
    return {
        CloudWatchLogsClient: MockLogsClient,
        FilterLogEventsCommand: MockFilterLogEventsCommand
    };
});

// Silence interactive prompts and telemetry during tests


describe('Command: diagnose', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockEcsSend.mockReset();
        mockLogsSend.mockReset();
        // Default: no running tasks (keeps pre-existing tests on the unresolved path).
        mockEcsSend.mockResolvedValue({ taskArns: [] });
    });

    it('should extract and format the stoppedReason from a failed ECS task', async () => {
        const stoppedReason = 'OutOfMemoryError: Container killed due to memory usage';

        // 1. ListTasks -> one stopped task; DescribeTasks -> failed task detail
        mockEcsSend
            .mockResolvedValueOnce({
                taskArns: ['arn:aws:ecs:us-east-1:123456789012:task/test-cluster/abc123']
            })
            .mockResolvedValueOnce({
                tasks: [
                    {
                        taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/abc123',
                        stoppedReason,
                        stoppedAt: new Date().toISOString(),
                        containers: [
                            { name: 'app', exitCode: 137, reason: 'Essential container in task exited' }
                        ]
                    }
                ]
            });

        // 2. CloudWatch -> 55 events, only the last 50 should be used
        const events = Array.from({ length: 55 }, (_, i) => ({
            message: i === 54 ? `FATAL ${stoppedReason}` : `log line ${i + 1}`
        }));
        mockLogsSend.mockResolvedValueOnce({ events });

        // 3. Capture formatted console output
        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });

        try {
            const result = await runDiagnose({
                cluster: 'test-cluster',
                region: 'us-east-2',
                logGroup: '/ecs/test'
            });

            // Return value carries the extracted reason
            expect(result.stoppedReason).toBe(stoppedReason);
            // Last-50-lines limit honored
            expect(result.logs).toHaveLength(50);
            // Formatted output highlights the exact error
            expect(output.join('\n')).toContain(stoppedReason);
            // Log fetch asked CloudWatch for the last 50 lines
            expect(MockFilterLogEventsCommand).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 50 })
            );
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('should report healthy when there are no stopped tasks', async () => {
        mockEcsSend.mockResolvedValueOnce({ taskArns: [] });

        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });

        try {
            const result = await runDiagnose({ cluster: 'test-cluster', region: 'us-east-2' });
            expect(result.healthy).toBe(true);
            expect(mockLogsSend).not.toHaveBeenCalled();
            expect(output.join('\n')).toMatch(/healthy|No stopped tasks/i);
            expect(trackEvent).toHaveBeenCalledWith(
                'diagnose_run',
                expect.objectContaining({ success: true, healthy: true, log_source: 'none' })
            );
        } finally {
            consoleSpy.mockRestore();
        }
    });

    describe('pickMostRecentTask', () => {
        const task = (overrides) => ({
            taskArn: 'arn:aws:ecs:us-east-2:123456789012:task/test-cluster/aaa',
            containers: [{ name: 'app', exitCode: 1 }],
            ...overrides,
        });

        it('selects the latest stoppedAt across unordered tasks', () => {
            const oldest = task({ taskArn: 'arn/old', stoppedAt: '2026-09-26T12:00:00.000Z' });
            const newest = task({ taskArn: 'arn/new', stoppedAt: '2026-09-26T12:19:47.000Z' });
            const middle = task({ taskArn: 'arn/mid', stoppedAt: '2026-09-26T12:10:00.000Z' });
            expect(pickMostRecentTask([oldest, newest, middle]).taskArn).toBe('arn/new');
        });

        it('falls back to startedAt then createdAt when stoppedAt is missing', () => {
            const noStop = task({ taskArn: 'arn/started', startedAt: '2026-09-26T12:15:00.000Z' });
            const createdOnly = task({ taskArn: 'arn/created', createdAt: '2026-09-26T12:18:00.000Z' });
            const ancient = task({ taskArn: 'arn/old', stoppedAt: '2026-09-26T11:00:00.000Z' });
            // createdAt 12:18 beats startedAt 12:15; both beat stoppedAt 11:00 here
            // only to prove fallbacks participate — stoppedAt still wins when newest.
            expect(pickMostRecentTask([ancient, noStop, createdOnly]).taskArn).toBe('arn/created');
            const freshStop = task({ taskArn: 'arn/fresh', stoppedAt: '2026-09-26T12:20:00.000Z' });
            expect(pickMostRecentTask([createdOnly, freshStop]).taskArn).toBe('arn/fresh');
        });

        it('returns null for empty input', () => {
            expect(pickMostRecentTask([])).toBeNull();
            expect(pickMostRecentTask(null)).toBeNull();
        });

        it('extractTaskIdFromArn returns the trailing task id', () => {
            expect(extractTaskIdFromArn('arn:aws:ecs:us-east-2:123456789012:task/test-cluster/4ae4e44b8e484ac481d44fc408e3b9e7'))
                .toBe('4ae4e44b8e484ac481d44fc408e3b9e7');
            expect(extractTaskIdFromArn('no-slash')).toBe('');
            expect(extractTaskIdFromArn(undefined)).toBe('');
        });
    });

    it('selects the most recently stopped task even when listed out of order', async () => {
        const arns = ['arn-old', 'arn-new', 'arn-mid'];
        mockEcsSend
            .mockResolvedValueOnce({ taskArns: arns })
            .mockResolvedValueOnce({
                tasks: [
                    { taskArn: 'arn-old', stoppedReason: 'old', stoppedAt: '2026-09-26T12:00:00.000Z', containers: [{ name: 'app', exitCode: 1 }] },
                    { taskArn: 'arn-new', stoppedReason: 'fresh crash', stoppedAt: '2026-09-26T12:19:47.000Z', containers: [{ name: 'app', exitCode: 1 }] },
                    { taskArn: 'arn-mid', stoppedReason: 'mid', stoppedAt: '2026-09-26T12:10:00.000Z', containers: [{ name: 'app', exitCode: 1 }] },
                ]
            });
        mockLogsSend.mockResolvedValueOnce({ events: [{ message: 'boom' }] });

        const result = await runDiagnose({ cluster: 'test-cluster', region: 'us-east-2', logGroup: '/ecs/test' });
        expect(result.taskArn).toBe('arn-new');
        expect(result.stoppedReason).toBe('fresh crash');
    });

    it('describes up to 100 ARNs in one batch', async () => {
        const arns = Array.from({ length: 101 }, (_, i) => `arn-${i}`);
        mockEcsSend
            .mockResolvedValueOnce({ taskArns: arns })
            .mockResolvedValueOnce({ tasks: [] });
        mockLogsSend.mockResolvedValueOnce({ events: [] });

        await runDiagnose({ cluster: 'test-cluster', region: 'us-east-2', logGroup: '/ecs/test' });
        expect(MockDescribeTasksCommand).toHaveBeenCalledWith(
            expect.objectContaining({ tasks: expect.arrayContaining(arns.slice(0, 100)) })
        );
        const described = MockDescribeTasksCommand.mock.calls[0][0].tasks;
        expect(described).toHaveLength(100);
        expect(described).not.toContain('arn-100');
    });

    it('scopes the first log query to the crashed task stream', async () => {
        mockEcsSend
            .mockResolvedValueOnce({ taskArns: ['arn-task'] })
            .mockResolvedValueOnce({
                tasks: [{
                    taskArn: 'arn:aws:ecs:us-east-2:123456789012:task/test-cluster/4ae4e44b8e484ac481d44fc408e3b9e7',
                    stoppedReason: 'crash',
                    stoppedAt: '2026-09-26T12:19:47.000Z',
                    containers: [{ name: 'myapp-container', exitCode: 1 }],
                }]
            });
        mockLogsSend.mockResolvedValueOnce({ events: [{ message: 'FATAL: boom' }] });

        const result = await runDiagnose({ cluster: 'test-cluster', region: 'us-east-2', logGroup: '/ecs/test' });
        expect(MockFilterLogEventsCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                logGroupName: '/ecs/test',
                logStreamNamePrefix: 'ecs/myapp-container/4ae4e44b8e484ac481d44fc408e3b9e7',
                limit: 50,
            })
        );
        expect(mockLogsSend).toHaveBeenCalledTimes(1);
        expect(result.logs).toEqual(['FATAL: boom']);
        expect(trackEvent).toHaveBeenCalledWith(
            'diagnose_run',
            expect.objectContaining({ success: true, healthy: false, log_source: 'task-stream' })
        );
    });

    it('falls back to a group-wide 1h query when the task stream is empty', async () => {
        mockEcsSend
            .mockResolvedValueOnce({ taskArns: ['arn-task'] })
            .mockResolvedValueOnce({
                tasks: [{
                    taskArn: 'arn:aws:ecs:us-east-2:123456789012:task/test-cluster/abc123',
                    stoppedReason: 'crash',
                    stoppedAt: '2026-09-26T12:19:47.000Z',
                    containers: [{ name: 'app', exitCode: 1 }],
                }]
            });
        mockLogsSend
            .mockResolvedValueOnce({ events: [] })
            .mockResolvedValueOnce({ events: [{ message: 'group tail line' }] });

        const result = await runDiagnose({ cluster: 'test-cluster', region: 'us-east-2', logGroup: '/ecs/test' });
        expect(mockLogsSend).toHaveBeenCalledTimes(2);
        expect(MockFilterLogEventsCommand).toHaveBeenNthCalledWith(2,
            expect.objectContaining({
                logGroupName: '/ecs/test',
                startTime: expect.any(Number),
                limit: 50,
            })
        );
        const secondInput = MockFilterLogEventsCommand.mock.calls[1][0];
        expect(secondInput.logStreamNamePrefix).toBeUndefined();
        expect(secondInput.startTime).toBeGreaterThan(Date.now() - 61 * 60 * 1000);
        expect(result.logs).toEqual(['group tail line']);
        expect(trackEvent).toHaveBeenCalledWith(
            'diagnose_run',
            expect.objectContaining({ success: true, healthy: false, log_source: 'group-fallback' })
        );
    });

    it("reports log_source 'none' when both queries return empty", async () => {
        mockEcsSend
            .mockResolvedValueOnce({ taskArns: ['arn-task'] })
            .mockResolvedValueOnce({
                tasks: [{
                    taskArn: 'arn:aws:ecs:us-east-2:123456789012:task/test-cluster/abc123',
                    stoppedReason: 'crash',
                    stoppedAt: '2026-09-26T12:19:47.000Z',
                    containers: [{ name: 'app', exitCode: 1 }],
                }]
            });
        mockLogsSend
            .mockResolvedValueOnce({ events: [] })
            .mockResolvedValueOnce({ events: [] });

        const result = await runDiagnose({ cluster: 'test-cluster', region: 'us-east-2', logGroup: '/ecs/test' });
        expect(result.logs).toEqual([]);
        expect(trackEvent).toHaveBeenCalledWith(
            'diagnose_run',
            expect.objectContaining({ success: true, healthy: false, log_source: 'none' })
        );
    });

    describe('recovered service detection', () => {
        const stoppedTask = {
            taskArn: 'arn-stopped',
            stoppedReason: 'old crash',
            stoppedAt: '2026-09-26T12:10:00.000Z',
            containers: [{ name: 'app', exitCode: 1 }],
        };

        const mockStoppedOnly = () => {
            mockEcsSend
                .mockResolvedValueOnce({ taskArns: ['arn-stopped'] })
                .mockResolvedValueOnce({ tasks: [stoppedTask] });
        };

        const runWithOutput = async () => {
            const output = [];
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
                output.push(args.join(' '));
            });
            try {
                const result = await runDiagnose({ cluster: 'test-cluster', region: 'us-east-2', logGroup: '/ecs/test' });
                return { result, text: stripVTControlCharacters(output.join('\n')) };
            } finally {
                consoleSpy.mockRestore();
            }
        };

        it('reports recovery without fetching logs when a running task is newer', async () => {
            mockStoppedOnly();
            mockEcsSend
                .mockResolvedValueOnce({ taskArns: ['arn-running'] })
                .mockResolvedValueOnce({
                    tasks: [{ taskArn: 'arn-running', lastStatus: 'RUNNING', startedAt: '2026-09-26T12:15:00.000Z', containers: [{ name: 'app' }] }],
                });

            const { result, text } = await runWithOutput();
            expect(result).toMatchObject({
                healthy: true,
                recovered: true,
                stoppedReason: 'old crash',
                taskArn: 'arn-stopped',
                containerName: 'app',
                logs: [],
            });
            expect(mockLogsSend).not.toHaveBeenCalled();
            expect(text).toContain('Service recovered');
            expect(text).toContain('Previous crash');
            expect(vi.mocked(outro)).toHaveBeenCalledWith(expect.stringContaining('recovered after that crash'));
            expect(vi.mocked(outro)).not.toHaveBeenCalledWith(expect.stringContaining('Fix the error above'));
            expect(trackEvent).toHaveBeenCalledWith(
                'diagnose_run',
                expect.objectContaining({ success: true, healthy: true, recovered: true, log_source: 'none' })
            );
        });

        it('stays unresolved when the running task started at the same instant (tie)', async () => {
            mockStoppedOnly();
            mockEcsSend
                .mockResolvedValueOnce({ taskArns: ['arn-running'] })
                .mockResolvedValueOnce({
                    tasks: [{ taskArn: 'arn-running', lastStatus: 'RUNNING', startedAt: '2026-09-26T12:10:00.000Z', containers: [{ name: 'app' }] }],
                });
            mockLogsSend.mockResolvedValueOnce({ events: [{ message: 'boom' }] });

            const { result } = await runWithOutput();
            expect(result.healthy).toBe(false);
            expect(result.recovered).toBeUndefined();
            expect(mockLogsSend).toHaveBeenCalledTimes(1);
        });

        it('stays unresolved when running tasks predate the stop (failed rollout)', async () => {
            mockStoppedOnly();
            mockEcsSend
                .mockResolvedValueOnce({ taskArns: ['arn-running'] })
                .mockResolvedValueOnce({
                    tasks: [{ taskArn: 'arn-running', lastStatus: 'RUNNING', startedAt: '2026-09-26T12:00:00.000Z', containers: [{ name: 'app' }] }],
                });
            mockLogsSend.mockResolvedValueOnce({ events: [{ message: 'boom' }] });

            const { result, text } = await runWithOutput();
            expect(result.healthy).toBe(false);
            expect(text).toContain('Stopped reason: old crash');
            expect(vi.mocked(outro)).toHaveBeenCalledWith(expect.stringContaining('Fix the error above'));
        });

        it('stays unresolved when running ARNs return no task details', async () => {
            mockStoppedOnly();
            mockEcsSend
                .mockResolvedValueOnce({ taskArns: ['arn-running'] })
                .mockResolvedValueOnce({ tasks: [] });
            mockLogsSend.mockResolvedValueOnce({ events: [{ message: 'boom' }] });

            const { result } = await runWithOutput();
            expect(result.healthy).toBe(false);
            expect(mockLogsSend).toHaveBeenCalledTimes(1);
        });

        it('diagnoses the crash when the desired-RUNNING task is still PENDING (crash loop)', async () => {
            // Live case: ListTasks({ desiredStatus: 'RUNNING' }) returns a
            // 2-second-old PENDING task (CannotPullContainerError loop) next
            // to the STOPPED crash. Fresh createdAt must not read as recovery.
            mockStoppedOnly();
            mockEcsSend
                .mockResolvedValueOnce({ taskArns: ['arn-pending'] })
                .mockResolvedValueOnce({
                    tasks: [{
                        taskArn: 'arn-pending',
                        desiredStatus: 'RUNNING',
                        lastStatus: 'PENDING',
                        createdAt: '2026-09-26T12:15:00.000Z',
                        containers: [{ name: 'app' }],
                    }],
                });
            mockLogsSend.mockResolvedValueOnce({ events: [{ message: 'boom' }] });

            const { result, text } = await runWithOutput();
            expect(result.healthy).toBe(false);
            expect(result.recovered).toBeUndefined();
            expect(text).toContain('Stopped reason: old crash');
            expect(text).not.toContain('Service recovered');
            expect(mockLogsSend).toHaveBeenCalledTimes(1);
        });

        it('diagnoses the crash when the only RUNNING task is UNHEALTHY', async () => {
            mockStoppedOnly();
            mockEcsSend
                .mockResolvedValueOnce({ taskArns: ['arn-running'] })
                .mockResolvedValueOnce({
                    tasks: [{
                        taskArn: 'arn-running',
                        lastStatus: 'RUNNING',
                        healthStatus: 'UNHEALTHY',
                        startedAt: '2026-09-26T12:15:00.000Z',
                        containers: [{ name: 'app' }],
                    }],
                });
            mockLogsSend.mockResolvedValueOnce({ events: [{ message: 'boom' }] });

            const { result, text } = await runWithOutput();
            expect(result.healthy).toBe(false);
            expect(result.recovered).toBeUndefined();
            expect(text).not.toContain('Service recovered');
            expect(mockLogsSend).toHaveBeenCalledTimes(1);
        });
    });

    describe('parseTaskDefinitionRef', () => {
        it('parses family and revision from ECS task definition ARNs', () => {
            expect(parseTaskDefinitionRef('arn:aws:ecs:us-east-2:123456789012:task-definition/myapp-task:9'))
                .toEqual({ family: 'myapp-task', revision: 9 });
        });

        it('returns null for missing or malformed ARNs', () => {
            expect(parseTaskDefinitionRef(undefined)).toBeNull();
            expect(parseTaskDefinitionRef('arn-stopped')).toBeNull();
            expect(parseTaskDefinitionRef('arn:aws:ecs:us-east-2:123456789012:task-definition/myapp-task')).toBeNull();
        });
    });

    describe('revision-based recovery', () => {
        const taskDef = (rev) => `arn:aws:ecs:us-east-2:123456789012:task-definition/myapp-task:${rev}`;

        const mockStoppedAtRev = (rev, stoppedAt) => {
            mockEcsSend
                .mockResolvedValueOnce({ taskArns: ['arn-stopped'] })
                .mockResolvedValueOnce({
                    tasks: [{
                        taskArn: 'arn-stopped',
                        taskDefinitionArn: taskDef(rev),
                        stoppedReason: 'old crash',
                        stoppedAt,
                        containers: [{ name: 'app', exitCode: 1 }],
                    }],
                });
        };

        const mockRunningAtRev = (rev, startedAt) => {
            mockEcsSend
                .mockResolvedValueOnce({ taskArns: ['arn-running'] })
                .mockResolvedValueOnce({
                    tasks: [{
                        taskArn: 'arn-running',
                        taskDefinitionArn: taskDef(rev),
                        lastStatus: 'RUNNING',
                        startedAt,
                        containers: [{ name: 'app' }],
                    }],
                });
        };

        const runWithOutput = async () => {
            const output = [];
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
                output.push(args.join(' '));
            });
            try {
                const result = await runDiagnose({ cluster: 'test-cluster', region: 'us-east-2', logGroup: '/ecs/test' });
                return { result, text: stripVTControlCharacters(output.join('\n')) };
            } finally {
                consoleSpy.mockRestore();
            }
        };

        it('recovers when the stop is on a superseded revision even if it stopped later (drain order)', async () => {
            // Live case: :9 started 14:44:19, :8 drained at 14:44:26.
            mockStoppedAtRev(8, '2026-09-26T14:44:26.000Z');
            mockRunningAtRev(9, '2026-09-26T14:44:19.000Z');

            const { result, text } = await runWithOutput();
            expect(result).toMatchObject({ healthy: true, recovered: true });
            expect(mockLogsSend).not.toHaveBeenCalled();
            expect(text).toContain('Revision 9 is now running');
        });

        it('recovers a rollback when the older revision restarted after the crash', async () => {
            // :9 crashed, then `rollback 8` launched a fresh :8 afterwards.
            mockStoppedAtRev(9, '2026-09-26T14:40:00.000Z');
            mockRunningAtRev(8, '2026-09-26T14:45:00.000Z');

            const { result } = await runWithOutput();
            expect(result).toMatchObject({ healthy: true, recovered: true });
            expect(mockLogsSend).not.toHaveBeenCalled();
        });

        it('stays unresolved when the crash is on a newer revision than the survivor', async () => {
            // Failed rollout: :8 kept serving while :9 crashed.
            mockStoppedAtRev(9, '2026-09-26T14:44:26.000Z');
            mockRunningAtRev(8, '2026-09-26T14:40:00.000Z');
            mockLogsSend.mockResolvedValueOnce({ events: [{ message: 'boom' }] });

            const { result, text } = await runWithOutput();
            expect(result.healthy).toBe(false);
            expect(result.recovered).toBeUndefined();
            expect(mockLogsSend).toHaveBeenCalledTimes(1);
            expect(text).toMatch(/\(stopped \S+ ago\)/);
        });

        it('falls back to timestamps when revisions match or are unparseable', async () => {
            // Same revision: newer running task still recovers via timestamps.
            mockStoppedAtRev(9, '2026-09-26T14:40:00.000Z');
            mockRunningAtRev(9, '2026-09-26T14:45:00.000Z');

            const first = await runWithOutput();
            expect(first.result).toMatchObject({ healthy: true, recovered: true });

            // Unparseable ARNs: timestamp rule decides (older running → unresolved).
            vi.clearAllMocks();
            mockEcsSend.mockResolvedValue({ taskArns: [] });
            mockEcsSend
                .mockResolvedValueOnce({ taskArns: ['arn-stopped'] })
                .mockResolvedValueOnce({
                    tasks: [{
                        taskArn: 'arn-stopped',
                        stoppedReason: 'old crash',
                        stoppedAt: '2026-09-26T14:44:00.000Z',
                        containers: [{ name: 'app', exitCode: 1 }],
                    }],
                })
                .mockResolvedValueOnce({ taskArns: ['arn-running'] })
                .mockResolvedValueOnce({
                    tasks: [{ taskArn: 'arn-running', lastStatus: 'RUNNING', startedAt: '2026-09-26T14:40:00.000Z', containers: [{ name: 'app' }] }],
                });
            mockLogsSend.mockResolvedValueOnce({ events: [{ message: 'boom' }] });

            const second = await runWithOutput();
            expect(second.result.healthy).toBe(false);
        });

        it('prefers container exit time over task stop time for the comparison', async () => {
            // Task fully stopped (ENI deprovisioned) after the running task
            // started, but the container itself exited long before.
            mockEcsSend
                .mockResolvedValueOnce({ taskArns: ['arn-stopped'] })
                .mockResolvedValueOnce({
                    tasks: [{
                        taskArn: 'arn-stopped',
                        stoppedReason: 'old crash',
                        executionStoppedAt: '2026-09-26T14:30:00.000Z',
                        stoppedAt: '2026-09-26T14:50:00.000Z',
                        containers: [{ name: 'app', exitCode: 1 }],
                    }],
                })
                .mockResolvedValueOnce({ taskArns: ['arn-running'] })
                .mockResolvedValueOnce({
                    tasks: [{ taskArn: 'arn-running', lastStatus: 'RUNNING', startedAt: '2026-09-26T14:40:00.000Z', containers: [{ name: 'app' }] }],
                });

            const { result } = await runWithOutput();
            expect(result).toMatchObject({ healthy: true, recovered: true });
        });
    });

    describe('formatAge', () => {
        it('formats seconds, minutes, hours, and days', () => {
            expect(formatAge(0)).toBe('0s');
            expect(formatAge(-5000)).toBe('0s');
            expect(formatAge(45 * 1000)).toBe('45s');
            expect(formatAge(5 * 60 * 1000)).toBe('5m');
            expect(formatAge(2 * 60 * 60 * 1000)).toBe('2h');
            expect(formatAge(3 * 24 * 60 * 60 * 1000)).toBe('3d');
        });
    });

    it('reports a missing log group instead of an empty stream', async () => {
        mockEcsSend
            .mockResolvedValueOnce({ taskArns: ['arn-task'] })
            .mockResolvedValueOnce({
                tasks: [{
                    taskArn: 'arn:aws:ecs:us-east-2:123456789012:task/test-cluster/abc123',
                    stoppedReason: 'crash',
                    stoppedAt: '2026-09-26T12:19:47.000Z',
                    containers: [{ name: 'app', exitCode: 1 }],
                }]
            });
        const notFound = new Error('The specified log group does not exist.');
        notFound.name = 'ResourceNotFoundException';
        mockLogsSend.mockRejectedValueOnce(notFound);

        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });
        try {
            const result = await runDiagnose({ cluster: 'test-cluster', region: 'us-east-2', logGroup: '/ecs/missing' });
            expect(mockLogsSend).toHaveBeenCalledTimes(1);
            expect(result.logs).toEqual([]);
            expect(output.join('\n')).toContain('Log group not found');
            expect(trackEvent).toHaveBeenCalledWith(
                'diagnose_run',
                expect.objectContaining({ success: true, healthy: false, log_source: 'none' })
            );
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('should exit gracefully on UnrecognizedClientException instead of throwing', async () => {
        const error = new Error('Invalid token');
        error.name = 'UnrecognizedClientException';
        mockEcsSend.mockRejectedValueOnce(error);

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        try {
            await runDiagnose({ cluster: 'test-cluster', region: 'us-east-1', spawnSyncImpl: () => ({ status: 0 }) });
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('AWS Session Expired'));
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            exitSpy.mockRestore();
            consoleSpy.mockRestore();
        }
    });

    it('routes unresolvable projects through PROJECT_NOT_INITIALIZED', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => { throw new Error('deleted'); });
        try {
            const result = await runDiagnose(null);
            expect(result).toEqual({ ok: false, reason: 'project-not-initialized' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(trackEvent).toHaveBeenCalledWith('diagnose_run', expect.objectContaining({
                success: false,
                error_code: 'PROJECT_NOT_INITIALIZED',
            }));
        } finally {
            cwdSpy.mockRestore();
            exitSpy.mockRestore();
            consoleSpy.mockRestore();
        }
    });
});

describe('Command: diagnose on --target lambda projects', () => {
    let exitSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
    });

    afterEach(() => {
        exitSpy.mockRestore();
    });

    const ACTIVE = JSON.stringify({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } });

    function baseInput(overrides = {}) {
        return {
            projectName: 'myapp',
            region: 'us-east-2',
            logGroup: '/aws/lambda/myapp-fn',
            spawnSyncImpl: vi.fn(() => ({ status: 0, stdout: ACTIVE, stderr: '' })),
            logsClient: { send: vi.fn().mockResolvedValue({ events: [] }) },
            ...overrides,
        };
    }

    it('reports healthy when the function is active with no error logs', async () => {
        const result = await runLambdaDiagnose(baseInput());
        expect(result.healthy).toBe(true);
        expect(result.functionName).toBe('myapp-fn');
        expect(trackEvent).toHaveBeenCalledWith('diagnose_run', expect.objectContaining({ healthy: true, success: true }));
    });

    it('resolves the function name with the rendered resource suffix', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnose-suffix-'));
        try {
            fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), 'locals {\n  grada_resource_suffix = "-a1b2c3"\n}\n');
            const result = await runLambdaDiagnose(baseInput({ cwd: dir }));
            expect(result.functionName).toBe('myapp-a1b2c3-fn');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('surfaces failed updates and recent error logs', async () => {
        const failed = JSON.stringify({ Configuration: { State: 'Active', LastUpdateStatus: 'Failed' } });
        const logsClient = { send: vi.fn().mockResolvedValue({ events: [{ message: 'ERROR boom' }, { message: 'ok line' }] }) };
        const result = await runLambdaDiagnose(baseInput({
            spawnSyncImpl: vi.fn(() => ({ status: 0, stdout: failed, stderr: '' })),
            logsClient,
        }));
        expect(result.healthy).toBe(false);
        expect(result.logs).toHaveLength(2);
        expect(outro).toHaveBeenCalled();
    });

    it('flags error logs even when the configuration looks healthy', async () => {
        const logsClient = { send: vi.fn().mockResolvedValue({ events: [{ message: 'FATAL out of memory' }] }) };
        const result = await runLambdaDiagnose(baseInput({ logsClient }));
        expect(result.healthy).toBe(false);
    });

    it('handles missing functions and missing CLIs without throwing', async () => {
        const missing = await runLambdaDiagnose(baseInput({
            spawnSyncImpl: vi.fn(() => ({ status: 254, stdout: '', stderr: 'ResourceNotFoundException' })),
        }));
        expect(missing).toMatchObject({ healthy: false, reason: 'not-deployed' });

        await runLambdaDiagnose(baseInput({ spawnSyncImpl: vi.fn(() => ({ error: { code: 'ENOENT' } })) }));
        expect(trackEvent).toHaveBeenCalledWith('diagnose_run', expect.objectContaining({ error_code: 'AWS_CLI_MISSING' }));
    });

    it('dispatches lambda projects from runDiagnose', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnose-lambda-test-'));
        try {
            fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'terraform', 'main.tf'),
                'locals {\n  app_name = "myapp${local.env_suffix}"\n}\nresource "aws_lambda_function" "app" {}\n'
            );
            const result = await runDiagnose({
                cwd: dir,
                region: 'us-east-2',
                spawnSyncImpl: vi.fn(() => ({ status: 0, stdout: ACTIVE, stderr: '' })),
                logsClient: { send: vi.fn().mockResolvedValue({ events: [] }) },
            });
            expect(result.healthy).toBe(true);
            expect(result.functionName).toBe('myapp-fn');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
