import { describe, it, expect } from 'vitest';
import { applyGitignoreRules, GITIGNORE_RULE_GRADA_DIR, GITIGNORE_RULE_BACKUPS } from '../src/utils/gitignore.js';

describe('applyGitignoreRules', () => {
    it('appends missing blocks separated by exactly one blank line', () => {
        const { content, changed } = applyGitignoreRules('node_modules/\n', [GITIGNORE_RULE_GRADA_DIR]);
        expect(changed).toBe(true);
        expect(content).toBe('node_modules/\n\n# Local grada runtime state (sleep/wake)\n.grada/\n');
    });

    it('leaves content untouched when every rule already matches', () => {
        const before = 'node_modules/\n.grada/\n';
        const { content, changed } = applyGitignoreRules(before, [GITIGNORE_RULE_GRADA_DIR]);
        expect(changed).toBe(false);
        expect(content).toBe(before);
    });

    it('appends only the missing rules and tolerates a missing trailing newline', () => {
        const { content, changed } = applyGitignoreRules('.grada/', [GITIGNORE_RULE_GRADA_DIR, GITIGNORE_RULE_BACKUPS]);
        expect(changed).toBe(true);
        expect(content).toBe('.grada/\n\n# grada backups\n*.bak.*\n');
    });

    it('treats non-string content as empty', () => {
        const { content, changed } = applyGitignoreRules(null, [GITIGNORE_RULE_GRADA_DIR]);
        expect(changed).toBe(true);
        expect(content).toBe('# Local grada runtime state (sleep/wake)\n.grada/\n');
    });
});
