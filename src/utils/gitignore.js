import fs from 'fs';
import path from 'path';

// Single home for `.gitignore` rule maintenance (backup stanzas,
// `.grada/` runtime state). Every writer goes through
// `ensureGitignoreRules` so concurrent commands never interleave partial
// appends and rule formats stay identical everywhere.

// A rule is `{ contains, block }`: `contains` is the substring whose
// presence means "already covered"; `block` is appended verbatim (with
// newline hygiene) when missing. Blocks keep their historical bytes so
// the eject strip regexes keep matching.
export const GITIGNORE_RULE_GRADA_DIR = {
    contains: '.grada/',
    block: '# Local grada runtime state (sleep/wake)\n.grada/\n',
};

export const GITIGNORE_RULE_BACKUPS = {
    contains: '*.bak.*',
    block: '\n# grada backups\n*.bak.*\n',
};

// Ensures every rule's block is present in `<cwd>/.gitignore`. Returns
// true when the file was created or amended, false when every rule
// already matched or the write failed.
export function ensureGitignoreRules(cwd = process.cwd(), rules = []) {
    const file = path.join(cwd, '.gitignore');
    let content = null;
    try {
        if (fs.existsSync(file)) content = fs.readFileSync(file, 'utf8');
    } catch {
        content = null;
    }
    const missing = rules.filter(
        (rule) => !(typeof content === 'string' && content.includes(rule.contains))
    );
    if (missing.length === 0) return false;
    const addition = missing.map((rule) => rule.block).join('');
    try {
        if (content === null) {
            fs.writeFileSync(file, addition, 'utf8');
        } else {
            // Exactly one blank line between the old tail and the first
            // block; blocks keep any leading newline only for new files.
            fs.appendFileSync(
                file,
                `${content.endsWith('\n') ? '\n' : '\n\n'}${addition.replace(/^\n+/, '')}`,
                'utf8'
            );
        }
    } catch {
        return false;
    }
    return true;
}
