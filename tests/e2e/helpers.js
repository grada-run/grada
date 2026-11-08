// Shared helpers for the E2E suites (Tier 0 + Tier 1). Kept separate from
// tests/helpers/ on purpose: unit mocks must never leak into black-box runs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const CLI = path.join(ROOT, 'bin', 'cli.js');

// OS-temp workspace root so runs never litter the checkout with stale
// workspaces. CI pins E2E_TMP_ROOT back to tests/e2e/.tmp/ so failure
// artifacts keep uploading from the known path.
export const E2E_TMP_ROOT = process.env.E2E_TMP_ROOT || path.join(os.tmpdir(), 'grada-e2e');

// Shared provider cache across runs (mirrors scripts/test-iac.js),
// namespaced per Vitest worker. Parallel workers must never share one
// cache dir: concurrent `terraform init` corrupts it (checksum mismatches
// against the lock file, dead plugin binaries) and fails `validate` in
// whichever test loses the race. Same-worker tests run sequentially, so
// sharing one dir within a worker is safe.
const pluginCacheDir = path.join(os.tmpdir(), `grada-e2e-plugin-cache-${process.env.VITEST_WORKER_ID ?? 'main'}`);

export function e2eEnv({ mockAws }) {
    fs.mkdirSync(pluginCacheDir, { recursive: true });
    const env = {
        ...process.env,
        DO_NOT_TRACK: '1',
        TF_PLUGIN_CACHE_DIR: pluginCacheDir,
    };
    if (mockAws) {
        env.CI_MOCK_AWS = 'true';
    } else {
        delete env.CI_MOCK_AWS;
    }
    return env;
}

export function commandExists(cmd) {
    try {
        const result = spawnSync(cmd, ['--version'], { stdio: 'pipe' });
        return result.status === 0;
    } catch {
        return false;
    }
}

// Fail fast with a helpful error when local prerequisites are missing.
export function assertPrerequisites() {
    if (!commandExists('terraform')) {
        throw new Error(
            'E2E requires the Terraform CLI on PATH (https://developer.hashicorp.com/terraform/install).'
        );
    }
}

export function makeTmpDir(prefix) {
    fs.mkdirSync(E2E_TMP_ROOT, { recursive: true });
    return fs.mkdtempSync(path.join(E2E_TMP_ROOT, `${prefix}-`));
}

export function removeDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

// Container-image prerequisites for the live suites (Tier 1 + Tier 2):
// docker builds the fixture image, aws fetches the ECR login password.
export function assertImageBuildPrereqs(suite) {
    for (const cmd of ['docker', 'aws']) {
        if (!commandExists(cmd)) {
            throw new Error(
                `${suite} E2E requires ${cmd} on PATH to build and push the fixture image.`
            );
        }
    }
}

// Adopt the account's permanent OIDC provider instead of creating one (AWS
// allows a single provider per account). Shared by the live suites; throws
// when the scaffolded oidc.tf lacks the expected variable or default.
export function adoptSharedOidcProvider(projectDir) {
    const oidcTfPath = path.join(projectDir, 'terraform', 'oidc.tf');
    const oidcTf = fs.readFileSync(oidcTfPath, 'utf-8');
    if (!oidcTf.includes('variable "create_oidc_provider"')) {
        throw new Error('expected variable "create_oidc_provider" in terraform/oidc.tf');
    }
    const adopted = oidcTf.replace(/default\s*=\s*true/, 'default     = false');
    if (adopted === oidcTf) {
        throw new Error('could not flip create_oidc_provider default to false in terraform/oidc.tf');
    }
    fs.writeFileSync(oidcTfPath, adopted);
}

// Build the fixture image and push it to the scaffolded ECR repository,
// mirroring the generated deploy.yml (build -> push :latest). Returns the
// pushed image URI plus the repository URL (callers derive suffixed names
// from the latter). Shared by the live suites; throws with the tool output
// attached when any step fails.
export function buildAndPushImage({ dir, env, region }) {
    const ecrUrl = readTerraformOutput(dir, 'ecr_repository_url', env);
    const image = `${ecrUrl}:latest`;
    const registry = ecrUrl.split('/')[0];

    const password = run('aws', ['ecr', 'get-login-password', '--region', region], { cwd: dir, env, capture: true });
    if (password.status !== 0) {
        throw new Error(`aws ecr get-login-password failed: ${password.output.trim()}`);
    }
    const login = run('docker', ['login', '--username', 'AWS', '--password-stdin', registry], { cwd: dir, env, capture: true, input: password.stdout });
    if (login.status !== 0) {
        throw new Error(`docker login to ${registry} failed: ${login.output.trim()}`);
    }
    const build = run('docker', ['build', '-t', image, '.'], { cwd: dir, env });
    if (build.status !== 0) {
        throw new Error(`docker build ${image} failed with exit ${build.status}`);
    }
    const push = run('docker', ['push', image], { cwd: dir, env });
    if (push.status !== 0) {
        throw new Error(`docker push ${image} failed with exit ${push.status}`);
    }
    return { image, ecrUrl };
}

// Run the real CLI with stdin always closed (headless purity: a prompt
// crashes loudly instead of hanging). Output is inherited for visibility
// unless capture is requested for assertions.
export function runCli(args, { cwd, env, capture = false } = {}) {
    const result = spawnSync('node', [CLI, ...args], {
        cwd,
        env,
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
        encoding: 'utf-8',
    });
    return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    };
}

// Generic synchronous runner for non-CLI tools (npm, docker, aws,
// terraform). Mirrors runCli's stdio contract: output is inherited for
// visibility unless capture is requested; `input` feeds stdin (capture
// only, e.g. piping an ECR password into `docker login`).
export function run(cmd, args, { cwd, env, capture = false, input } = {}) {
    const result = spawnSync(cmd, args, {
        cwd,
        env,
        input: capture ? input : undefined,
        stdio: capture
            ? [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
            : ['ignore', 'inherit', 'inherit'],
        encoding: 'utf-8',
    });
    return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    };
}

// Read a raw Terraform output value (fails loudly when errored or unset).
export function readTerraformOutput(projectDir, name, env) {
    const result = run('terraform', ['output', '-raw', name], {
        cwd: path.join(projectDir, 'terraform'),
        env,
        capture: true,
    });
    if (result.status !== 0) {
        throw new Error(`terraform output -raw ${name} failed: ${result.output.trim()}`);
    }
    return result.stdout.trim();
}

export function runTerraform(args, { cwd, env }) {
    const result = spawnSync('terraform', args, {
        cwd,
        env,
        stdio: ['ignore', 'inherit', 'inherit'],
        encoding: 'utf-8',
    });
    if (result.status !== 0) {
        throw new Error(`terraform ${args.join(' ')} failed with exit ${result.status}`);
    }
}

// Isolated workspace that is removed on success and preserved (with its
// path printed) on failure for debugging and CI artifact upload.
export async function withTmpDir(prefix, fn) {
    const dir = makeTmpDir(prefix);
    try {
        await fn(dir);
    } catch (error) {
        console.log(`E2E workspace preserved for debugging: ${dir}`);
        throw error;
    }
    removeDir(dir);
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBackendValue(projectDir, key) {
    const backend = fs.readFileSync(path.join(projectDir, 'terraform', 'backend.tf'), 'utf-8');
    const match = backend.match(new RegExp(`${key}\\s*=\\s*"([^"]+)"`));
    if (!match) throw new Error(`could not parse ${key} from terraform/backend.tf`);
    return match[1];
}

export function readBackendBucket(projectDir) {
    return readBackendValue(projectDir, 'bucket');
}

export function readBackendRegion(projectDir) {
    return readBackendValue(projectDir, 'region');
}
