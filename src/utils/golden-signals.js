import { GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { RDSClient } from '@aws-sdk/client-rds';
import { resolveClient } from './aws.js';
import { normalizeOptions } from './args.js';
import { findDbTarget, resolveDbIdentifier, resolveDbClusterIdentifier } from './rds.js';

// Golden Signals: live CloudWatch telemetry for `grada status`.
//
// Zero-cost rule: this module only READS standard AWS service metrics
// (`AWS/ApplicationELB`, `AWS/ECS`, `AWS/RDS`) via a single batched
// GetMetricData call. It never calls PutMetricData, so no custom metrics
// (and no custom-metric charges) are ever created. Retrieval itself costs
// $0.01 per 1,000 metrics requested — a status run requests fewer than 10.
//
// Every section degrades independently: a failed lookup yields a null
// section plus an entry in `errors`, never a throw, so the core health
// check in status.js always survives telemetry outages.

export const GOLDEN_SIGNALS_WINDOW_MINUTES = 15;
export const GOLDEN_SIGNALS_PERIOD_SECONDS = 300;

// Mirrors the generated ALB name (`substr("${app}-alb", 0, 32)` in
// templates/terraform/main.tf) so lookup matches the truncated name.
export function resolveAlbName(projectName) {
    return `${projectName}-alb`.slice(0, 32);
}

// `arn:aws:elasticloadbalancing:<region>:<acct>:loadbalancer/app/<name>/<id>`
// → `app/<name>/<id>`, the LoadBalancer dimension CloudWatch expects.
export function albDimensionFromArn(arn) {
    const full = String(arn || '').split(':loadbalancer/')[1];
    return full || null;
}

function metricStatQuery(id, namespace, metricName, dimensions, stat) {
    return {
        Id: id,
        MetricStat: {
            Metric: { Namespace: namespace, MetricName: metricName, Dimensions: dimensions },
            Period: GOLDEN_SIGNALS_PERIOD_SECONDS,
            ...(stat === 'p95' ? { ExtendedStatistic: 'p95' } : { Stat: stat }),
        },
    };
}

async function resolveAlbDimension(elbClient, projectName) {
    const resp = await elbClient.send(new DescribeLoadBalancersCommand({ Names: [resolveAlbName(projectName)] }));
    const arn = (resp.LoadBalancers || [])[0]?.LoadBalancerArn;
    const dimension = albDimensionFromArn(arn);
    if (!dimension) throw new Error('ALB not found');
    return dimension;
}

function latestValue(resultsById, id) {
    const values = resultsById.get(id)?.Values;
    if (!Array.isArray(values) || values.length === 0) return null;
    // ScanBy TimestampDescending puts the newest datapoint first.
    const value = values[0];
    return typeof value === 'number' ? value : null;
}

export async function fetchGoldenSignals(input = {}) {
    const failed = (errors) => ({ alb: null, ecs: null, db: null, errors });
    try {
        const options = normalizeOptions(input);
        const projectName = options.projectName;
        if (typeof projectName !== 'string' || !projectName.trim()) {
            return failed(['projectName is required']);
        }
        const region = options.region;
        const cluster = options.cluster || `${projectName}-cluster`;
        const service = options.service || `${projectName}-service`;
        const cloudWatchClient = options.cloudWatchClient;
        if (!cloudWatchClient || typeof cloudWatchClient.send !== 'function') {
            return failed(['cloudWatchClient is required']);
        }
        const elbClient = resolveClient(options.elbClient, ElasticLoadBalancingV2Client, { region });
        const rdsClient = resolveClient(options.rdsClient, RDSClient, { region });

        const errors = [];

        // 1. ALB dimension discovery (name → app/<name>/<id>).
        let albDimension = null;
        try {
            albDimension = await resolveAlbDimension(elbClient, projectName);
        } catch (error) {
            errors.push(`alb: ${error?.message || error}`);
        }

        // 2. DB discovery: cluster (Aurora Serverless v2) vs instance
        // (RDS postgres/mysql) determines which metrics exist.
        let dbTarget = null;
        try {
            dbTarget = await findDbTarget(rdsClient, {
                dbIdentifier: resolveDbIdentifier({ projectName, dbIdentifier: options.dbIdentifier }),
                dbClusterIdentifier: resolveDbClusterIdentifier({ projectName, dbIdentifier: options.dbIdentifier }),
            });
        } catch (error) {
            errors.push(`db: ${error?.message || error}`);
        }

        // 3. One batched GetMetricData for every applicable query.
        const queries = [
            metricStatQuery('ecsCpu', 'AWS/ECS', 'CPUUtilization', [
                { Name: 'ClusterName', Value: cluster },
                { Name: 'ServiceName', Value: service },
            ], 'Average'),
            metricStatQuery('ecsMem', 'AWS/ECS', 'MemoryUtilization', [
                { Name: 'ClusterName', Value: cluster },
                { Name: 'ServiceName', Value: service },
            ], 'Average'),
        ];
        if (albDimension) {
            const albDims = [{ Name: 'LoadBalancer', Value: albDimension }];
            queries.push(
                metricStatQuery('albRequests', 'AWS/ApplicationELB', 'RequestCount', albDims, 'Sum'),
                metricStatQuery('alb5xx', 'AWS/ApplicationELB', 'HTTPCode_Target_5XX_Count', albDims, 'Sum'),
                metricStatQuery('albLatencyP95', 'AWS/ApplicationELB', 'TargetResponseTime', albDims, 'p95'),
            );
        }
        if (dbTarget?.kind === 'cluster') {
            const dims = [{ Name: 'DBClusterIdentifier', Value: dbTarget.id }];
            queries.push(
                metricStatQuery('dbPrimary', 'AWS/RDS', 'ServerlessDatabaseCapacity', dims, 'Average'),
                metricStatQuery('dbConns', 'AWS/RDS', 'DatabaseConnections', dims, 'Average'),
            );
        } else if (dbTarget?.kind === 'instance') {
            const dims = [{ Name: 'DBInstanceIdentifier', Value: dbTarget.id }];
            queries.push(
                metricStatQuery('dbPrimary', 'AWS/RDS', 'CPUUtilization', dims, 'Average'),
                metricStatQuery('dbConns', 'AWS/RDS', 'DatabaseConnections', dims, 'Average'),
            );
        }

        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - GOLDEN_SIGNALS_WINDOW_MINUTES * 60 * 1000);
        let resultsById;
        try {
            const resp = await cloudWatchClient.send(new GetMetricDataCommand({
                StartTime: startTime,
                EndTime: endTime,
                ScanBy: 'TimestampDescending',
                MetricDataQueries: queries,
            }));
            resultsById = new Map((resp.MetricDataResults || []).map((r) => [r.Id, r]));
        } catch (error) {
            errors.push(`metrics: ${error?.message || error}`);
            return { alb: null, ecs: null, db: null, errors };
        }

        // TargetResponseTime arrives in seconds; the payload promises ms.
        const latencyP95Seconds = albDimension ? latestValue(resultsById, 'albLatencyP95') : null;
        const alb = albDimension ? {
            requestCount: latestValue(resultsById, 'albRequests'),
            error5xxCount: latestValue(resultsById, 'alb5xx'),
            latencyP95Ms: latencyP95Seconds === null ? null : latencyP95Seconds * 1000,
        } : null;
        const ecs = {
            cpuPercent: latestValue(resultsById, 'ecsCpu'),
            memoryPercent: latestValue(resultsById, 'ecsMem'),
        };
        let db = null;
        if (dbTarget?.kind === 'cluster') {
            db = { kind: 'cluster', engine: dbTarget.engine, capacityAcu: latestValue(resultsById, 'dbPrimary'), connections: latestValue(resultsById, 'dbConns') };
        } else if (dbTarget?.kind === 'instance') {
            db = { kind: 'instance', engine: dbTarget.engine, cpuPercent: latestValue(resultsById, 'dbPrimary'), connections: latestValue(resultsById, 'dbConns') };
        }
        return { alb, ecs, db, errors };
    } catch (error) {
        // Total function: unexpected failures degrade, never throw.
        return failed([`signals: ${error?.message || error}`]);
    }
}
