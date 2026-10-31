import fsSync from 'fs';
import path from 'path';
import { text, confirm, cancel, log } from '@clack/prompts';
import color from 'picocolors';

export async function resolveDjangoWsgi(targetDir, procfile, framework, isHeadless) {
    if (framework !== 'django') return 'core.wsgi';

    let extractedWsgi = null;
    if (procfile && procfile.web) {
        const webCommand = procfile.web.join(' ');
        const wsgiMatch = webCommand.match(/([a-zA-Z0-9_]+)\.wsgi/);
        if (wsgiMatch) extractedWsgi = `${wsgiMatch[1]}.wsgi`;
    }

    if (extractedWsgi) {
        if (!isHeadless) log.success(`Auto-detected Django WSGI from Procfile: ${color.cyan(extractedWsgi)}`);
        return extractedWsgi;
    }

    if (isHeadless) return 'core.wsgi';

    const djangoWsgi = await text({
        message: 'What is the Python module path to your Django wsgi.py?',
        placeholder: 'core.wsgi',
        initialValue: 'core.wsgi',
        validate: (value) => {
            if (/^[A-Za-z0-9_.]+$/.test(String(value ?? ''))) return undefined;
            return 'Enter a Python module path with letters, numbers, dots, and underscores only (e.g. core.wsgi).';
        },
    });

    if (typeof djangoWsgi === 'symbol') process.exit(0);
    return djangoWsgi;
}

export async function handleRailsCI(targetDir, framework, isHeadless, { force = false } = {}) {
    if (framework !== 'rails') return false;

    const ciPath = path.join(targetDir, '.github', 'workflows', 'ci.yml');
    const dependabotPath = path.join(targetDir, '.github', 'dependabot.yml');

    if (fsSync.existsSync(ciPath) || fsSync.existsSync(dependabotPath)) {
        // Headless renames user files only with explicit --force;
        // otherwise warn and keep them like the interactive decline path.
        if (isHeadless) {
            if (force !== true) {
                log.warn(color.yellow('⚠️  Detected default Rails GitHub Actions (ci.yml, dependabot.yml) that usually crash in isolated CI environments without a database — keeping them. Re-run with --force to let grada rename them to .bak.'));
                return false;
            }
            return true;
        }

        console.log('');
        const disable = await confirm({
            message: color.yellow('We detected default Rails GitHub Actions (ci.yml, dependabot.yml) that usually crash in isolated CI environments without a database. Would you like grada to safely disable them by renaming them to .bak?'),
            initialValue: true,
        });

        if (typeof disable === 'symbol') {
            cancel('Provisioning cancelled.');
            process.exit(0);
        }
        return disable;
    }
    return false;
}