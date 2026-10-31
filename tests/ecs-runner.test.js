import { describe, it, expect, vi } from 'vitest';
import { runEphemeralEcsTask } from '../src/utils/ecs-runner.js';

const {
    MockDescribeTasksCommand,
    MockDescribeServicesCommand,
    MockDescribeTaskDefinitionCommand,
    MockRunTaskCommand,
    MockStopTaskCommand,
    MockFilterLogEventsCommand,
    MockGetLogEventsCommand,
} = vi.hoisted(() => {
    const cmd = () => vi.fn(function (input) { Object.assign(this, input); });
    return {
        MockDescribeTasksCommand: cmd(),
        MockDescribeServicesCommand: cmd(),
        MockDescribeTaskDefinitionCommand: cmd(),
        MockRunTaskCommand: cmd(),
        MockStopTaskCommand: cmd(),
        MockFilterLogEventsCommand: cmd(),
        MockGetLogEventsCommand: cmd(),
    };
});

vi.mock('@aws-sdk/client-ecs', () => ({
    ECSClient: vi.fn(function () { this.send = vi.fn(); }),
    DescribeTasksCommand: MockDescribeTasksCommand,
    DescribeServicesCommand: MockDescribeServicesCommand,
    DescribeTaskDefinitionCommand: MockDescribeTaskDefinitionCommand,
    RunTaskCommand: MockRunTaskCommand,
    StopTaskCommand: MockStopTaskCommand,
}));

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
    CloudWatchLogsClient: vi.fn(function () { this.send = vi.fn(); }),
    FilterLogEventsCommand: MockFilterLogEventsCommand,
    GetLogEventsCommand: MockGetLogEventsCommand,
}));

const TASK_ARN = 'arn:aws:ecs:us-east-2:123456789012:task/myapp-cluster/abc123def456';

function mockEcsClient(finalTask) {
    return {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockDescribeServicesCommand) {
                return Promise.resolve({
                    services: [{
                        status: 'ACTIVE',
                        taskDefinition: 'myapp-taskdef:1',
                        networkConfiguration: {
                            awsvpcConfiguration: { subnets: ['subnet-1'], securityGroups: ['sg-1'] },
                        },
                    }],
                });
            }
            if (cmd instanceof MockDescribeTaskDefinitionCommand) {
                return Promise.resolve({
                    taskDefinition: {
                        containerDefinitions: [{
                            name: 'myapp-container',
                            logConfiguration: { options: {} },
                            environment: [],
                            secrets: [],
                        }],
                    },
                });
            }
            if (cmd instanceof MockRunTaskCommand) {
                return Promise.resolve({ tasks: [{ taskArn: TASK_ARN }], failures: [] });
            }
            if (cmd instanceof MockDescribeTasksCommand) {
                return Promise.resolve({ tasks: [finalTask] });
            }
            return Promise.resolve({});
        }),
    };
}

function mockLogsClient() {
    return {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockFilterLogEventsCommand) return Promise.resolve({ events: [] });
            if (cmd instanceof MockGetLogEventsCommand) {
                return Promise.resolve({ events: [], nextForwardToken: 't1' });
            }
            return Promise.resolve({});
        }),
    };
}

function runWith(finalTask) {
    return runEphemeralEcsTask({
        ecsClient: mockEcsClient(finalTask),
        logsClient: mockLogsClient(),
        cluster: 'myapp-cluster',
        service: 'myapp-service',
        containerName: 'myapp-container',
        command: ['node', './dist/migrate.cjs'],
        startedBy: 'grada-test',
        logGroupName: '/ecs/myapp',
        timeoutMs: 5000,
        timeoutSeconds: 5,
        pollIntervalMs: 1,
        maxFlushPolls: 1,
        flushIntervalMs: 1,
        spinner: null,
    });
}

describe('ecs-runner exit attribution', () => {
    it('fails loud when the final task lacks the named container (never the sidecar exit)', async () => {
        const outcome = await runWith({
            taskArn: TASK_ARN,
            lastStatus: 'STOPPED',
            stoppedReason: 'Essential container in task exited',
            containers: [{ name: 'sidecar', lastStatus: 'STOPPED', exitCode: 0, reason: 'done' }],
        });
        expect(outcome.ok).toBe(false);
        expect(outcome.containerName).toBe('myapp-container');
        expect(outcome.available).toEqual(['sidecar']);
    });

    it('reports the named container exit when present', async () => {
        const outcome = await runWith({
            taskArn: TASK_ARN,
            lastStatus: 'STOPPED',
            stoppedReason: 'Essential container in task exited',
            containers: [{ name: 'myapp-container', lastStatus: 'STOPPED', exitCode: 0, reason: 'done' }],
        });
        expect(outcome).toMatchObject({ ok: true, taskArn: TASK_ARN, exitCode: 0 });
    });
});
