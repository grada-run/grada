import fs from 'fs';
import path from 'path';
import { load } from 'js-yaml';

// Parse docker-compose.yml (or its aliases) and normalize it into an
// array of services. Filenames are checked in canonical order.
const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

// Image names that are dependencies, never the app: used to keep the
// web-service heuristic (and its warnings) from anointing a database.
export const DATASTORE_IMAGE_PATTERNS = [
    'postgres', 'postgis', 'pgvector', 'mysql', 'mariadb', 'redis',
    'valkey', 'keydb', 'mongo', 'memcached', 'elasticsearch',
    'opensearch', 'cassandra', 'scylla', 'rabbitmq', 'kafka',
    'zookeeper', 'clickhouse', 'cockroach', 'neo4j', 'influxdb',
    'timescale', 'timescaledb', 'surrealdb', 'meilisearch', 'typesense',
    'nats', 'qdrant', 'dragonfly', 'couchdb', 'hazelcast',
];

// True when an image reference names a datastore: the last path segment
// (tag/digest stripped) equals a known pattern or extends it with a
// `-`/`_`/`+` suffix (`redis-stack` matches; `myapp-postgres` does not).
export function isDatastoreImage(image) {
    if (typeof image !== 'string' || image.trim() === '') return false;
    const lastSegment = image.toLowerCase().split('/').pop().split(':')[0].split('@')[0];
    return DATASTORE_IMAGE_PATTERNS.some((pattern) =>
        lastSegment === pattern
        || lastSegment.startsWith(`${pattern}-`)
        || lastSegment.startsWith(`${pattern}_`)
        || lastSegment.startsWith(`${pattern}+`)
    );
}

// Selects the compose service to treat as the app for port overrides and
// env/command merges. Preference order: (1) the service with a `build:`
// key — image-only services are dependencies by definition; (2) a service
// whose port matches the framework default; (3) the first non-datastore
// service with a port, else the first non-datastore service. When every
// service is a datastore there is no app to merge, so the merge is
// skipped (`{ service: null, skipped: 'all-datastores' }`) instead of
// baking a database port into the task definition. `datastoreImage` flags
// a datastore pick from rules 1–2 so callers can warn loudly.
export function selectComposeWebService(services, { frameworkPort = null } = {}) {
    if (!Array.isArray(services) || services.length === 0) {
        return { service: null, skipped: 'empty', datastoreImage: false };
    }
    const withBuild = services.find((s) => s && s.build !== null && s.build !== undefined);
    if (withBuild) {
        return { service: withBuild, skipped: undefined, datastoreImage: isDatastoreImage(withBuild.image) };
    }
    if (frameworkPort !== null && frameworkPort !== undefined && String(frameworkPort) !== '') {
        const matches = services.filter((s) => s && s.port !== null && s.port !== undefined
            && Number(s.port) === Number(frameworkPort));
        if (matches.length > 0) {
            const pick = matches.find((s) => !isDatastoreImage(s.image)) || matches[0];
            return { service: pick, skipped: undefined, datastoreImage: isDatastoreImage(pick.image) };
        }
    }
    const nonDatastores = services.filter((s) => s && !isDatastoreImage(s.image));
    if (nonDatastores.length === 0) {
        return { service: null, skipped: 'all-datastores', datastoreImage: false };
    }
    const fallback = nonDatastores.find((s) => s.port !== null && s.port !== undefined) || nonDatastores[0];
    return { service: fallback, skipped: undefined, datastoreImage: false };
}

// Env names whose values must never be inlined into generated HCL:
// substring match on the uppercased name (`TOKEN` catches SESSION_TOKEN).
export const SECRET_ENV_PATTERNS = [
    'PASSWORD', 'PASSWD', 'SECRET', 'TOKEN', 'PRIVATE_KEY', 'PRIVATEKEY',
    'CREDENTIALS', 'API_KEY', 'APIKEY', 'ACCESS_KEY',
];

export function isSecretLikeEnvName(name) {
    if (typeof name !== 'string' || name === '') return false;
    const upper = name.toUpperCase();
    return SECRET_ENV_PATTERNS.some((pattern) => upper.includes(pattern));
}

// True when a value embeds `user:password@` credentials (connection
// strings like `postgres://app:s3cret@db:5432/app`), whose names alone
// (`DATABASE_URL`) would otherwise pass the filter.
export function valueContainsCredentials(value) {
    if (typeof value !== 'string') return false;
    return /:\/\/[^/\s]*:[^/\s]*@/.test(value);
}

// Splits a compose `environment` map into inlinable entries (`safe`) and
// withheld names (`skipped`): secret-like names or credential-bearing
// values are never rendered — users push those via `grada secrets push`.
export function partitionComposeEnv(environment) {
    const safe = {};
    const skipped = [];
    if (!environment || typeof environment !== 'object') return { safe, skipped };
    for (const [key, value] of Object.entries(environment)) {
        if (isSecretLikeEnvName(key) || valueContainsCredentials(value)) {
            skipped.push(key);
        } else {
            safe[key] = value;
        }
    }
    return { safe, skipped };
}

export function parseDockerCompose(targetDir) {
    let composePath = null;
    for (const filename of COMPOSE_FILENAMES) {
        const candidate = path.join(targetDir, filename);
        if (fs.existsSync(candidate)) {
            composePath = candidate;
            break;
        }
    }

    if (!composePath) return null;

    try {
        const fileContents = fs.readFileSync(composePath, 'utf8');
        const data = load(fileContents);

        if (!data || !data.services) return null;

        const services = [];

        for (const [name, config] of Object.entries(data.services)) {
            // Extract the container port (e.g., "8080:80" -> 80)
            let exposedPort = null;
            if (config.ports && config.ports.length > 0) {
                const firstPort = config.ports[0];
                if (firstPort !== null && typeof firstPort === 'object') {
                    // Long syntax: { target, published } — target is the
                    // container side, matching short-syntax last-segment.
                    const target = Number(firstPort.target ?? firstPort.published);
                    exposedPort = Number.isFinite(target) ? target : null;
                } else {
                    // Handle different port formats like "3000" or "8000:8000" or "127.0.0.1:8001:8001"
                    const portMapping = String(firstPort);
                    const parts = portMapping.split(':');
                    const parsed = parseInt(parts[parts.length - 1].replace(/[^0-9]/g, ''), 10);
                    exposedPort = Number.isFinite(parsed) ? parsed : null;
                }
            }

            // Normalize environment variables from Array or Object
            let envVars = {};
            if (Array.isArray(config.environment)) {
                config.environment.forEach(env => {
                    const [key, ...val] = env.split('=');
                    if (key) envVars[key] = val.join('=');
                });
            } else if (typeof config.environment === 'object') {
                envVars = config.environment;
            }

            services.push({
                name,
                build: config.build || null,
                image: config.image || null,
                port: exposedPort,
                command: config.command || null,
                environment: envVars
            });
        }

        return services;
    } catch (e) {
        console.error('⚠️ Failed to parse Docker Compose file:', e.message);
        return null;
    }
}