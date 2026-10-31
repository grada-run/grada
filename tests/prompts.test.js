import { describe, it, expect, vi, beforeEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackMocks as clack } from './helpers/clack.js';
import { promptGitHubRepo } from '../src/utils/prompts.js';
import { resolveDjangoWsgi } from '../src/utils/frameworks.js';


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

describe('resolveDjangoWsgi prompt validation', () => {
    it('re-prompts on module paths outside [A-Za-z0-9_.]', async () => {
        clack.mockText.mockResolvedValue('core.wsgi');
        await resolveDjangoWsgi('/tmp/nowhere', null, 'django', false);
        const validate = clack.mockText.mock.calls[0][0].validate;
        expect(validate).toBeTypeOf('function');
        expect(validate('core.wsgi')).toBeUndefined();
        expect(validate('my_project.wsgi')).toBeUndefined();
        expect(validate('my project.wsgi')).toMatch(/letters, numbers, dots/);
        expect(validate('core.wsgi"')).toMatch(/letters, numbers, dots/);
        expect(validate('')).toMatch(/letters, numbers, dots/);
    });

    it('skips the prompt for non-django, procfile, and headless paths', async () => {
        await expect(resolveDjangoWsgi('/tmp/nowhere', null, 'rails', false)).resolves.toBe('core.wsgi');
        await expect(resolveDjangoWsgi('/tmp/nowhere', { web: ['gunicorn', 'shop.wsgi'] }, 'django', false)).resolves.toBe('shop.wsgi');
        await expect(resolveDjangoWsgi('/tmp/nowhere', null, 'django', true)).resolves.toBe('core.wsgi');
        expect(clack.mockText).not.toHaveBeenCalled();
    });
});
