import { normalizeArgv } from '../utils/args.js';

export function parseCliArgs(processArgs) {
    const argv = normalizeArgv(processArgs);
    // 1. Extract telemetry flag safely
    const hasNoTelemetry = argv.some(arg => arg === '--no-telemetry' || (typeof arg === 'string' && arg.startsWith('--no-telemetry=')));

    // 2. Filter out telemetry flag
    const args = argv.filter(arg => arg !== '--no-telemetry' && !(typeof arg === 'string' && arg.startsWith('--no-telemetry=')));

    // 3. Flag readers. Every value flag supports both `--flag=value` and
    // `--flag value` spellings; space-form values are recorded in
    // `consumed` so section 5 can keep them out of the positional
    // command string. Boolean flags never consume the next token.
    const consumed = new Set();

    const getValueFlag = (flagName) => {
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (typeof arg !== 'string') continue;
            if (arg.startsWith(`--${flagName}=`)) {
                const value = arg.slice(flagName.length + 3);
                return value === '' ? null : value;
            }
            if (arg === `--${flagName}`) {
                const next = args[i + 1];
                if (typeof next === 'string' && next !== '' && !next.startsWith('--')) {
                    consumed.add(i + 1);
                    return next;
                }
                return null;
            }
        }
        return null;
    };

    const getBoolFlag = (flagName) => {
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (typeof arg !== 'string') continue;
            if (arg.startsWith(`--${flagName}=`)) {
                return arg.slice(flagName.length + 3) === 'true';
            }
            if (arg === `--${flagName}`) return true;
        }
        return null;
    };

    // 4. Parse execution flags
    const isHeadless = args.includes('--headless');
    const isDryRun = args.includes('--dry-run');
    const isPreconfigured = args.includes('--preconfigured');

    // Headless values are always parsed (so consumption marking is
    // mode-independent) but only exposed in headless mode.
    const headlessValues = {
        dir: getValueFlag('dir'),
        framework: getValueFlag('framework'),
        region: getValueFlag('region'),
        port: getValueFlag('port'),
        size: getValueFlag('size'),
        healthCheckPath: getValueFlag('healthCheckPath'),
        desiredCount: getValueFlag('desiredCount'),
        branch: getValueFlag('branch'),
        needsDatabase: getBoolFlag('needsDatabase'),
        enablePrPreviews: getBoolFlag('enablePrPreviews')
    };
    const headlessOptions = isHeadless ? headlessValues : {};

    const parseWithFlag = () => {
        const values = [];
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (typeof arg !== 'string') continue;
            if (arg === '--with') {
                const next = args[i + 1];
                if (typeof next === 'string' && next !== '' && !next.startsWith('--')) {
                    consumed.add(i + 1);
                    values.push(...next.split(','));
                }
                continue;
            }
            if (arg.startsWith('--with=')) {
                values.push(...arg.slice('--with='.length).split(','));
            }
        }
        const seen = new Set();
        const deduped = [];
        for (const raw of values) {
            const value = String(raw).trim();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            deduped.push(value);
        }
        return deduped;
    };

    const initOptions = {
        with: parseWithFlag(),
        force: getBoolFlag('force') === true,
        model: getValueFlag('model'),
        domain: getValueFlag('domain'),
        zoneId: getValueFlag('zone-id'),
        fromEmail: getValueFlag('from-email'),
        dbEngine: getValueFlag('db-engine'),
        target: getValueFlag('target'),
        setupCiMigrate: args.includes('--setup-ci-migrate'),
        setupCiDrift: args.includes('--setup-ci-drift'),
    };

    // 5. Isolate positional commands (non-string elements are positionals;
    // values consumed by space-form flags are excluded).
    const isFlag = (arg) => typeof arg === 'string' && arg.startsWith('--');
    const positionalArgs = args.filter((arg, idx) => !isFlag(arg) && !consumed.has(idx));
    const baseCommand = positionalArgs.length > 0 ? positionalArgs.slice(0, 2).join(' ') : 'init';

    return {
        hasNoTelemetry,
        positionalArgs,
        baseCommand,
        isHeadless,
        isDryRun,
        isPreconfigured,
        autoApprove: getBoolFlag('auto-approve') === true,
        yes: getBoolFlag('yes') === true,
        headlessOptions,
        initOptions
    };
}