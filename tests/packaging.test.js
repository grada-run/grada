import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// The published tarball is an allowlist, not a denylist: a one-line
// .npmignore once shipped 1,004 files (tests, specs, docs site,
// editor configs, and a 645-file trivy cache) while excluding the
// extensions/ scaffolds two tests assert on. A dirty-tree dry-run
// additionally showed gitignored internal notes shipping through
// the same hole; the allowlist prevents that class by
// construction. This gate pins the contract so the pack can only
// change by deliberate diff.
describe('packaging: published tarball contract', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));

    // Mirrors npm's `files` matching for our simple entries (exact file
    // or dir-prefix with trailing slash).
    function isCovered(filePath, files) {
        return files.some((entry) => entry.endsWith('/')
            ? filePath === entry.slice(0, -1) || filePath.startsWith(entry)
            : filePath === entry);
    }

    it('declares an exact files allowlist', () => {
        expect(pkg.files).toEqual(['bin/', 'src/', 'templates/', 'package.json']);
    });

    it('has no .npmignore to silently override the allowlist', () => {
        // When .npmignore exists npm ignores .gitignore entirely —
        // that override trap is what would ship gitignored trees
        // (.muse/, .cache/, tests/e2e/.tmp/) alongside the tracked
        // bloat. A single source of truth only.
        expect(fs.existsSync(path.resolve('.npmignore'))).toBe(false);
    });

    it('covers every runtime read root', () => {
        // bin/cli.js (entry), templates/ (generator), package.json
        // (version climb), src/data (bedrock catalog). If a runtime
        // read moves outside these roots, the allowlist must move too.
        expect(isCovered('bin/cli.js', pkg.files)).toBe(true);
        expect(isCovered('templates/main.tf', pkg.files)).toBe(true);
        expect(isCovered('package.json', pkg.files)).toBe(true);
        expect(isCovered('src/data/bedrock-models.json', pkg.files)).toBe(true);
        expect(fs.existsSync(path.resolve('src/data/bedrock-models.json'))).toBe(true);
        expect(fs.readdirSync(path.resolve('templates')).length).toBeGreaterThan(0);
    });

    it('excludes every known non-runtime root', () => {
        const nonRuntime = [
            'tests/db.test.js',
            'tests/e2e/.tmp/leftover-workspace/terraform/main.tf',
            'vitest.config.js',
            'specs/status.md',
            'apps/docs/package.json',
            '.github/workflows/publish.yml',
            '.muse/bug-reports/grada-0.40.6-review.md',
            '.cache/trivy',
            'extensions/vscode/package.json',
            'extensions/zed/extension.toml',
            'skills/grada-aws-infrastructure/SKILL.md',
            'assets/logo.svg',
            'scripts/sync-bedrock-models.js',
            'marketplace-launch.md',
            'release_notes.md',
            'Dockerfile',
            '.cursor/rules/grada.mdc',
            '.windsurfrules',
        ];
        for (const filePath of nonRuntime) {
            expect(isCovered(filePath, pkg.files)).toBe(false);
        }
    });
});
