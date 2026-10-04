import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackPromptsMockFactory, mockText, mockSelect, mockConfirm, mockPassword, mockSpinner } from './helpers/clack.js';
import { telemetryMockFactory, mockTrackEvent } from './helpers/telemetry.js';
import { netMockFactory, resetNetMock, mockNetConnect, mockNetCreateServer } from './helpers/net.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'node:stream';
import {
    buildSsmArgs as sharedBuildSsmArgs,
    fetchManagedDbCredentials,
    findJumpHostTarget,
    waitForTcpPort,
    getFreeLocalPort,
    redactUri,
    parseSourceUri,
    findMissingBinaries,
} from '../src/utils/db-tunnel.js';
import { stripVTControlCharacters } from 'node:util';
import {
    runDb,
    runDbConnect,
    parseDbArgs,
    isValidPort,
    resolveDbIdentifier,
    buildConnectionString,
    formatConnectionInfo,
    buildSsmArgs,
    pickRuntimeContainer,
    DEFAULT_LOCAL_PORT,
    MASKED_PASSWORD,
    runDbMigrate,
    parseDbMigrateArgs,
    runDbBackup,
    parseDbBackupArgs,
    runDbRestore,
    parseDbRestoreArgs,
    upsertSnapshotIdentifier,
    runDbEnableVector,
    parseDbEnableVectorArgs,
    buildVectorExtensionCommand,
    runDbImport,
    parseDbImportArgs,
    classifyImportFile,
    requiredClientBinaries,
    buildTargetClientCommand,
    buildSourceDumpCommand,
} from '../src/commands/db.js';
import { injectMigrationGate, quoteShellArg, buildMigrationCommand, findGateBlock } from '../src/commands/db/migrate.js';
import { resolveWorkspaceSuffix } from '../src/utils/resolvers.js';

vi.mock('@clack/prompts', () => clackPromptsMockFactory());

vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));

vi.mock('node:net', () => netMockFactory());

const {
    MockDescribeDBInstancesCommand,
    MockDescribeDBClustersCommand,
    MockCreateDBSnapshotCommand,
    MockDescribeDBSnapshotsCommand,
    MockCreateDBClusterSnapshotCommand,
    MockDescribeDBClusterSnapshotsCommand,
    MockListTasksCommand,
    MockDescribeTasksCommand,
    MockDescribeServicesCommand,
    MockDescribeTaskDefinitionCommand,
    MockRunTaskCommand,
    MockStopTaskCommand,
    MockGetSecretValueCommand,
    MockFilterLogEventsCommand,
    MockGetLogEventsCommand,
} = vi.hoisted(() => {
    const cmd = () => vi.fn(function (input) { Object.assign(this, input); });
    return {
        MockDescribeDBInstancesCommand: cmd(),
        MockDescribeDBClustersCommand: cmd(),
        MockCreateDBSnapshotCommand: cmd(),
        MockDescribeDBSnapshotsCommand: cmd(),
        MockCreateDBClusterSnapshotCommand: cmd(),
        MockDescribeDBClusterSnapshotsCommand: cmd(),
        MockListTasksCommand: cmd(),
        MockDescribeTasksCommand: cmd(),
        MockDescribeServicesCommand: cmd(),
        MockDescribeTaskDefinitionCommand: cmd(),
        MockRunTaskCommand: cmd(),
        MockStopTaskCommand: cmd(),
        MockGetSecretValueCommand: cmd(),
        MockFilterLogEventsCommand: cmd(),
        MockGetLogEventsCommand: cmd(),
    };
});

vi.mock('@aws-sdk/client-rds', () => ({
    RDSClient: vi.fn(function () { this.send = vi.fn(); }),
    DescribeDBInstancesCommand: MockDescribeDBInstancesCommand,
    DescribeDBClustersCommand: MockDescribeDBClustersCommand,
    CreateDBSnapshotCommand: MockCreateDBSnapshotCommand,
    DescribeDBSnapshotsCommand: MockDescribeDBSnapshotsCommand,
    CreateDBClusterSnapshotCommand: MockCreateDBClusterSnapshotCommand,
    DescribeDBClusterSnapshotsCommand: MockDescribeDBClusterSnapshotsCommand,
}));

vi.mock('@aws-sdk/client-ecs', () => ({
    ECSClient: vi.fn(function () { this.send = vi.fn(); }),
    ListTasksCommand: MockListTasksCommand,
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

vi.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: vi.fn(function () { this.send = vi.fn(); }),
    GetSecretValueCommand: MockGetSecretValueCommand,
}));

const TASK_ARN = 'arn:aws:ecs:us-east-2:123456789012:task/myapp-cluster/abc123def456';
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!db-xyz';
const DB_PASSWORD = 's3cr3t-db-password';
const DB_USERNAME = 'dbadmin';

function mockRdsClient(dbInstance) {
    return {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockDescribeDBInstancesCommand) {
                return Promise.resolve({ DBInstances: dbInstance ? [dbInstance] : [] });
            }
            return Promise.resolve({});
        }),
    };
}

function mockRdsNotFoundClient() {
    return {
        send: vi.fn((cmd) => {
            const err = new Error('DB not found');
            err.name = cmd instanceof MockDescribeDBClustersCommand ? 'DBClusterNotFound' : 'DBInstanceNotFound';
            return Promise.reject(err);
        }),
    };
}

function mockSecretsClient(secretString) {
    return {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockGetSecretValueCommand) {
                return Promise.resolve({ SecretString: secretString });
            }
            return Promise.resolve({});
        }),
    };
}

function mockEcsClient({ taskArns = [], tasks = [] } = {}) {
    return {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockListTasksCommand) return Promise.resolve({ taskArns });
            if (cmd instanceof MockDescribeTasksCommand) return Promise.resolve({ tasks });
            return Promise.resolve({});
        }),
    };
}

function healthyDbInstance(overrides = {}) {
    return {
        DBInstanceIdentifier: 'myapp-db',
        Endpoint: { Address: 'myapp-db.abc123.us-east-2.rds.amazonaws.com' },
        DBName: 'myapp',
        MasterUserSecret: { SecretArn: SECRET_ARN },
        ...overrides,
    };
}

function healthyDbCluster(overrides = {}) {
    return {
        DBClusterIdentifier: 'myapp-db-cluster',
        Engine: 'aurora-postgresql',
        Status: 'available',
        Endpoint: 'myapp-db-cluster.xyz789.us-east-2.rds.amazonaws.com',
        Port: 5432,
        DatabaseName: 'myapp',
        MasterUserSecret: { SecretArn: SECRET_ARN },
        ...overrides,
    };
}

function mockRdsClusterClient(cluster) {
    return {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockDescribeDBInstancesCommand) {
                const err = new Error('DB instance not found');
                err.name = 'DBInstanceNotFound';
                return Promise.reject(err);
            }
            if (cmd instanceof MockDescribeDBClustersCommand) {
                return Promise.resolve({ DBClusters: cluster ? [cluster] : [] });
            }
            return Promise.resolve({});
        }),
    };
}

function healthyTask(overrides = {}) {
    return {
        taskArn: TASK_ARN,
        containers: [{ name: 'myapp-container', lastStatus: 'RUNNING', runtimeId: 'runtime-1' }],
        ...overrides,
    };
}

function mockSpawnImpl(calls, exitCode = 0) {
    return vi.fn((cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('close', exitCode));
        return child;
    });
}

function baseOptions(overrides = {}) {
    return {
        projectName: 'myapp',
        region: 'us-east-2',
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-')),
        hasAwsCli: true,
        hasSsmPlugin: true,
        spawnImpl: mockSpawnImpl([], 0),
        ...overrides,
    };
}

describe('db: CLI args', () => {
    it('parses port, flags, and overrides after db connect', () => {
        expect(parseDbArgs(['db', 'connect', '--port', '5433', '--show-credentials', '--workspace', 'pr-7', '--region', 'eu-west-1', '--cluster', 'c', '--service', 's'])).toEqual({
            port: '5433',
            showCredentials: true,
            workspace: 'pr-7',
            region: 'eu-west-1',
            cluster: 'c',
            service: 's',
        });
    });

    it('supports = syntax and defaults to empty options', () => {
        expect(parseDbArgs(['db', 'connect', '--port=5544', '--region=us-west-2'])).toEqual({
            port: '5544',
            region: 'us-west-2',
        });
        expect(parseDbArgs(['db', 'connect'])).toEqual({});
        expect(parseDbArgs([])).toEqual({});
    });

    it('validates ports as purely numeric in range', () => {
        expect(isValidPort('5432')).toBe(true);
        expect(isValidPort('1')).toBe(true);
        expect(isValidPort('65535')).toBe(true);
        expect(isValidPort('abc')).toBe(false);
        expect(isValidPort('54a2')).toBe(false);
        expect(isValidPort('')).toBe(false);
        expect(isValidPort('0')).toBe(false);
        expect(isValidPort('65536')).toBe(false);
        expect(isValidPort('-1')).toBe(false);
        expect(isValidPort(undefined)).toBe(false);
        expect(DEFAULT_LOCAL_PORT).toBe('5432');
    });

    it.each([null, 42, true, { port: 'string' }])('parseDbArgs(%s) returns defaults', (bad) => {
        expect(parseDbArgs(bad)).toEqual({});
    });
});

describe('db: workspace resolution', () => {
    it('returns no suffix without a workspace', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-ws-'));
        expect(resolveWorkspaceSuffix({ projectName: 'myapp', cwd: dir }, dir)).toBe('');
        expect(resolveDbIdentifier({ projectName: 'myapp', cwd: dir }, dir)).toBe('myapp-db');
    });

    it('appends an explicit --workspace flag', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-ws-'));
        expect(resolveWorkspaceSuffix({ workspace: 'pr-123' }, dir)).toBe('-pr-123');
        expect(resolveDbIdentifier({ projectName: 'myapp', workspace: 'pr-123', cwd: dir }, dir)).toBe('myapp-pr-123-db');
    });

    it('detects the workspace from .terraform/environment', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-ws-'));
        fs.mkdirSync(path.join(dir, '.terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.terraform', 'environment'), 'pr-42\n');
        expect(resolveWorkspaceSuffix({}, dir)).toBe('-pr-42');
        expect(resolveDbIdentifier({ projectName: 'myapp' }, dir)).toBe('myapp-pr-42-db');
    });

    it('treats the default workspace as no suffix', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-ws-'));
        fs.mkdirSync(path.join(dir, '.terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.terraform', 'environment'), 'default');
        expect(resolveWorkspaceSuffix({}, dir)).toBe('');
    });
});

describe('db: output formatting', () => {
    const details = { localPort: '5432', dbName: 'myapp', username: 'dbadmin', password: DB_PASSWORD };

    it('masks the password unless --show-credentials is passed', () => {
        const masked = formatConnectionInfo({ ...details, showCredentials: false });
        expect(masked).toContain(MASKED_PASSWORD);
        expect(masked).not.toContain(DB_PASSWORD);
        expect(masked).toContain(`postgresql://dbadmin:${MASKED_PASSWORD}@localhost:5432/myapp`);

        const shown = formatConnectionInfo({ ...details, showCredentials: true });
        expect(shown).toContain(DB_PASSWORD);
        expect(shown).toContain(`postgresql://dbadmin:${DB_PASSWORD}@localhost:5432/myapp`);
    });

    it('builds masked connection strings by default', () => {
        expect(buildConnectionString(details)).toBe(`postgresql://dbadmin:${MASKED_PASSWORD}@localhost:5432/myapp`);
        expect(buildConnectionString({ ...details, showCredentials: true })).toContain(DB_PASSWORD);
    });

    it('supports the mysql scheme and remote SSM ports', () => {
        expect(buildConnectionString({ ...details, scheme: 'mysql' }))
            .toBe(`mysql://dbadmin:${MASKED_PASSWORD}@localhost:5432/myapp`);
        expect(formatConnectionInfo({ ...details, scheme: 'mysql' })).toContain('mysql://dbadmin:');
        const args = buildSsmArgs({
            cluster: 'c', taskId: 't', runtimeId: 'r', dbHost: 'h', remotePort: '3306', localPort: '3306', region: 'us-east-2',
        });
        expect(args.join(' ')).toContain('"portNumber":["3306"]');
        expect(args.join(' ')).toContain('"localPortNumber":["3306"]');
    });

    it('percent-encodes credentials in the URI but not the standalone password line', () => {
        const tricky = {
            localPort: '5432',
            dbName: 'myapp',
            username: 'db@admin',
            password: 'p@ss[w]/ord:!',
        };
        const encodedUser = encodeURIComponent('db@admin');
        const encodedPass = encodeURIComponent('p@ss[w]/ord:!');
        expect(encodedPass).toBe('p%40ss%5Bw%5D%2Ford%3A!');

        expect(buildConnectionString({ ...tricky, showCredentials: true }))
            .toBe(`postgresql://${encodedUser}:${encodedPass}@localhost:5432/myapp`);

        const shown = formatConnectionInfo({ ...tricky, showCredentials: true });
        // URI line carries the encoded form so parsers don't break...
        expect(shown).toContain(`postgresql://${encodedUser}:${encodedPass}@localhost:5432/myapp`);
        // ...while the standalone Password line stays verbatim for copy-paste.
        expect(shown).toContain('p@ss[w]/ord:!');
    });

    it('builds the SSM target from cluster, task id, and runtime id', () => {
        expect(buildSsmArgs({
            cluster: 'myapp-cluster',
            taskId: 'abc123',
            runtimeId: 'runtime-1',
            dbHost: 'db.host',
            localPort: '5433',
            region: 'us-east-2',
        })).toEqual([
            'ssm', 'start-session',
            '--target', 'ecs:myapp-cluster_abc123_runtime-1',
            '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
            '--parameters', '{"host":["db.host"],"portNumber":["5432"],"localPortNumber":["5433"]}',
            '--region', 'us-east-2',
        ]);
    });

    it('picks the expected container, then first RUNNING, then first', () => {
        const task = {
            containers: [
                { name: 'redis', lastStatus: 'RUNNING', runtimeId: 'rt-redis' },
                { name: 'myapp-container', lastStatus: 'RUNNING', runtimeId: 'rt-app' },
            ],
        };
        expect(pickRuntimeContainer(task, 'myapp-container').runtimeId).toBe('rt-app');
        expect(pickRuntimeContainer(task, 'missing').runtimeId).toBe('rt-redis');
        expect(pickRuntimeContainer({ containers: [{ name: 'only' }] }, 'missing').name).toBe('only');
        expect(pickRuntimeContainer({ containers: [] }, 'missing')).toBeNull();
        expect(pickRuntimeContainer({}, 'missing')).toBeNull();
    });
});

describe('Command: db connect (mocked AWS + spawn)', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
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

    function telemetryPayloads() {
        return mockTrackEvent.mock.calls.map(([, props]) => props || {});
    }

    function assertNoCredentialLeak() {
        const serialized = JSON.stringify(mockTrackEvent.mock.calls);
        expect(serialized).not.toContain(DB_PASSWORD);
        expect(serialized).not.toContain('postgresql://');
        for (const props of telemetryPayloads()) {
            expect(props).not.toHaveProperty('password');
            expect(props).not.toHaveProperty('connectionString');
            expect(props).not.toHaveProperty('secret');
        }
    }

    function healthyClients() {
        return {
            rdsClient: mockRdsClient(healthyDbInstance()),
            secretsClient: mockSecretsClient(JSON.stringify({ username: DB_USERNAME, password: DB_PASSWORD })),
            ecsClient: mockEcsClient({ taskArns: [TASK_ARN], tasks: [healthyTask()] }),
        };
    }

    it('opens the tunnel and prints masked credentials by default', async () => {
        const calls = [];
        const result = await runDbConnect({ ...baseOptions(), ...healthyClients(), spawnImpl: mockSpawnImpl(calls, 0) });

        expect(result.ok).toBe(true);
        expect(result.dbIdentifier).toBe('myapp-db');
        expect(result.localPort).toBe('5432');
        expect(result).not.toHaveProperty('password');
        expect(exitSpy).not.toHaveBeenCalled();

        expect(calls).toHaveLength(1);
        const { cmd, args, opts } = calls[0];
        expect(cmd).toBe('aws');
        expect(args).toEqual([
            'ssm', 'start-session',
            '--target', 'ecs:myapp-cluster_abc123def456_runtime-1',
            '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
            '--parameters', '{"host":["myapp-db.abc123.us-east-2.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5432"]}',
            '--region', 'us-east-2',
        ]);
        expect(opts).toEqual(expect.objectContaining({ stdio: 'inherit' }));

        const text = output.join('\n');
        expect(text).toContain(MASKED_PASSWORD);
        expect(text).not.toContain(DB_PASSWORD);

        expect(mockTrackEvent).toHaveBeenCalledWith('db_connect_run', expect.objectContaining({ success: true }));
        assertNoCredentialLeak();
    });

    it('reveals credentials and uses a custom local port when requested', async () => {
        const calls = [];
        const result = await runDbConnect({
            ...baseOptions({ port: '5544', showCredentials: true }),
            ...healthyClients(),
            spawnImpl: mockSpawnImpl(calls, 0),
        });

        expect(result.ok).toBe(true);
        expect(result.localPort).toBe('5544');
        const text = output.join('\n');
        expect(text).toContain(DB_PASSWORD);
        expect(text).toContain('localhost:5544');
        // Terminal output intentionally shows credentials here, but telemetry must not.
        assertNoCredentialLeak();
    });

    it('targets PR-preview resources with --workspace', async () => {
        const calls = [];
        const rdsClient = mockRdsClient(healthyDbInstance({ DBInstanceIdentifier: 'myapp-pr-9-db' }));
        const result = await runDbConnect({
            ...baseOptions({ workspace: 'pr-9' }),
            rdsClient,
            secretsClient: mockSecretsClient(JSON.stringify({ username: DB_USERNAME, password: DB_PASSWORD })),
            ecsClient: mockEcsClient({ taskArns: [TASK_ARN], tasks: [healthyTask()] }),
            spawnImpl: mockSpawnImpl(calls, 0),
        });

        expect(result.ok).toBe(true);
        expect(result.dbIdentifier).toBe('myapp-pr-9-db');
        const describeInput = rdsClient.send.mock.calls[0][0];
        expect(describeInput.DBInstanceIdentifier).toBe('myapp-pr-9-db');
        expect(calls[0].args.join(' ')).toContain('ecs:myapp-pr-9-cluster_');
    });

    it('exits gracefully when no database is provisioned', async () => {
        const spawnImpl = mockSpawnImpl([], 0);
        const result = await runDbConnect({
            ...baseOptions(),
            rdsClient: mockRdsNotFoundClient(),
            secretsClient: mockSecretsClient('{}'),
            ecsClient: mockEcsClient(),
            spawnImpl,
        });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('no-database');
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(output.join('\n')).toMatch(/No database found|no database is provisioned/i);
        const spin = mockSpinner.mock.results[mockSpinner.mock.results.length - 1].value;
        expect(spin.stop).toHaveBeenCalledWith();
        expect(output.join('\n').split('No database found').length - 1).toBe(1);
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_connect_run', expect.objectContaining({ success: false, error_code: 'NO_DATABASE' }));
        assertNoCredentialLeak();
    });

    it('exits gracefully when no tasks are running', async () => {
        const spawnImpl = mockSpawnImpl([], 0);
        const result = await runDbConnect({
            ...baseOptions(),
            ...healthyClients(),
            ecsClient: mockEcsClient({ taskArns: [], tasks: [] }),
            spawnImpl,
        });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('no-running-tasks');
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(output.join('\n')).toMatch(/No running containers|jump host/i);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects a non-numeric --port before any AWS call', async () => {
        const clients = healthyClients();
        const spawnImpl = mockSpawnImpl([], 0);
        const result = await runDbConnect({ ...baseOptions({ port: 'abc' }), ...clients, spawnImpl });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('invalid-port');
        expect(clients.rdsClient.send).not.toHaveBeenCalled();
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_connect_run', expect.objectContaining({ success: false, error_code: 'INVALID_PORT' }));
    });

    it('fails fast with install guidance when AWS CLI is missing', async () => {
        const clients = healthyClients();
        const spawnImpl = mockSpawnImpl([], 0);
        const result = await runDbConnect({ ...baseOptions({ hasAwsCli: false }), ...clients, spawnImpl });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('aws-cli-missing');
        expect(clients.rdsClient.send).not.toHaveBeenCalled();
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(output.join('\n')).toMatch(/AWS CLI not found/);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('fails fast when the Session Manager plugin is missing', async () => {
        const clients = healthyClients();
        const spawnImpl = mockSpawnImpl([], 0);
        const result = await runDbConnect({ ...baseOptions({ hasSsmPlugin: false }), ...clients, spawnImpl });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('ssm-plugin-missing');
        expect(clients.rdsClient.send).not.toHaveBeenCalled();
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(output.join('\n')).toMatch(/Session Manager plugin not found/);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits gracefully when the managed secret is malformed', async () => {
        const spawnImpl = mockSpawnImpl([], 0);
        const result = await runDbConnect({
            ...baseOptions(),
            rdsClient: mockRdsClient(healthyDbInstance()),
            secretsClient: mockSecretsClient('not-json{{{'),
            ecsClient: mockEcsClient({ taskArns: [TASK_ARN], tasks: [healthyTask()] }),
            spawnImpl,
        });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('secret-malformed');
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_connect_run', expect.objectContaining({ success: false, error_code: 'SECRET_MALFORMED' }));
        assertNoCredentialLeak();
    });

    it('tunnels to MySQL on 3306 with a mysql:// connection string', async () => {
        const calls = [];
        const result = await runDbConnect({
            ...baseOptions(),
            rdsClient: mockRdsClient(healthyDbInstance({
                Engine: 'mysql',
                Endpoint: { Address: 'myapp-db.abc123.us-east-2.rds.amazonaws.com', Port: 3306 },
            })),
            secretsClient: mockSecretsClient(JSON.stringify({ username: DB_USERNAME, password: DB_PASSWORD })),
            ecsClient: mockEcsClient({ taskArns: [TASK_ARN], tasks: [healthyTask()] }),
            spawnImpl: mockSpawnImpl(calls, 0),
        });

        expect(result.ok).toBe(true);
        expect(result.localPort).toBe('3306');
        expect(calls[0].args.join(' ')).toContain('"portNumber":["3306"]');
        expect(calls[0].args.join(' ')).toContain('"localPortNumber":["3306"]');
        expect(output.join('\n')).toContain('mysql://dbadmin:********@localhost:3306/myapp');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_connect_run', expect.objectContaining({ success: true, db_engine: 'mysql' }));
        assertNoCredentialLeak();
    });

    it('keeps an explicit --port while forwarding to the remote MySQL port', async () => {
        const calls = [];
        const result = await runDbConnect({
            ...baseOptions({ port: '5433' }),
            rdsClient: mockRdsClient(healthyDbInstance({
                Engine: 'mysql',
                Endpoint: { Address: 'myapp-db.abc123.us-east-2.rds.amazonaws.com', Port: 3306 },
            })),
            secretsClient: mockSecretsClient(JSON.stringify({ username: DB_USERNAME, password: DB_PASSWORD })),
            ecsClient: mockEcsClient({ taskArns: [TASK_ARN], tasks: [healthyTask()] }),
            spawnImpl: mockSpawnImpl(calls, 0),
        });

        expect(result.ok).toBe(true);
        expect(result.localPort).toBe('5433');
        expect(calls[0].args.join(' ')).toContain('"portNumber":["3306"]');
        expect(calls[0].args.join(' ')).toContain('"localPortNumber":["5433"]');
        assertNoCredentialLeak();
    });

    it('discovers an Aurora cluster via the -db-cluster identifier', async () => {
        const calls = [];
        const result = await runDbConnect({
            ...baseOptions(),
            rdsClient: mockRdsClusterClient(healthyDbCluster()),
            secretsClient: mockSecretsClient(JSON.stringify({ username: DB_USERNAME, password: DB_PASSWORD })),
            ecsClient: mockEcsClient({ taskArns: [TASK_ARN], tasks: [healthyTask()] }),
            spawnImpl: mockSpawnImpl(calls, 0),
        });

        expect(result.ok).toBe(true);
        expect(result.localPort).toBe('5432');
        expect(calls[0].args.join(' ')).toContain('myapp-db-cluster.xyz789.us-east-2.rds.amazonaws.com');
        expect(output.join('\n')).toContain('postgresql://dbadmin:********@localhost:5432/myapp');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_connect_run', expect.objectContaining({ success: true, db_engine: 'aurora-postgresql', db_kind: 'cluster' }));
        assertNoCredentialLeak();
    });
});

describe('db: dispatcher', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
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

    it('reports unknown subcommands with usage and telemetry', async () => {
        const result = await runDb(['db', 'frobnicate']);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('unknown-db-subcommand');
        expect(exitSpy).toHaveBeenCalledWith(1);
        const text = stripVTControlCharacters(output.join('\n'));
        expect(text).toContain('Unknown db subcommand "frobnicate"');
        expect(text).toContain('db connect');
        expect(text).toContain('db migrate');
        expect(text).toContain('db backup');
        expect(text).toContain('db restore');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_run', expect.objectContaining({
            success: false,
            error_code: 'UNKNOWN_DB_SUBCOMMAND',
        }));
    });

    it('reports a missing subcommand', async () => {
        const result = await runDb(['db']);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('unknown-db-subcommand');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('Missing db subcommand');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('routes to each subcommand', async () => {
        // Each proof fails before any AWS call, so no clients are needed.
        const migrate = await runDb(['db', 'migrate', 'oops-unquoted', '--cmd', 'x']);
        expect(migrate.reason).toBe('unexpected-positional-args');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({ success: false }));

        const backup = await runDb(['db', 'backup', 'oops']);
        expect(backup.reason).toBe('unexpected-positional-args');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_backup_run', expect.objectContaining({ success: false }));

        // The repo root has no terraform/database.tf, so restore fails fast
        // on the missing file before any AWS call.
        const restore = await runDb(['db', 'restore', '--project-name', 'myapp']);
        expect(restore.reason).toBe('database-tf-not-found');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_restore_run', expect.objectContaining({ success: false }));

        // enable-vector fails fast on the missing file before any AWS call.
        const vector = await runDb(['db', 'enable-vector', '--project-name', 'myapp']);
        expect(vector.reason).toBe('no-database-configured');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_enable_vector_run', expect.objectContaining({ success: false }));

        // import fails fast on the missing source before any AWS call.
        const imported = await runDb(['db', 'import', '--project-name', 'myapp']);
        expect(imported.reason).toBe('invalid-import-source');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_import_run', expect.objectContaining({ success: false }));
    });

    it('keeps routing connect without headless interference', async () => {
        const result = await runDb(['db', 'connect', '--port', 'abc']);
        expect(result.reason).toBe('invalid-port');
    });

    it.each([null, 42, true, { port: 'string' }])('runDb(%s) reports a missing subcommand', async (bad) => {
        const result = await runDb(bad, null);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('unknown-db-subcommand');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});

describe('db: migrate/backup/restore parsers', () => {
    it('parses migrate flags, = syntax, and boolean shorthands', () => {
        expect(parseDbMigrateArgs([
            'db', 'migrate', '--cmd', 'npx prisma migrate deploy', '--task-def', 'fam:3',
            '--timeout', '120', '--setup-ci', '--project-name', 'p', '--region', 'r',
            '--workspace', 'w', '--cluster', 'c', '--service', 's', '--container', 'ct',
        ])).toEqual({
            cmd: 'npx prisma migrate deploy',
            taskDef: 'fam:3',
            timeout: '120',
            setupCi: true,
            projectName: 'p',
            region: 'r',
            workspace: 'w',
            cluster: 'c',
            service: 's',
            container: 'ct',
        });
        expect(parseDbMigrateArgs(['migrate', '--cmd=x y', '--timeout=30'])).toEqual({
            cmd: 'x y',
            timeout: '30',
        });
        expect(parseDbMigrateArgs(['db', 'migrate'])).toEqual({});
    });

    it('captures unexpected migrate positionals for the quoting guard', () => {
        expect(parseDbMigrateArgs(['db', 'migrate', '--cmd', 'prisma', 'migrate', 'deploy']).unexpectedPositionals)
            .toEqual(['migrate', 'deploy']);
    });

    it('parses backup flags', () => {
        expect(parseDbBackupArgs(['db', 'backup', '--id', 'snap-1', '--no-wait', '--timeout', '60', '--db-identifier', 'dbx'])).toEqual({
            snapshotId: 'snap-1',
            noWait: true,
            timeout: '60',
            dbIdentifier: 'dbx',
        });
        expect(parseDbBackupArgs(['db', 'backup', '--id=snap-2'])).toEqual({ snapshotId: 'snap-2' });
        expect(parseDbBackupArgs(['db', 'backup', 'oops']).unexpectedPositionals).toEqual(['oops']);
    });

    it('parses restore flags and the positional snapshot id', () => {
        expect(parseDbRestoreArgs(['db', 'restore', 'snap-9', '--yes', '--db-identifier', 'dbx'])).toEqual({
            snapshotId: 'snap-9',
            yes: true,
            dbIdentifier: 'dbx',
        });
        expect(parseDbRestoreArgs(['db', 'restore'])).toEqual({});
        expect(parseDbRestoreArgs(['restore', 'a', 'b']).unexpectedPositionals).toEqual(['b']);
    });

    it.each([null, 42, true, { port: 'string' }])('migrate/backup/restore parsers return defaults for %s', (bad) => {
        expect(parseDbMigrateArgs(bad)).toEqual({});
        expect(parseDbBackupArgs(bad)).toEqual({});
        expect(parseDbRestoreArgs(bad)).toEqual({});
        expect(parseDbEnableVectorArgs(bad)).toEqual({});
    });
});

const MIGRATE_TASK_ARN = 'arn:aws:ecs:us-east-2:123456789012:task/myapp-cluster/migrate123';

function activeServiceDesc(overrides = {}) {
    return {
        serviceName: 'myapp-service',
        status: 'ACTIVE',
        taskDefinition: 'arn:aws:ecs:us-east-2:123456789012:task-definition/myapp-task:7',
        networkConfiguration: {
            awsvpcConfiguration: { subnets: ['sub-1', 'sub-2'], securityGroups: ['sg-1'], assignPublicIp: 'ENABLED' },
        },
        ...overrides,
    };
}

function runningTask() {
    return { taskArn: MIGRATE_TASK_ARN, lastStatus: 'RUNNING', containers: [{ name: 'myapp-container' }] };
}

function stoppedTask(exitCode, reason = 'Essential container exited') {
    const container = exitCode === undefined
        ? { name: 'myapp-container', reason }
        : { name: 'myapp-container', exitCode, reason };
    return { taskArn: MIGRATE_TASK_ARN, lastStatus: 'STOPPED', stoppedReason: 'task-level', containers: [container] };
}

function mockEcsMigrateClient({
    service = activeServiceDesc(),
    taskDefNames = ['myapp-container'],
    containerDefinitions = null,
    runTasks = [{ taskArn: MIGRATE_TASK_ARN }],
    failures = [],
    taskSequence = [],
} = {}) {
    const queue = [...taskSequence];
    const runs = [];
    const stops = [];
    const client = {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockDescribeServicesCommand) {
                return Promise.resolve({ services: service ? [service] : [] });
            }
            if (cmd instanceof MockDescribeTaskDefinitionCommand) {
                const defs = containerDefinitions || taskDefNames.map((name) => ({ name }));
                return Promise.resolve({ taskDefinition: { containerDefinitions: defs } });
            }
            if (cmd instanceof MockRunTaskCommand) {
                runs.push(cmd);
                return Promise.resolve({ tasks: runTasks, failures });
            }
            if (cmd instanceof MockDescribeTasksCommand) {
                const next = queue.length > 0 ? queue.shift() : runningTask();
                return Promise.resolve({ tasks: [next] });
            }
            if (cmd instanceof MockStopTaskCommand) {
                stops.push(cmd);
                return Promise.resolve({});
            }
            return Promise.resolve({});
        }),
        runs,
        stops,
    };
    return client;
}

function mockLogsClient(script = [], flushScript = []) {
    const queue = [...script];
    const flushQueue = [...flushScript];
    const calls = [];
    const flushCalls = [];
    const client = {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockGetLogEventsCommand) {
                flushCalls.push(cmd);
                const next = flushQueue.length > 0 ? flushQueue.shift() : { events: [] };
                if (next.error) return Promise.reject(next.error);
                return Promise.resolve({ events: next.events || [], nextForwardToken: next.nextForwardToken });
            }
            calls.push(cmd);
            const next = queue.length > 0 ? queue.shift() : { events: [] };
            if (next.error) return Promise.reject(next.error);
            return Promise.resolve({ events: next.events || [] });
        }),
        calls,
        flushCalls,
    };
    return client;
}

function migrateOptions(overrides = {}) {
    return {
        ...baseOptions(),
        projectName: 'myapp',
        region: 'us-east-2',
        cmd: 'npx prisma migrate deploy',
        pollIntervalMs: 5,
        flushIntervalMs: 0,
        ...overrides,
    };
}

describe('Command: db migrate (mocked AWS)', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
        mockText.mockReset();
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

    function assertNoCmdLeak(cmd) {
        const serialized = JSON.stringify(mockTrackEvent.mock.calls);
        expect(serialized).not.toContain(cmd);
    }

    it('fails fast on invalid --timeout before AWS calls', async () => {
        const ecsClient = mockEcsMigrateClient();
        const result = await runDbMigrate(migrateOptions({ timeout: 'soon', ecsClient, logsClient: mockLogsClient() }));
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('invalid-timeout');
        expect(ecsClient.send).not.toHaveBeenCalled();
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({
            success: false, error_code: 'INVALID_TIMEOUT',
        }));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('fails fast on unexpected positional args with a quoting hint', async () => {
        const ecsClient = mockEcsMigrateClient();
        const result = await runDbMigrate(migrateOptions({
            ecsClient,
            logsClient: mockLogsClient(),
            unexpectedPositionals: ['migrate', 'deploy'],
        }));
        expect(result.reason).toBe('unexpected-positional-args');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('Wrap multi-word --cmd values in quotes');
        expect(ecsClient.send).not.toHaveBeenCalled();
    });

    it('fails headless without --cmd when nothing is detected', async () => {
        const ecsClient = mockEcsMigrateClient();
        const { cmd: _cmd, ...noCmd } = migrateOptions({ ecsClient, logsClient: mockLogsClient() });
        const result = await runDbMigrate(noCmd);
        expect(result.reason).toBe('missing-migration-cmd');
        expect(ecsClient.send).not.toHaveBeenCalled();
        expect(mockText).not.toHaveBeenCalled();
    });

    it('uses the detected command in headless mode', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-migrate-detect-'));
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { migrate: 'knex migrate' } }));
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        const { cmd: _cmd, ...noCmd } = migrateOptions({ cwd: dir, ecsClient, logsClient: mockLogsClient() });
        const result = await runDbMigrate(noCmd);
        expect(result.success).toBe(true);
        expect(ecsClient.runs[0].overrides.containerOverrides[0].command).toEqual(['sh', '-c', 'npm run migrate']);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({
            success: true, cmd_source: 'detected', ci_setup: false,
        }));
        assertNoCmdLeak('npm run migrate');
    });

    it('prompts interactively and honors cancellation', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-migrate-prompt-'));
        fs.writeFileSync(path.join(dir, 'alembic.ini'), '[alembic]');
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        mockText.mockResolvedValueOnce('alembic upgrade head --verbose');
        const { cmd: _cmd, ...noCmd } = migrateOptions({
            cwd: dir, isHeadless: false, ecsClient, logsClient: mockLogsClient(),
        });
        const result = await runDbMigrate(noCmd);
        expect(result.success).toBe(true);
        expect(mockText).toHaveBeenCalledWith(expect.objectContaining({ initialValue: 'alembic upgrade head' }));
        expect(ecsClient.runs[0].overrides.containerOverrides[0].command[2]).toBe('alembic upgrade head --verbose');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({ cmd_source: 'prompted' }));
        assertNoCmdLeak('alembic upgrade head --verbose');

        mockText.mockResolvedValueOnce(Symbol('clack-cancel'));
        const ecsClient2 = mockEcsMigrateClient();
        const { cmd: _c2, ...noCmd2 } = migrateOptions({
            cwd: dir, isHeadless: false, ecsClient: ecsClient2, logsClient: mockLogsClient(),
        });
        const cancelled = await runDbMigrate(noCmd2);
        expect(cancelled).toEqual(expect.objectContaining({ ok: false, reason: 'cancelled' }));
        expect(ecsClient2.send).not.toHaveBeenCalled();
    });

    it('fails when the service is missing or inactive', async () => {
        const ecsClient = mockEcsMigrateClient({ service: null });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.reason).toBe('ecs-service-not-found');
        expect(ecsClient.runs).toHaveLength(0);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({
            success: false, error_code: 'ECS_SERVICE_NOT_FOUND', cmd_source: 'explicit',
        }));
    });

    it('fails before RunTask when the container is missing from the task definition', async () => {
        const ecsClient = mockEcsMigrateClient({ taskDefNames: ['sidecar'] });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.reason).toBe('container-not-found');
        expect(ecsClient.runs).toHaveLength(0);
        expect(stripVTControlCharacters(output.join('\n'))).toContain('--container');
    });

    it('fails when RunTask reports failures', async () => {
        const ecsClient = mockEcsMigrateClient({ runTasks: [], failures: [{ reason: 'RESOURCE:ENI' }] });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.reason).toBe('run-task-failed');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('RESOURCE:ENI');
    });

    it('uses an explicit --task-def revision for validation and RunTask', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        const result = await runDbMigrate(migrateOptions({
            taskDef: 'myapp-task:9', ecsClient, logsClient: mockLogsClient(),
        }));
        expect(result.success).toBe(true);
        const describeInput = ecsClient.send.mock.calls.find(([c]) => c instanceof MockDescribeTaskDefinitionCommand)[0];
        expect(describeInput.taskDefinition).toBe('myapp-task:9');
        expect(ecsClient.runs[0].taskDefinition).toBe('myapp-task:9');
    });

    it('streams deduplicated logs and returns exit 0 on success', async () => {
        const sigintBefore = process.listenerCount('SIGINT');
        const ecsClient = mockEcsMigrateClient({ taskSequence: [runningTask(), stoppedTask(0)] });
        const logsClient = mockLogsClient([
            { events: [{ eventId: '1', message: 'applying migration 001' }] },
            { events: [{ eventId: '1', message: 'applying migration 001' }, { eventId: '2', message: 'done' }] },
            { events: [] },
        ]);
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient }));
        expect(result).toEqual(expect.objectContaining({ ok: true, success: true, exitCode: 0, taskArn: MIGRATE_TASK_ARN }));

        const fetchInput = logsClient.calls[0];
        expect(fetchInput.logGroupName).toBe('/ecs/myapp');
        expect(fetchInput.logStreamNames).toEqual(['ecs/myapp-container/migrate123']);

        const text = output.join('\n');
        expect(text.match(/applying migration 001/g)).toHaveLength(1);
        expect(text).toContain('done');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({
            success: true, cmd_source: 'explicit', ci_setup: false,
        }));
        assertNoCmdLeak('npx prisma migrate deploy');
        expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    });

    it('ignores ResourceNotFoundException while the stream initializes', async () => {
        const notFound = new Error('stream missing');
        notFound.name = 'ResourceNotFoundException';
        const ecsClient = mockEcsMigrateClient({ taskSequence: [runningTask(), stoppedTask(0)] });
        const logsClient = mockLogsClient([
            { error: notFound },
            { events: [{ eventId: '7', message: 'late log line' }] },
            { events: [] },
        ]);
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient }));
        expect(result.success).toBe(true);
        expect(output.join('\n')).toContain('late log line');
    });

    it('propagates non-zero exit codes via failCommand', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(3, 'migration boom')] });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'migration-task-failed' }));
        expect(exitSpy).toHaveBeenCalledWith(3);
        expect(stripVTControlCharacters(output.join('\n'))).toContain('migration boom');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({
            success: false, error_code: 'MIGRATION_TASK_FAILED', exit_code: 3,
        }));
    });

    it('exits 1 with exit_code -1 when no exit code is reported', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(undefined, 'CannotPullContainerError')] });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.reason).toBe('migration-task-failed');
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({ exit_code: -1 }));
    });

    it('stops the task and fails on timeout', async () => {
        const ecsClient = mockEcsMigrateClient({});
        const result = await runDbMigrate(migrateOptions({
            ecsClient, logsClient: mockLogsClient(), timeoutMs: 30,
        }));
        expect(result.reason).toBe('migration-timeout');
        expect(ecsClient.stops).toHaveLength(1);
        expect(ecsClient.stops[0].task).toBe(MIGRATE_TASK_ARN);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({
            success: false, error_code: 'MIGRATION_TIMEOUT',
        }));
    });

    it('stops the task on SIGINT', async () => {
        const ecsClient = mockEcsMigrateClient({});
        const promise = runDbMigrate(migrateOptions({
            ecsClient, logsClient: mockLogsClient(), timeoutMs: 500,
        }));
        await new Promise((resolve) => setTimeout(resolve, 25));
        process.emit('SIGINT');
        await promise;
        expect(ecsClient.stops.length).toBeGreaterThanOrEqual(1);
        expect(ecsClient.stops[0].reason).toContain('SIGINT');
        expect(exitSpy).toHaveBeenCalledWith(130);
    });
});

const WORKFLOW_FIXTURE = `name: Deploy
jobs:
  deploy:
    steps:
      - name: Register new task definition revision
        id: register-task-def
        run: echo hi
      - name: Force ECS deployment
        run: echo deploy
`;

function writeWorkflow(dir, content = WORKFLOW_FIXTURE) {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), content);
    return path.join(dir, '.github', 'workflows', 'deploy.yml');
}

describe('Command: db migrate live-tail fixes (mocked AWS)', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
        mockText.mockReset();
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

    function spinnerInstance() {
        return mockSpinner.mock.results[mockSpinner.mock.results.length - 1].value;
    }

    function describeTasksCalls(ecsClient) {
        return ecsClient.send.mock.calls.filter(([cmd]) => cmd instanceof MockDescribeTasksCommand);
    }

    it('updates the phase spinner through PROVISIONING/PENDING before streaming', async () => {
        const ecsClient = mockEcsMigrateClient({
            taskSequence: [
                { taskArn: MIGRATE_TASK_ARN, lastStatus: 'PROVISIONING', containers: [] },
                { taskArn: MIGRATE_TASK_ARN, lastStatus: 'PENDING', containers: [] },
                runningTask(),
                stoppedTask(0),
            ],
        });
        const logsClient = mockLogsClient();
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient }));
        expect(result.ok).toBe(true);
        const spin = spinnerInstance();
        const shortId = MIGRATE_TASK_ARN.split('/').pop().slice(0, 8);
        const messages = spin.message.mock.calls.map((call) => call[0]);
        expect(messages).toEqual([
            `Starting migration task (PROVISIONING, ${shortId})...`,
            `Starting migration task (PENDING, ${shortId})...`,
        ]);
        expect(spin.stop).toHaveBeenCalledWith(expect.stringContaining('Migration container running. Streaming logs...'));
        const text = stripVTControlCharacters(output.join('\n'));
        expect(text).toContain('press Ctrl+C to abort and stop the remote task.');
        expect(text).not.toContain('Ctrl+C cancels (the task is stopped)');
    });

    it('uses a generic spinner message for unexpected pre-RUNNING statuses', async () => {
        const ecsClient = mockEcsMigrateClient({
            taskSequence: [
                { taskArn: MIGRATE_TASK_ARN, lastStatus: 'DEPROVISIONING', containers: [] },
                runningTask(),
                stoppedTask(0),
            ],
        });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.ok).toBe(true);
        const messages = spinnerInstance().message.mock.calls.map((call) => call[0]);
        const shortId = MIGRATE_TASK_ARN.split('/').pop().slice(0, 8);
        expect(messages).toEqual([`Waiting on Fargate task (DEPROVISIONING, ${shortId})...`]);
    });

    it('exits early when the migration container stops and stops the task best-effort', async () => {
        const containerDone = {
            taskArn: MIGRATE_TASK_ARN,
            lastStatus: 'RUNNING',
            containers: [{ name: 'myapp-container', lastStatus: 'STOPPED', exitCode: 0 }],
        };
        const ecsClient = mockEcsMigrateClient({ taskSequence: [runningTask(), containerDone] });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.ok).toBe(true);
        // Never waited for task STOPPED: only the two scripted polls ran.
        expect(describeTasksCalls(ecsClient)).toHaveLength(2);
        expect(ecsClient.stops).toHaveLength(1);
        expect(String(ecsClient.stops[0].reason)).toContain('Migration container finished');
    });

    it('ignores a sidecar container finishing before the migration container', async () => {
        const sidecarFirst = {
            taskArn: MIGRATE_TASK_ARN,
            lastStatus: 'RUNNING',
            containers: [
                { name: 'otel-sidecar', lastStatus: 'STOPPED', exitCode: 5 },
                { name: 'myapp-container', lastStatus: 'RUNNING' },
            ],
        };
        const migrationDone = {
            taskArn: MIGRATE_TASK_ARN,
            lastStatus: 'RUNNING',
            containers: [
                { name: 'otel-sidecar', lastStatus: 'STOPPED', exitCode: 5 },
                { name: 'myapp-container', lastStatus: 'STOPPED', exitCode: 0 },
            ],
        };
        const ecsClient = mockEcsMigrateClient({ taskSequence: [sidecarFirst, migrationDone] });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.ok).toBe(true);
        expect(describeTasksCalls(ecsClient)).toHaveLength(2);
        expect(result.exitCode).toBe(0);
    });

    it('derives the log group and stream prefix from the task definition logConfiguration', async () => {
        const ecsClient = mockEcsMigrateClient({
            taskSequence: [stoppedTask(0)],
            containerDefinitions: [{
                name: 'myapp-container',
                logConfiguration: { options: { 'awslogs-group': '/custom/group', 'awslogs-stream-prefix': 'custom' } },
            }],
        });
        const logsClient = mockLogsClient();
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient }));
        expect(result.ok).toBe(true);
        expect(logsClient.calls.length).toBeGreaterThan(0);
        expect(logsClient.calls[0].logGroupName).toBe('/custom/group');
        expect(logsClient.calls[0].logStreamNames).toEqual(['custom/myapp-container/migrate123']);
        expect('startTime' in logsClient.calls[0]).toBe(false);
    });

    it('flushes missed lines from the stream head with GetLogEvents on completion', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [runningTask(), stoppedTask(0)] });
        const logsClient = mockLogsClient([], [
            { events: [{ eventId: 'f1', message: 'flushed line' }] },
        ]);
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient }));
        expect(result.ok).toBe(true);
        expect(logsClient.flushCalls).toHaveLength(1);
        expect(logsClient.flushCalls[0].logStreamName).toBe('ecs/myapp-container/migrate123');
        expect(logsClient.flushCalls[0].startFromHead).toBe(true);
        expect(stripVTControlCharacters(output.join('\n'))).toContain('flushed line');
        // Task already STOPPED: no best-effort StopTask.
        expect(ecsClient.stops).toHaveLength(0);
    });

    it('re-polls the flush while nothing has printed yet, up to the max polls', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        const logsClient = mockLogsClient();
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient, maxFlushPolls: 3 }));
        expect(result.ok).toBe(true);
        expect(logsClient.flushCalls).toHaveLength(3);
    });

    it('stops re-polling the flush as soon as lines print', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        const logsClient = mockLogsClient([], [
            { events: [] },
            { events: [{ eventId: 'late', message: 'late line' }] },
        ]);
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient, maxFlushPolls: 6 }));
        expect(result.ok).toBe(true);
        expect(logsClient.flushCalls).toHaveLength(2);
        expect(stripVTControlCharacters(output.join('\n'))).toContain('late line');
    });

    it('defaults the empty-flush retry loop to six polls', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        const logsClient = mockLogsClient();
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient }));
        expect(result.ok).toBe(true);
        expect(logsClient.flushCalls).toHaveLength(6);
    });

    it('prints a line returned by both FilterLogEvents and GetLogEvents only once', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [runningTask(), stoppedTask(0)] });
        const logsClient = mockLogsClient(
            [{ events: [{ eventId: 'e1', timestamp: 1727440000000, message: 'shared line' }] }],
            [{ events: [{ timestamp: 1727440000000, message: 'shared line' }] }],
        );
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient }));
        expect(result.ok).toBe(true);
        expect(logsClient.flushCalls).toHaveLength(1);
        const text = stripVTControlCharacters(output.join('\n'));
        expect(text.split('shared line').length - 1).toBe(1);
    });

    it('prints the task line only after the spinner stops (no line collision)', async () => {
        const ecsClient = mockEcsMigrateClient({
            taskSequence: [
                { taskArn: MIGRATE_TASK_ARN, lastStatus: 'PROVISIONING', containers: [] },
                runningTask(),
                stoppedTask(0),
            ],
        });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.ok).toBe(true);
        const spin = spinnerInstance();
        const streamStopOrder = spin.stop.mock.invocationCallOrder[0];
        const taskLineIndex = consoleSpy.mock.calls.findIndex((args) => String(args[0]).includes('press Ctrl+C'));
        expect(taskLineIndex).toBeGreaterThanOrEqual(0);
        expect(consoleSpy.mock.invocationCallOrder[taskLineIndex]).toBeGreaterThan(streamStopOrder);
        const shortId = MIGRATE_TASK_ARN.split('/').pop().slice(0, 8);
        expect(spin.message.mock.calls[0][0]).toBe(`Starting migration task (PROVISIONING, ${shortId})...`);
    });
});

describe('db migrate: --setup-ci and gate injection', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
        mockText.mockReset();
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

    it('installs the gate after task-def registration without AWS calls', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-ci-'));
        const workflowFile = writeWorkflow(dir);
        const throwing = { send: () => { throw new Error('must not call AWS'); } };
        const result = await runDbMigrate(migrateOptions({
            cwd: dir,
            setupCi: true,
            cmd: 'npx prisma migrate deploy',
            ecsClient: throwing,
            logsClient: throwing,
        }));
        expect(result).toEqual(expect.objectContaining({ ok: true, ciSetup: true, workflowFile }));
        const updated = fs.readFileSync(workflowFile, 'utf8');
        expect(updated).toContain('# grada:db-migrate-start');
        expect(updated).toContain('# grada:db-migrate-end');
        expect(updated).toContain('actions/setup-node@v4');
        expect(updated).toContain(`--cmd 'npx prisma migrate deploy'`);
        expect(updated).toContain('${{ steps.register-task-def.outputs.task-arn }}');
        expect(updated.indexOf('# grada:db-migrate-start')).toBeLessThan(updated.indexOf('- name: Force ECS deployment'));
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({
            success: true, cmd_source: 'explicit', ci_setup: true,
        }));
    });

    it('is idempotent and refreshes the command on re-runs', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-ci-'));
        const workflowFile = writeWorkflow(dir);
        const base = { cwd: dir, setupCi: true, ecsClient: mockEcsMigrateClient(), logsClient: mockLogsClient() };
        await runDbMigrate(migrateOptions({ ...base, cmd: 'first cmd' }));
        await runDbMigrate(migrateOptions({ ...base, cmd: 'second cmd' }));
        const updated = fs.readFileSync(workflowFile, 'utf8');
        expect(updated.match(/# grada:db-migrate-start/g)).toHaveLength(1);
        expect(updated).toContain(`--cmd 'second cmd'`);
        expect(updated).not.toContain('first cmd');
    });

    it('omits setup-node when the workflow already has it', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-ci-'));
        writeWorkflow(dir, `jobs:\n  deploy:\n    steps:\n      - uses: actions/setup-node@v4\n      - name: Force ECS deployment\n        run: echo deploy\n`);
        await runDbMigrate(migrateOptions({
            cwd: dir, setupCi: true, ecsClient: mockEcsMigrateClient(), logsClient: mockLogsClient(),
        }));
        const updated = fs.readFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'utf8');
        expect(updated.match(/actions\/setup-node/g)).toHaveLength(1);
    });

    it('fails when the workflow is missing or has no anchor step', async () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-ci-'));
        const missing = await runDbMigrate(migrateOptions({
            cwd: empty, setupCi: true, ecsClient: mockEcsMigrateClient(), logsClient: mockLogsClient(),
        }));
        expect(missing.reason).toBe('workflow-not-found');

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-ci-'));
        writeWorkflow(dir, 'name: Custom\njobs:\n  deploy:\n    steps:\n      - run: echo custom\n');
        const anchored = await runDbMigrate(migrateOptions({
            cwd: dir, setupCi: true, ecsClient: mockEcsMigrateClient(), logsClient: mockLogsClient(),
        }));
        expect(anchored.reason).toBe('workflow-anchor-not-found');
    });

    it('still requires a resolvable command for --setup-ci', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-ci-'));
        writeWorkflow(dir);
        const { cmd: _cmd, ...noCmd } = migrateOptions({
            cwd: dir, setupCi: true, ecsClient: mockEcsMigrateClient(), logsClient: mockLogsClient(),
        });
        const result = await runDbMigrate(noCmd);
        expect(result.reason).toBe('missing-migration-cmd');
    });
});

describe('db migrate: gate helpers', () => {
    it('injectMigrationGate places the block before the Force step', () => {
        const updated = injectMigrationGate(WORKFLOW_FIXTURE, { cmd: 'npm run migrate' });
        expect(updated).toContain(`--cmd 'npm run migrate'`);
        expect(updated).toContain('actions/setup-node@v4');
        expect(updated.indexOf('# grada:db-migrate-end')).toBeLessThan(updated.indexOf('- name: Force ECS deployment'));
    });

    it('injectMigrationGate returns null without an anchor', () => {
        expect(injectMigrationGate('steps: []', { cmd: 'x' })).toBeNull();
    });

    it('findGateBlock locates legacy gates and injection migrates them', () => {
        const legacy = WORKFLOW_FIXTURE.replace(
            '- name: Force ECS deployment',
            '      # deploy-stack:db-migrate-start\n      - name: Pre-Deploy Database Migration\n        run: echo old\n      # deploy-stack:db-migrate-end\n      - name: Force ECS deployment'
        );
        expect(findGateBlock(legacy)).not.toBeNull();
        expect(findGateBlock('steps: []')).toBeNull();
        const updated = injectMigrationGate(legacy, { cmd: 'npm run migrate' });
        expect(updated).not.toContain('deploy-stack:db-migrate-start');
        expect(updated).not.toContain('deploy-stack:db-migrate-end');
        expect(updated.match(/# grada:db-migrate-start/g)).toHaveLength(1);
        expect(updated).toContain(`--cmd 'npm run migrate'`);
    });

    it('quoteShellArg single-quotes and escapes embedded quotes', () => {
        expect(quoteShellArg('npx prisma migrate deploy')).toBe(`'npx prisma migrate deploy'`);
        expect(quoteShellArg(`don't stop`)).toBe(`'don'\\''t stop'`);
    });
});

function vectorOptions(overrides = {}) {
    return {
        ...baseOptions(),
        projectName: 'myapp',
        region: 'us-east-2',
        pollIntervalMs: 5,
        flushIntervalMs: 0,
        ...overrides,
    };
}

describe('Command: db enable-vector (mocked AWS)', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
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

    it('rejects MySQL projects before any AWS call', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-vector-'));
        writeDatabaseTf(dir, DATABASE_TF_MYSQL_FIXTURE);
        const ecsClient = mockEcsMigrateClient();
        const result = await runDbEnableVector(vectorOptions({ cwd: dir, ecsClient }));
        expect(result.reason).toBe('unsupported-vector-engine');
        expect(ecsClient.send).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_enable_vector_run', expect.objectContaining({
            success: false, error_code: 'UNSUPPORTED_VECTOR_ENGINE',
        }));
    });

    it('requires database.tf or explicit cluster/service overrides', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-vector-'));
        const ecsClient = mockEcsMigrateClient();
        const result = await runDbEnableVector(vectorOptions({ cwd: dir, ecsClient }));
        expect(result.reason).toBe('no-database-configured');
        expect(ecsClient.send).not.toHaveBeenCalled();

        // Explicit overrides proceed to service discovery instead.
        const overrideClient = mockEcsMigrateClient({ service: null });
        const overrideResult = await runDbEnableVector(vectorOptions({
            cwd: dir, cluster: 'custom-cluster', ecsClient: overrideClient,
        }));
        expect(overrideResult.reason).toBe('ecs-service-not-found');
        expect(overrideClient.send).toHaveBeenCalled();
    });

    it('launches the vector task and reports success with engine telemetry', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-vector-'));
        writeDatabaseTf(dir);
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        const result = await runDbEnableVector(vectorOptions({
            cwd: dir, ecsClient, logsClient: mockLogsClient(),
        }));
        expect(result).toEqual(expect.objectContaining({ ok: true, taskArn: MIGRATE_TASK_ARN, engine: 'postgres' }));
        expect(ecsClient.runs).toHaveLength(1);
        const run = ecsClient.runs[0];
        expect(run.startedBy).toBe('grada-db-enable-vector');
        const override = run.overrides.containerOverrides[0];
        expect(override.command.slice(0, 2)).toEqual(['sh', '-c']);
        expect(override.command[2]).toContain('CREATE EXTENSION IF NOT EXISTS vector');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('pgvector extension enabled');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_enable_vector_run', expect.objectContaining({
            success: true, engine: 'postgres', duration_ms: expect.any(Number),
        }));
    });

    it('prints the Prisma hint only when postgresqlExtensions is missing', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-vector-'));
        writeDatabaseTf(dir);
        fs.mkdirSync(path.join(dir, 'prisma'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }\n');
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        await runDbEnableVector(vectorOptions({ cwd: dir, ecsClient, logsClient: mockLogsClient() }));
        expect(stripVTControlCharacters(output.join('\n'))).toContain('postgresqlExtensions');

        const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'db-vector-'));
        writeDatabaseTf(dir2);
        fs.mkdirSync(path.join(dir2, 'prisma'), { recursive: true });
        fs.writeFileSync(path.join(dir2, 'prisma', 'schema.prisma'), 'previewFeatures = ["postgresqlExtensions"]\n');
        output = [];
        const ecsClient2 = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        await runDbEnableVector(vectorOptions({ cwd: dir2, ecsClient: ecsClient2, logsClient: mockLogsClient() }));
        expect(stripVTControlCharacters(output.join('\n'))).not.toContain('postgresqlExtensions');
    });

    it('maps the no-client exit code to install guidance', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-vector-'));
        writeDatabaseTf(dir);
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(3, 'no client')] });
        const result = await runDbEnableVector(vectorOptions({
            cwd: dir, ecsClient, logsClient: mockLogsClient(),
        }));
        expect(result.reason).toBe('vector-task-failed');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('postgresql-client');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_enable_vector_run', expect.objectContaining({
            success: false, error_code: 'VECTOR_TASK_FAILED',
        }));
    });
});

describe('buildVectorExtensionCommand', () => {
    it('orders the client ladder psql, node, python with a diagnostic tail', () => {
        const script = buildVectorExtensionCommand();
        const psql = script.indexOf('command -v psql');
        const pg = script.indexOf("require.resolve('pg')");
        const prisma = script.indexOf("require.resolve('@prisma/client')");
        const psycopg = script.indexOf('import psycopg"');
        const tail = script.indexOf('exit 3');
        expect(psql).toBeGreaterThanOrEqual(0);
        expect(pg).toBeGreaterThan(psql);
        expect(prisma).toBeGreaterThan(pg);
        expect(psycopg).toBeGreaterThan(prisma);
        expect(tail).toBeGreaterThan(psycopg);
        expect(script).toContain('CREATE EXTENSION IF NOT EXISTS vector');
        expect(script).toContain('$DATABASE_URL');
    });

    it('negotiates TLS on every branch (rds.force_ssl)', () => {
        const script = buildVectorExtensionCommand();
        // libpq clients (psql, psycopg/psycopg2) via PGSSLMODE, exported
        // before the ladder runs.
        expect(script).toContain('export PGSSLMODE="${PGSSLMODE:-require}"');
        expect(script.indexOf('export PGSSLMODE=')).toBeLessThan(script.indexOf('command -v psql'));
        // node-postgres ignores PGSSLMODE: explicit ssl opt instead.
        expect(script).toContain('ssl:{rejectUnauthorized:false}');
        // Prisma ignores PGSSLMODE too: sslmode is appended to the URL when
        // missing, preserving an existing query string.
        expect(script).toContain('sslmode=require');
        expect(script).toContain("[?&]sslmode=");
        // asyncpg is not libpq-based either: explicit ssl='require'.
        expect(script).toContain("asyncpg.connect(os.environ['DATABASE_URL'],ssl='require')");
    });
});

function mockImportSpawn({ exitCode = 0 } = {}) {
    const calls = [];
    const spawnImpl = (bin, args, opts) => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = vi.fn();
        child.unref = vi.fn();
        const call = { bin, args, opts, child, stdinBytes: Buffer.alloc(0) };
        calls.push(call);
        child.stdin.on('data', (chunk) => {
            call.stdinBytes = Buffer.concat([call.stdinBytes, chunk]);
        });
        // Close once piped input completes (file streams) or shortly after
        // spawn when nothing is piped (tunnel, pg_restore, dump binaries).
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            child.emit('close', exitCode);
        };
        child.stdin.once('finish', close);
        const timer = setTimeout(close, 25);
        if (typeof timer.unref === 'function') timer.unref();
        return child;
    };
    return { calls, spawnImpl };
}

function importOptions(overrides = {}) {
    return {
        ...baseOptions(),
        projectName: 'myapp',
        region: 'us-east-2',
        yes: true,
        rdsClient: mockRdsClient(healthyDbInstance({ Engine: 'postgres' })),
        secretsClient: mockSecretsClient(JSON.stringify({ username: DB_USERNAME, password: DB_PASSWORD })),
        ecsClient: mockEcsClient({ taskArns: [TASK_ARN], tasks: [healthyTask()] }),
        spawnSyncImpl: () => ({}),
        waitForTunnelImpl: async () => ({ done: true, value: true }),
        // Fixed port keeps the suite hermetic (no loopback binding); the
        // real allocator is covered by the db-tunnel helper tests.
        allocatePortImpl: async () => 54399,
        ...overrides,
    };
}

describe('Command: db import (mocked AWS + spawn)', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
        output = [];
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });
        mockSelect.mockReset();
        mockText.mockReset();
        mockPassword.mockReset();
        mockConfirm.mockReset();
    });

    afterEach(() => {
        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });

    function writeSqlFile(dir, name = 'seed.sql', content = 'CREATE TABLE t (id int);\n') {
        const filePath = path.join(dir, name);
        fs.writeFileSync(filePath, content);
        return filePath;
    }

    it('rejects both/neither sources before any AWS call', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-import-'));
        const sqlFile = writeSqlFile(dir);
        const ecsClient = { send: vi.fn() };
        const both = await runDbImport(importOptions({
            file: sqlFile, from: 'postgresql://u:p@h/db', ecsClient,
        }));
        expect(both.reason).toBe('invalid-import-source');
        const neither = await runDbImport(importOptions({ ecsClient }));
        expect(neither.reason).toBe('invalid-import-source');
        expect(ecsClient.send).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects missing files and bad URLs before any AWS call', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-import-'));
        const ecsClient = { send: vi.fn() };
        const missing = await runDbImport(importOptions({
            file: path.join(dir, 'nope.sql'), ecsClient,
        }));
        expect(missing.reason).toBe('import-file-not-found');
        expect(ecsClient.send).not.toHaveBeenCalled();

        const bad = await runDbImport(importOptions({
            from: 'http://user:s3cret@host/db', ecsClient,
        }));
        expect(bad.reason).toBe('invalid-source-uri');
        expect(ecsClient.send).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('redacts the source password in validation output', async () => {
        const bad = await runDbImport(importOptions({ from: 'postgresql://u:p@ssw0rd@h' }));
        expect(bad.reason).toBe('invalid-source-uri');
        const textOut = stripVTControlCharacters(output.join('\n'));
        expect(textOut).toContain('****');
        expect(textOut).not.toContain('p@ssw0rd');
        const serialized = JSON.stringify(mockTrackEvent.mock.calls);
        expect(serialized).not.toContain('p@ssw0rd');
    });

    it('requires client binaries with install guidance', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-import-'));
        const sqlFile = writeSqlFile(dir);
        const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
        const result = await runDbImport(importOptions({
            file: sqlFile,
            spawnSyncImpl: (bin) => (bin === 'psql' ? { error: enoent } : ({})),
        }));
        expect(result.reason).toBe('missing-db-client-binary');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('brew install libpq');
    });

    it('requires confirmation in headless mode without --yes', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-import-'));
        const sqlFile = writeSqlFile(dir);
        const { spawnImpl } = mockImportSpawn();
        const result = await runDbImport(importOptions({ file: sqlFile, yes: false, spawnImpl }));
        expect(result.reason).toBe('confirmation-required');
    });

    it('names the service and cluster when no tasks are running', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-import-'));
        const sqlFile = writeSqlFile(dir);
        const { spawnImpl } = mockImportSpawn();
        const result = await runDbImport(importOptions({
            file: sqlFile,
            spawnImpl,
            ecsClient: mockEcsClient({ taskArns: [], tasks: [] }),
        }));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('no-running-tasks');
        const text = stripVTControlCharacters(output.join('\n'));
        expect(text).toContain('No running containers');
        expect(text).toContain('myapp-service');
        expect(text).toContain('myapp-cluster');
        expect(text).not.toContain('[object Object]');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('streams a .sql file into psql with env-only secrets', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-import-'));
        const sqlFile = writeSqlFile(dir);
        const { calls, spawnImpl } = mockImportSpawn();
        const result = await runDbImport(importOptions({ file: sqlFile, spawnImpl }));
        expect(result).toEqual(expect.objectContaining({ ok: true, source: 'file' }));

        const tunnel = calls[0];
        expect(tunnel.bin).toBe('aws');
        expect(tunnel.args).toContain('start-session');
        expect(tunnel.args.join(' ')).toContain('"portNumber":["5432"]');
        expect(tunnel.args.join(' ')).toContain('"localPortNumber":["54399"]');
        expect(tunnel.child.kill).toHaveBeenCalledWith('SIGTERM');
        // Hang fix: stdio torn down and the handle unref'd so an orphaned
        // session-manager-plugin grandchild can't hold the event loop.
        expect(tunnel.child.unref).toHaveBeenCalled();
        expect(tunnel.child.stdin.destroyed).toBe(true);
        expect(tunnel.child.stdout.destroyed).toBe(true);
        expect(tunnel.child.stderr.destroyed).toBe(true);

        const client = calls[1];
        expect(client.bin).toBe('psql');
        expect(client.args).toContain('myapp');
        expect(client.opts.env.PGPASSWORD).toBe(DB_PASSWORD);
        expect(client.opts.env.PGSSLMODE).toBe(process.env.PGSSLMODE || 'require');
        expect(calls.flatMap((c) => c.args).join(' ')).not.toContain(DB_PASSWORD);
        expect(client.stdinBytes.toString()).toBe('CREATE TABLE t (id int);\n');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_import_run', expect.objectContaining({
            success: true, source: 'file', target_engine: 'postgres',
        }));
    });

    it('gunzips .sql.gz files before streaming', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-import-'));
        const { gzipSync } = await import('node:zlib');
        const filePath = path.join(dir, 'seed.sql.gz');
        fs.writeFileSync(filePath, gzipSync('INSERT INTO t VALUES (1);\n'));
        const { calls, spawnImpl } = mockImportSpawn();
        const result = await runDbImport(importOptions({ file: filePath, spawnImpl }));
        expect(result.ok).toBe(true);
        expect(calls[1].bin).toBe('psql');
        expect(calls[1].stdinBytes.toString()).toBe('INSERT INTO t VALUES (1);\n');
    });

    it('restores .dump archives with pg_restore', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-import-'));
        const filePath = writeSqlFile(dir, 'seed.dump', 'PGDMP');
        const { calls, spawnImpl } = mockImportSpawn();
        const result = await runDbImport(importOptions({ file: filePath, spawnImpl }));
        expect(result.ok).toBe(true);
        expect(calls[1].bin).toBe('pg_restore');
        expect(calls[1].args).toContain('--no-owner');
        expect(calls[1].args).toContain(filePath);
        expect(calls[1].opts.env.PGPASSWORD).toBe(DB_PASSWORD);
        expect(calls[1].opts.env.PGSSLMODE).toBe(process.env.PGSSLMODE || 'require');
    });

    it('pipes pg_dump into psql with per-process passwords for --from', async () => {
        const { calls, spawnImpl } = mockImportSpawn();
        const result = await runDbImport(importOptions({
            from: 'postgresql://srcuser:src-pass@src-host:5433/sourcedb',
            spawnImpl,
        }));
        expect(result.ok).toBe(true);
        expect(calls.map((c) => c.bin)).toEqual(['aws', 'pg_dump', 'psql']);
        const dump = calls[1];
        expect(dump.args).toEqual(expect.arrayContaining(['--no-owner', '--no-acl', '-h', 'src-host', '-p', '5433', '-U', 'srcuser', '-d', 'sourcedb']));
        expect(dump.opts.env.PGPASSWORD).toBe('src-pass');
        expect(dump.opts.env.PGSSLMODE).toBe(process.env.PGSSLMODE || 'require');
        expect(calls[2].opts.env.PGPASSWORD).toBe(DB_PASSWORD);
        expect(calls[2].opts.env.PGSSLMODE).toBe(process.env.PGSSLMODE || 'require');
        expect(calls.flatMap((c) => c.args).join(' ')).not.toContain('src-pass');
        expect(calls.flatMap((c) => c.args).join(' ')).not.toContain(DB_PASSWORD);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_import_run', expect.objectContaining({ success: true, source: 'url' }));
    });

    it('uses mysql/mysqldump with MYSQL_PWD for MySQL targets', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-import-'));
        const sqlFile = writeSqlFile(dir);
        const mysqlInstance = healthyDbInstance({
            Engine: 'mysql',
            Endpoint: { Address: 'myapp-db.abc123.us-east-2.rds.amazonaws.com', Port: 3306 },
        });
        const { calls, spawnImpl } = mockImportSpawn();
        const result = await runDbImport(importOptions({
            file: sqlFile,
            rdsClient: mockRdsClient(mysqlInstance),
            spawnImpl,
        }));
        expect(result.ok).toBe(true);
        expect(calls[1].bin).toBe('mysql');
        expect(calls[1].opts.env.MYSQL_PWD).toBe(DB_PASSWORD);
        // MySQL branch adds nothing: whatever the ambient shell exported (if
        // anything) passes through untouched.
        expect(calls[1].opts.env.PGSSLMODE).toBe(process.env.PGSSLMODE);
        expect(calls[0].args.join(' ')).toContain('"portNumber":["3306"]');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_import_run', expect.objectContaining({ target_engine: 'mysql' }));
    });

    it('rejects .dump archives for MySQL targets', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-import-'));
        const filePath = writeSqlFile(dir, 'seed.dump', 'PGDMP');
        const mysqlInstance = healthyDbInstance({
            Engine: 'mysql',
            Endpoint: { Address: 'myapp-db.abc123.us-east-2.rds.amazonaws.com', Port: 3306 },
        });
        const { spawnImpl } = mockImportSpawn();
        const result = await runDbImport(importOptions({
            file: filePath,
            rdsClient: mockRdsClient(mysqlInstance),
            spawnImpl,
        }));
        expect(result.reason).toBe('unsupported-import-format');
    });

    it('fails cleanly on tunnel timeout and client errors', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-import-'));
        const sqlFile = writeSqlFile(dir);
        const { calls, spawnImpl } = mockImportSpawn();
        const timedOut = await runDbImport(importOptions({
            file: sqlFile,
            spawnImpl,
            waitForTunnelImpl: async () => ({ timedOut: true }),
        }));
        expect(timedOut.reason).toBe('tunnel-timeout');
        expect(calls).toHaveLength(1);
        expect(calls[0].child.kill).toHaveBeenCalledWith('SIGTERM');

        const failing = mockImportSpawn({ exitCode: 1 });
        const failed = await runDbImport(importOptions({ file: sqlFile, spawnImpl: failing.spawnImpl }));
        expect(failed.reason).toBe('import-failed');
        expect(failing.calls[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('escalates to SIGKILL when the tunnel survives SIGTERM', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-import-'));
        const sqlFile = writeSqlFile(dir);
        const { calls, spawnImpl } = mockImportSpawn();
        const result = await runDbImport(importOptions({ file: sqlFile, spawnImpl, tunnelSigkillTimeoutMs: 5 }));
        expect(result.ok).toBe(true);
        // Mock children never report an exit code, so escalation always fires.
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(calls[0].child.kill).toHaveBeenCalledWith('SIGTERM');
        expect(calls[0].child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('defaults PGSSLMODE=require for Postgres targets unless the caller pinned it', async () => {
        const saved = process.env.PGSSLMODE;
        delete process.env.PGSSLMODE;
        try {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-import-'));
            const sqlFile = writeSqlFile(dir);

            const fresh = mockImportSpawn();
            const okDefault = await runDbImport(importOptions({ file: sqlFile, spawnImpl: fresh.spawnImpl }));
            expect(okDefault.ok).toBe(true);
            expect(fresh.calls[1].opts.env.PGSSLMODE).toBe('require');

            const fromFresh = mockImportSpawn();
            const okFrom = await runDbImport(importOptions({
                from: 'postgresql://srcuser:src-pass@src-host:5433/sourcedb',
                spawnImpl: fromFresh.spawnImpl,
            }));
            expect(okFrom.ok).toBe(true);
            expect(fromFresh.calls[1].opts.env.PGSSLMODE).toBe('require');

            process.env.PGSSLMODE = 'disable';
            const pinned = mockImportSpawn();
            const okPinned = await runDbImport(importOptions({ file: sqlFile, spawnImpl: pinned.spawnImpl }));
            expect(okPinned.ok).toBe(true);
            expect(pinned.calls[1].opts.env.PGSSLMODE).toBe('disable');

            delete process.env.PGSSLMODE;
            const mysqlInstance = healthyDbInstance({
                Engine: 'mysql',
                Endpoint: { Address: 'myapp-db.abc123.us-east-2.rds.amazonaws.com', Port: 3306 },
            });
            const mysql = mockImportSpawn();
            const okMysql = await runDbImport(importOptions({
                file: sqlFile,
                rdsClient: mockRdsClient(mysqlInstance),
                spawnImpl: mysql.spawnImpl,
            }));
            expect(okMysql.ok).toBe(true);
            expect(mysql.calls[1].opts.env.PGSSLMODE).toBeUndefined();
        } finally {
            if (saved === undefined) delete process.env.PGSSLMODE;
            else process.env.PGSSLMODE = saved;
        }
    });

    it('prompts for the source when interactive without flags', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-import-'));
        const sqlFile = writeSqlFile(dir);
        mockSelect.mockResolvedValueOnce('file');
        mockText.mockResolvedValueOnce(sqlFile);
        mockConfirm.mockResolvedValueOnce(true);
        const { calls, spawnImpl } = mockImportSpawn();
        const result = await runDbImport(importOptions({ isHeadless: false, yes: false, spawnImpl }));
        expect(result.ok).toBe(true);
        expect(mockSelect).toHaveBeenCalled();
        expect(mockText).toHaveBeenCalled();
        expect(calls[1].bin).toBe('psql');
    });
});

describe('db import: pure builders', () => {
    it('classifies import files by extension', () => {
        expect(classifyImportFile('seed.sql')).toBe('sql');
        expect(classifyImportFile('seed.SQL.GZ')).toBe('gzip');
        expect(classifyImportFile('backup.dump')).toBe('dump');
        expect(classifyImportFile('weird.backup')).toBe('sql');
    });

    it('selects client binaries per scheme and source', () => {
        expect(requiredClientBinaries({ targetScheme: 'postgresql', source: { type: 'file', kind: 'sql' } })).toEqual(['psql']);
        expect(requiredClientBinaries({ targetScheme: 'postgresql', source: { type: 'file', kind: 'dump' } })).toEqual(['pg_restore']);
        expect(requiredClientBinaries({ targetScheme: 'postgresql', source: { type: 'url' } })).toEqual(['pg_dump', 'psql']);
        expect(requiredClientBinaries({ targetScheme: 'mysql', source: { type: 'file', kind: 'sql' } })).toEqual(['mysql']);
        expect(requiredClientBinaries({ targetScheme: 'mysql', source: { type: 'url' } })).toEqual(['mysqldump', 'mysql']);
    });

    it('builds target and dump commands without secrets in argv', () => {
        const target = buildTargetClientCommand({ targetScheme: 'postgresql', localPort: 5555, username: 'u', dbName: 'd', fileKind: 'sql' });
        expect(target).toEqual({ bin: 'psql', args: ['-h', '127.0.0.1', '-p', '5555', '-U', 'u', '-d', 'd', '-v', 'ON_ERROR_STOP=1', '-q', '--no-password'] });
        const dump = buildSourceDumpCommand({ scheme: 'postgresql', host: 'h', port: '5432', user: 'u', database: 'd' });
        expect(dump).toEqual({ bin: 'pg_dump', args: ['--no-owner', '--no-acl', '--no-password', '-h', 'h', '-p', '5432', '-U', 'u', '-d', 'd'] });
        const mysqlDump = buildSourceDumpCommand({ scheme: 'mysql', host: 'h', port: '3306', user: '', database: 'd' });
        expect(mysqlDump.args).not.toContain('-u');
    });

    it('parses db import flags', () => {
        expect(parseDbImportArgs(['db', 'import', '--file', 'a.sql', '--yes'])).toMatchObject({ file: 'a.sql', yes: true });
        expect(parseDbImportArgs(['--from=x', '--force'])).toMatchObject({ from: 'x', force: true });
        expect(parseDbImportArgs(null)).toEqual({});
        expect(parseDbImportArgs(['db', 'import', 'oops']).unexpectedPositionals).toEqual(['oops']);
    });
});

describe('db-tunnel: shared helpers', () => {
    it('re-exports the shared SSM builder through connect', () => {
        expect(sharedBuildSsmArgs).toBe(buildSsmArgs);
    });

    it('fetches managed credentials or null when malformed', async () => {
        const good = { send: vi.fn(async () => ({ SecretString: JSON.stringify({ username: 'u', password: 'p' }) })) };
        await expect(fetchManagedDbCredentials(good, 'arn')).resolves.toEqual({ username: 'u', password: 'p' });
        const bad = { send: vi.fn(async () => ({ SecretString: 'nope{{{' })) };
        await expect(fetchManagedDbCredentials(bad, 'arn')).resolves.toBeNull();
        const empty = { send: vi.fn(async () => ({})) };
        await expect(fetchManagedDbCredentials(empty, 'arn')).resolves.toBeNull();
    });

    it('finds jump-host targets and reports task gaps', async () => {
        const ecsClient = mockEcsClient({ taskArns: [TASK_ARN], tasks: [healthyTask()] });
        const found = await findJumpHostTarget(ecsClient, { cluster: 'c', service: 's', expectedContainer: 'x' });
        expect(found.taskId).toBe(TASK_ARN.split('/').pop());
        expect(found.runtimeId).toBeTruthy();
        const none = await findJumpHostTarget(mockEcsClient(), { cluster: 'c', service: 's' });
        expect(none).toEqual({ error: 'NO_RUNNING_TASKS' });
    });

    it('redacts passwords in database URIs', () => {
        expect(redactUri('postgresql://u:p@ss@host:5432/db')).toBe('postgresql://u:****@host:5432/db');
        expect(redactUri('mysql://u@host/db')).toBe('mysql://u@host/db');
        expect(redactUri('not-a-uri')).toBe('not-a-uri');
        expect(redactUri(null)).toBe('');
    });

    it('parses source URIs into discrete parts', () => {
        expect(parseSourceUri('postgresql://u:p%40ss@h:5433/db')).toEqual({
            scheme: 'postgresql', user: 'u', password: 'p@ss', host: 'h', port: '5433', database: 'db',
        });
        expect(parseSourceUri('postgres://u@h/db')).toMatchObject({ scheme: 'postgresql', port: '5432' });
        expect(parseSourceUri('mysql://h/db')).toMatchObject({ scheme: 'mysql', port: '3306' });
        expect(parseSourceUri('http://h/db')).toBeNull();
        expect(parseSourceUri('postgresql://h/')).toBeNull();
        expect(parseSourceUri('garbage')).toBeNull();
    });

    it('reports missing binaries via ENOENT', () => {
        const enoent = Object.assign(new Error('x'), { code: 'ENOENT' });
        expect(findMissingBinaries(['psql', 'pg_dump'], { spawnSyncImpl: () => ({}) })).toEqual([]);
        expect(findMissingBinaries(['psql', 'pg_dump'], {
            spawnSyncImpl: (bin) => (bin === 'psql' ? { error: enoent } : ({})),
        })).toEqual(['psql']);
    });

    it('times out on closed TCP ports without binding', async () => {
        resetNetMock();
        const closed = await waitForTcpPort('127.0.0.1', 54399, { timeoutMs: 30, pollIntervalMs: 5 });
        expect(closed).toEqual({ timedOut: true });
        // The retry loop must probe repeatedly before giving up.
        expect(mockNetConnect.mock.calls.length).toBeGreaterThan(1);
    });

    it('allocates free loopback ports and detects open TCP ports', async () => {
        resetNetMock();
        const port = await getFreeLocalPort();
        expect(Number.isInteger(port)).toBe(true);
        expect(port).toBeGreaterThan(0);

        // Resolves to the shared `node:net` mock: no real sockets are bound.
        const net = await import('node:net');
        const server = net.createServer();
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const open = await waitForTcpPort('127.0.0.1', server.address().port, { timeoutMs: 2000, pollIntervalMs: 5 });
            expect(open).toEqual({ done: true, value: true });
        } finally {
            server.close();
        }
        expect(mockNetCreateServer).toHaveBeenCalled();
    });
});

function backupOptions(overrides = {}) {
    return {
        ...baseOptions(),
        projectName: 'myapp',
        region: 'us-east-2',
        pollIntervalMs: 5,
        ...overrides,
    };
}

function mockRdsBackupClient({ instance, cluster = null, snapshotScript = [], clusterSnapshotScript = [], createError = null } = {}) {
    const resolved = instance === undefined ? healthyDbInstance() : instance;
    const queue = [...snapshotScript];
    const clusterQueue = [...clusterSnapshotScript];
    const created = [];
    const described = [];
    const client = {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockDescribeDBInstancesCommand) {
                return Promise.resolve({ DBInstances: resolved ? [resolved] : [] });
            }
            if (cmd instanceof MockDescribeDBClustersCommand) {
                return Promise.resolve({ DBClusters: cluster ? [cluster] : [] });
            }
            if (cmd instanceof MockCreateDBSnapshotCommand) {
                created.push(cmd);
                if (createError) return Promise.reject(createError);
                return Promise.resolve({ DBSnapshot: { DBSnapshotIdentifier: cmd.DBSnapshotIdentifier, Status: 'creating' } });
            }
            if (cmd instanceof MockCreateDBClusterSnapshotCommand) {
                created.push(cmd);
                if (createError) return Promise.reject(createError);
                return Promise.resolve({ DBClusterSnapshot: { DBClusterSnapshotIdentifier: cmd.DBClusterSnapshotIdentifier, Status: 'creating' } });
            }
            if (cmd instanceof MockDescribeDBSnapshotsCommand) {
                described.push(cmd);
                const next = queue.length > 0 ? queue.shift() : { snapshots: [] };
                if (next.error) return Promise.reject(next.error);
                return Promise.resolve({ DBSnapshots: next.snapshots || [] });
            }
            if (cmd instanceof MockDescribeDBClusterSnapshotsCommand) {
                described.push(cmd);
                const next = clusterQueue.length > 0 ? clusterQueue.shift() : { snapshots: [] };
                if (next.error) return Promise.reject(next.error);
                return Promise.resolve({ DBClusterSnapshots: next.snapshots || [] });
            }
            return Promise.resolve({});
        }),
        created,
        described,
    };
    return client;
}

describe('Command: db backup (mocked AWS)', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
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

    it('rejects invalid --id and --timeout before AWS calls', async () => {
        const rdsClient = mockRdsBackupClient();
        const badId = await runDbBackup(backupOptions({ snapshotId: 'bad--id-', rdsClient }));
        expect(badId.reason).toBe('invalid-snapshot-id');
        expect(rdsClient.send).not.toHaveBeenCalled();

        const badTimeout = await runDbBackup(backupOptions({ timeout: 'never', rdsClient }));
        expect(badTimeout.reason).toBe('invalid-timeout');
        expect(rdsClient.send).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('fails when no database is provisioned', async () => {
        const rdsClient = mockRdsBackupClient({ instance: null });
        const result = await runDbBackup(backupOptions({ rdsClient }));
        expect(result.reason).toBe('rds-instance-not-found');
        expect(rdsClient.created).toHaveLength(0);
        const spin = mockSpinner.mock.results[mockSpinner.mock.results.length - 1].value;
        expect(spin.stop).toHaveBeenCalledWith();
        const text = stripVTControlCharacters(output.join('\n'));
        expect(text).toContain('No database found');
        expect(text.split('No database found').length - 1).toBe(1);
    });

    it('returns immediately with --no-wait', async () => {
        const rdsClient = mockRdsBackupClient();
        const result = await runDbBackup(backupOptions({ snapshotId: 'pre-migrate', noWait: true, rdsClient }));
        expect(result).toEqual({ ok: true, snapshotId: 'pre-migrate', status: 'creating' });
        expect(rdsClient.created).toHaveLength(1);
        const create = rdsClient.created[0];
        expect(create.DBInstanceIdentifier).toBe('myapp-db');
        expect(create.DBSnapshotIdentifier).toBe('pre-migrate');
        expect(create.Tags).toEqual([
            { Key: 'ManagedBy', Value: 'grada' },
            { Key: 'Project', Value: 'myapp' },
        ]);
        expect(rdsClient.described).toHaveLength(0);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_backup_run', expect.objectContaining({
            success: true, waited: false,
        }));
    });

    it('generates a timestamped id by default', async () => {
        const rdsClient = mockRdsBackupClient();
        const result = await runDbBackup(backupOptions({ noWait: true, rdsClient }));
        expect(result.snapshotId).toMatch(/^myapp-db-manual-\d{8}-\d{6}$/);
    });

    it('polls until the snapshot is available', async () => {
        const rdsClient = mockRdsBackupClient({
            snapshotScript: [
                { snapshots: [{ DBSnapshotIdentifier: 's1', Status: 'creating' }] },
                { snapshots: [{ DBSnapshotIdentifier: 's1', Status: 'available' }] },
            ],
        });
        const result = await runDbBackup(backupOptions({ snapshotId: 's1', rdsClient }));
        expect(result).toEqual({ ok: true, snapshotId: 's1', status: 'available' });
        expect(rdsClient.described.length).toBeGreaterThanOrEqual(2);
        expect(stripVTControlCharacters(output.join('\n'))).toContain('npx grada-run db restore s1');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_backup_run', expect.objectContaining({
            success: true, waited: true,
        }));
    });

    it('tolerates eventual-consistency not-found errors while polling', async () => {
        const notFound = new Error('not yet visible');
        notFound.name = 'DBSnapshotNotFound';
        const rdsClient = mockRdsBackupClient({
            snapshotScript: [
                { error: notFound },
                { snapshots: [{ DBSnapshotIdentifier: 's1', Status: 'available' }] },
            ],
        });
        const result = await runDbBackup(backupOptions({ snapshotId: 's1', rdsClient }));
        expect(result.status).toBe('available');
    });

    it('fails on timeout while creation continues in the background', async () => {
        const rdsClient = mockRdsBackupClient({
            snapshotScript: Array.from({ length: 50 }, () => ({ snapshots: [{ DBSnapshotIdentifier: 's1', Status: 'creating' }] })),
        });
        const result = await runDbBackup(backupOptions({ snapshotId: 's1', rdsClient, timeoutMs: 20 }));
        expect(result.reason).toBe('snapshot-timeout');
        expect(result.snapshotId).toBe('s1');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('continues in the background');
    });

    it('propagates quota and state errors from CreateDBSnapshot', async () => {
        const quota = new Error('quota exceeded');
        quota.name = 'SnapshotQuotaExceeded';
        const rdsClient = mockRdsBackupClient({ createError: quota });
        const result = await runDbBackup(backupOptions({ rdsClient }));
        expect(result.reason).toBe('error');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_backup_run', expect.objectContaining({
            success: false, error_code: 'SnapshotQuotaExceeded',
        }));
    });

    it('backs up an Aurora cluster with cluster snapshot commands', async () => {
        const rdsClient = mockRdsBackupClient({
            instance: null,
            cluster: healthyDbCluster(),
            clusterSnapshotScript: [
                { snapshots: [{ DBClusterSnapshotIdentifier: 'c1', Status: 'creating' }] },
                { snapshots: [{ DBClusterSnapshotIdentifier: 'c1', Status: 'available' }] },
            ],
        });
        const result = await runDbBackup(backupOptions({ snapshotId: 'c1', rdsClient }));
        expect(result).toEqual({ ok: true, snapshotId: 'c1', status: 'available' });
        expect(rdsClient.created).toHaveLength(1);
        const create = rdsClient.created[0];
        expect(create).toBeInstanceOf(MockCreateDBClusterSnapshotCommand);
        expect(create.DBClusterIdentifier).toBe('myapp-db-cluster');
        expect(create.DBClusterSnapshotIdentifier).toBe('c1');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_backup_run', expect.objectContaining({
            success: true, waited: true, db_kind: 'cluster',
        }));
    });
});

const DATABASE_TF_FIXTURE = `resource "aws_db_instance" "postgres" {
  identifier          = "myapp-db"
  engine              = "postgres"
  skip_final_snapshot = true
}
`;

function writeDatabaseTf(dir, content = DATABASE_TF_FIXTURE) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'terraform', 'database.tf'), content);
    return path.join(dir, 'terraform', 'database.tf');
}

function snapshotFixture(id, overrides = {}) {
    return {
        DBSnapshotIdentifier: id,
        Status: 'available',
        SnapshotCreateTime: new Date('2026-05-01T10:00:00.000Z'),
        AllocatedStorage: 20,
        SnapshotType: 'manual',
        ...overrides,
    };
}

function mockRdsRestoreClient({ pages = [], byId = {}, clusterPages = [], clusterById = {} } = {}) {
    const queue = [...pages];
    const clusterQueue = [...clusterPages];
    const instanceCalls = [];
    const clusterCalls = [];
    const idCalls = [];
    const client = {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockDescribeDBSnapshotsCommand) {
                if (cmd.DBSnapshotIdentifier) {
                    idCalls.push(cmd);
                    const found = byId[cmd.DBSnapshotIdentifier];
                    if (!found) {
                        const err = new Error('not found');
                        err.name = 'DBSnapshotNotFound';
                        return Promise.reject(err);
                    }
                    return Promise.resolve({ DBSnapshots: [found] });
                }
                instanceCalls.push(cmd);
                const page = queue.length > 0 ? queue.shift() : [];
                return Promise.resolve({ DBSnapshots: page, Marker: queue.length > 0 ? 'next-marker' : undefined });
            }
            if (cmd instanceof MockDescribeDBClusterSnapshotsCommand) {
                if (cmd.DBClusterSnapshotIdentifier) {
                    idCalls.push(cmd);
                    const found = clusterById[cmd.DBClusterSnapshotIdentifier];
                    if (!found) {
                        const err = new Error('not found');
                        err.name = 'DBClusterSnapshotNotFound';
                        return Promise.reject(err);
                    }
                    return Promise.resolve({ DBClusterSnapshots: [found] });
                }
                clusterCalls.push(cmd);
                const page = clusterQueue.length > 0 ? clusterQueue.shift() : [];
                return Promise.resolve({ DBClusterSnapshots: page, Marker: clusterQueue.length > 0 ? 'next-marker' : undefined });
            }
            return Promise.resolve({});
        }),
        instanceCalls,
        clusterCalls,
        idCalls,
    };
    return client;
}

const DATABASE_TF_CLUSTER_FIXTURE = `resource "aws_rds_cluster" "postgres" {
  cluster_identifier = "myapp-db-cluster"
  engine             = "aurora-postgresql"
  skip_final_snapshot = true
}
`;

const DATABASE_TF_MYSQL_FIXTURE = `resource "aws_db_instance" "postgres" {
  identifier          = "myapp-db"
  engine              = "mysql"
  skip_final_snapshot = true
}
`;

function clusterSnapshotFixture(id, overrides = {}) {
    return {
        DBClusterSnapshotIdentifier: id,
        Status: 'available',
        SnapshotCreateTime: new Date('2026-05-01T10:00:00.000Z'),
        AllocatedStorage: 10,
        SnapshotType: 'manual',
        ...overrides,
    };
}

function restoreOptions(overrides = {}) {
    return {
        ...baseOptions(),
        projectName: 'myapp',
        region: 'us-east-2',
        ...overrides,
    };
}

describe('Command: db restore (mocked AWS)', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
        mockSelect.mockReset();
        mockConfirm.mockReset();
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

    it('fails on a missing database.tf before AWS calls', async () => {
        const rdsClient = mockRdsRestoreClient();
        const result = await runDbRestore(restoreOptions({ rdsClient }));
        expect(result.reason).toBe('database-tf-not-found');
        expect(rdsClient.send).not.toHaveBeenCalled();
    });

    it('fails when no snapshots exist', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        writeDatabaseTf(dir);
        const rdsClient = mockRdsRestoreClient({ pages: [[]] });
        const result = await runDbRestore(restoreOptions({ cwd: dir, rdsClient }));
        expect(result.reason).toBe('no-snapshots-found');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('npx grada-run db backup');
    });

    it('requires a snapshot id and confirmation in headless mode', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        writeDatabaseTf(dir);
        const missing = await runDbRestore(restoreOptions({
            cwd: dir, rdsClient: mockRdsRestoreClient({ pages: [[snapshotFixture('s1')]] }),
        }));
        expect(missing.reason).toBe('missing-snapshot-id');
        expect(mockSelect).not.toHaveBeenCalled();

        const unconfirmed = await runDbRestore(restoreOptions({
            cwd: dir,
            snapshotId: 's1',
            rdsClient: mockRdsRestoreClient({ pages: [[snapshotFixture('s1')]] }),
        }));
        expect(unconfirmed.reason).toBe('confirmation-required');
        expect(mockConfirm).not.toHaveBeenCalled();
    });

    it('restores by positional id with --yes and pins the snapshot in HCL', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        const tfFile = writeDatabaseTf(dir);
        const rdsClient = mockRdsRestoreClient({ pages: [[snapshotFixture('snap-1')]] });
        const result = await runDbRestore(restoreOptions({ cwd: dir, snapshotId: 'snap-1', yes: true, rdsClient }));
        expect(result).toEqual({ ok: true, snapshotId: 'snap-1' });
        const updated = fs.readFileSync(tfFile, 'utf8');
        expect(updated).toContain('snapshot_identifier = "snap-1"');
        expect(updated).toContain('keep snapshot_identifier');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('npx grada-run apply');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_restore_run', expect.objectContaining({ success: true }));
    });

    it('restores an Aurora cluster snapshot into the cluster block', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        const tfFile = writeDatabaseTf(dir, DATABASE_TF_CLUSTER_FIXTURE);
        const rdsClient = mockRdsRestoreClient({ clusterPages: [[clusterSnapshotFixture('csnap-1')]] });
        const result = await runDbRestore(restoreOptions({ cwd: dir, snapshotId: 'csnap-1', yes: true, rdsClient }));
        expect(result).toEqual({ ok: true, snapshotId: 'csnap-1' });
        expect(rdsClient.clusterCalls).toHaveLength(1);
        expect(rdsClient.clusterCalls[0].DBClusterIdentifier).toBe('myapp-db-cluster');
        expect(rdsClient.instanceCalls).toHaveLength(0);
        const updated = fs.readFileSync(tfFile, 'utf8');
        expect(updated).toContain('snapshot_identifier = "csnap-1"');
        expect(updated.indexOf('snapshot_identifier')).toBeGreaterThan(updated.indexOf('resource "aws_rds_cluster" "postgres"'));
        expect(mockTrackEvent).toHaveBeenCalledWith('db_restore_run', expect.objectContaining({ success: true, db_kind: 'cluster' }));
    });

    it('falls back to a direct lookup for snapshots from replaced instances', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        writeDatabaseTf(dir);
        const orphan = snapshotFixture('orphan-snap');
        const rdsClient = mockRdsRestoreClient({ pages: [[]], byId: { 'orphan-snap': orphan } });
        const result = await runDbRestore(restoreOptions({ cwd: dir, snapshotId: 'orphan-snap', yes: true, rdsClient }));
        expect(result).toEqual({ ok: true, snapshotId: 'orphan-snap' });
        expect(rdsClient.idCalls).toHaveLength(1);
        expect(rdsClient.idCalls[0].DBSnapshotIdentifier).toBe('orphan-snap');
    });

    it('rejects unknown ids and non-available snapshots', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        writeDatabaseTf(dir);
        const unknown = await runDbRestore(restoreOptions({
            cwd: dir, snapshotId: 'nope', yes: true, rdsClient: mockRdsRestoreClient({ pages: [[snapshotFixture('other')]] }),
        }));
        expect(unknown.reason).toBe('snapshot-not-available');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('not found');

        const pending = await runDbRestore(restoreOptions({
            cwd: dir,
            snapshotId: 's1',
            yes: true,
            rdsClient: mockRdsRestoreClient({ pages: [[snapshotFixture('s1', { Status: 'pending' })]] }),
        }));
        expect(pending.reason).toBe('snapshot-not-available');
    });

    it('follows pagination markers across snapshot pages', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        writeDatabaseTf(dir);
        const rdsClient = mockRdsRestoreClient({ pages: [[snapshotFixture('page-1')], [snapshotFixture('page-2')]] });
        const result = await runDbRestore(restoreOptions({ cwd: dir, snapshotId: 'page-2', yes: true, rdsClient }));
        expect(result).toEqual({ ok: true, snapshotId: 'page-2' });
        expect(rdsClient.instanceCalls).toHaveLength(2);
        expect(rdsClient.instanceCalls[1].Marker).toBe('next-marker');
    });

    it('offers an interactive picker sorted newest-first', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        writeDatabaseTf(dir);
        const older = snapshotFixture('older', { SnapshotCreateTime: new Date('2026-04-01T10:00:00.000Z') });
        const newer = snapshotFixture('newer', { SnapshotCreateTime: new Date('2026-06-01T10:00:00.000Z'), SnapshotType: 'automated' });
        const rdsClient = mockRdsRestoreClient({ pages: [[older, newer]] });
        mockSelect.mockResolvedValueOnce('older');
        mockConfirm.mockResolvedValueOnce(true);
        const result = await runDbRestore(restoreOptions({ cwd: dir, isHeadless: false, rdsClient }));
        expect(result).toEqual({ ok: true, snapshotId: 'older' });
        const promptOptions = mockSelect.mock.calls[0][0].options;
        expect(promptOptions.map((o) => o.value)).toEqual(['newer', 'older']);
        expect(promptOptions[0].hint).toContain('2026-06-01');
        expect(promptOptions[0].hint).toContain('20GB');
        expect(promptOptions[0].hint).toContain('automated');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('skip_final_snapshot = true');
    });

    it('aborts cleanly when the confirmation is declined or cancelled', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        const tfFile = writeDatabaseTf(dir);
        mockSelect.mockResolvedValueOnce('s1');
        mockConfirm.mockResolvedValueOnce(false);
        const declined = await runDbRestore(restoreOptions({
            cwd: dir,
            isHeadless: false,
            rdsClient: mockRdsRestoreClient({ pages: [[snapshotFixture('s1')]] }),
        }));
        expect(declined).toEqual(expect.objectContaining({ ok: false, reason: 'cancelled' }));
        expect(fs.readFileSync(tfFile, 'utf8')).toBe(DATABASE_TF_FIXTURE);

        mockSelect.mockResolvedValueOnce(Symbol('clack-cancel'));
        const cancelled = await runDbRestore(restoreOptions({
            cwd: dir,
            isHeadless: false,
            rdsClient: mockRdsRestoreClient({ pages: [[snapshotFixture('s1')]] }),
        }));
        expect(cancelled).toEqual(expect.objectContaining({ ok: false, reason: 'cancelled' }));
    });
});

describe('db restore: upsertSnapshotIdentifier', () => {
    it('inserts the attribute after identifier with a keep-in-place comment', () => {
        const updated = upsertSnapshotIdentifier(DATABASE_TF_FIXTURE, 'snap-1');
        expect(updated).toContain('snapshot_identifier = "snap-1"');
        expect(updated).toContain('keep snapshot_identifier');
        expect(updated.indexOf('snapshot_identifier')).toBeGreaterThan(updated.indexOf('identifier          = "myapp-db"'));
    });

    it('replaces an existing attribute and stays idempotent', () => {
        const once = upsertSnapshotIdentifier(DATABASE_TF_FIXTURE, 'snap-1');
        const twice = upsertSnapshotIdentifier(once, 'snap-2');
        expect(twice).toContain('snapshot_identifier = "snap-2"');
        expect(twice).not.toContain('snap-1');
        expect(twice.match(/snapshot_identifier =/g)).toHaveLength(1);
        expect(upsertSnapshotIdentifier(twice, 'snap-2')).toBe(twice);
    });

    it('scopes edits to the postgres resource block only', () => {
        const hcl = `${DATABASE_TF_FIXTURE}\nresource "aws_db_instance" "other" {\n  identifier = "other"\n}\n`;
        const updated = upsertSnapshotIdentifier(hcl, 'snap-1');
        expect(updated.match(/snapshot_identifier =/g)).toHaveLength(1);
        expect(updated.indexOf('snapshot_identifier')).toBeLessThan(updated.indexOf('resource "aws_db_instance" "other"'));
    });

    it('returns content unchanged when the resource is missing', () => {
        expect(upsertSnapshotIdentifier('resource "aws_s3_bucket" "x" {}', 'snap-1'))
            .toBe('resource "aws_s3_bucket" "x" {}');
    });

    it('pins cluster snapshots after cluster_identifier in aws_rds_cluster', () => {
        const updated = upsertSnapshotIdentifier(DATABASE_TF_CLUSTER_FIXTURE, 'csnap-1', 'aws_rds_cluster');
        expect(updated).toContain('snapshot_identifier = "csnap-1"');
        expect(updated).toContain('keep snapshot_identifier');
        expect(updated.indexOf('snapshot_identifier')).toBeGreaterThan(updated.indexOf('cluster_identifier'));
        expect(updated.match(/snapshot_identifier =/g)).toHaveLength(1);
        expect(upsertSnapshotIdentifier(updated, 'csnap-1', 'aws_rds_cluster')).toBe(updated);
    });

    it('leaves cluster blocks untouched when scoping to aws_db_instance', () => {
        expect(upsertSnapshotIdentifier(DATABASE_TF_CLUSTER_FIXTURE, 'snap-1')).toBe(DATABASE_TF_CLUSTER_FIXTURE);
    });
});

describe('db: fuzzer hardening', () => {
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

    it.each([
        ['runDbConnect', runDbConnect, 'db_connect_run'],
        ['runDbMigrate', runDbMigrate, 'db_migrate_run'],
        ['runDbBackup', runDbBackup, 'db_backup_run'],
        ['runDbRestore', runDbRestore, 'db_restore_run'],
        ['runDbEnableVector', runDbEnableVector, 'db_enable_vector_run'],
        ['runDbImport', runDbImport, 'db_import_run'],
    ])('%s routes unresolvable projects through PROJECT_NOT_INITIALIZED', async (_name, run, event) => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => { throw new Error('deleted'); });
        try {
            const result = await run(null);
            expect(result).toEqual({ ok: false, reason: 'project-not-initialized' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(mockTrackEvent).toHaveBeenCalledWith(event, expect.objectContaining({
                success: false,
                error_code: 'PROJECT_NOT_INITIALIZED',
            }));
        } finally {
            cwdSpy.mockRestore();
        }
    });
});

describe('buildMigrationCommand', () => {
    const DB_ENV = [
        { name: 'DB_HOST', value: 'db.internal' },
        { name: 'DB_PORT', value: '5432' },
        { name: 'DB_NAME', value: 'myapp' },
    ];
    const DB_SECRETS = [
        { name: 'DB_USER', valueFrom: 'arn:username' },
        { name: 'DB_PASSWORD', valueFrom: 'arn:password' },
    ];

    it('passes the command through for env-less containers', () => {
        expect(buildMigrationCommand('npx prisma migrate deploy', { name: 'c' }))
            .toEqual(['sh', '-c', 'npx prisma migrate deploy']);
        expect(buildMigrationCommand('npx prisma migrate deploy', null))
            .toEqual(['sh', '-c', 'npx prisma migrate deploy']);
        expect(buildMigrationCommand('npx prisma migrate deploy', { name: 'c', environment: [], secrets: [] }))
            .toEqual(['sh', '-c', 'npx prisma migrate deploy']);
    });

    it('synthesizes a mysql:// URL for MySQL task definitions', () => {
        const mysqlEnv = [
            { name: 'DB_HOST', value: 'db.internal' },
            { name: 'DB_PORT', value: '3306' },
            { name: 'DB_NAME', value: 'myapp' },
            { name: 'DB_ENGINE', value: 'mysql' },
        ];
        const [sh, dashC, script] = buildMigrationCommand('migrate', { name: 'c', environment: mysqlEnv, secrets: DB_SECRETS });
        expect([sh, dashC]).toEqual(['sh', '-c']);
        expect(script).toContain('export DATABASE_URL="${DATABASE_URL:-mysql://');
        // MySQL clients ignore PGSSLMODE: no TLS prefix on mysql:// URLs.
        expect(script).not.toContain('PGSSLMODE');
        const portOnly = { name: 'c', environment: mysqlEnv.filter((e) => e.name !== 'DB_ENGINE'), secrets: DB_SECRETS };
        expect(buildMigrationCommand('migrate', portOnly)[2]).toContain(':-mysql://');
    });

    it('passes through when DATABASE_URL is already defined', () => {
        const withUrl = { name: 'c', environment: [...DB_ENV, { name: 'DATABASE_URL', value: 'postgres://x' }], secrets: DB_SECRETS };
        expect(buildMigrationCommand('migrate', withUrl)).toEqual(['sh', '-c', 'migrate']);
        const withUrlSecret = { name: 'c', environment: DB_ENV, secrets: [...DB_SECRETS, { name: 'DATABASE_URL', valueFrom: 'arn' }] };
        expect(buildMigrationCommand('migrate', withUrlSecret)).toEqual(['sh', '-c', 'migrate']);
    });

    it('passes through when credentials are incomplete', () => {
        const noUser = { name: 'c', environment: DB_ENV, secrets: [{ name: 'DB_PASSWORD', valueFrom: 'arn' }] };
        expect(buildMigrationCommand('migrate', noUser)).toEqual(['sh', '-c', 'migrate']);
    });

    it('synthesizes DATABASE_URL from discrete credentials at runtime', () => {
        const container = { name: 'c', environment: DB_ENV, secrets: DB_SECRETS };
        const [shell, flag, script] = buildMigrationCommand('npx prisma migrate deploy', container);
        expect([shell, flag]).toEqual(['sh', '-c']);
        expect(script).toContain('export DATABASE_URL="${DATABASE_URL:-postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT:-5432}/${DB_NAME:-postgres}}"');
        // RDS/Aurora enforces rds.force_ssl: TLS is required before the URL.
        expect(script).toContain('export PGSSLMODE="${PGSSLMODE:-require}"');
        expect(script.indexOf('export PGSSLMODE=')).toBeLessThan(script.indexOf('export DATABASE_URL='));
        expect(script.endsWith('npx prisma migrate deploy')).toBe(true);
        // Secrets stay as runtime expansions, never baked into the command.
        expect(script).not.toContain('arn:');
    });

    it('wraps the RunTask command when the task definition carries DB credentials', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const ecsClient = mockEcsMigrateClient({
                containerDefinitions: [{ name: 'myapp-container', environment: DB_ENV, secrets: DB_SECRETS }],
                taskSequence: [stoppedTask(0)],
            });
            const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
            expect(result.success).toBe(true);
            expect(ecsClient.runs[0].overrides.containerOverrides[0].command[2]).toContain('export DATABASE_URL=');
        } finally {
            exitSpy.mockRestore();
            consoleSpy.mockRestore();
        }
    });
});
