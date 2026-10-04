import fsSync from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackSuccess, trackFailure, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { failCommand, failProjectNotInitialized, isProgrammaticCall } from '../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { resolveRegion, resolveProjectName, resolveCwd, readFileSafe } from '../utils/resolvers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DRIFT_TEMPLATE_PATH = path.join(__dirname, '../../templates/github/drift.yml');

export const DRIFT_WORKFLOW_FILE = path.join('.github', 'workflows', 'drift.yml');
export const MAX_SUMMARY_LINES = 60;

export function parseDriftArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'drift') args.shift();
    const { options, rest } = parseFlags(args, {
        string: ['region', 'project-name'],
        boolean: ['setup', 'force'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    // `drift init` is an alias for `drift --setup`.
    if (positionals.includes('init') || positionals.includes('setup')) options.setup = true;
    const others = positionals.filter((positional) => positional !== 'init' && positional !== 'setup');
    if (others.length > 0) options.unexpectedPositionals = others;
    return options;
}

// The OIDC role ARN the deploy workflow assumes — drift CI reuses it so no
// extra secret is needed. Null when the anchor cannot be found.
export function extractRoleArn(deployYmlContent) {
    const match = /role-to-assume:\s*([^\s#]+)/.exec(String(deployYmlContent ?? ''));
    return match ? match[1] : null;
}

// Renders `templates/github/drift.yml` into the project. Shared by
// `drift --setup` and `--setup-ci-drift`; never exits, never tracks.
export function scaffoldDriftWorkflow(cwd = process.cwd(), { region, roleArn, force = false } = {}) {
    const template = fsSync.readFileSync(DRIFT_TEMPLATE_PATH, 'utf8');
    const rendered = template
        .replaceAll('{{REGION}}', region)
        .replaceAll('{{ROLE_ARN}}', roleArn);
    const targetPath = path.join(cwd, DRIFT_WORKFLOW_FILE);
    if (fsSync.existsSync(targetPath) && force !== true && force !== 'true') {
        return { ok: false, reason: 'exists', path: targetPath };
    }
    fsSync.mkdirSync(path.dirname(targetPath), { recursive: true });
    fsSync.writeFileSync(targetPath, rendered, 'utf8');
    return { ok: true, path: targetPath };
}

// Condenses `terraform plan` output to the resource-change lines plus the
// `Plan:` summary, capped so Issue bodies and terminals stay readable.
export function extractPlanSummary(output) {
    const lines = String(output ?? '').split('\n');
    const picked = lines.filter((line) => /^\s*[~+-] /.test(line) || /^# \S/.test(line) || /^Plan:/.test(line));
    const trimmed = picked.slice(0, MAX_SUMMARY_LINES);
    if (picked.length > trimmed.length) {
        trimmed.push(`... (${picked.length - trimmed.length} more lines)`);
    }
    return trimmed.join('\n');
}

function tailLines(output, count = 15) {
    return String(output ?? '').split('\n').slice(-count).join('\n').trim();
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runDrift(input = {}) {
    setActiveCommandName('drift');
    try {
        return await runDriftMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runDriftMain(input = {}) {
    const options = normalizeOptions(input);
    const noExit = isProgrammaticCall(options);
    let cwd;
    let region;
    let projectName;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'drift_run', noExit });
    }
    const setup = options.setup === true || options.setup === 'true';
    const force = options.force === true || options.force === 'true';

    intro(color.bgCyan(color.black(' grada drift 🔍 ')));

    if (Array.isArray(options.unexpectedPositionals) && options.unexpectedPositionals.length > 0) {
        return failCommand({
            noExit,
            message: `\n✖ Unexpected argument "${options.unexpectedPositionals[0]}". Run "grada drift" to check, or "grada drift --setup" to scaffold scheduled checks.\n`,
            event: 'drift_run',
            telemetry: { projectName },
            errorCode: 'UNEXPECTED_POSITIONAL_ARGS',
            reason: 'unexpected-positional-args',
            resultExtra: { region },
        });
    }

    if (setup) {
        const deployYml = readFileSafe(path.join(cwd, '.github', 'workflows', 'deploy.yml'));
        if (!deployYml) {
            return failCommand({
                noExit,
                message: `\n✖ Workflow not found at ${color.cyan('.github/workflows/deploy.yml')}. Run ${color.green('npx grada-run')} first.\n`,
                event: 'drift_run',
                telemetry: { projectName },
                errorCode: 'WORKFLOW_NOT_FOUND',
                reason: 'workflow-not-found',
                resultExtra: { region },
            });
        }
        const roleArn = extractRoleArn(deployYml);
        if (!roleArn) {
            return failCommand({
                noExit,
                message: '\n✖ Could not find the OIDC role ARN (role-to-assume) in .github/workflows/deploy.yml.\n',
                event: 'drift_run',
                telemetry: { projectName },
                errorCode: 'ROLE_ARN_NOT_FOUND',
                reason: 'role-arn-not-found',
                resultExtra: { region },
            });
        }
        const scaffolded = scaffoldDriftWorkflow(cwd, { region, roleArn, force });
        if (!scaffolded.ok) {
            return failCommand({
                noExit,
                message: `\n⚠ ${DRIFT_WORKFLOW_FILE} already exists. Pass --force to overwrite.\n`,
                tone: 'yellow',
                event: 'drift_run',
                telemetry: { projectName, error_code: 'DRIFT_WORKFLOW_EXISTS' },
                reason: 'drift-workflow-exists',
                resultExtra: { projectName, region },
                exitCode: null,
            });
        }
        console.log(color.green(`\n✅ Created ${DRIFT_WORKFLOW_FILE} (daily 06:00 UTC drift check).`));
        console.log(color.dim('  Drift opens (or updates) a GitHub Issue labeled iac-drift; set SLACK_WEBHOOK_URL for Slack alerts.\n'));
        await trackSuccess('drift_run', { projectName, action: 'setup' });
        outro(color.green('Done.'));
        return { ok: true, action: 'setup', projectName, region, file: DRIFT_WORKFLOW_FILE };
    }

    const tfDir = path.join(cwd, 'terraform');
    if (!fsSync.existsSync(path.join(tfDir, 'main.tf'))) {
        return failCommand({
            noExit,
            message: '\n✖ No terraform/main.tf found. Run "grada" first before checking drift.\n',
            event: 'drift_run',
            telemetry: { projectName, error_code: 'TERRAFORM_NOT_INITIALIZED' },
            reason: 'terraform-not-initialized',
            resultExtra: { region },
        });
    }

    const runSync = options.spawnSyncImpl || spawnSync;
    const s = spinner();
    s.start('Running terraform plan...');

    try {
        const initResult = runSync('terraform', ['init', '-input=false'], { cwd: tfDir, encoding: 'utf8' });
        if (initResult?.error?.code === 'ENOENT') {
            s.stop(color.red('Terraform not found.'));
            return failCommand({
                noExit,
                message: '\n✖ Terraform is not installed.',
                hint: '  Please run "npx grada-run doctor" to check your environment.\n',
                event: 'drift_run',
                telemetry: { projectName },
                errorCode: 'TERRAFORM_NOT_INSTALLED',
                reason: 'terraform-not-installed',
                resultExtra: { region },
            });
        }
        if (initResult?.status !== 0) {
            s.stop(color.red('Terraform init failed.'));
            return failCommand({
                noExit,
                message: `\n✖ terraform init failed:\n${tailLines(initResult?.stderr || initResult?.stdout)}\n`,
                event: 'drift_run',
                telemetry: { projectName },
                errorCode: 'TERRAFORM_INIT_FAILED',
                reason: 'terraform-init-failed',
                resultExtra: { region },
            });
        }

        const planResult = runSync('terraform', ['plan', '-detailed-exitcode', '-no-color'], {
            cwd: tfDir,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
        });
        const status = planResult?.status;
        if (status === 0) {
            s.stop(color.green('No drift.'));
            console.log(color.green('\n✅ No infrastructure drift detected.\n'));
            await trackSuccess('drift_run', { projectName, action: 'check', drift: false });
            outro(color.green('Done.'));
            return { ok: true, action: 'check', drift: false, region };
        }
        if (status === 2) {
            s.stop(color.yellow('Drift detected.'));
            const summary = extractPlanSummary(planResult?.stdout);
            return failCommand({
                noExit,
                print: () => {
                    console.log(color.yellow('\n⚠ Infrastructure drift detected!'));
                    if (summary) console.log(color.dim(`\n${summary}\n`));
                    console.log(`  Reconcile with ${color.green('npx grada-run apply')}, or adopt the live resource with ${color.green('terraform import')}.\n`);
                },
                event: 'drift_run',
                telemetry: { projectName, action: 'check', drift: true },
                errorCode: 'DRIFT_DETECTED',
                reason: 'drift-detected',
                resultExtra: { region },
                exitCode: 2,
            });
        }
        s.stop(color.red('Terraform plan failed.'));
        return failCommand({
            noExit,
            message: `\n✖ terraform plan failed:\n${tailLines(planResult?.stderr || planResult?.stdout)}\n`,
            event: 'drift_run',
            telemetry: { projectName, action: 'check' },
            errorCode: 'TERRAFORM_PLAN_FAILED',
            reason: 'terraform-plan-failed',
            resultExtra: { region },
        });
    } catch (error) {
        await trackFailure('drift_run', {
            projectName,
            action: 'check',
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        try { s.stop(color.red('❌ Drift check failed.')); } catch { /* spinner already stopped */ }
        return failCommand({
            noExit,
            message: `✖ ${error?.message || error}`,
            hint: 'Check your AWS credentials and region, then try again.',
            reason: 'error',
            resultExtra: { region },
        });
    }
}

export const driftCommand = runDrift;

export default runDrift;
