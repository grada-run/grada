// Pins the proactive IDE guardrail rules (spec: stability-guardrails §B):
// the ai-rules.js generator must emit all three trigger rules with
// target-aware architecture, and the repo's own dogfood manifests must
// carry the same rules so the two cannot drift apart silently.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getBaseRules, getCursorRules, ARCHITECTURE_BY_TARGET } from '../src/utils/ai-rules.js';

function readRepo(rel) {
    return fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
}

describe('ai-rules generator trigger rules', () => {
    it('emits the terraform validation rule', () => {
        const rules = getBaseRules({ region: 'us-east-2', port: '3000', target: 'ecs' });
        expect(rules).toContain('terraform validate');
        expect(rules).toMatch(/MUST.*terraform validate/);
    });

    it('emits the secrets audit-then-push rule', () => {
        const rules = getBaseRules({ region: 'us-east-2', port: '3000', target: 'ecs' });
        expect(rules).toContain('secrets audit');
        expect(rules).toContain('secrets push');
        expect(rules.indexOf('secrets audit')).toBeLessThan(rules.indexOf('secrets push'));
    });

    it('emits the infrastructure sync rule for build/output changes', () => {
        const rules = getBaseRules({ region: 'us-east-2', port: '3000', target: 'ecs' });
        expect(rules).toContain('package.json');
        expect(rules).toContain('npx grada-run apply');
    });

    it('describes the actual compute target topology', () => {
        expect(getBaseRules({ target: 'ecs' })).toContain('ECS Fargate');
        expect(getBaseRules({ target: 'ecs' })).toContain('`ecs`');
        const lambda = getBaseRules({ target: 'lambda' });
        expect(lambda).toContain('Lambda');
        expect(lambda).toContain('API Gateway');
        expect(lambda).not.toContain('ECS Fargate cluster');
        const staticRules = getBaseRules({ target: 'static' });
        expect(staticRules).toContain('zero-compute');
        expect(staticRules).toContain('S3');
        expect(staticRules).not.toContain('ECS Fargate cluster');
    });

    it('falls back to ECS for unknown targets', () => {
        expect(getBaseRules({})).toContain('ECS Fargate');
        expect(getBaseRules({ target: 'bogus' })).toContain('ECS Fargate');
    });

    it('covers every canonical compute target', () => {
        expect(Object.keys(ARCHITECTURE_BY_TARGET).sort()).toEqual(['ecs', 'lambda', 'static']);
    });

    it('wraps the base rules in cursor frontmatter', () => {
        const rules = getCursorRules({ region: 'us-east-2', port: '3000', target: 'lambda' });
        expect(rules).toContain('description:');
        expect(rules).toContain('terraform validate');
        expect(rules).toContain('API Gateway');
    });
});

describe('dogfood manifests carry the same three rules', () => {
    const manifests = [
        '.windsurfrules',
        '.github/copilot-instructions.md',
        '.cursor/rules/grada-infrastructure.mdc',
    ];
    for (const manifest of manifests) {
        it(`${manifest} has validate + secrets + infra-sync rules`, () => {
            const content = readRepo(manifest);
            expect(content).toContain('terraform validate');
            expect(content).toContain('secrets audit');
            expect(content).toContain('secrets push');
            expect(content).toContain('grada-run apply');
        });
    }
});
