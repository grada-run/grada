import fsSync from 'fs';
import path from 'path';

export { detectProjectCapabilities } from './capabilities.js';

// Detects the framework based on the presence of framework-specific files.
export function detectFramework(targetDir) {
    const packageJsonPath = path.join(targetDir, 'package.json');
    const requirementsTxtPath = path.join(targetDir, 'requirements.txt');
    const managePyPath = path.join(targetDir, 'manage.py');
    const goModPath = path.join(targetDir, 'go.mod');
    const gemfilePath = path.join(targetDir, 'Gemfile');

    // 1. Detect Node.js Frameworks
    if (fsSync.existsSync(packageJsonPath)) {
        try {
            const pkg = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8'));
            // Merge dependencies and devDependencies to check both
            const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

            // Fullstack / API
            if (deps['@nestjs/core']) return { id: 'nestjs', name: 'NestJS' };
            if (deps['next']) {
                // A static export is still Next.js (same container preset on
                // ecs/lambda) but carries no server — flag it so --target
                // static admits it and BUILD_DIR points at out/.
                if (analyzeNextConfig(targetDir).isExport) {
                    return { id: 'nextjs', name: 'Next.js Static Export', buildDir: 'out', isStaticExport: true };
                }
                return { id: 'nextjs', name: 'Next.js' };
            }
            if (deps['nuxt']) return { id: 'nuxt', name: 'Nuxt 3 (SSR)' };
            if (deps['express']) return { id: 'node', name: 'Node.js / Express' };

            // Explicit SvelteKit SSR Detection
            if (deps['@sveltejs/kit']) {
                // adapter-static prerenders to build/ with no server — same
                // static-target eligibility as a Next.js static export.
                if (analyzeSvelteConfig(targetDir).adapter === 'static') {
                    return { id: 'svelte', name: 'SvelteKit Static', buildDir: 'build', isStaticExport: true };
                }
                return { id: 'svelte', name: 'SvelteKit SSR', buildDir: 'build' };
            }

            // Static Site Generators & SPAs (with precise build directories)
            if (deps['react-scripts']) return { id: 'static', name: 'Create React App', buildDir: 'build' };
            if (deps['gatsby']) return { id: 'static', name: 'Gatsby', buildDir: 'public' };
            if (deps['astro']) return { id: 'static', name: 'Astro', buildDir: 'dist' };
            if (deps['vite']) return { id: 'static', name: 'Vite', buildDir: 'dist' };
            if (deps['@vue/cli-service']) return { id: 'static', name: 'Vue.js', buildDir: 'dist' };
            if (deps['@angular/cli']) return { id: 'static', name: 'Angular', buildDir: 'dist' };
        } catch (e) {
            // Silently fail if package.json is malformed
        }
    }

    // 2. Detect Python Frameworks
    if (fsSync.existsSync(requirementsTxtPath)) {
        try {
            const reqs = fsSync.readFileSync(requirementsTxtPath, 'utf-8').toLowerCase();
            if (reqs.includes('fastapi')) return { id: 'python', name: 'Python FastAPI' };
            if (reqs.includes('django')) return { id: 'django', name: 'Django' };
        } catch (e) {
            // Silently fail
        }
    }

    // Fallback Django detection (sometimes requirements.txt is named differently)
    if (fsSync.existsSync(managePyPath)) return { id: 'django', name: 'Django' };

    // 3. Detect Ruby on Rails
    if (fsSync.existsSync(gemfilePath)) {
        try {
            const gemfile = fsSync.readFileSync(gemfilePath, 'utf-8').toLowerCase();
            if (/gem\s+['"]rails['"]/i.test(gemfile)) { return { id: 'rails', name: 'Ruby on Rails' }; }
        } catch (e) {
            // Silently fail
        }
    }

    // 4. Detect Go
    if (fsSync.existsSync(goModPath)) return { id: 'go', name: 'Go' };

    // 5. Fallback
    return null;
}

// Splits a Procfile-style command into Terraform's JSON-array form,
// respecting single and double quotes. Shared by Procfile parsing and
// the interactive worker-command prompt so both produce identical arrays.
export function splitProcfileCommand(rawCommand) {
    const match = String(rawCommand || '').match(/[^\s"']+|"([^"]*)"|'([^']*)'/g);
    if (!match) return [];
    return match.map(str => str.replace(/^["']|["']$/g, '')); // Strip the quotes
}

// Parses a Heroku/Render Procfile and formats the commands for Terraform ECS.
export function parseProcfile(targetDir) {
    const procfilePath = path.join(targetDir, 'Procfile');

    if (!fsSync.existsSync(procfilePath)) return null;

    const content = fsSync.readFileSync(procfilePath, 'utf-8');
    const processes = {};

    // Match lines like "web: gunicorn myapp.wsgi"
    const lines = content.split('\n');
    const procRegex = /^([A-Za-z0-9_-]+):\s*(.+)$/;

    for (const line of lines) {
        const match = line.trim().match(procRegex);
        if (match) {
            const type = match[1].toLowerCase();
            const rawCommand = match[2].trim();

            // Terraform requires the command as a JSON array of strings
            const commandArray = splitProcfileCommand(rawCommand);

            processes[type] = commandArray;
        }
    }

    return Object.keys(processes).length > 0 ? processes : null;
}

// Parses a vercel.json file to extract routing and edge rules
export function parseVercelConfig(targetDir) {
    const vercelConfigPath = path.join(targetDir, 'vercel.json');
    if (!fsSync.existsSync(vercelConfigPath)) return null;

    try {
        const content = fsSync.readFileSync(vercelConfigPath, 'utf-8');
        const vercelJson = JSON.parse(content);

        // We only care about network-level edge rules that AWS needs to handle
        const rules = {
            redirects: vercelJson.redirects || null,
            headers: vercelJson.headers || null,
            rewrites: vercelJson.rewrites || null
        };

        // If it's just an empty vercel.json, return null
        if (!rules.redirects && !rules.headers && !rules.rewrites) {
            return null;
        }

        return rules;
    } catch (e) {
        // Silently fail on malformed JSON
        return null;
    }
}

// Checks if Next.js is configured for 'standalone' output
export function analyzeNextConfig(targetDir) {
    const extensions = ['js', 'mjs', 'cjs', 'ts'];
    let configPath = null;
    let configContent = '';

    for (const ext of extensions) {
        const tempPath = path.join(targetDir, `next.config.${ext}`);
        if (fsSync.existsSync(tempPath)) {
            configPath = tempPath;
            configContent = fsSync.readFileSync(tempPath, 'utf-8');
            break;
        }
    }

    if (!configPath) return { hasConfig: false, isStandalone: false, isExport: false };

    // Regex looks for output: 'standalone' or output: "standalone" (handling spacing)
    const isStandalone = /output\s*:\s*['"`]standalone['"`]/.test(configContent);
    // Static exports (output: 'export') emit plain files to out/ — they are
    // eligible for --target static without a container (see detectFramework).
    const isExport = /output\s*:\s*['"`]export['"`]/.test(configContent);

    return {
        hasConfig: true,
        isStandalone: isStandalone,
        isExport: isExport,
        configPath: configPath
    };
}

// Checks if SvelteKit is locked into Vercel
export function analyzeSvelteConfig(targetDir) {
    const configPath = path.join(targetDir, 'svelte.config.js');
    if (!fsSync.existsSync(configPath)) return { hasConfig: false, adapter: 'unknown' };

    const content = fsSync.readFileSync(configPath, 'utf-8');

    let adapter = 'unknown';
    if (content.includes('@sveltejs/adapter-vercel')) adapter = 'vercel';
    else if (content.includes('@sveltejs/adapter-node')) adapter = 'node';
    else if (content.includes('@sveltejs/adapter-static')) adapter = 'static';
    else if (content.includes('@sveltejs/adapter-auto')) adapter = 'auto'; // Vercel's default

    return { hasConfig: true, adapter };
}

// Checks if Astro is locked into Vercel
export function analyzeAstroConfig(targetDir) {
    const extensions = ['mjs', 'js', 'ts', 'cjs'];
    let configPath = null;
    let content = '';

    for (const ext of extensions) {
        const tempPath = path.join(targetDir, `astro.config.${ext}`);
        if (fsSync.existsSync(tempPath)) {
            configPath = tempPath;
            content = fsSync.readFileSync(tempPath, 'utf-8');
            break;
        }
    }

    if (!configPath) return { hasConfig: false, adapter: 'unknown' };

    let adapter = 'unknown';
    if (content.includes('@astrojs/vercel')) adapter = 'vercel';
    else if (content.includes('@astrojs/node')) adapter = 'node';

    return { hasConfig: true, adapter };
}

// Detects the project's schema-migration command from well-known ORM and
// framework markers. Pure: reads files under `cwd`, never throws (malformed
// or unreadable files fall through to the next marker). Returns the shell
// command string or null when nothing matches.
export function detectMigrationCommand(cwd = process.cwd()) {
    const readJson = (file) => {
        try {
            return JSON.parse(fsSync.readFileSync(path.join(cwd, file), 'utf-8'));
        } catch {
            return null;
        }
    };
    const exists = (file) => {
        try {
            return fsSync.existsSync(path.join(cwd, file));
        } catch {
            return false;
        }
    };

    // 1. Explicit package.json migration scripts win over framework markers.
    const pkg = readJson('package.json');
    const scripts = pkg && typeof pkg === 'object' ? pkg.scripts || {} : {};
    if (typeof scripts['db:migrate'] === 'string' && scripts['db:migrate'].trim()) {
        return 'npm run db:migrate';
    }
    if (typeof scripts.migrate === 'string' && scripts.migrate.trim()) {
        return 'npm run migrate';
    }

    // 2. Prisma: schema file or dependency in either dep block.
    const deps = pkg && typeof pkg === 'object'
        ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
        : {};
    if (exists(path.join('prisma', 'schema.prisma')) || deps.prisma) {
        return 'npx prisma migrate deploy';
    }

    // 3. Drizzle: config file in any supported extension.
    if (exists('drizzle.config.ts') || exists('drizzle.config.js') || exists('drizzle.config.mjs')) {
        return 'npx drizzle-kit migrate';
    }

    // 4. Alembic.
    if (exists('alembic.ini')) {
        return 'alembic upgrade head';
    }

    // 5. Django.
    if (exists('manage.py')) {
        return 'python manage.py migrate --noinput';
    }

    // 6. Ruby on Rails: binstub or Gemfile rails dependency.
    if (exists(path.join('bin', 'rails'))) {
        return 'bundle exec rails db:migrate';
    }
    try {
        const gemfilePath = path.join(cwd, 'Gemfile');
        if (fsSync.existsSync(gemfilePath)) {
            const gemfile = fsSync.readFileSync(gemfilePath, 'utf-8');
            if (/gem\s+['"]rails['"]/i.test(gemfile)) {
                return 'bundle exec rails db:migrate';
            }
        }
    } catch {
        // Fall through to null below.
    }

    return null;
}

// Checks if a NestJS app explicitly listens on 0.0.0.0 for Docker networking
export function analyzeNestApp(targetDir) {
    const mainTsPath = path.join(targetDir, 'src', 'main.ts');
    const mainJsPath = path.join(targetDir, 'src', 'main.js');

    const filePath = fsSync.existsSync(mainTsPath) ? mainTsPath : (fsSync.existsSync(mainJsPath) ? mainJsPath : null);
    if (!filePath) return { hasMain: false, listensOnAllInterfaces: true };

    try {
        const content = fsSync.readFileSync(filePath, 'utf-8');
        const hasHostBinding = content.includes('0.0.0.0');
        return {
            hasMain: true,
            listensOnAllInterfaces: hasHostBinding,
            filePath: path.relative(targetDir, filePath)
        };
    } catch {
        return { hasMain: false, listensOnAllInterfaces: true };
    }
}