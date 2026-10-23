import { normalizeArgv } from '../utils/args.js';

// The only meaningful --no-telemetry spellings (bare, =true, =false —
// the getBoolFlag convention). Anything else (=garbage, or a flag-like
// *value* such as --cmd "--no-telemetry=x") is not a global: it flows
// through to per-command parsing, where the unknown-flag gate rejects
// it loudly instead of this layer silently eating a command value.
const GLOBAL_ONLY_FLAGS = new Set(['--no-telemetry', '--no-telemetry=true', '--no-telemetry=false']);

export function parseCliArgs(processArgs) {
    const argv = normalizeArgv(processArgs);
    // 1. Extract telemetry flag safely
    const hasNoTelemetry = argv.some(arg => arg === '--no-telemetry' || arg === '--no-telemetry=true');

    // 2. Filter out telemetry flag
    const args = argv.filter(arg => !GLOBAL_ONLY_FLAGS.has(arg));

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

    // Boolean-or-value flags: bare `--flag` reads true, `--flag=value`
    // and `--flag value` read the value, absent reads false. Empty values
    // degrade to bare (a blank command is meaningless).
    const getBoolOrValueFlag = (flagName) => {
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (typeof arg !== 'string') continue;
            if (arg.startsWith(`--${flagName}=`)) {
                const value = arg.slice(flagName.length + 3);
                return value === '' ? true : value;
            }
            if (arg === `--${flagName}`) {
                const next = args[i + 1];
                if (typeof next === 'string' && next !== '' && !next.startsWith('--')) {
                    consumed.add(i + 1);
                    return next;
                }
                return true;
            }
        }
        return false;
    };

    // 4. Parse execution flags (getBoolFlag like their neighbors: bare and
    // =true both set, =false and absent both clear)
    const isHeadless = getBoolFlag('headless') === true;
    const isDryRun = getBoolFlag('dry-run') === true;
    const isPreconfigured = getBoolFlag('preconfigured') === true;

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
        offline: getBoolFlag('offline') === true,
        adoptState: getBoolFlag('adopt-state') === true,
        model: getValueFlag('model'),
        domain: getValueFlag('domain'),
        zoneId: getValueFlag('zone-id'),
        fromEmail: getValueFlag('from-email'),
        dbEngine: getValueFlag('db-engine'),
        target: getValueFlag('target'),
        projectName: getValueFlag('project-name'),
        githubRepo: getValueFlag('github-repo'),
        setupCiMigrate: getBoolOrValueFlag('setup-ci-migrate'),
        setupCiDrift: getBoolFlag('setup-ci-drift') === true,
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

// Args for per-command parsers: --no-telemetry is honored globally via
// DO_NOT_TRACK (see parseCliArgs), so it must not reach parseFlags —
// otherwise the unknown-flag gate would reject a documented global
// option on every command. Only meaningful spellings are stripped; a
// flag-like value (e.g. --cmd "--no-telemetry=x") passes through to the
// command untouched.
export function stripGlobalOnlyFlags(processArgs) {
    return normalizeArgv(processArgs).filter((arg) => !GLOBAL_ONLY_FLAGS.has(arg));
}