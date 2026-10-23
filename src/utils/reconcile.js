import fs from 'fs';
import path from 'path';

// Token offline scaffolds (`init --offline`) leave where the AWS account
// ID belongs: the bucket name in terraform/backend.tf plus every
// role-to-assume ARN in .github/workflows/*.yml. Detection only —
// rewriting lives in apply's reconcile pre-step.
export const PLACEHOLDER_ACCOUNT_ID = 'YOUR_AWS_ACCOUNT_ID';

// Repo-relative paths still containing the placeholder (`[]` when the
// tree is reconciled). Missing files are skipped, never an error; the
// workflows directory is globbed (not filename-hardcoded) so future
// workflows are covered.
export function findUnreconciledFiles(targetDir) {
    const found = [];
    const check = (repoPath) => {
        let content;
        try {
            content = fs.readFileSync(path.join(targetDir, repoPath), 'utf8');
        } catch {
            return;
        }
        if (content.includes(PLACEHOLDER_ACCOUNT_ID)) found.push(repoPath);
    };
    check(path.join('terraform', 'backend.tf'));
    let entries = [];
    try {
        entries = fs.readdirSync(path.join(targetDir, '.github', 'workflows'));
    } catch {
        entries = [];
    }
    for (const entry of entries.filter((name) => /\.ya?ml$/.test(name)).sort()) {
        check(path.join('.github', 'workflows', entry));
    }
    return found.sort();
}

export function isValidAccountId(value) {
    return typeof value === 'string' && /^\d{12}$/.test(value);
}
