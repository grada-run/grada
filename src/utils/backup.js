import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { select, isCancel, cancel, confirm } from '@clack/prompts';
import color from 'picocolors';
import { normalizeOptions } from './args.js';
import { atomicWriteFileSync } from './atomic-write.js';
import { withProjectLock } from './file-lock.js';
import { failCommand } from './command.js';
import { SLEEP_STATE_DIRNAME } from './sleep-state.js';
import { detectEjectedState } from './terraform-metadata.js';
import { ensureGitignoreRules, GITIGNORE_RULE_BACKUPS } from './gitignore.js';
import { trackEvent } from '../core/telemetry.js';

export const INIT_MANIFEST_FILENAME = 'manifest.json';

// Files covered by the init manifest: everything init generates that a
// re-run would overwrite. Stored as targetDir-relative paths.
function collectManifestFiles(targetDir) {
    const relPaths = [];
    const tfDir = path.join(targetDir, 'terraform');
    const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.includes('.bak.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(fullPath);
            else if (entry.isFile()) relPaths.push(path.relative(targetDir, fullPath));
        }
    };
    walk(tfDir);
    for (const rel of ['Dockerfile', path.join('.github', 'workflows', 'deploy.yml')]) {
        if (fs.existsSync(path.join(targetDir, rel))) relPaths.push(rel);
    }
    return relPaths.sort();
}

function hashFile(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function initManifestPath(targetDir) {
    return path.join(targetDir, SLEEP_STATE_DIRNAME, INIT_MANIFEST_FILENAME);
}

// Reads `.grada/manifest.json` tolerantly: null when missing or corrupt.
// A missing/corrupt manifest never blocks a command — callers treat it
// as "unknown history".
export function readInitManifest(targetDir) {
    const manifestPath = initManifestPath(targetDir);
    if (!fs.existsSync(manifestPath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
            return parsed;
        }
    } catch {
        // Fall through to null below.
    }
    return null;
}

// Records content hashes of every generated file so a later re-run can
// tell pristine output from hand edits (or addon wiring). Called by init
// after all generation (templates, addons, migration gate, drift) lands.
// With a target the v2 shape is written (intended target; the applied
// target/revision is filled by recordAppliedTarget). Without one the
// legacy v1 shape is preserved for existing callers. Re-inits carry the
// previous applied target forward — without that the target-switch gate
// could not see a static→ECS pivot (init never applies, so it must
// never clear applied history).
export function writeInitManifest(targetDir, { target } = {}) {
    const files = {};
    for (const rel of collectManifestFiles(targetDir)) {
        files[rel] = hashFile(path.join(targetDir, rel));
    }
    const manifestPath = initManifestPath(targetDir);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const previous = readInitManifest(targetDir);
    const manifest = target === undefined
        ? { version: 1, files }
        : {
            version: 2,
            target,
            appliedTarget: previous?.appliedTarget ?? null,
            appliedRevision: previous?.appliedRevision ?? null,
            files,
        };
    atomicWriteFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifestPath;
}

// Records the actually-applied target after a successful apply, merging
// into the existing manifest without touching file hashes. Missing
// manifests are created as minimal v2. Runs under the project lock so a
// concurrent init cannot interleave a regenerate between read and write.
export async function recordAppliedTarget(targetDir, { target, revision = null } = {}) {
    return withProjectLock(targetDir, async () => {
        const manifestPath = initManifestPath(targetDir);
        const existing = readInitManifest(targetDir) || { version: 2, target: target ?? null, files: {} };
        const next = {
            ...existing,
            version: 2,
            target: existing.target ?? target ?? null,
            appliedTarget: target ?? existing.appliedTarget ?? null,
            appliedRevision: revision ?? existing.appliedRevision ?? null,
            appliedAt: new Date().toISOString(),
            files: existing.files || {},
        };
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        atomicWriteFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        return next;
    }, { scope: 'terraform' });
}

// Compares the working tree against the init manifest. Returns
// `{ modified, missing }` (targetDir-relative paths), or null for
// legacy projects that predate the manifest — those keep the
// historical backup behavior instead of failing on unjudgeable trees.
export function detectModifiedTree(targetDir) {
    const manifest = readInitManifest(targetDir);
    if (!manifest) return null;
    const modified = [];
    const missing = [];
    for (const [rel, hash] of Object.entries(manifest.files)) {
        const fullPath = path.join(targetDir, rel);
        if (!fs.existsSync(fullPath)) {
            missing.push(rel);
            continue;
        }
        let current;
        try {
            current = hashFile(fullPath);
        } catch {
            missing.push(rel);
            continue;
        }
        if (current !== hash) modified.push(rel);
    }
    return { modified, missing };
}

// Managed files carried forward across a backup-and-regenerate: stashed
// before the old tree moves aside, restored over the fresh output.
// TargetDir-relative paths; missing files are skipped silently.
export const PRESERVED_FILES = ['terraform/secret_keys.json'];

// Reads the current preserved files into an in-memory stash. Pure read:
// safe to call before planning or provisioning.
export function preserveManagedFiles(targetDir) {
    const files = {};
    for (const rel of PRESERVED_FILES) {
        try {
            files[rel] = fs.readFileSync(path.join(targetDir, rel), 'utf8');
        } catch {
            // Absent or unreadable: nothing to carry forward.
        }
    }
    return { files };
}

// Writes a stash back over freshly generated output (parents created).
// Emits telemetry only when something was actually restored.
export function restoreManagedFiles(targetDir, stash = null) {
    const files = stash && typeof stash === 'object' && stash.files && typeof stash.files === 'object'
        ? stash.files
        : {};
    const restored = [];
    for (const [rel, content] of Object.entries(files)) {
        if (typeof content !== 'string') continue;
        const fullPath = path.join(targetDir, rel);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        atomicWriteFileSync(fullPath, content, 'utf8');
        restored.push(rel);
    }
    if (restored.length > 0) {
        trackEvent('preserved_files_restored', {
            projectName: path.basename(path.resolve(targetDir)),
            restored,
        });
    }
    return restored;
}

// Classifies the existing tree WITHOUT touching it, so init can gate on
// the decision before provisioning (an AWS failure then leaves the
// pre-backup tree intact). Prompts are interactions, not touches: the
// interactive backup/cancel and re-manage gates live here, pre-provision.
// Decisions:
// - `clean`: proceed (clean slate when foundFiles is empty, otherwise a
//   standard auto-backup — clean and legacy trees alike).
// - `backup`: proceed with an explicit (--force) backup.
// - `refuse-ejected` / `refuse-dirty`: do not proceed; the caller maps
//   the plan through `refusalResultForPlan` to build the outcome.
// Refusals stay out of the plan itself so planning never exits.
export async function refusalResultForPlan(plan = {}) {
    if (plan.decision === 'refuse-ejected') {
        return failCommand({
            message: '\n✖ This project was ejected from grada — re-running init would re-apply managed metadata.',
            hint: '  Re-run with --force to re-manage it, or keep editing the vanilla Terraform by hand.\n',
            event: 'cli-error',
            telemetry: { step: 'existing_files', error_code: 'EJECTED_PROJECT' },
            reason: 'ejected-project',
        });
    }
    if (plan.decision === 'refuse-dirty') {
        const dirty = Array.isArray(plan.dirty) ? plan.dirty : [];
        return failCommand({
            message: `\n✖ Existing infrastructure files were modified since generation (${dirty.join(', ')}).`,
            hint: '  Re-run with --force to back them up and regenerate, or move them aside by hand.\n',
            event: 'cli-error',
            telemetry: { step: 'existing_files', error_code: 'MODIFIED_TREE' },
            reason: 'modified-tree',
        });
    }
    return null;
}
export async function planExistingFiles(targetDir, { isHeadless = false, force = false } = {}) {
    const forceRegen = force === true || force === 'true';
    const tfPath = path.join(targetDir, 'terraform');
    const dockerfilePath = path.join(targetDir, 'Dockerfile');
    const wfPath = path.join(targetDir, '.github', 'workflows', 'deploy.yml');

    const tfExists = fs.existsSync(tfPath);
    const dockerfileExists = fs.existsSync(dockerfilePath);
    const wfExists = fs.existsSync(wfPath);

    if (!tfExists && !dockerfileExists && !wfExists) {
        return { decision: 'clean', foundFiles: [], dirty: [] };
    }

    const foundFiles = [];
    if (tfExists) foundFiles.push('terraform/');
    if (dockerfileExists) foundFiles.push('Dockerfile');
    if (wfExists) foundFiles.push('.github/workflows/deploy.yml');

    const treeStatus = detectModifiedTree(targetDir);
    const dirty = treeStatus ? [...treeStatus.modified, ...treeStatus.missing] : [];

    // Ejected projects are user-owned vanilla Terraform: re-running init
    // would re-apply managed metadata, so it needs an explicit opt-in.
    // Runs before the dirty-tree gate (ejected trees always differ from
    // the manifest); --force bypasses both. The committed sentinel joins
    // the local marker so fresh clones refuse instead of re-managing.
    const ejectedState = detectEjectedState(targetDir);
    if (ejectedState.which && !forceRegen) {
        trackEvent('ejected_sentinel_detected', { which: ejectedState.which });
        if (isHeadless) {
            return { decision: 'refuse-ejected', foundFiles, dirty, which: ejectedState.which };
        }
        const remanage = await confirm({
            message: 'This project was ejected from grada. Re-run init and re-apply managed metadata?',
            initialValue: false,
        });
        if (remanage !== true) {
            cancel('Operation cancelled. The project stays ejected.');
            process.exit(0);
        }
    }

    if (isHeadless && dirty.length > 0 && !forceRegen) {
        return { decision: 'refuse-dirty', foundFiles, dirty };
    }

    if (!isHeadless && !forceRegen) {
        const dirtyNote = dirty.length > 0 ? ` Modified since generation: ${dirty.join(', ')}.` : '';
        const overwriteDecision = await select({
            message: color.yellow(`⚠️  Conflicting files found (${foundFiles.join(', ')}). To guarantee a secure, 0-CVE deployment, we must use our optimized configurations.${dirtyNote}`),
            options: [
                { value: 'backup', label: 'Backup & Regenerate', hint: 'Move old configs to .bak and generate secure templates' },
                { value: 'cancel', label: 'Cancel', hint: 'Exit without making changes' }
            ]
        });

        if (isCancel(overwriteDecision) || overwriteDecision === 'cancel') {
            cancel('Operation cancelled to protect existing files.');
            process.exit(0);
        }
    }

    return { decision: forceRegen ? 'backup' : 'clean', foundFiles, dirty };
}

// Executes a backup plan: renames the planned set aside with one shared
// timestamp. Re-checks existence per path — minutes may have passed since
// planning while provisioning. A clean-slate plan is a silent no-op.
export async function executeBackup(targetDir, plan = {}) {
    const foundFiles = Array.isArray(plan.foundFiles) ? plan.foundFiles : [];
    if (foundFiles.length === 0) return { backedUp: [] };
    const timestamp = Date.now();
    const backedUp = [];
    const renames = [
        ['terraform/', path.join(targetDir, 'terraform')],
        ['Dockerfile', path.join(targetDir, 'Dockerfile')],
        ['.github/workflows/deploy.yml', path.join(targetDir, '.github', 'workflows', 'deploy.yml')],
    ];
    for (const [rel, fullPath] of renames) {
        if (!foundFiles.includes(rel)) continue;
        if (!fs.existsSync(fullPath)) continue;
        fs.renameSync(fullPath, `${fullPath}.bak.${timestamp}`);
        backedUp.push(`${rel} → ${path.basename(fullPath)}.bak.${timestamp}`);
    }
    if (backedUp.length === 0) return { backedUp };

    ensureGitIgnore(targetDir);

    console.log(color.cyan('ℹ️  Existing configuration files were safely backed up locally.'));
    for (const pointer of backedUp) console.log(color.dim(`  ${pointer}`));
    return { backedUp };
}

export async function handleExistingFiles(targetDir, isHeadless = false, maybeOptions) {
    const opts = normalizeOptions(maybeOptions);
    const plan = await planExistingFiles(targetDir, { isHeadless, force: opts.force });
    const refusal = await refusalResultForPlan(plan);
    if (refusal) return refusal;
    await executeBackup(targetDir, plan);
}

/**
 * Appends backup patterns to .gitignore so local clutter never reaches GitHub.
 */
function ensureGitIgnore(targetDir) {
    ensureGitignoreRules(targetDir, [GITIGNORE_RULE_BACKUPS]);
}