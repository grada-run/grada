import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    findDbInstance,
    findDbCluster,
    findDbTarget,
    dbStatusOf,
    generateSnapshotId,
    isValidSnapshotId,
    resolveDbIdentifier,
    resolveDbClusterIdentifier,
} from '../src/utils/rds.js';

const { MockDescribeDBInstancesCommand, MockDescribeDBClustersCommand } = vi.hoisted(() => {
    const cmd = () => vi.fn(function (input) { Object.assign(this, input); });
    return {
        MockDescribeDBInstancesCommand: cmd(),
        MockDescribeDBClustersCommand: cmd(),
    };
});

vi.mock('@aws-sdk/client-rds', () => ({
    RDSClient: vi.fn(function () { this.send = vi.fn(); }),
    DescribeDBInstancesCommand: MockDescribeDBInstancesCommand,
    DescribeDBClustersCommand: MockDescribeDBClustersCommand,
}));

function mockClient(handler) {
    return { send: vi.fn(handler) };
}

describe('findDbInstance', () => {
    it('returns the instance for an exact identifier match', async () => {
        const instance = { DBInstanceIdentifier: 'myapp-db' };
        const client = mockClient(() => Promise.resolve({ DBInstances: [instance] }));
        await expect(findDbInstance(client, 'myapp-db')).resolves.toBe(instance);
        const input = client.send.mock.calls[0][0];
        expect(input.DBInstanceIdentifier).toBe('myapp-db');
    });

    it('returns null when no instances are returned', async () => {
        const client = mockClient(() => Promise.resolve({ DBInstances: [] }));
        await expect(findDbInstance(client, 'myapp-db')).resolves.toBeNull();
    });

    it.each(['DBInstanceNotFound', 'DBInstanceNotFoundFault'])('returns null on %s', async (name) => {
        const err = new Error('missing');
        err.name = name;
        const client = mockClient(() => Promise.reject(err));
        await expect(findDbInstance(client, 'myapp-db')).resolves.toBeNull();
    });

    it('rethrows unexpected errors', async () => {
        const err = new Error('boom');
        err.name = 'AccessDenied';
        const client = mockClient(() => Promise.reject(err));
        await expect(findDbInstance(client, 'myapp-db')).rejects.toBe(err);
    });
});

describe('generateSnapshotId', () => {
    it('formats the UTC timestamp suffix', () => {
        const now = new Date(Date.UTC(2026, 4, 9, 7, 8, 9));
        expect(generateSnapshotId('myapp-db', now)).toBe('myapp-db-manual-20260509-070809');
    });

    it('lowercases the identifier', () => {
        const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
        expect(generateSnapshotId('MyApp-DB', now)).toBe('myapp-db-manual-20260101-000000');
    });

    it('produces a valid snapshot id by default', () => {
        expect(isValidSnapshotId(generateSnapshotId('myapp-db'))).toBe(true);
    });
});

describe('isValidSnapshotId', () => {
    it.each([
        'a',
        'snap1',
        'myapp-db-manual-20260509-070809',
        'A-valid-ID-123',
        'x'.repeat(255),
    ])('accepts %s', (id) => {
        expect(isValidSnapshotId(id)).toBe(true);
    });

    it.each([
        '',
        '1abc',
        '-abc',
        'has space',
        'has_underscore',
        'has--double-hyphen',
        'trailing-',
        'x'.repeat(256),
        undefined,
        null,
        123,
    ])('rejects %s', (id) => {
        expect(isValidSnapshotId(id)).toBe(false);
    });
});

describe('resolveDbIdentifier', () => {
    it('prefers an explicit --db-identifier override', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-id-'));
        expect(resolveDbIdentifier({ projectName: 'myapp', dbIdentifier: '  custom-db  ' }, dir)).toBe('custom-db');
    });

    it('resolves the project default with workspace suffixes', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-id-'));
        expect(resolveDbIdentifier({ projectName: 'myapp' }, dir)).toBe('myapp-db');
        expect(resolveDbIdentifier({ projectName: 'myapp', workspace: 'pr-1' }, dir)).toBe('myapp-pr-1-db');
    });

    it('auto-detects the workspace from .terraform/environment', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-id-'));
        fs.mkdirSync(path.join(dir, '.terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.terraform', 'environment'), 'pr-42\n');
        expect(resolveDbIdentifier({ projectName: 'myapp' }, dir)).toBe('myapp-pr-42-db');
    });

    it('survives synthetic fuzzer inputs', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-id-'));
        for (const bad of [null, undefined, 'string', 42, true, { port: 'string' }]) {
            expect(resolveDbIdentifier(bad, dir)).toBe(resolveDbIdentifier({}, dir));
        }
        expect(resolveDbIdentifier({ projectName: 'myapp' }, 42)).toBe(resolveDbIdentifier({ projectName: 'myapp' }));
        expect(resolveDbIdentifier({ projectName: 'myapp', cwd: 42 }, dir)).toBe('myapp-db');
    });

    it('inserts the resource suffix after the workspace segment', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-id-'));
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  grada_resource_suffix = "-a1b2c3"\n}\n'
        );
        expect(resolveDbIdentifier({ projectName: 'myapp' }, dir)).toBe('myapp-a1b2c3-db');
        expect(resolveDbIdentifier({ projectName: 'myapp', workspace: 'pr-1' }, dir)).toBe('myapp-pr-1-a1b2c3-db');
        expect(resolveDbClusterIdentifier({ projectName: 'myapp' }, dir)).toBe('myapp-a1b2c3-db-cluster');
    });
});

describe('resolveDbClusterIdentifier', () => {
    it('prefers an explicit --db-identifier override', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-id-'));
        expect(resolveDbClusterIdentifier({ projectName: 'myapp', dbIdentifier: '  custom-db  ' }, dir)).toBe('custom-db');
    });

    it('resolves the cluster default with workspace suffixes', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-id-'));
        expect(resolveDbClusterIdentifier({ projectName: 'myapp' }, dir)).toBe('myapp-db-cluster');
        expect(resolveDbClusterIdentifier({ projectName: 'myapp', workspace: 'pr-1' }, dir)).toBe('myapp-pr-1-db-cluster');
    });
});

describe('findDbCluster', () => {
    it('returns the cluster for an exact identifier match', async () => {
        const cluster = { DBClusterIdentifier: 'myapp-db-cluster' };
        const client = mockClient(() => Promise.resolve({ DBClusters: [cluster] }));
        await expect(findDbCluster(client, 'myapp-db-cluster')).resolves.toBe(cluster);
        const input = client.send.mock.calls[0][0];
        expect(input.DBClusterIdentifier).toBe('myapp-db-cluster');
    });

    it.each(['DBClusterNotFound', 'DBClusterNotFoundFault'])('returns null on %s', async (name) => {
        const err = new Error('missing');
        err.name = name;
        const client = mockClient(() => Promise.reject(err));
        await expect(findDbCluster(client, 'myapp-db-cluster')).resolves.toBeNull();
    });

    it('rethrows unexpected errors', async () => {
        const err = new Error('boom');
        err.name = 'AccessDenied';
        const client = mockClient(() => Promise.reject(err));
        await expect(findDbCluster(client, 'myapp-db-cluster')).rejects.toBe(err);
    });
});

describe('findDbTarget', () => {
    const instance = {
        DBInstanceIdentifier: 'myapp-db',
        Engine: 'postgres',
        DBInstanceStatus: 'available',
        Endpoint: { Address: 'myapp-db.abc.us-east-2.rds.amazonaws.com', Port: 5432 },
        DBName: 'myapp',
        MasterUserSecret: { SecretArn: 'arn:secret' },
    };
    const cluster = {
        DBClusterIdentifier: 'myapp-db-cluster',
        Engine: 'aurora-postgresql',
        Status: 'available',
        Endpoint: 'myapp-db-cluster.xyz.us-east-2.rds.amazonaws.com',
        Port: 5432,
        DatabaseName: 'myapp',
        MasterUserSecret: { SecretArn: 'arn:secret' },
    };

    it('resolves an instance with a single API call', async () => {
        const client = mockClient(() => Promise.resolve({ DBInstances: [instance] }));
        const target = await findDbTarget(client, { dbIdentifier: 'myapp-db', dbClusterIdentifier: 'myapp-db-cluster' });
        expect(target).toMatchObject({
            kind: 'instance',
            id: 'myapp-db',
            engine: 'postgres',
            status: 'available',
            endpoint: 'myapp-db.abc.us-east-2.rds.amazonaws.com',
            port: '5432',
            dbName: 'myapp',
            masterSecretArn: 'arn:secret',
        });
        expect(target.raw).toBe(instance);
        expect(client.send).toHaveBeenCalledTimes(1);
    });

    it('falls back to the cluster identifier on instance miss', async () => {
        const notFound = new Error('missing');
        notFound.name = 'DBInstanceNotFound';
        const client = mockClient((cmd) => {
            if (cmd instanceof MockDescribeDBInstancesCommand) return Promise.reject(notFound);
            return Promise.resolve({ DBClusters: [cluster] });
        });
        const target = await findDbTarget(client, { dbIdentifier: 'myapp-db', dbClusterIdentifier: 'myapp-db-cluster' });
        expect(target).toMatchObject({
            kind: 'cluster',
            id: 'myapp-db-cluster',
            engine: 'aurora-postgresql',
            endpoint: 'myapp-db-cluster.xyz.us-east-2.rds.amazonaws.com',
            port: '5432',
            dbName: 'myapp',
            masterSecretArn: 'arn:secret',
        });
        expect(target.raw).toBe(cluster);
        expect(client.send.mock.calls[1][0].DBClusterIdentifier).toBe('myapp-db-cluster');
    });

    it('returns null when neither kind exists', async () => {
        const client = mockClient((cmd) => {
            const err = new Error('missing');
            err.name = cmd instanceof MockDescribeDBInstancesCommand ? 'DBInstanceNotFound' : 'DBClusterNotFound';
            return Promise.reject(err);
        });
        await expect(findDbTarget(client, { dbIdentifier: 'myapp-db', dbClusterIdentifier: 'myapp-db-cluster' })).resolves.toBeNull();
    });

    it('defaults the port by engine when the endpoint omits it', async () => {
        const mysql = { ...instance, Engine: 'mysql', Endpoint: { Address: 'host' } };
        const client = mockClient(() => Promise.resolve({ DBInstances: [mysql] }));
        const target = await findDbTarget(client, { dbIdentifier: 'myapp-db' });
        expect(target.port).toBe('3306');
    });
});

describe('dbStatusOf', () => {
    // RDS API asymmetry: instances report DBInstanceStatus, clusters
    // report Status. Reading Status off an instance yields undefined and
    // hung the destroy/wake wait loops forever (P2 live incident).
    it('reads DBInstanceStatus for instances', () => {
        expect(dbStatusOf({ DBInstanceStatus: 'creating' }, 'instance')).toBe('creating');
        expect(dbStatusOf({ DBInstanceStatus: 'available' }, 'instance')).toBe('available');
    });

    it('reads Status for clusters', () => {
        expect(dbStatusOf({ Status: 'available' }, 'cluster')).toBe('available');
    });

    it('returns null for missing records and missing fields', () => {
        expect(dbStatusOf(null, 'instance')).toBeNull();
        expect(dbStatusOf({}, 'instance')).toBeNull();
        expect(dbStatusOf({ Status: 'available' }, 'instance')).toBeNull();
        expect(dbStatusOf({ DBInstanceStatus: 'available' }, 'cluster')).toBeNull();
    });
});
