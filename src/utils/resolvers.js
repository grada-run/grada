import fsSync from 'fs';
import path from 'path';
import { normalizeOptions } from './args.js';

export const FALLBACK_REGION = 'us-east-2';

export function readFileSafe(filePath) {
    if (typeof filePath !== 'string') return null;
    try {
        if (fsSync.existsSync(filePath)) return fsSync.readFileSync(filePath, 'utf8');
    } catch {
        // Fall through to defaults
    }
    return null;
}

// Canonical compute targets supported by `--target`. `ecs` covers both
// the canonical `ecs` value and its `fargate` synonym (normalized by
// callers). Single source of truth — commands must import this instead
// of re-declaring their own target list.
export const COMPUTE_TARGETS = ['ecs', 'lambda', 'static'];

// Pure target check over rendered `main.tf` content: Lambda projects
// provision the serverless function; static projects serve the site
// straight from a CloudFront distribution (ECS keeps its distribution in
// cloudfront.tf, so one in main.tf is unambiguous); the rest is ECS.
export function detectComputeTargetFromMainTf(mainTfContent) {
    if (typeof mainTfContent === 'string') {
        if (mainTfContent.includes('resource "aws_lambda_function"')) {
            return 'lambda';
        }
        if (mainTfContent.includes('resource "aws_cloudfront_distribution"')) {
            return 'static';
        }
    }
    return 'ecs';
}

// Reads the compute target of the project rooted at `cwd`. Missing or
// unreadable Terraform falls back to `ecs` so legacy projects and
// pre-init guards keep their historical behavior.
export function readTerraformComputeTarget(cwd = process.cwd()) {
    const base = resolveCwd({}, cwd);
    return detectComputeTargetFromMainTf(readFileSafe(path.join(base, 'terraform', 'main.tf')));
}

// Predicate form of the target check for commands that adapt (rather
// than refuse) per target: `isComputeTarget(cwd, 'lambda')`.
export function isComputeTarget(cwd = process.cwd(), ...targets) {
    return targets.includes(readTerraformComputeTarget(cwd));
}

function prettyTargetName(target) {
    return target === 'ecs' ? 'ECS' : `${target[0].toUpperCase()}${target.slice(1)}`;
}

// Shared unsupported-target guard: checks the target BEFORE the caller
// prompts or constructs AWS clients. Returns null when the project
// target is supported; otherwise a descriptor the caller passes straight
// to failCommand ({ actual, reason, errorCode, message, hint }).
// The message names every unsupported target ("…is not supported on
// Lambda or Static targets.") so one call site covers all of them.
export function guardComputeTarget({ cwd = process.cwd(), command, supported = ['ecs'], hint = null } = {}) {
    const actual = readTerraformComputeTarget(cwd);
    if (supported.includes(actual)) return null;
    const unsupported = COMPUTE_TARGETS.filter((target) => !supported.includes(target)).map(prettyTargetName);
    const targetList = unsupported.length > 1
        ? `${unsupported.slice(0, -1).join(', ')} or ${unsupported[unsupported.length - 1]} targets`
        : `${unsupported[0] ?? prettyTargetName(actual)} targets`;
    return {
        actual,
        reason: `${actual}-target-unsupported`,
        errorCode: `${actual.toUpperCase()}_TARGET_UNSUPPORTED`,
        message: `\n✖ ${command} is not supported on ${targetList}.`,
        hint,
    };
}

// Working directory for file resolution: an explicit string `cwd` option,
// otherwise the positional `fallback` when it is a usable path, otherwise
// the process cwd. A throwing `process.cwd()` (deleted directory)
// propagates so callers route through PROJECT_NOT_INITIALIZED.
export function resolveCwd(options = {}, fallback) {
    const opts = normalizeOptions(options);
    if (typeof opts.cwd === 'string' && opts.cwd) return opts.cwd;
    if (typeof fallback === 'string' && fallback) return fallback;
    return process.cwd();
}

export function readTerraformRegion(cwd = process.cwd()) {
    const base = resolveCwd({}, cwd);
    const mainTf = readFileSafe(path.join(base, 'terraform', 'main.tf'));
    if (!mainTf) return null;
    const match = mainTf.match(/region\s*=\s*"([^"]+)"/);
    if (!match || match[1].includes('{{')) return null;
    return match[1];
}

export function resolveRegion(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    if (typeof opts.region === 'string' && opts.region.trim()) {
        return opts.region.trim();
    }
    if (typeof process.env.AWS_REGION === 'string' && process.env.AWS_REGION.trim()) {
        return process.env.AWS_REGION.trim();
    }
    return readTerraformRegion(resolveCwd(opts, cwd)) || FALLBACK_REGION;
}

export function readTerraformProjectName(cwd = process.cwd()) {
    const base = resolveCwd({}, cwd);
    const mainTf = readFileSafe(path.join(base, 'terraform', 'main.tf'));
    if (!mainTf) return null;
    const appNameMatch = mainTf.match(/app_name\s*=\s*"([^"$]+)\$\{local\.env_suffix\}"/);
    if (appNameMatch) return appNameMatch[1];
    // Hand-written files may set a plain app_name (possibly with some other
    // ${...} suffix); it still outranks the ECR heuristic below.
    const genericMatch = mainTf.match(/app_name\s*=\s*"([^"]+)"/);
    if (genericMatch && !genericMatch[1].includes('{{')) {
        const stripped = genericMatch[1].replace(/\$\{.*$/, '').replace(/[-_]$/, '');
        if (stripped) return stripped;
    }
    const ecrMatch = mainTf.match(/resource\s+"aws_ecr_repository"\s+"app"\s*\{[^}]*?name\s*=\s*"([^"]+)-repo"/);
    if (ecrMatch) return ecrMatch[1];
    return null;
}

export function resolveProjectName(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    const base = resolveCwd(opts, cwd);
    if (typeof opts.projectName === 'string' && opts.projectName.trim()) {
        return opts.projectName.trim();
    }
    return readTerraformProjectName(base) || path.basename(path.resolve(base));
}

export function resolveCluster(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    if (typeof opts.cluster === 'string' && opts.cluster.trim()) return opts.cluster.trim();
    if (typeof process.env.ECS_CLUSTER === 'string' && process.env.ECS_CLUSTER.trim()) {
        return process.env.ECS_CLUSTER.trim();
    }
    return `${resolveProjectName(opts, cwd)}-cluster`;
}

export function resolveService(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    if (typeof opts.service === 'string' && opts.service.trim()) return opts.service.trim();
    if (typeof opts.serviceName === 'string' && opts.serviceName.trim()) return opts.serviceName.trim();
    if (typeof process.env.ECS_SERVICE === 'string' && process.env.ECS_SERVICE.trim()) {
        return process.env.ECS_SERVICE.trim();
    }
    return `${resolveProjectName(opts, cwd)}-service`;
}

export function resolveLogGroup(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    if (typeof opts.logGroup === 'string' && opts.logGroup.trim()) {
        return opts.logGroup.trim();
    }
    if (typeof opts.logGroupName === 'string' && opts.logGroupName.trim()) {
        return opts.logGroupName.trim();
    }
    if (typeof process.env.ECS_LOG_GROUP === 'string' && process.env.ECS_LOG_GROUP.trim()) {
        return process.env.ECS_LOG_GROUP.trim();
    }
    const base = resolveCwd(opts, cwd);
    const projectName = resolveProjectName(opts, base);
    // Lambda functions log to /aws/lambda/<fn> (see main-lambda.tf), where
    // the function name is `<app>-fn`.
    if (readTerraformComputeTarget(base) === 'lambda') {
        return `/aws/lambda/${projectName}-fn`;
    }
    return `/ecs/${projectName}`;
}

// True when prompts must not block: explicit headless flags, CI/test
// environments, or non-TTY stdio. An explicit `isHeadless: false` (or
// `headless: false`) forces interactive mode so unit tests can simulate
// TTY prompts. `env`/`stdin`/`stdout` are injectable for tests.
export function resolveHeadless(options = {}, env = process.env, stdin = process.stdin, stdout = process.stdout) {
    const opts = normalizeOptions(options);
    if (opts.isHeadless === false || opts.headless === false) return false;
    return Boolean(
        opts.isHeadless ||
        opts.headless ||
        (env && (env.CI || env.VITEST)) ||
        (env && env.NODE_ENV === 'test') ||
        !stdin?.isTTY ||
        !stdout?.isTTY
    );
}

// Workspace-namespaced application name (`myapp` or `myapp-pr-123`) shared
// by every `db` subcommand. `workspace` is the explicit `--workspace` value
// (or undefined to auto-detect `.terraform/environment` under `cwd`).
export function resolveAppName(projectName, workspace, cwd = process.cwd()) {
    return `${projectName}${resolveWorkspaceSuffix({ workspace, cwd }, cwd)}`;
}

// Reads the local Terraform workspace (e.g. a PR-preview environment).
// Returns '' for the default workspace so names stay un-suffixed.
export function resolveWorkspaceSuffix(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    const base = resolveCwd(opts, cwd);
    let workspace = null;
    if (typeof opts.workspace === 'string' && opts.workspace.trim()) {
        workspace = opts.workspace.trim();
    } else {
        const detected = readFileSafe(path.join(base, '.terraform', 'environment'));
        if (typeof detected === 'string' && detected.trim()) workspace = detected.trim();
    }
    if (!workspace || workspace === 'default') return '';
    return `-${workspace}`;
}
