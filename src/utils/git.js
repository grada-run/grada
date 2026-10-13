import { execSync } from 'child_process';

// GitHub owner (user/org) + repo slug: `owner/name`. Owner allows
// alphanumerics and interior hyphens; repo names also allow . _ -.
const GITHUB_SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;

export function isValidGitHubRepoSlug(slug) {
    return typeof slug === 'string' && GITHUB_SLUG_RE.test(slug.trim());
}

// Extracts `owner/name` from https (with or without userinfo, as CI
// checkouts embed tokens), ssh://, and scp-like remote URLs. Anything
// else (non-GitHub hosts, malformed input) yields null.
const REMOTE_URL_RE = /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

export function parseGitHubRepoFromUrl(url) {
    if (typeof url !== 'string') return null;
    const match = url.trim().match(REMOTE_URL_RE);
    if (!match) return null;
    const slug = `${match[1]}/${match[2]}`;
    return isValidGitHubRepoSlug(slug) ? slug : null;
}

// Reads the GitHub `owner/name` from the origin remote. Never throws:
// missing git, non-repos, missing remotes, and non-GitHub hosts all
// yield null (the caller falls back to prompting or the open trust).
export function readGitHubRepoFromRemote(cwd = process.cwd(), execImpl = execSync) {
    let url;
    try {
        url = execImpl('git remote get-url origin', { cwd, stdio: 'pipe' }).toString().trim();
    } catch {
        return null;
    }
    return parseGitHubRepoFromUrl(url);
}
