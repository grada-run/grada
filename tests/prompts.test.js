import { describe, it, expect, vi, beforeEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackMocks as clack } from './helpers/clack.js';
import { promptGitHubRepo } from '../src/utils/prompts.js';


beforeEach(() => {
    vi.clearAllMocks();
});

describe('promptGitHubRepo', () => {
    it('returns the trimmed owner/name slug', async () => {
        clack.mockText.mockResolvedValue('  acme/widgets  ');
        await expect(promptGitHubRepo()).resolves.toBe('acme/widgets');
    });

    it('returns null on empty input (skip)', async () => {
        clack.mockText.mockResolvedValue('');
        await expect(promptGitHubRepo()).resolves.toBeNull();
    });

    it('validates the slug format without rejecting empty input', async () => {
        clack.mockText.mockResolvedValue('acme/widgets');
        await promptGitHubRepo();
        const validate = clack.mockText.mock.calls[0][0].validate;
        expect(validate('acme/widgets')).toBeUndefined();
        expect(validate('')).toBeUndefined();
        expect(validate('not-a-slug')).toMatch(/owner\/name/);
    });
});
