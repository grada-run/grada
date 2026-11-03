import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { analyzeNextConfig, detectFramework, detectMigrationCommand, detectOrmMigrationCommand, frameworkDefaultPort, frameworkUsesStrippedRunner, isNpmShimCommand, dockerfileStripsNpmShims, ormMappedHintSegment, toHclStringArray } from '../src/utils/detector.js';

function makeProject(files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-migrate-'));
    for (const [name, content] of Object.entries(files)) {
        const full = path.join(dir, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    return dir;
}

describe('detectMigrationCommand', () => {
    it('prefers the db:migrate npm script', () => {
        const dir = makeProject({
            'package.json': JSON.stringify({ scripts: { 'db:migrate': 'prisma migrate deploy', migrate: 'other' } }),
        });
        expect(detectMigrationCommand(dir)).toBe('npm run db:migrate');
    });

    it('falls back to the migrate npm script', () => {
        const dir = makeProject({
            'package.json': JSON.stringify({ scripts: { migrate: 'knex migrate:latest' } }),
        });
        expect(detectMigrationCommand(dir)).toBe('npm run migrate');
    });

    it('detects Prisma via schema file or dependency', () => {
        expect(detectMigrationCommand(makeProject({ 'prisma/schema.prisma': 'datasource db {}' })))
            .toBe('npx prisma migrate deploy');
        expect(detectMigrationCommand(makeProject({
            'package.json': JSON.stringify({ dependencies: { prisma: '^5.0.0' } }),
        }))).toBe('npx prisma migrate deploy');
        expect(detectMigrationCommand(makeProject({
            'package.json': JSON.stringify({ devDependencies: { prisma: '^5.0.0' } }),
        }))).toBe('npx prisma migrate deploy');
    });

    it('maps Drizzle markers to the bundled node migrator', () => {
        for (const file of ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs']) {
            expect(detectMigrationCommand(makeProject({ [file]: 'export default {}' })))
                .toBe('node ./dist/migrate.cjs');
        }
        for (const dep of ['drizzle-kit', 'drizzle-orm']) {
            expect(detectMigrationCommand(makeProject({
                'package.json': JSON.stringify({ dependencies: { [dep]: '^0.30.0' } }),
            }))).toBe('node ./dist/migrate.cjs');
            expect(detectMigrationCommand(makeProject({
                'package.json': JSON.stringify({ devDependencies: { [dep]: '^0.30.0' } }),
            }))).toBe('node ./dist/migrate.cjs');
        }
    });

    it('maps Prisma v6/v7 markers to the direct node CLI entry', () => {
        for (const version of ['^6.0.0', '~7.2.1', '6.19.3']) {
            expect(detectMigrationCommand(makeProject({
                'package.json': JSON.stringify({ dependencies: { prisma: version } }),
            }))).toBe('node ./node_modules/prisma/build/index.js migrate deploy');
        }
        expect(detectMigrationCommand(makeProject({
            'prisma/schema.prisma': 'datasource db {}',
            'package.json': JSON.stringify({ dependencies: { prisma: '^6.0.0' } }),
        }))).toBe('node ./node_modules/prisma/build/index.js migrate deploy');
    });

    it('keeps the npx fallback for unmappable Prisma (v5, v8, unresolvable)', () => {
        for (const version of ['^5.0.0', '^8.0.0', 'latest', '*']) {
            expect(detectMigrationCommand(makeProject({
                'package.json': JSON.stringify({ dependencies: { prisma: version } }),
            }))).toBe('npx prisma migrate deploy');
        }
        expect(detectMigrationCommand(makeProject({ 'prisma/schema.prisma': 'datasource db {}' })))
            .toBe('npx prisma migrate deploy');
    });

    it('exposes the mapped ORM command for hints and warnings', () => {
        expect(detectOrmMigrationCommand(makeProject({
            'package.json': JSON.stringify({ dependencies: { 'drizzle-orm': '^0.30.0' } }),
        }))).toEqual({ command: 'node ./dist/migrate.cjs', orm: 'drizzle' });
        expect(detectOrmMigrationCommand(makeProject({
            'package.json': JSON.stringify({ dependencies: { prisma: '^7.0.0' } }),
        }))).toEqual({ command: 'node ./node_modules/prisma/build/index.js migrate deploy', orm: 'prisma' });
        expect(detectOrmMigrationCommand(makeProject({
            'package.json': JSON.stringify({ dependencies: { prisma: '^8.0.0' } }),
        }))).toBeNull();
        expect(detectOrmMigrationCommand(makeProject({ 'manage.py': '# django' }))).toBeNull();
        expect(detectOrmMigrationCommand(makeProject({}))).toBeNull();
    });

    it('builds the mapped-hint segment for refusal hints and warnings', () => {
        const drizzle = makeProject({
            'package.json': JSON.stringify({ dependencies: { 'drizzle-orm': '^0.30.0' } }),
        });
        expect(ormMappedHintSegment(drizzle, '--cmd '))
            .toBe(' Detected Drizzle ORM — re-run with --cmd "node ./dist/migrate.cjs" instead');
        expect(ormMappedHintSegment(drizzle, '--setup-ci-migrate='))
            .toBe(' Detected Drizzle ORM — re-run with --setup-ci-migrate="node ./dist/migrate.cjs" instead');
        const prisma = makeProject({
            'package.json': JSON.stringify({ dependencies: { prisma: '^6.0.0' } }),
        });
        expect(ormMappedHintSegment(prisma, '--cmd '))
            .toBe(' Detected Prisma — re-run with --cmd "node ./node_modules/prisma/build/index.js migrate deploy" instead');
        expect(ormMappedHintSegment(makeProject({}))).toBe('');
        expect(ormMappedHintSegment(makeProject({
            'package.json': JSON.stringify({ dependencies: { prisma: '^8.0.0' } }),
        }))).toBe('');
    });

    it('keeps explicit scripts ahead of ORM markers', () => {
        const dir = makeProject({
            'package.json': JSON.stringify({
                scripts: { 'db:migrate': 'node custom.js' },
                dependencies: { 'drizzle-orm': '^0.30.0' },
            }),
        });
        expect(detectMigrationCommand(dir)).toBe('npm run db:migrate');
    });

    it('detects Alembic, Django, and Rails markers', () => {
        expect(detectMigrationCommand(makeProject({ 'alembic.ini': '[alembic]' })))
            .toBe('alembic upgrade head');
        expect(detectMigrationCommand(makeProject({ 'manage.py': '# django' })))
            .toBe('python manage.py migrate --noinput');
        expect(detectMigrationCommand(makeProject({ 'bin/rails': '#!/usr/bin/env ruby' })))
            .toBe('bundle exec rails db:migrate');
        expect(detectMigrationCommand(makeProject({ Gemfile: 'source "https://rubygems.org"\ngem "rails"\n' })))
            .toBe('bundle exec rails db:migrate');
    });

    it('ignores a Gemfile without rails', () => {
        const dir = makeProject({ Gemfile: 'source "https://rubygems.org"\ngem "sinatra"\n' });
        expect(detectMigrationCommand(dir)).toBeNull();
    });

    it('returns null for empty projects and survives malformed files', () => {
        expect(detectMigrationCommand(makeProject({}))).toBeNull();
        expect(detectMigrationCommand(makeProject({ 'package.json': 'not-json{{{' }))).toBeNull();
        expect(detectMigrationCommand('/nonexistent-dir-xyz')).toBeNull();
    });

    it('keeps priority order across mixed markers', () => {
        const dir = makeProject({
            'package.json': JSON.stringify({ scripts: { migrate: 'x' }, dependencies: { prisma: '1' } }),
            'manage.py': '# django',
        });
        expect(detectMigrationCommand(dir)).toBe('npm run migrate');
    });

    it('prefers the prescribed migration bundle over npm shims and framework markers', () => {
        const dir = makeProject({
            'package.json': JSON.stringify({ scripts: { migrate: 'drizzle-kit migrate' } }),
            'drizzle.config.ts': 'export default {}',
            'dist/migrate.cjs': 'module.exports = {}',
        });
        expect(detectMigrationCommand(dir)).toBe('node ./dist/migrate.cjs');
    });

    it('falls back through dist .mjs and scripts/ bundles', () => {
        expect(detectMigrationCommand(makeProject({ 'dist/migrate.mjs': 'export default {}' })))
            .toBe('node ./dist/migrate.mjs');
        expect(detectMigrationCommand(makeProject({ 'scripts/migrate.cjs': 'module.exports = {}' })))
            .toBe('node ./scripts/migrate.cjs');
        expect(detectMigrationCommand(makeProject({ 'scripts/migrate.mjs': 'export default {}' })))
            .toBe('node ./scripts/migrate.mjs');
    });
});

describe('detectFramework SvelteKit contract', () => {
    it("maps @sveltejs/kit to id 'svelte' (init.js adapter-warning predicate)", () => {
        const dir = makeProject({
            'package.json': JSON.stringify({ dependencies: { '@sveltejs/kit': '2.0.0' } }),
        });
        expect(detectFramework(dir)).toMatchObject({ id: 'svelte', buildDir: 'build' });
    });
});

describe('detectFramework static-export detection', () => {
    it("flags Next.js output:'export' with buildDir 'out' (--target static gate)", () => {
        const dir = makeProject({
            'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
            'next.config.js': "module.exports = { output: 'export' };\n",
        });
        expect(detectFramework(dir)).toMatchObject({
            id: 'nextjs',
            name: 'Next.js Static Export',
            buildDir: 'out',
            isStaticExport: true,
        });
    });

    it('does not flag Next.js standalone or config-less apps', () => {
        const standalone = makeProject({
            'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
            'next.config.js': "module.exports = { output: 'standalone' };\n",
        });
        expect(detectFramework(standalone)).toMatchObject({ id: 'nextjs' });
        expect(detectFramework(standalone).isStaticExport).toBeUndefined();
        const bare = makeProject({
            'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
        });
        expect(detectFramework(bare)).toMatchObject({ id: 'nextjs' });
        expect(detectFramework(bare).isStaticExport).toBeUndefined();
    });

    it('reads output export with double quotes and odd spacing', () => {
        const dir = makeProject({
            'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
            'next.config.mjs': 'export default { output  :  "export" };\n',
        });
        expect(analyzeNextConfig(dir).isExport).toBe(true);
        expect(detectFramework(dir).isStaticExport).toBe(true);
    });

    it('flags SvelteKit adapter-static with buildDir build (--target static gate)', () => {
        const dir = makeProject({
            'package.json': JSON.stringify({ dependencies: { '@sveltejs/kit': '2.0.0' } }),
            'svelte.config.js': "import adapter from '@sveltejs/adapter-static';\nexport default { kit: { adapter: adapter() } };\n",
        });
        expect(detectFramework(dir)).toMatchObject({
            id: 'svelte',
            name: 'SvelteKit Static',
            buildDir: 'build',
            isStaticExport: true,
        });
    });

    it('does not flag SvelteKit adapter-auto as a static export', () => {
        const dir = makeProject({
            'package.json': JSON.stringify({ dependencies: { '@sveltejs/kit': '2.0.0' } }),
            'svelte.config.js': "import adapter from '@sveltejs/adapter-auto';\nexport default { kit: { adapter: adapter() } };\n",
        });
        expect(detectFramework(dir)).toMatchObject({ id: 'svelte', name: 'SvelteKit SSR' });
        expect(detectFramework(dir).isStaticExport).toBeUndefined();
    });
});

describe('frameworkDefaultPort', () => {
    it.each([
        ['nextjs', '3000'],
        ['node', '3000'],
        ['rails', '3000'],
        ['static', '8080'],
        ['go', '8080'],
        ['python', '8000'],
        ['django', '8000'],
        ['unknown-framework', '3000'],
        [null, '3000'],
        [undefined, '3000'],
    ])('maps %s to port %s', (framework, expected) => {
        expect(frameworkDefaultPort(framework)).toBe(expected);
    });
});

describe('stripped-runner detection', () => {
    it.each([
        ['node', true],
        ['nestjs', true],
        ['nextjs', true],
        ['nuxt', true],
        ['svelte', true],
        ['python', false],
        ['django', false],
        ['rails', false],
        ['go', false],
        ['static', false],
    ])('frameworkUsesStrippedRunner(%s) is %s', (framework, expected) => {
        expect(frameworkUsesStrippedRunner(framework)).toBe(expected);
    });

    it.each([
        ['npm run db:migrate', true],
        ['npx drizzle-kit migrate', true],
        ['npx prisma migrate deploy', true],
        ['yarn db:migrate', true],
        ['  npm run cron  ', true],
        ['NODE_ENV=production npm run migrate', true],
        ['node ./dist/migrate.cjs', false],
        ['node ./dist/migrate.mjs', false],
        ['alembic upgrade head', false],
        ['python manage.py migrate --noinput', false],
        ['bundle exec rails db:migrate', false],
        ['', false],
        [null, false],
    ])('isNpmShimCommand(%s) is %s', (cmd, expected) => {
        expect(isNpmShimCommand(cmd)).toBe(expected);
    });

    it('detects the npx strip line in Grada Dockerfiles', () => {
        const stripped = [
            'FROM node:22-alpine AS runner',
            'RUN apk upgrade --no-cache && \\',
            '    rm -rf /usr/local/lib/node_modules/npm \\',
            '    /usr/local/bin/npm \\',
            '    /usr/local/bin/npx \\',
            '',
        ].join('\n');
        expect(dockerfileStripsNpmShims(stripped)).toBe(true);
        expect(dockerfileStripsNpmShims('FROM node:22-alpine\nRUN npm ci\n')).toBe(false);
        expect(dockerfileStripsNpmShims('')).toBe(false);
        expect(dockerfileStripsNpmShims(null)).toBe(false);
    });

    it('ignores marker mentions in comments but not quoted hashes before a real strip', () => {
        // Comment-only mention: no strip, no guard trip.
        expect(dockerfileStripsNpmShims('FROM node:22-alpine\n# we used to rm /usr/local/bin/npx here\nRUN npm ci\n')).toBe(false);
        // Trailing comment after a real strip still counts.
        expect(dockerfileStripsNpmShims('FROM node:22-alpine\nRUN rm -rf /usr/local/bin/npx # slim the image\n')).toBe(true);
        // A quoted hash earlier on the line must not hide a real strip.
        expect(dockerfileStripsNpmShims('FROM node:22-alpine\nRUN echo "#" && rm -rf /usr/local/bin/npx\n')).toBe(true);
    });
});

describe('toHclStringArray', () => {
    it('renders multi-element arrays with fmt-canonical spacing', () => {
        expect(toHclStringArray(['node', './dist/worker.cjs'])).toBe('["node", "./dist/worker.cjs"]');
        expect(toHclStringArray(['sh', '-c', 'node server.js'])).toBe('["sh", "-c", "node server.js"]');
    });

    it('handles single elements and JSON escaping', () => {
        expect(toHclStringArray(['node worker.js'])).toBe('["node worker.js"]');
        expect(toHclStringArray(['echo', 'say "hi"'])).toBe('["echo", "say \\"hi\\""]');
        expect(toHclStringArray([])).toBe('[]');
    });
});
