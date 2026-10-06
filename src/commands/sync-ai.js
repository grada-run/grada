import fsSync from 'fs';
import path from 'path';
import { intro, outro, spinner, log } from '@clack/prompts';
import color from 'picocolors';
import { getAiAssistants } from '../utils/prompts.js';
import { getBaseRules, getCursorRules, injectManagedBlock } from '../utils/ai-rules.js';
import { readTerraformComputeTarget } from '../utils/resolvers.js';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';
import { failCommand } from '../utils/command.js';

function getProjectContext(cwd) {
    const context = { region: '', port: '', target: readTerraformComputeTarget(cwd) };
    const mainTfPath = path.join(cwd, 'terraform', 'main.tf');

    if (fsSync.existsSync(mainTfPath)) {
        const tfContent = fsSync.readFileSync(mainTfPath, 'utf8');

        // Extract Region
        const regionMatch = tfContent.match(/region\s*=\s*"([^"]+)"/);
        if (regionMatch) context.region = regionMatch[1];

        // Extract Port
        const portMatch = tfContent.match(/containerPort\s*=\s*(\d+)/);
        if (portMatch) context.port = portMatch[1];
    }

    return context;
}

export async function syncAi() {
    intro(color.bgCyan(color.black(' grada sync-ai 🤖 ')));

    const assistants = await getAiAssistants();

    if (!assistants || assistants.length === 0) {
        log.warn('No AI assistants selected. Skipping synchronization.');
        process.exit(0);
    }

    const s = spinner();
    s.start('Writing AI context rules...');
    const cwd = process.cwd();

    const context = getProjectContext(cwd);

    try {
        // --- Agentic IDEs ---
        if (assistants.includes('cursor')) {
            const cursorDir = path.join(cwd, '.cursor', 'rules');
            if (!fsSync.existsSync(cursorDir)) fsSync.mkdirSync(cursorDir, { recursive: true });
            fsSync.writeFileSync(path.join(cursorDir, 'grada.mdc'), getCursorRules(context));
        }

        if (assistants.includes('roo')) {
            const rooDir = path.join(cwd, '.roo', 'rules');
            if (!fsSync.existsSync(rooDir)) fsSync.mkdirSync(rooDir, { recursive: true });
            fsSync.writeFileSync(path.join(rooDir, 'grada.md'), getBaseRules(context));
        }

        if (assistants.includes('trae')) {
            const traeDir = path.join(cwd, '.trae', 'rules');
            if (!fsSync.existsSync(traeDir)) fsSync.mkdirSync(traeDir, { recursive: true });
            injectManagedBlock(path.join(traeDir, 'project_rules.md'), getBaseRules(context), true);
        }

        if (assistants.includes('continue')) {
            const promptsDir = path.join(cwd, '.prompts');
            if (!fsSync.existsSync(promptsDir)) fsSync.mkdirSync(promptsDir, { recursive: true });
            fsSync.writeFileSync(path.join(promptsDir, 'grada.prompt'), getBaseRules(context));
        }

        if (assistants.includes('windsurf')) {
            injectManagedBlock(path.join(cwd, '.windsurfrules'), getBaseRules(context), false);
        }

        if (assistants.includes('copilot')) {
            const githubDir = path.join(cwd, '.github');
            if (!fsSync.existsSync(githubDir)) fsSync.mkdirSync(githubDir, { recursive: true });
            injectManagedBlock(path.join(githubDir, 'copilot-instructions.md'), getBaseRules(context), true);
        }

        // --- Terminal Agents ---
        if (assistants.includes('claude')) {
            injectManagedBlock(path.join(cwd, 'CLAUDE.md'), getBaseRules(context), true);
        }

        if (assistants.includes('goose')) {
            injectManagedBlock(path.join(cwd, '.goosehints'), getBaseRules(context), true);
        }

        if (assistants.includes('aider')) {
            injectManagedBlock(path.join(cwd, '.aider.conf.yml'), getBaseRules(context), false); // Uses # comments
        }

        s.stop('AI context synchronized successfully!');
        outro(`${color.green('✅ AI Assistant Rules generated!')} Your AI tools now know exactly how to deploy your app without hallucinating Terraform.`);

        trackEvent('sync_ai_executed', {
            assistants_selected: assistants,
            has_cursor: assistants.includes('cursor'),
            has_roo: assistants.includes('roo'),
            has_trae: assistants.includes('trae'),
            has_continue: assistants.includes('continue'),
            has_windsurf: assistants.includes('windsurf'),
            has_copilot: assistants.includes('copilot'),
            has_claude: assistants.includes('claude'),
            has_goose: assistants.includes('goose'),
            has_aider: assistants.includes('aider')
        });
        await flushTelemetry();

    } catch (error) {
        s.stop('❌ Failed to write AI context files.');
        return failCommand({ message: error.message, useErrorStream: true });
    }
}