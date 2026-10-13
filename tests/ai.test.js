import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { mockMultiselect } from './helpers/clack.js';
import fs from 'fs/promises';
import path from 'path';
import { syncAi } from '../src/commands/sync-ai.js';
import { injectManagedBlock } from '../src/utils/ai-rules.js';

// 1. Mock the interactive prompts to simulate user input

// Simulate the user selecting 'claude' from the list and hitting Enter
mockMultiselect.mockResolvedValue(['claude']);

// 2. Mock telemetry to prevent real network calls

describe('AI Context Synchronization', () => {
    const originalCwd = process.cwd();
    const testDir = path.join(originalCwd, 'tests', '.tmp-ai-env');

    beforeEach(async () => {
        // Create a fake project directory and step into it
        await fs.mkdir(testDir, { recursive: true });
        process.chdir(testDir);
    });

    afterEach(async () => {
        // Step back out and clean up
        process.chdir(originalCwd);
        await fs.rm(testDir, { recursive: true, force: true });
        vi.clearAllMocks();
    });

    it('safely injects managed blocks without overwriting existing user instructions', async () => {
        // Setup 1: Create a CLAUDE.md with pre-existing user instructions
        const existingUserText = 'Always use async/await. Never use promises directly.\n';
        await fs.writeFile('CLAUDE.md', existingUserText);

        // Setup 2: Create a dummy terraform state so syncAi can extract the region/port
        await fs.mkdir('terraform', { recursive: true });
        await fs.writeFile(path.join('terraform', 'main.tf'), 'region = "us-east-2"\nport = "8000"');

        // Execute the CLI command
        await syncAi();

        // Assert: Read the file back and verify both contents exist
        const finalContent = await fs.readFile('CLAUDE.md', 'utf-8');

        // 1. The user's original rules MUST remain intact
        expect(finalContent).toContain(existingUserText);

        // 2. The grada managed block MUST be injected
        expect(finalContent).toContain('grada');
    });

    it('replaces a legacy markdown block instead of duplicating it', async () => {
        await fs.writeFile(
            'CLAUDE.md',
            'User notes.\n\n<!-- BEGIN DEPLOY-STACK CONTEXT -->\nold rules\n<!-- END DEPLOY-STACK CONTEXT -->\n'
        );
        injectManagedBlock('CLAUDE.md', 'new rules', true);
        const finalContent = await fs.readFile('CLAUDE.md', 'utf-8');
        expect(finalContent).toContain('User notes.');
        expect(finalContent).toContain('<!-- BEGIN GRADA CONTEXT -->');
        expect(finalContent).toContain('new rules');
        expect(finalContent).not.toContain('DEPLOY-STACK CONTEXT');
        expect(finalContent).not.toContain('old rules');
    });

    it('replaces a legacy hash block instead of duplicating it', async () => {
        await fs.writeFile(
            '.windsurfrules',
            'User notes.\n\n# BEGIN DEPLOY-STACK CONTEXT\nold rules\n# END DEPLOY-STACK CONTEXT\n'
        );
        injectManagedBlock('.windsurfrules', 'new rules', false);
        const finalContent = await fs.readFile('.windsurfrules', 'utf-8');
        expect(finalContent).toContain('# BEGIN GRADA CONTEXT');
        expect(finalContent).not.toContain('DEPLOY-STACK CONTEXT');
        expect(finalContent).not.toContain('old rules');
    });

    it('writes GRADA markers for brand-new files', async () => {
        injectManagedBlock('FRESH.md', 'fresh rules', true);
        const finalContent = await fs.readFile('FRESH.md', 'utf-8');
        expect(finalContent).toContain('<!-- BEGIN GRADA CONTEXT -->');
        expect(finalContent).toContain('<!-- END GRADA CONTEXT -->');
    });
});