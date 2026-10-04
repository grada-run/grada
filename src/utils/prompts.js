import path from 'path';
import { text, select, multiselect, confirm, group, cancel } from '@clack/prompts';
import color from 'picocolors';
import { execSync } from 'child_process';

// Sanitizes a raw project name for AWS resource compatibility (ALB names
// allow `[a-zA-Z0-9-]` only; ECR repositories require lowercase): trim,
// lowercase, collapse every run of characters outside `[a-z0-9-]` —
// including dots and underscores — into a single hyphen, strip
// leading/trailing hyphens, and fall back to `'app'` when empty.
export function sanitizeProjectName(rawName) {
    const sanitized = String(rawName ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return sanitized || 'app';
}

function resolveActualProjectName(rawName) {
    const actualProjectName = sanitizeProjectName(rawName);
    if (actualProjectName !== String(rawName ?? '').trim()) {
        console.log(color.dim(`Project name sanitized to "${actualProjectName}" for AWS resource compatibility.`));
    }
    return actualProjectName;
}

export async function getTargetDirectory(isHeadless, headlessOptions) {
    if (isHeadless) {
        const projectName = headlessOptions.dir || '.';
        const rawName = projectName === '.' ? path.basename(process.cwd()) : projectName;
        return {
            projectName,
            actualProjectName: resolveActualProjectName(rawName),
            targetDir: projectName === '.' ? process.cwd() : path.join(process.cwd(), projectName)
        };
    }

    const projectName = await text({
        message: 'Where should we generate the infrastructure? (Type "." for current directory)',
        placeholder: '.',
        initialValue: '.',
        validate: (value) => {
            if (!value) return 'Please enter a name or directory.';
            if (value !== '.' && value.includes(' ')) return 'Name cannot contain spaces.';
        },
    });

    if (typeof projectName === 'symbol') {
        cancel('Operation cancelled.');
        process.exit(0);
    }

    const rawName = projectName === '.' ? path.basename(process.cwd()) : projectName;
    return {
        projectName,
        actualProjectName: resolveActualProjectName(rawName),
        targetDir: projectName === '.' ? process.cwd() : path.join(process.cwd(), projectName)
    };
}

export async function getProjectConfig(isHeadless, headlessOptions, targetDir, detectedFramework, hints = {}) {
    const capabilities = hints && typeof hints === 'object' ? hints.capabilities : null;
    const explicitDbEngine = hints && typeof hints === 'object' && typeof hints.dbEngine === 'string' && hints.dbEngine
        ? hints.dbEngine
        : null;
    // Lambda functions are fixed at 512 MB with no ALB health checks or
    // replica counts, and static targets have no containers at all, so the
    // ECS sizing prompts are skipped for both targets.
    const skipsContainerSizing = hints && typeof hints === 'object'
        && (hints.target === 'lambda' || hints.target === 'static');
    if (isHeadless) {
        return {
            framework: headlessOptions.framework || (detectedFramework ? detectedFramework.id : 'static'),
            region: headlessOptions.region || 'us-east-2',
            port: headlessOptions.port || (headlessOptions.framework === 'static' ? '8080' : '3000'),
            size: headlessOptions.size || 'micro',
            healthCheckPath: headlessOptions.healthCheckPath || '/',
            desiredCount: headlessOptions.desiredCount || '1',
            branch: headlessOptions.branch || 'main',
            needsDatabase: headlessOptions.needsDatabase === 'true' || headlessOptions.needsDatabase === true,
            dbEngine: 'postgres',
            enablePrPreviews: headlessOptions.enablePrPreviews === 'true' || headlessOptions.enablePrPreviews === true,
            setupType: 'headless'
        };
    }

    let finalFramework = detectedFramework ? detectedFramework.id : null;

    if (!finalFramework) {
        finalFramework = await select({
            message: 'Which framework preset should we configure?',
            options: [
                { value: 'node', label: 'Node.js / Express' },
                { value: 'nestjs', label: 'NestJS' },
                { value: 'nextjs', label: 'Next.js (Standalone)' },
                { value: 'nuxt', label: 'Nuxt 3 (SSR)' },
                { value: 'svelte', label: 'SvelteKit (SSR)' },
                { value: 'python', label: 'Python FastAPI' },
                { value: 'django', label: 'Django (Python)' },
                { value: 'rails', label: 'Ruby on Rails' },
                { value: 'go', label: 'Go (Golang)' },
                { value: 'static', label: 'Static Site (Gatsby, React, plain HTML via Nginx)' },
            ],
        });
        if (typeof finalFramework === 'symbol') process.exit(0);
    }

    const setupType = await select({
        message: 'Choose your setup mode:',
        options: [
            { value: 'quick', label: '⚡ Quickstart (Recommended)', hint: 'Production defaults, minimal prompts' },
            { value: 'advanced', label: '🛠️  Advanced Configuration', hint: 'Customize health checks, task count, branch, etc.' },
        ],
    });
    if (typeof setupType === 'symbol') process.exit(0);

    let defaultPort = '3000';
    if (finalFramework === 'static' || finalFramework === 'go') defaultPort = '8080';
    if (finalFramework === 'python' || finalFramework === 'django') defaultPort = '8000';

    let currentGitBranch = 'main';
    try {
        currentGitBranch = execSync('git symbolic-ref --short HEAD', { cwd: targetDir, stdio: 'pipe' }).toString().trim();
    } catch (e) { }

    let needsDatabase = false;
    let dbEngine = 'postgres';
    const isBackendFramework = ['node', 'nestjs', 'nextjs', 'nuxt', 'svelte', 'python', 'django', 'rails', 'go'].includes(finalFramework);

    if (isBackendFramework) {
        const dbEvidence = capabilities?.relationalDb?.detected === true
            ? capabilities.relationalDb.evidence || []
            : [];
        const mysqlHint = capabilities?.upcomingHints?.mysql === true;
        const dbChoice = await confirm({
            message: dbEvidence.length > 0
                ? `Do you need a managed AWS RDS PostgreSQL database? (Adds ~$14/month or uses AWS Free Tier) (detected: ${dbEvidence.join(', ')})`
                : 'Do you need a managed AWS RDS PostgreSQL database? (Adds ~$14/month or uses AWS Free Tier)',
            initialValue: dbEvidence.length > 0 || mysqlHint,
        });
        if (typeof dbChoice === 'symbol') process.exit(0);
        needsDatabase = dbChoice;
        if (needsDatabase) {
            if (explicitDbEngine) {
                dbEngine = explicitDbEngine;
            } else {
                const engineChoice = await select({
                    message: 'Which database engine should we provision?',
                    options: [
                        { value: 'postgres', label: 'PostgreSQL 16 (RDS db.t4g.micro)', hint: '~$13.98/mo fixed' },
                        { value: 'aurora-postgresql', label: 'Aurora PostgreSQL Serverless v2 (0–2 ACU)', hint: '$0/mo idle compute + storage' },
                        { value: 'mysql', label: 'MySQL 8.0 (RDS db.t4g.micro)', hint: '~$13.98/mo fixed' },
                    ],
                    initialValue: mysqlHint ? 'mysql' : 'postgres',
                });
                if (typeof engineChoice === 'symbol') process.exit(0);
                dbEngine = engineChoice;
            }
        }
    }

    let enablePrPreviews = false;
    let aiAssistants = [];
    if (setupType === 'advanced') {
        const prChoice = await confirm({
            message: `Enable Ephemeral PR Previews? (Spins up isolated, temporary AWS environments for PRs)\n  ${color.gray('📖 Learn more: https://github.com/grada-run/grada/blob/main/apps/docs/src/content/docs/guides/ephemeral-pr-previews.md')}`,
            initialValue: false,
        });
        if (typeof prChoice === 'symbol') process.exit(0);
        enablePrPreviews = prChoice;

        aiAssistants = await getAiAssistants();
    }

    const project = await group({
        region: () => select({
            message: 'Which AWS region do you want to deploy to?',
            options: [
                { value: 'us-east-1', label: 'us-east-1 (N. Virginia)' },
                { value: 'us-east-2', label: 'us-east-2 (Ohio)' },
                { value: 'eu-west-1', label: 'eu-west-1 (Ireland)' },
                { value: 'eu-central-1', label: 'EU (Frankfurt)' },
                { value: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' },
            ],
        }),
        port: () => text({
            message: 'What port does your container expose?',
            placeholder: defaultPort,
            defaultValue: defaultPort,
        }),
        size: () => skipsContainerSizing ? undefined : select({
            message: 'Select your Fargate compute size:',
            options: [
                { value: 'micro', label: 'Micro (0.25 vCPU, 512MB RAM) - Best for POCs' },
                { value: 'small', label: 'Small (0.5 vCPU, 1GB RAM) - Best for small Projects' },
            ],
        }),
        healthCheckPath: () => (setupType === 'quick' || skipsContainerSizing) ? undefined : text({
            message: 'ALB Health Check Path:',
            placeholder: '/',
            defaultValue: '/',
        }),
        desiredCount: () => (setupType === 'quick' || skipsContainerSizing) ? undefined : select({
            message: 'How many container replicas (tasks) should run?',
            options: [
                { value: '1', label: '1 Task (Single instance - lowest cost)' },
                { value: '2', label: '2 Tasks (High Availability across AZs)' },
            ],
            defaultValue: '1',
        }),
        branch: () => setupType === 'quick' ? undefined : text({
            message: 'Primary Git deployment branch for CI/CD:',
            placeholder: currentGitBranch,
            defaultValue: currentGitBranch,
        }),
    }, { onCancel: () => process.exit(0) });

    return {
        framework: finalFramework,
        region: project.region,
        port: project.port,
        size: project.size || 'micro',
        healthCheckPath: project.healthCheckPath || '/',
        desiredCount: project.desiredCount || '1',
        branch: project.branch || currentGitBranch,
        needsDatabase,
        dbEngine,
        enablePrPreviews,
        aiAssistants,
        setupType
    };
}

// Prompts for the background worker command. Pre-fills from the Procfile
// worker process when present, otherwise from capability detection
// (`npm run <script>`). Returns the (possibly edited) command string.
export async function promptWorkerCommand(procfile, capabilities = null) {
    const procfileCommand = Array.isArray(procfile?.worker) ? procfile.worker.join(' ') : '';
    const detectedCommand = typeof capabilities?.worker?.suggestedCommand === 'string'
        ? capabilities.worker.suggestedCommand
        : '';
    const answer = await text({
        message: procfileCommand
            ? 'What command runs your background worker? (Empty keeps the Procfile default)'
            : 'What command runs your background worker? (Empty skips the worker service)',
        placeholder: 'celery -A config worker',
        initialValue: procfileCommand || detectedCommand,
    });
    if (typeof answer === 'symbol') {
        cancel('Operation cancelled.');
        process.exit(0);
    }
    return typeof answer === 'string' ? answer : '';
}

export async function getAiAssistants() {
    const selected = await multiselect({
        message: 'Which AI coding assistants does your team use?',
        options: [
            { value: 'cursor', label: 'Cursor', hint: 'Generates .cursor/rules/grada.mdc' },
            { value: 'roo', label: 'Roo Code', hint: 'Generates .roo/rules/grada.md' },
            { value: 'trae', label: 'Trae IDE', hint: 'Generates .trae/rules/project_rules.md' },
            { value: 'windsurf', label: 'Windsurf', hint: 'Generates .windsurfrules' },
            { value: 'copilot', label: 'GitHub Copilot', hint: 'Generates .github/copilot-instructions.md' },
            { value: 'claude', label: 'Claude Code', hint: 'Updates CLAUDE.md' },
            { value: 'goose', label: 'Goose', hint: 'Updates .goosehints' },
            { value: 'aider', label: 'Aider', hint: 'Updates .aider.conf.yml' },
            { value: 'continue', label: 'Continue.dev', hint: 'Generates .prompts/grada.prompt' }
        ],
        required: false,
    });

    if (typeof selected === 'symbol') {
        cancel('Operation cancelled.');
        process.exit(0);
    }

    return selected;
}