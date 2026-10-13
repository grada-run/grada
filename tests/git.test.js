import { describe, it, expect } from 'vitest';
import {
    parseGitHubRepoFromUrl,
    isValidGitHubRepoSlug,
    readGitHubRepoFromRemote,
} from '../src/utils/git.js';

describe('parseGitHubRepoFromUrl', () => {
    it.each([
        ['https://github.com/acme/widgets', 'acme/widgets'],
        ['https://github.com/acme/widgets.git', 'acme/widgets'],
        ['https://github.com/acme/widgets/', 'acme/widgets'],
        ['git@github.com:acme/widgets.git', 'acme/widgets'],
        ['git@github.com:acme/widgets', 'acme/widgets'],
        ['ssh://git@github.com/acme/widgets.git', 'acme/widgets'],
        ['https://x-access-token:sekret@github.com/acme/widgets.git', 'acme/widgets'],
        ['https://github.com/My-Org/my.repo_name-2', 'My-Org/my.repo_name-2'],
        ['ssh://git@github.com:22/acme/widgets.git', 'acme/widgets'],
        ['https://github.com:8443/acme/widgets.git', 'acme/widgets'],
        ['https://x-access-token:sekret@github.com:443/acme/widgets', 'acme/widgets'],
    ])('parses %s', (url, expected) => {
        expect(parseGitHubRepoFromUrl(url)).toBe(expected);
    });

    it.each([
        ['https://gitlab.com/acme/widgets.git'],
        ['https://github.com/acme-only'],
        ['https://github.com/acme/widgets/extra'],
        ['not-a-url'],
        [''],
        [null],
        [undefined],
        [42],
    ])('returns null for %s', (url) => {
        expect(parseGitHubRepoFromUrl(url)).toBeNull();
    });
});

describe('isValidGitHubRepoSlug', () => {
    it.each([
        ['acme/widgets'],
        ['a/b'],
        ['My-Org/my.repo_name-2'],
    ])('accepts %s', (slug) => {
        expect(isValidGitHubRepoSlug(slug)).toBe(true);
    });

    it.each([
        ['acme'],
        ['acme/'],
        ['/widgets'],
        ['acme/widgets/extra'],
        ['-acme/widgets'],
        ['acme with space/widgets'],
        [''],
        [null],
        [undefined],
    ])('rejects %s', (slug) => {
        expect(isValidGitHubRepoSlug(slug)).toBe(false);
    });
});

describe('readGitHubRepoFromRemote', () => {
    it('parses the origin remote URL', () => {
        const execImpl = () => Buffer.from('git@github.com:acme/widgets.git\n');
        expect(readGitHubRepoFromRemote('/tmp/whatever', execImpl)).toBe('acme/widgets');
    });

    it('returns null when git fails (no repo, no remote)', () => {
        const execImpl = () => { throw new Error('git failed'); };
        expect(readGitHubRepoFromRemote('/tmp/whatever', execImpl)).toBeNull();
    });

    it('returns null for non-GitHub remotes', () => {
        const execImpl = () => Buffer.from('https://gitlab.com/acme/widgets.git\n');
        expect(readGitHubRepoFromRemote('/tmp/whatever', execImpl)).toBeNull();
    });
});
