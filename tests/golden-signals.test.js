import { describe, it, expect, vi } from 'vitest';
import { fetchGoldenSignals, resolveAlbName, albDimensionFromArn } from '../src/utils/golden-signals.js';

const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-2:123456789012:loadbalancer/app/myapp-alb/abcdef1234567890';

function mockElbClient(arn = LB_ARN) {
    return { send: vi.fn().mockResolvedValue({ LoadBalancers: arn ? [{ LoadBalancerArn: arn }] : [] }) };
}

function mockMetricClient(results = []) {
    return {
        send: vi.fn().mockResolvedValue({ MetricDataResults: results }),
    };
}

function mockRdsClientEmpty() {
    return {
        send: vi.fn((command) => {
            const name = command.constructor.name === 'DescribeDBClustersCommand'
                ? 'DBClusterNotFound'
                : 'DBInstanceNotFound';
            return Promise.reject(Object.assign(new Error('not found'), { name }));
        }),
    };
}

function mockRdsClientCluster() {
    return {
        send: vi.fn((command) => {
            if (command.constructor.name === 'DescribeDBClustersCommand') {
                return Promise.resolve({ DBClusters: [{ Engine: 'aurora-postgresql', Status: 'available', Port: 5432, Endpoint: 'myapp.cluster-xyz.us-east-2.rds.amazonaws.com' }] });
            }
            return Promise.reject(Object.assign(new Error('not found'), { name: 'DBInstanceNotFound' }));
        }),
    };
}

function mockRdsClientInstance() {
    return {
        send: vi.fn((command) => {
            if (command.constructor.name === 'DescribeDBInstancesCommand') {
                return Promise.resolve({ DBInstances: [{ Engine: 'postgres', DBName: 'myapp', Endpoint: { Address: 'myapp.xyz.us-east-2.rds.amazonaws.com', Port: 5432 } }] });
            }
            return Promise.resolve({ DBClusters: [] });
        }),
    };
}

function baseInput(overrides = {}) {
    return {
        projectName: 'myapp',
        region: 'us-east-2',
        cloudWatchClient: mockMetricClient([]),
        elbClient: mockElbClient(),
        rdsClient: mockRdsClientEmpty(),
        ...overrides,
    };
}

describe('golden-signals: ALB discovery helpers', () => {
    it('truncates the ALB name to 32 chars like the Terraform template', () => {
        expect(resolveAlbName('myapp')).toBe('myapp-alb');
        expect(resolveAlbName('a-very-long-project-name-that-exceeds-limits')).toHaveLength(32);
    });

    it('parses the CloudWatch dimension from the LB ARN', () => {
        expect(albDimensionFromArn(LB_ARN)).toBe('app/myapp-alb/abcdef1234567890');
        expect(albDimensionFromArn('garbage')).toBeNull();
        expect(albDimensionFromArn(null)).toBeNull();
    });
});

describe('golden-signals: fetch', () => {
    it('populates ALB and ECS sections from one batched GetMetricData call', async () => {
        const cloudWatchClient = mockMetricClient([
            { Id: 'albRequests', Values: [1240] },
            { Id: 'alb5xx', Values: [3] },
            { Id: 'albLatencyP95', Values: [0.125] },
            { Id: 'ecsCpu', Values: [34.2] },
            { Id: 'ecsMem', Values: [58.1] },
        ]);
        const result = await fetchGoldenSignals(baseInput({ cloudWatchClient }));

        expect(result.errors).toEqual([]);
        expect(result.alb).toEqual({ requestCount: 1240, error5xxCount: 3, latencyP95Ms: 125 });
        expect(result.ecs).toEqual({ cpuPercent: 34.2, memoryPercent: 58.1 });
        expect(result.db).toBeNull();

        // Cost contract: exactly one batched call, standard AWS namespaces only.
        expect(cloudWatchClient.send).toHaveBeenCalledTimes(1);
        const queries = cloudWatchClient.send.mock.calls[0][0].input.MetricDataQueries;
        expect(queries.length).toBeGreaterThan(0);
        for (const query of queries) {
            expect(query.MetricStat.Metric.Namespace.startsWith('AWS/')).toBe(true);
        }
        const latency = queries.find((query) => query.Id === 'albLatencyP95');
        expect(latency.MetricStat.ExtendedStatistic).toBe('p95');
        expect(latency.MetricStat.Stat).toBeUndefined();
        const albDims = queries.find((query) => query.Id === 'albRequests').MetricStat.Metric.Dimensions;
        expect(albDims).toEqual([{ Name: 'LoadBalancer', Value: 'app/myapp-alb/abcdef1234567890' }]);
    });

    it('queries ACU metrics for Aurora Serverless v2 clusters', async () => {
        const cloudWatchClient = mockMetricClient([
            { Id: 'ecsCpu', Values: [10] },
            { Id: 'ecsMem', Values: [20] },
            { Id: 'dbPrimary', Values: [4] },
            { Id: 'dbConns', Values: [12] },
        ]);
        const result = await fetchGoldenSignals(baseInput({ cloudWatchClient, rdsClient: mockRdsClientCluster() }));

        expect(result.errors).toEqual([]);
        expect(result.db).toEqual({ kind: 'cluster', engine: 'aurora-postgresql', capacityAcu: 4, connections: 12 });
        const queries = cloudWatchClient.send.mock.calls[0][0].input.MetricDataQueries;
        const primary = queries.find((query) => query.Id === 'dbPrimary');
        expect(primary.MetricStat.Metric.MetricName).toBe('ServerlessDatabaseCapacity');
        expect(primary.MetricStat.Metric.Dimensions).toEqual([{ Name: 'DBClusterIdentifier', Value: 'myapp-db-cluster' }]);
    });

    it('queries CPU metrics for RDS instances', async () => {
        const cloudWatchClient = mockMetricClient([
            { Id: 'ecsCpu', Values: [10] },
            { Id: 'ecsMem', Values: [20] },
            { Id: 'dbPrimary', Values: [22.5] },
            { Id: 'dbConns', Values: [7] },
        ]);
        const result = await fetchGoldenSignals(baseInput({ cloudWatchClient, rdsClient: mockRdsClientInstance() }));

        expect(result.errors).toEqual([]);
        expect(result.db).toEqual({ kind: 'instance', engine: 'postgres', cpuPercent: 22.5, connections: 7 });
        const queries = cloudWatchClient.send.mock.calls[0][0].input.MetricDataQueries;
        const primary = queries.find((query) => query.Id === 'dbPrimary');
        expect(primary.MetricStat.Metric.MetricName).toBe('CPUUtilization');
        expect(primary.MetricStat.Metric.Dimensions).toEqual([{ Name: 'DBInstanceIdentifier', Value: 'myapp-db' }]);
    });

    it('skips DB queries when no database exists', async () => {
        const cloudWatchClient = mockMetricClient([]);
        const result = await fetchGoldenSignals(baseInput({ cloudWatchClient }));
        expect(result.db).toBeNull();
        expect(result.errors).toEqual([]);
        const queries = cloudWatchClient.send.mock.calls[0][0].input.MetricDataQueries;
        expect(queries.some((query) => query.Id.startsWith('db'))).toBe(false);
    });

    it('degrades the ALB section when LB discovery fails', async () => {
        const cloudWatchClient = mockMetricClient([{ Id: 'ecsCpu', Values: [10] }, { Id: 'ecsMem', Values: [20] }]);
        const elbClient = { send: vi.fn().mockRejectedValue(new Error('denied')) };
        const result = await fetchGoldenSignals(baseInput({ cloudWatchClient, elbClient }));

        expect(result.alb).toBeNull();
        expect(result.ecs).toEqual({ cpuPercent: 10, memoryPercent: 20 });
        expect(result.errors).toEqual(['alb: denied']);
        const queries = cloudWatchClient.send.mock.calls[0][0].input.MetricDataQueries;
        expect(queries.some((query) => query.Id.startsWith('alb'))).toBe(false);
    });

    it('nulls every section when GetMetricData fails', async () => {
        const cloudWatchClient = { send: vi.fn().mockRejectedValue(new Error('throttled')) };
        const result = await fetchGoldenSignals(baseInput({ cloudWatchClient }));

        expect(result.alb).toBeNull();
        expect(result.ecs).toBeNull();
        expect(result.db).toBeNull();
        expect(result.errors).toEqual(['metrics: throttled']);
    });

    it('returns null metric values when CloudWatch has no datapoints', async () => {
        const result = await fetchGoldenSignals(baseInput());
        expect(result.errors).toEqual([]);
        expect(result.alb).toEqual({ requestCount: null, error5xxCount: null, latencyP95Ms: null });
        expect(result.ecs).toEqual({ cpuPercent: null, memoryPercent: null });
    });

    it('never throws on missing inputs', async () => {
        expect(await fetchGoldenSignals(null)).toMatchObject({ alb: null, ecs: null, db: null });
        expect(await fetchGoldenSignals({})).toMatchObject({ alb: null, ecs: null, db: null });
        const noClient = await fetchGoldenSignals({ projectName: 'myapp', region: 'us-east-2' });
        expect(noClient.errors).toEqual(['cloudWatchClient is required']);
    });
});
