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
            env: { ...process.env, DO_NOT_TRACK: '1', FORCE_COLOR: '0' },
            timeout: 30000,
        });
        return { status: 0, stdout };
    } catch (error) {
        return { status: error.status ?? 1, stdout: String(error.stdout ?? '') };
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

    it('bare --help still prints the top-level usage', () => {
        const { status, stdout } = runCliHelp(['--help']);
        expect(status).toBe(0);
        expect(stdout).toContain('grada — Provision production-ready AWS infrastructure');
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