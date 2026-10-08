import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

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