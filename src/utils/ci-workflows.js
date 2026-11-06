import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { atomicWriteFileSync } from './atomic-write.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PLAN_TEMPLATE_PATH = path.join(__dirname, '../../templates/github/plan.yml');
export const PLAN_WORKFLOW_FILE = path.join('.github', 'workflows', 'plan.yml');

// Shared render-and-write core for generated CI workflows: substitutes
// the region + role ARN placeholders, refuses to overwrite without
// force, and writes atomically. Never exits, never tracks.
export function renderCiWorkflow({ templatePath, region, roleArn, targetPath, force = false } = {}) {
    const template = fsSync.readFileSync(templatePath, 'utf8');
    const rendered = template
        .replaceAll('{{REGION}}', region)
        .replaceAll('{{ROLE_ARN}}', roleArn);
    if (fsSync.existsSync(targetPath) && force !== true && force !== 'true') {
        return { ok: false, reason: 'exists', path: targetPath };
    }
    fsSync.mkdirSync(path.dirname(targetPath), { recursive: true });
    atomicWriteFileSync(targetPath, rendered, 'utf8');
    return { ok: true, path: targetPath };
}

// Renders `templates/github/plan.yml` into the project. Used by init's
// `--setup-ci-plan`; never exits, never tracks.
export function scaffoldPlanWorkflow(cwd = process.cwd(), { region, roleArn, force = false } = {}) {
    return renderCiWorkflow({
        templatePath: PLAN_TEMPLATE_PATH,
        region,
        roleArn,
        targetPath: path.join(cwd, PLAN_WORKFLOW_FILE),
        force,
    });
}
