import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.join(here, '..', 'src', 'commands');

// Guards against telemetry helpers used without imports (e.g. `trackSuccess`
// referenced but never imported from '../core/telemetry.js'). Such typos only
// throw at runtime on the affected path, so the suite scans every command
// module statically instead of relying on path coverage.
function codeTokens(source) {
    // Strip comments; strip string contents but keep template interpolations
    // (a real call could hide inside `${...}`).
    const withoutComments = source
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    const withTemplatesExpanded = withoutComments.replace(/`(?:\\.|[^`\\])*`/g, (span) => {
        const exprs = [...span.matchAll(/\$\{([^{}]*)\}/g)].map((m) => m[1]);
        return ` ${exprs.join(' ')} `;
    });
    const codeOnly = withTemplatesExpanded
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""');
    return codeOnly.match(/\btrack[A-Z][A-Za-z0-9]*\b/g) || [];
}

function telemetryImports(source) {
    const names = new Set();
    // Telemetry helpers live in core/telemetry.js — except the shared
    // trackAwsFailure stamps helper, which command.js defines alongside
    // failAwsError (both are equally typo-proof imports).
    const importRe = /import\s*\{([^}]*)\}\s*from\s*['"](?:\.\.\/)+(?:core\/telemetry|utils\/command)\.js['"]/g;
    for (const match of source.matchAll(importRe)) {
        for (const spec of match[1].split(',')) {
            const name = spec.trim().split(/\s+as\s+/)[0].trim();
            if (name) names.add(name);
        }
    }
    return names;
}

function localDefinitions(source, token) {
    return new RegExp(`\\b(?:function|const|let|var|class)\\s+${token}\\b`).test(source);
}

describe('command telemetry imports', () => {
    // Recursively collect command modules so subdirectories (e.g.
    // `src/commands/db/`) are guarded the same as top-level commands.
    const commandFiles = [];
    const walk = (dir, prefix = '') => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
            } else if (entry.name.endsWith('.js')) {
                commandFiles.push(`${prefix}${entry.name}`);
            }
        }
    };
    walk(COMMANDS_DIR);

    it('finds command modules to audit', () => {
        expect(commandFiles.length).toBeGreaterThan(0);
    });

    for (const file of commandFiles) {
        it(`${file} imports every telemetry helper it references`, () => {
            const source = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8');
            const imported = telemetryImports(source);
            const undeclared = [...new Set(codeTokens(source))].filter(
                (token) => !imported.has(token) && !localDefinitions(source, token)
            );
            expect(undeclared).toEqual([]);
        });
    }
});
