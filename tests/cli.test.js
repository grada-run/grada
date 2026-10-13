import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI_PATH = path.resolve(__dirname, '../bin/cli.js');

function runCliHelp(args) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grada-help-'));
    try {
        const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
            encoding: 'utf8',
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, DO_NOT_TRACK: '1', FORCE_COLOR: '0' },
            timeout: 60000,
        });
        return { status: 0, stdout, stderr: '', entries: fs.readdirSync(cwd) };
    } catch (error) {
        return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), entries: fs.readdirSync(cwd) };
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
}

describe('CLI Executable', () => {
    it('must have the Node.js shebang at the top to prevent bash execution errors', () => {
        const cliPath = path.resolve(__dirname, '../bin/cli.js');
        const content = fs.readFileSync(cliPath, 'utf8');

        expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
    });

    it('must have executable permissions', () => {
        const cliPath = path.resolve(__dirname, '../bin/cli.js');
        const stats = fs.statSync(cliPath);

        // Checks if the file is executable by the owner (Unix permission check)
        const isExecutable = (stats.mode & fs.constants.S_IXUSR) !== 0;
        expect(isExecutable).toBe(true);
    });

    it('documents the --target chooser in help text', () => {
        const cliPath = path.resolve(__dirname, '../bin/cli.js');
        const content = fs.readFileSync(cliPath, 'utf8');

        expect(content).toContain('--target <ecs|lambda|static>');
        expect(content).toContain('Fargate vs Lambda');
    });

    it.each(['destroy', 'sleep', 'gc', 'logs', 'status', 'rollback', 'exec'])(
        '%s --help prints usage instead of executing',
        (cmd) => {
            const { status, stdout } = runCliHelp([cmd, '--help']);
            expect(status).toBe(0);
            expect(stdout).toContain('Usage:');
        }
    );

    it('destroy --help prints exactly the top-level usage (no flow output)', () => {
        const bare = runCliHelp(['--help']);
        const sub = runCliHelp(['destroy', '--help']);
        expect(sub.status).toBe(0);
        expect(sub.stdout).toBe(bare.stdout);
    });

    it('db --help keeps its db-specific usage', () => {
        const { stdout } = runCliHelp(['db', '--help']);
        expect(stdout).toContain('db migrate');
        expect(stdout).toContain('db backup');
    });

    it.each(['migrate', 'backup', 'connect', 'enable-vector', 'restore', 'import'])(
        'db %s --help prints db usage instead of executing',
        (leaf) => {
            const { status, stdout } = runCliHelp(['db', leaf, '--help']);
            expect(status).toBe(0);
            expect(stdout).toContain('db migrate');
            expect(stdout).not.toContain('grada — Provision production-ready AWS infrastructure');
        }
    );

    it('bare --help still prints the top-level usage', () => {
        const { status, stdout } = runCliHelp(['--help']);
        expect(status).toBe(0);
        expect(stdout).toContain('grada — Provision production-ready AWS infrastructure');
    });

    it.each([['--version'], ['-v']])('%s prints the CLI version and exits 0', (flag) => {
        const { status, stdout } = runCliHelp([flag]);
        const { version } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
        expect(status).toBe(0);
        expect(stdout.trim()).toBe(`grada ${version}`);
    });

    it('destroy --version prints the version instead of executing', () => {
        const { status, stdout } = runCliHelp(['destroy', '--version']);
        expect(status).toBe(0);
        expect(stdout).toMatch(/^grada \d+\.\d+\.\d+/m);
    });

    it('db --version prints the version (no db exemption for version)', () => {
        const { status, stdout } = runCliHelp(['db', '--version']);
        expect(status).toBe(0);
        expect(stdout).toMatch(/^grada \d+\.\d+\.\d+/m);
    });

    it('documents --version in the global options', () => {
        const content = fs.readFileSync(CLI_PATH, 'utf8');
        expect(content).toContain('--version, -v');
    });

    it('rejects unknown commands with usage and exit 1, writing nothing', () => {
        const { status, stdout, stderr, entries } = runCliHelp(['frobnicate', '--headless', '--offline']);
        expect(status).toBe(1);
        expect(stderr).toContain('Unknown command "frobnicate"');
        expect(stdout).toContain('grada — Provision production-ready AWS infrastructure');
        expect(entries).toEqual([]);
    });

    it('still routes an explicit init positional to scaffolding', () => {
        const { status, entries } = runCliHelp(['init', '--headless', '--framework=node', '--offline']);
        expect(status).toBe(0);
        expect(entries).toContain('terraform');
    });

    it('still routes bare no-args invocations to the init wizard', () => {
        const content = fs.readFileSync(CLI_PATH, 'utf8');
        expect(content).toMatch(/positionalArgs\[0\] === undefined[\s\S]{0,200}mainStack/);
    });

    it('documents the telemetry opt-out in help text and routes the command', () => {
        const cliPath = path.resolve(__dirname, '../bin/cli.js');
        const content = fs.readFileSync(cliPath, 'utf8');

        expect(content).toContain('telemetry off|on|status');
        expect(content).toContain('--no-telemetry');
        expect(content).toContain('DO_NOT_TRACK=1');
        expect(content).toContain("positionalArgs[0] === 'telemetry'");
        expect(content).toContain('runTelemetry');
    });
});