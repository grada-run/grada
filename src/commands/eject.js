import fs from 'fs';
import path from 'path';
import { intro, outro, confirm, spinner, cancel } from '@clack/prompts';
import color from 'picocolors';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';
import { shouldAutoApprove } from '../utils/command.js';
import { normalizeOptions } from '../utils/args.js';
import {
    stripTerraformMetadata,
    stripGitignoreMetadata,
    writeEjectedMarker,
} from '../utils/terraform-metadata.js';

// Re-exported so existing importers (tests) keep working unchanged.
export { stripTerraformMetadata, stripGitignoreMetadata };

function collectTerraformFiles(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) collectTerraformFiles(fullPath, out);
        else if (entry.isFile() && entry.name.endsWith('.tf')) out.push(fullPath);
    }
    return out;
}

export async function ejectStack(input = {}) {
    const options = normalizeOptions(input);
    intro(color.bgRed(color.white(' grada eject ⏏️  ')));

    console.log(color.yellow('This will permanently decouple your infrastructure from the grada CLI.'));
    console.log(color.gray('It removes all ManagedBy tags and tool-specific metadata from your local files.'));
    console.log(color.gray('Your infrastructure will remain fully operational as raw, standalone Terraform.'));

    const shouldEject = shouldAutoApprove(options) ? true : await confirm({
        message: 'Are you sure you want to eject? (This cannot be undone)',
        initialValue: false,
    });

    if (!shouldEject || typeof shouldEject === 'symbol') {
        cancel('Eject cancelled. You are still managed by grada.');
        process.exit(0);
    }

    const s = spinner();
    s.start('Ejecting grada metadata...');

    const targetDir = process.cwd();
    const tfDir = path.join(targetDir, 'terraform');
    const gitignorePath = path.join(targetDir, '.gitignore');

    // 1. Clean every Terraform file (main.tf headers and tag blocks,
    // addon headers in either brand variant).
    for (const tfPath of collectTerraformFiles(tfDir)) {
        const content = fs.readFileSync(tfPath, 'utf8');
        const cleaned = stripTerraformMetadata(content);
        if (cleaned !== content) {
            fs.writeFileSync(tfPath, cleaned.trim() + '\n');
        }
    }

    // 2. Clean up .gitignore
    if (fs.existsSync(gitignorePath)) {
        let gitignore = fs.readFileSync(gitignorePath, 'utf8');
        // Remove the exact block we injected in backup.js
        gitignore = stripGitignoreMetadata(gitignore);
        fs.writeFileSync(gitignorePath, gitignore.trim() + '\n');
    }

    // 3. Purge all local `.bak` files to leave a pristine directory
    const cleanBackups = (dir) => {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (file.includes('.bak.')) {
                fs.rmSync(fullPath, { recursive: true, force: true });
            } else if (fs.statSync(fullPath).isDirectory() && file !== 'node_modules' && file !== '.git') {
                cleanBackups(fullPath); // Recursively check subdirectories like .github/workflows
            }
        }
    };

    cleanBackups(targetDir);

    // 4. Record the ejection in gitignored local state so later `add` /
    // `init` runs can warn instead of silently re-managing the tree.
    writeEjectedMarker(targetDir);

    s.stop('Ejection complete.');

    const actualProjectName = path.basename(process.cwd());
    trackEvent('project_ejected', {
        projectName: actualProjectName
    });
    await flushTelemetry();

    outro(`
    ${color.green('✅ Successfully ejected from grada!')}
    
    Your Terraform and CI/CD files are now 100% vanilla. 
    
    ${color.blue('Next Step:')}
    Run ${color.cyan('terraform apply')} inside your terraform/ folder. 
    AWS will sync your state and automatically remove the 'ManagedBy' tags from your live cloud resources.

    ${color.magenta('Godspeed! You are now the sole owner of your infrastructure.')}
    `);
}