import { describe, it, expect } from 'vitest';
import {
    selectComposeWebService,
    isDatastoreImage,
    isSecretLikeEnvName,
    partitionComposeEnv,
} from '../src/utils/dockerCompose.js';

describe('isDatastoreImage', () => {
    it.each([
        ['postgres:16', true],
        ['docker.io/library/postgres:15-alpine', true],
        ['postgis/postgis:16-3.4', true],
        ['mysql:8.0', true],
        ['mariadb:11', true],
        ['redis:alpine', true],
        ['redis/redis-stack:latest', true],
        ['valkey/valkey:8', true],
        ['mongo:7', true],
        ['memcached:1', true],
        ['myapp-postgres-migrator:1', false],
        ['myapp:latest', false],
        ['node:22-alpine', false],
        [null, false],
        [undefined, false],
        ['', false],
    ])('classifies %s as datastore=%s', (image, expected) => {
        expect(isDatastoreImage(image)).toBe(expected);
    });
});

describe('selectComposeWebService', () => {
    it('prefers the service with a build key over a first-listed datastore with ports', () => {
        const services = [
            { name: 'postgres', image: 'postgres:16', port: 5432, build: null, environment: {} },
            { name: 'web', image: 'myapp:latest', port: 3000, build: { context: '.' }, environment: {} },
        ];
        const { service, skipped } = selectComposeWebService(services, { frameworkPort: '3000' });
        expect(skipped).toBeUndefined();
        expect(service.name).toBe('web');
    });

    it('matches the framework default port when no service has a build key', () => {
        const services = [
            { name: 'postgres', image: 'postgres:16', port: 5432, build: null, environment: {} },
            { name: 'app', image: 'myapp:latest', port: 3000, build: null, environment: {} },
        ];
        const { service, skipped } = selectComposeWebService(services, { frameworkPort: '3000' });
        expect(skipped).toBeUndefined();
        expect(service.name).toBe('app');
    });

    it('skips the merge entirely when every service is a datastore', () => {
        const services = [
            { name: 'postgres', image: 'postgres:16', port: 5432, build: null, environment: {} },
            { name: 'valkey', image: 'valkey/valkey:8', port: 6379, build: null, environment: {} },
        ];
        const { service, skipped } = selectComposeWebService(services, { frameworkPort: '3000' });
        expect(service).toBeNull();
        expect(skipped).toBe('all-datastores');
    });

    it('falls back to the first non-datastore service when nothing else matches', () => {
        const services = [
            { name: 'postgres', image: 'postgres:16', port: 5432, build: null, environment: {} },
            { name: 'worker', image: 'myapp:latest', port: null, build: null, environment: {} },
        ];
        const { service, skipped } = selectComposeWebService(services, { frameworkPort: '3000' });
        expect(skipped).toBeUndefined();
        expect(service.name).toBe('worker');
    });

    it('flags a datastore pick so callers can warn (backstop)', () => {
        const services = [
            { name: 'postgres', image: 'postgres:16', port: 3000, build: { context: '.' }, environment: {} },
        ];
        const { service, datastoreImage } = selectComposeWebService(services, { frameworkPort: '3000' });
        expect(service.name).toBe('postgres');
        expect(datastoreImage).toBe(true);
    });

    it('handles empty input without throwing', () => {
        expect(selectComposeWebService([], { frameworkPort: '3000' }).service).toBeNull();
        expect(selectComposeWebService(null, { frameworkPort: '3000' }).service).toBeNull();
    });
});

describe('isSecretLikeEnvName', () => {
    it.each([
        'POSTGRES_PASSWORD', 'password', 'DB_PASSWD', 'API_SECRET', 'secret_key',
        'AUTH_TOKEN', 'token', 'PRIVATE_KEY', 'AWS_SECRET_ACCESS_KEY', 'CREDENTIALS',
        'API_KEY', 'SESSION_TOKEN',
    ])('flags %s as secret-like', (name) => {
        expect(isSecretLikeEnvName(name)).toBe(true);
    });

    it.each([
        'PORT', 'NODE_ENV', 'POSTGRES_USER', 'POSTGRES_DB', 'REDIS_URL', 'SQS_QUEUE_URL', 'DATABASE_URL',
    ])('passes %s through as safe', (name) => {
        expect(isSecretLikeEnvName(name)).toBe(false);
    });

    it('also flags values with embedded credentials (connection strings)', () => {
        const { safe, skipped } = partitionComposeEnv({
            DATABASE_URL: 'postgres://app:s3cret@db:5432/app',
            REDIS_URL: 'redis://valkey:6379',
        });
        expect(safe).toEqual({ REDIS_URL: 'redis://valkey:6379' });
        expect(skipped).toEqual(['DATABASE_URL']);
    });

    it('handles non-string input without throwing', () => {
        expect(isSecretLikeEnvName(null)).toBe(false);
        expect(isSecretLikeEnvName(undefined)).toBe(false);
        expect(isSecretLikeEnvName('')).toBe(false);
    });
});

describe('partitionComposeEnv', () => {
    it('splits safe entries from secret-like ones, preserving values', () => {
        const { safe, skipped } = partitionComposeEnv({
            POSTGRES_USER: 'app',
            POSTGRES_PASSWORD: 's3cret',
            PORT: '3000',
        });
        expect(safe).toEqual({ POSTGRES_USER: 'app', PORT: '3000' });
        expect(skipped).toEqual(['POSTGRES_PASSWORD']);
    });

    it('handles empty and missing input', () => {
        expect(partitionComposeEnv({})).toEqual({ safe: {}, skipped: [] });
        expect(partitionComposeEnv(null)).toEqual({ safe: {}, skipped: [] });
        expect(partitionComposeEnv(undefined)).toEqual({ safe: {}, skipped: [] });
    });
});
