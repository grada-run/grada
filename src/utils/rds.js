import { DescribeDBInstancesCommand, DescribeDBClustersCommand } from '@aws-sdk/client-rds';
import { resolveProjectName, resolveWorkspaceSuffix, readResourceSuffix } from './resolvers.js';
import { normalizeOptions } from './args.js';

// Error names the RDS API returns for a missing instance across SDK shapes.
const NOT_FOUND_NAMES = new Set(['DBInstanceNotFound', 'DBInstanceNotFoundFault']);

// Same convention for Aurora clusters.
const CLUSTER_NOT_FOUND_NAMES = new Set(['DBClusterNotFound', 'DBClusterNotFoundFault']);

// Shared RDS instance lookup for every `db` subcommand: exact identifier
// match, `null` when the project has no database, unexpected errors rethrown.
export async function findDbInstance(rdsClient, dbIdentifier) {
    try {
        const resp = await rdsClient.send(
            new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbIdentifier })
        );
        return (resp.DBInstances || [])[0] || null;
    } catch (error) {
        if (error && NOT_FOUND_NAMES.has(error.name)) return null;
        throw error;
    }
}

// Shared Aurora cluster lookup: exact identifier match, `null` when no
// cluster exists under it, unexpected errors rethrown.
export async function findDbCluster(rdsClient, dbClusterIdentifier) {
    try {
        const resp = await rdsClient.send(
            new DescribeDBClustersCommand({ DBClusterIdentifier: dbClusterIdentifier })
        );
        return (resp.DBClusters || [])[0] || null;
    } catch (error) {
        if (error && CLUSTER_NOT_FOUND_NAMES.has(error.name)) return null;
        throw error;
    }
}

function isMysqlEngine(engine) {
    return engine === 'mysql' || engine === 'aurora-mysql';
}

// RDS API asymmetry: DB instances report `DBInstanceStatus`, Aurora
// clusters report `Status`. Every status read goes through here — reading
// `Status` off an instance yields undefined and hung the destroy/wake
// wait loops forever (P2 live incident: `(undefined)` status polling).
export function dbStatusOf(record, kind) {
    if (!record) return null;
    if (kind === 'cluster') return record.Status ?? null;
    return record.DBInstanceStatus ?? null;
}

// Unified RDS discovery across single instances and Aurora clusters.
// Tries the instance identifier first (zero extra API calls for the common
// postgres/mysql case), then the cluster identifiers. Returns a normalized
// descriptor `{ kind, id, engine, status, endpoint, port, dbName,
// masterSecretArn, raw }` or `null` when nothing is provisioned.
export async function findDbTarget(rdsClient, { dbIdentifier, dbClusterIdentifier } = {}) {
    if (dbIdentifier) {
        const instance = await findDbInstance(rdsClient, dbIdentifier);
        if (instance) {
            const port = instance.Endpoint?.Port ?? (isMysqlEngine(instance.Engine) ? 3306 : 5432);
            return {
                kind: 'instance',
                id: dbIdentifier,
                engine: instance.Engine,
                status: dbStatusOf(instance, 'instance'),
                endpoint: instance.Endpoint?.Address,
                port: String(port),
                dbName: instance.DBName,
                masterSecretArn: instance.MasterUserSecret?.SecretArn,
                raw: instance,
            };
        }
    }
    const clusterIds = [dbClusterIdentifier, dbIdentifier].filter(
        (id, index, list) => typeof id === 'string' && id !== '' && list.indexOf(id) === index
    );
    for (const clusterId of clusterIds) {
        const cluster = await findDbCluster(rdsClient, clusterId);
        if (cluster) {
            const port = cluster.Port ?? (isMysqlEngine(cluster.Engine) ? 3306 : 5432);
            return {
                kind: 'cluster',
                id: clusterId,
                engine: cluster.Engine,
                status: dbStatusOf(cluster, 'cluster'),
                endpoint: cluster.Endpoint,
                port: String(port),
                dbName: cluster.DatabaseName,
                masterSecretArn: cluster.MasterUserSecret?.SecretArn,
                raw: cluster,
            };
        }
    }
    return null;
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

// Default manual snapshot id: `<db>-manual-YYYYMMDD-HHmmss` in UTC.
// Lowercased so project names with uppercase stay RDS-safe.
export function generateSnapshotId(dbIdentifier, now = new Date()) {
    const stamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`
        + `-${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`;
    return `${dbIdentifier}-manual-${stamp}`.toLowerCase();
}

// RDS snapshot identifier rules: starts with a letter, letters/digits/hyphens
// after that, no consecutive hyphens, no trailing hyphen, max 255 chars.
export function isValidSnapshotId(id) {
    if (typeof id !== 'string') return false;
    if (!/^[a-zA-Z][a-zA-Z0-9-]{0,254}$/.test(id)) return false;
    if (id.includes('--') || id.endsWith('-')) return false;
    return true;
}

// Database identifier for the current project/workspace. An explicit
// `--db-identifier` override wins; otherwise `<appName>-db`.
export function resolveDbIdentifier(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    if (typeof opts.dbIdentifier === 'string' && opts.dbIdentifier.trim()) {
        return opts.dbIdentifier.trim();
    }
    const base = resolveProjectName(opts, cwd);
    return `${base}${resolveWorkspaceSuffix(opts, cwd)}${readResourceSuffix(cwd)}-db`;
}

// Aurora cluster identifier for the current project/workspace. An explicit
// `--db-identifier` override wins (tried as both kinds); otherwise
// `<appName>-db-cluster`, matching the generated cluster_identifier.
export function resolveDbClusterIdentifier(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    if (typeof opts.dbIdentifier === 'string' && opts.dbIdentifier.trim()) {
        return opts.dbIdentifier.trim();
    }
    const base = resolveProjectName(opts, cwd);
    return `${base}${resolveWorkspaceSuffix(opts, cwd)}${readResourceSuffix(cwd)}-db-cluster`;
}
