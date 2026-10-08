import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { select, isCancel, cancel, confirm } from '@clack/prompts';
import color from 'picocolors';
import { normalizeOptions } from './args.js';
import { failCommand } from './command.js';
import { SLEEP_STATE_DIRNAME } from './sleep-state.js';
import { readEjectedMarker } from './terraform-metadata.js';

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

// Records content hashes of every generated file so a later re-run can
// tell pristine output from hand edits (or addon wiring). Called by init
// after all generation (templates, addons, migration gate, drift) lands.
export function writeInitManifest(targetDir) {
    const files = {};
    for (const rel of collectManifestFiles(targetDir)) {
        files[rel] = hashFile(path.join(targetDir, rel));
    }
    const manifestPath = initManifestPath(targetDir);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify({ version: 1, files }, null, 2)}\n`, 'utf8');
    return manifestPath;
}

// Compares the working tree against the init manifest. Returns
// `{ modified, missing }` (targetDir-relative paths), or null for
// legacy projects that predate the manifest — those keep the
// historical backup behavior instead of failing on unjudgeable trees.
export function detectModifiedTree(targetDir) {
    const manifestPath = initManifestPath(targetDir);
    if (!fs.existsSync(manifestPath)) return null;
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
        return null;
    }
    if (!manifest || typeof manifest !== 'object' || !manifest.files || typeof manifest.files !== 'object') {
        return null;
    }
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

export async function handleExistingFiles(targetDir, isHeadless = false, maybeOptions) {
    const opts = normalizeOptions(maybeOptions);
    const forceRegen = opts.force === true || opts.force === 'true';
    const tfPath = path.join(targetDir, 'terraform');
    const dockerfilePath = path.join(targetDir, 'Dockerfile');
    const wfDir = path.join(targetDir, '.github', 'workflows');
    const wfPath = path.join(wfDir, 'deploy.yml');

    const tfExists = fs.existsSync(tfPath);
    const dockerfileExists = fs.existsSync(dockerfilePath);
    const wfExists = fs.existsSync(wfPath);

    if (!tfExists && !dockerfileExists && !wfExists) {
        return; // Clean slate
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
    // the manifest); --force bypasses both.
    if (readEjectedMarker(targetDir) && !forceRegen) {
        if (isHeadless) {
            return failCommand({
                message: '\n✖ This project was ejected from grada — re-running init would re-apply managed metadata.',
                hint: '  Re-run with --force to re-manage it, or keep editing the vanilla Terraform by hand.\n',
                event: 'cli-error',
                telemetry: { step: 'existing_files', error_code: 'EJECTED_PROJECT' },
                reason: 'ejected-project',
            });
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
        return failCommand({
            message: `\n✖ Existing infrastructure files were modified since generation (${dirty.join(', ')}).`,
            hint: '  Re-run with --force to back them up and regenerate, or move them aside by hand.\n',
            event: 'cli-error',
            telemetry: { step: 'existing_files', error_code: 'MODIFIED_TREE' },
            reason: 'modified-tree',
        });
    }

    let overwriteDecision = 'backup';

    if (!isHeadless && !forceRegen) {
        const dirtyNote = dirty.length > 0 ? ` Modified since generation: ${dirty.join(', ')}.` : '';
        overwriteDecision = await select({
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

    // Execute the safe backup
    const timestamp = Date.now();

    if (tfExists) fs.renameSync(tfPath, `${tfPath}.bak.${timestamp}`);
    if (dockerfileExists) fs.renameSync(dockerfilePath, `${dockerfilePath}.bak.${timestamp}`);
    if (wfExists) fs.renameSync(wfPath, `${wfPath}.bak.${timestamp}`);

    ensureGitIgnore(targetDir);

    console.log(color.cyan(`ℹ️  Existing configuration files were safely backed up locally.`));
}

/**
 * Appends backup patterns to .gitignore so local clutter never reaches GitHub.
 */
function ensureGitIgnore(targetDir) {
    const gitignorePath = path.join(targetDir, '.gitignore');
    const ignoreRules = '\n# grada backups\n*.bak.*\n';

    if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf8');
        if (!content.includes('*.bak.*')) {
            fs.appendFileSync(gitignorePath, ignoreRules);
        }
    } else {
        fs.writeFileSync(gitignorePath, ignoreRules);
    }
}