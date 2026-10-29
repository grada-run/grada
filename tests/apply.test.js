import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackMocks as clack } from './helpers/clack.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { stripVTControlCharacters } from 'node:util';

// --- Deep mock for child_process.spawn (no real terraform binary) ---
const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  exec: vi.fn(),
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

// --- Silence interactive UI ---

// --- Never hit network / AWS ---

vi.mock('../src/utils/aws.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    provisionStateBucket: vi.fn().mockResolvedValue({
      awsAccountId: '123456789012',
      stateBucketName: 'mock-tf-state-bucket',
    }),
    ensureStateBucketExists: vi.fn().mockResolvedValue({ bucket: 'mock-tf-state-bucket' }),
  };
});

// Keep the real parseTerraformConfig (pure file reads) but stub the
// interactive preview so tests stay headless.
vi.mock('../src/utils/visualizer.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    renderDryRunPreview: vi.fn().mockResolvedValue(true),
  };
});

import { applyStack, OIDC_ADOPT_MANUAL_COMMAND } from '../src/commands/apply.js';
import { renderDryRunPreview } from '../src/utils/visualizer.js';
import { provisionStateBucket, ensureStateBucketExists } from '../src/utils/aws.js';
import { upsertAutoTfvar } from '../src/utils/terraform-metadata.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';

const COST_PROPS_SHAPE = {
  projectName: expect.any(String),
  estimated_monthly_usd: expect.any(Number),
  cpu: expect.any(Number),
  memory: expect.any(Number),
  has_db: expect.any(Boolean),
  has_worker: expect.any(Boolean),
  addons: expect.any(Array),
  addon_count: expect.any(Number),
};

// Build a fake terraform child process: stdout/stderr EventEmitters
// plus close/error on the child itself, matching apply.js usage.
function makeChild({ code = 0, stdout = '', stderr = '', error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    if (error) {
      child.emit('error', error);
      return;
    }
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
}

function exitError(code) {
  return Object.assign(new Error(`process.exit:${code}`), { exitCode: code });
}

describe('Command: apply (mocked terraform spawn)', () => {
  const originalCwd = process.cwd();
  let tmpDir;
  let exitSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    clack.mockConfirm.mockResolvedValue(true);
    clack.mockIsCancel.mockReturnValue(false);
    // process.exit throws so execution halts like the real runtime.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw exitError(code);
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-test-'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    exitSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeProject(files = {}) {
    fs.mkdirSync(path.join(tmpDir, 'terraform'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'terraform', 'main.tf'), '# fake stack\n');
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    process.chdir(tmpDir);
  }

  it('exits 1 when no terraform directory exists', async () => {
    process.chdir(tmpDir); // empty tmpdir: no terraform/main.tf
    await expect(applyStack({})).rejects.toMatchObject({ exitCode: 1 });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('dry run renders preview and returns without spawning terraform', async () => {
    writeProject();
    const result = await applyStack({ isDryRun: true });
    expect(result).toEqual({ ok: true, dryRun: true });
    expect(renderDryRunPreview).toHaveBeenCalledWith(expect.anything(), true);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_dry_run',
      expect.objectContaining({ success: true, ...COST_PROPS_SHAPE })
    );
    expect(flushTelemetry).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('programmatic target-switch refusal stops before terraform (no fall-through)', async () => {
    writeProject({
      '.grada/manifest.json': JSON.stringify({ version: 2, appliedTarget: 'lambda', files: {} }),
    });
    // json:true is programmatic (noExit) without approving: the gate must
    // return its refusal instead of falling through to cross-target apply.
    // (_skipPreview moves past the earlier preview prompt to the gate.)
    const result = await applyStack({ json: true, _skipPreview: true });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'non-interactive' }));
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_applied',
      expect.objectContaining({ success: false, error_code: 'APPLY_NON_INTERACTIVE' })
    );
  });

  it('returns cancelled without exiting when the preview confirm is declined', async () => {
    writeProject();
    renderDryRunPreview.mockResolvedValueOnce(false);
    const result = await applyStack({ isHeadless: false });
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses loudly when headless without approval flags instead of abandoning the preview prompt', async () => {
    writeProject();
    // No-op exit so the refusal result returns instead of throwing.
    exitSpy.mockImplementation(() => { });
    const result = await applyStack({});

    expect(result).toEqual({ ok: false, reason: 'non-interactive' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_applied',
      expect.objectContaining({ success: false, error_code: 'APPLY_NON_INTERACTIVE', reason: 'non-interactive' })
    );
    expect(flushTelemetry).toHaveBeenCalled();
    expect(renderDryRunPreview).not.toHaveBeenCalled();
    expect(clack.mockConfirm).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('provisions successfully: init + apply return and print app/direct URL outputs', async () => {
    writeProject();
    mockSpawn.mockImplementation((cmd, args = []) => {
      expect(cmd).toBe('terraform');
      if (args[0] === 'init') return makeChild({ code: 0, stdout: 'init ok' });
      if (args[0] === 'apply') return makeChild({ code: 0, stdout: 'apply complete' });
      if (args[0] === 'output')
        return makeChild({
          code: 0,
          stdout: JSON.stringify({
            cloudfront_url: { value: 'https://d123.cloudfront.net' },
            alb_direct_url: { value: 'http://alb-123.us-east-2.elb.amazonaws.com' },
          }),
        });
      return makeChild({ code: 0 });
    });

    const outroSpy = clack.mockOutro;
    // In-process callers get a result object; only real CLI runs exit.
    const result = await applyStack({ isHeadless: false });

    expect(result).toMatchObject({ ok: true });
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(mockSpawn.mock.calls[0][1]).toEqual(['init', '-upgrade']);
    expect(mockSpawn.mock.calls[1][1]).toEqual(['apply', '-auto-approve']);
    expect(mockSpawn.mock.calls[2][1]).toEqual(['output', '-json']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(outroSpy).toHaveBeenCalled();
    const outroText = stripVTControlCharacters(outroSpy.mock.calls.map((call) => call[0]).join('\n'));
    expect(outroText).toContain('App URL: https://d123.cloudfront.net (global CDN — share this link)');
    expect(outroText).toContain('Direct URL: http://alb-123.us-east-2.elb.amazonaws.com (bypasses the CDN — for debugging)');
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_applied',
      expect.objectContaining({ success: true, ...COST_PROPS_SHAPE })
    );
    // No dangling spinner: init stops the spinner before apply restarts it.
    const firstStop = clack.mockSpinnerStop.mock.invocationCallOrder[0];
    const secondStart = clack.mockSpinnerStart.mock.invocationCallOrder[1];
    expect(firstStop).toBeLessThan(secondStart);
    expect(clack.mockSpinnerStop.mock.calls[0][0]).toContain('Terraform initialized.');
  });

  it('exits 1 and tracks failure when terraform apply exits non-zero', async () => {
    writeProject();
    mockSpawn.mockImplementation((cmd, args = []) => {
      if (args[0] === 'init') return makeChild({ code: 0, stdout: 'init ok' });
      if (args[0] === 'apply')
        return makeChild({ code: 1, stderr: 'Error: generic apply boom' });
      return makeChild({ code: 0, stdout: '{}' });
    });

    await expect(applyStack({ isHeadless: false })).rejects.toMatchObject({ exitCode: 1 });
    expect(clack.mockLogError).toHaveBeenCalled();
    expect(provisionStateBucket).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_applied',
      expect.objectContaining({ success: false, ...COST_PROPS_SHAPE })
    );
  });

  it('recovers from a missing state bucket: recreates bucket and resumes', async () => {
    writeProject({
      'terraform/backend.tf': 'backend "s3" {\n  bucket = "myapp-a1b2c3-tfstate-123456789012"\n  key = "state/terraform.tfstate"\n  region = "us-east-2"\n}\n',
    });
    let applyCalls = 0;
    mockSpawn.mockImplementation((cmd, args = []) => {
      if (args[0] === 'init') return makeChild({ code: 0, stdout: 'init ok' });
      if (args[0] === 'apply') {
        applyCalls += 1;
        if (applyCalls === 1)
          return makeChild({ code: 1, stderr: 'NoSuchBucket: state bucket does not exist' });
        return makeChild({ code: 0, stdout: 'apply complete' });
      }
      if (args[0] === 'output')
        return makeChild({ code: 0, stdout: JSON.stringify({ alb_direct_url: { value: 'http://alb.example' }, ecr_repository_url: { value: 'repo' } }) });
      return makeChild({ code: 0 });
    });
    clack.mockConfirm.mockResolvedValue(true); // accept recovery prompt

    const result = await applyStack({ isHeadless: false });

    expect(result).toMatchObject({ ok: true });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(ensureStateBucketExists).toHaveBeenCalledWith({
      region: 'us-east-2',
      bucket: 'myapp-a1b2c3-tfstate-123456789012',
    });
    expect(provisionStateBucket).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('recovery_accepted', expect.anything());
    expect(trackEvent).toHaveBeenCalledWith('recovery_successful', expect.anything());
    expect(applyCalls).toBe(2);
    // Initial confirm-mode preview plus the confirm-mode preview on the
    // recovery resume: the resume preserves the caller's approval mode
    // (H5) instead of forcing auto-approve.
    expect(renderDryRunPreview).toHaveBeenCalledTimes(2);
    expect(renderDryRunPreview).toHaveBeenNthCalledWith(1, expect.anything(), false);
    expect(renderDryRunPreview).toHaveBeenNthCalledWith(2, expect.anything(), false);
  });

  it('still prints the preview in print-only mode when autoApprove is true', async () => {
    writeProject();
    mockSpawn.mockImplementation((cmd, args = []) => {
      if (args[0] === 'output') return makeChild({ code: 0, stdout: JSON.stringify({ alb_direct_url: { value: 'http://alb.example' }, ecr_repository_url: { value: 'repo' } }) });
      return makeChild({ code: 0 });
    });

    const result = await applyStack({ autoApprove: true });

    expect(result).toMatchObject({ ok: true });
    expect(renderDryRunPreview).toHaveBeenCalledTimes(1);
    expect(renderDryRunPreview).toHaveBeenCalledWith(expect.anything(), true);
    expect(clack.mockConfirm).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('aborts when the user declines state-bucket recovery', async () => {
    writeProject();
    mockSpawn.mockImplementation((cmd, args = []) => {
      if (args[0] === 'init') return makeChild({ code: 0 });
      return makeChild({ code: 1, stderr: 'NoSuchBucket: gone' });
    });
    clack.mockConfirm.mockResolvedValue(false); // decline recovery

    await expect(applyStack({ isHeadless: false })).rejects.toMatchObject({ exitCode: 1 });
    expect(provisionStateBucket).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('recovery_declined', expect.anything());
  });

  it('prints OIDC guidance when the GitHub provider already exists', async () => {
    writeProject();
    mockSpawn.mockImplementation((cmd, args = []) => {
      if (args[0] === 'init') return makeChild({ code: 0 });
      return makeChild({
        code: 1,
        stderr: 'EntityAlreadyExists: token.actions.githubusercontent.com provider exists',
      });
    });
    clack.mockConfirm.mockResolvedValue(false); // decline adoption

    await expect(applyStack({ isHeadless: false })).rejects.toMatchObject({ exitCode: 1 });
    expect(clack.mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('OIDC')
    );
    expect(clack.mockLogMessage).toHaveBeenCalledWith(expect.stringContaining('safe to re-run'));
    expect(clack.mockLogMessage).toHaveBeenCalledWith(expect.stringContaining(OIDC_ADOPT_MANUAL_COMMAND));
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_applied',
      expect.objectContaining({ success: false })
    );
    expect(fs.existsSync(path.join(tmpDir, 'terraform', 'grada.auto.tfvars'))).toBe(false);
  });

  it('falls through to guidance (never a raw crash) when the adopt write fails', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root bypasses directory perms
    writeProject();
    const tfDir = path.join(tmpDir, 'terraform');
    let applies = 0;
    mockSpawn.mockImplementation((cmd, args = []) => {
      if (args[0] === 'init') return makeChild({ code: 0 });
      if (args[0] === 'apply') {
        applies += 1;
        return makeChild({ code: 1, stderr: 'EntityAlreadyExists: token.actions.githubusercontent.com provider exists' });
      }
      return makeChild({ code: 0 });
    });
    clack.mockConfirm.mockResolvedValue(true); // accept adoption
    fs.chmodSync(tfDir, 0o555);
    try {
      await expect(applyStack({ isHeadless: false })).rejects.toMatchObject({ exitCode: 1 });
    } finally {
      fs.chmodSync(tfDir, 0o755);
    }
    expect(applies).toBe(1);
    expect(trackEvent).not.toHaveBeenCalledWith('oidc_provider_adopted', expect.anything());
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_applied',
      expect.objectContaining({ success: false, error_code: 'OIDC_PROVIDER_CONFLICT' })
    );
    expect(clack.mockLogMessage).toHaveBeenCalledWith(expect.stringContaining('Automatic adoption failed'));
  });

  it('manual adopt command converges when run twice, even over an indented line', async () => {
    const { execFileSync } = await vi.importActual('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-cmd-'));
    try {
      fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'terraform', 'grada.auto.tfvars'), '  create_oidc_provider = true\nasleep = true\n');
      for (let i = 0; i < 2; i++) {
        execFileSync('sh', ['-c', OIDC_ADOPT_MANUAL_COMMAND], { cwd: dir, stdio: 'pipe' });
      }
      expect(fs.readFileSync(path.join(dir, 'terraform', 'grada.auto.tfvars'), 'utf8')).toBe(
        'asleep = true\ncreate_oidc_provider = false\n'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('manual adopt command converges under set -e on a single-key file', async () => {
    const { execFileSync } = await vi.importActual('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-cmd-'));
    try {
      fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'terraform', 'grada.auto.tfvars'), 'create_oidc_provider = true\n');
      for (let i = 0; i < 2; i++) {
        execFileSync('sh', ['-e', '-c', OIDC_ADOPT_MANUAL_COMMAND], { cwd: dir, stdio: 'pipe' });
      }
      expect(fs.readFileSync(path.join(dir, 'terraform', 'grada.auto.tfvars'), 'utf8')).toBe(
        'create_oidc_provider = false\n'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('manual adopt command creates the file when missing', async () => {
    const { execFileSync } = await vi.importActual('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-cmd-'));
    try {
      fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
      execFileSync('sh', ['-c', OIDC_ADOPT_MANUAL_COMMAND], { cwd: dir, stdio: 'pipe' });
      expect(fs.readFileSync(path.join(dir, 'terraform', 'grada.auto.tfvars'), 'utf8')).toBe(
        'create_oidc_provider = false\n'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adopts the existing OIDC provider on confirm and retries the apply', async () => {
    writeProject();
    let applies = 0;
    mockSpawn.mockImplementation((cmd, args = []) => {
      if (args[0] === 'init') return makeChild({ code: 0 });
      if (args[0] === 'apply') {
        applies += 1;
        if (applies === 1) {
          return makeChild({ code: 1, stderr: 'EntityAlreadyExists: token.actions.githubusercontent.com provider exists' });
        }
        return makeChild({ code: 0, stdout: 'Apply complete!' });
      }
      if (args[0] === 'output')
        return makeChild({
          code: 0,
          stdout: JSON.stringify({
            cloudfront_url: { value: 'https://d123.cloudfront.net' },
            alb_direct_url: { value: 'http://alb-123.us-east-2.elb.amazonaws.com' },
          }),
        });
      return makeChild({ code: 0 });
    });

    const result = await applyStack({ isHeadless: false });

    expect(result).toMatchObject({ ok: true });
    expect(applies).toBe(2);
    expect(fs.readFileSync(path.join(tmpDir, 'terraform', 'grada.auto.tfvars'), 'utf8')).toContain('create_oidc_provider = false');
    expect(trackEvent).toHaveBeenCalledWith('oidc_provider_adopted', expect.objectContaining({ projectName: expect.any(String) }));
  });

  it('refuses OIDC adoption headless without approval and writes nothing', async () => {
    writeProject();
    mockSpawn.mockImplementation((cmd, args = []) => {
      if (args[0] === 'init') return makeChild({ code: 0 });
      return makeChild({
        code: 1,
        stderr: 'EntityAlreadyExists: token.actions.githubusercontent.com provider exists',
      });
    });

    // _skipPreview bypasses the provision confirm (internal retries do
    // this after the user already confirmed), isolating the adoption
    // gate: inferred-headless (vitest) with no approval flag refuses.
    await expect(applyStack({ _skipPreview: true })).rejects.toMatchObject({ exitCode: 1 });
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_applied',
      expect.objectContaining({ success: false, error_code: 'OIDC_ADOPT_NON_INTERACTIVE' })
    );
    expect(fs.existsSync(path.join(tmpDir, 'terraform', 'grada.auto.tfvars'))).toBe(false);
  });

  it('adopts without prompting under --auto-approve', async () => {
    writeProject();
    let applies = 0;
    mockSpawn.mockImplementation((cmd, args = []) => {
      if (args[0] === 'init') return makeChild({ code: 0 });
      if (args[0] === 'apply') {
        applies += 1;
        if (applies === 1) {
          return makeChild({ code: 1, stderr: 'EntityAlreadyExists: token.actions.githubusercontent.com provider exists' });
        }
        return makeChild({ code: 0, stdout: 'Apply complete!' });
      }
      if (args[0] === 'output')
        return makeChild({
          code: 0,
          stdout: JSON.stringify({
            cloudfront_url: { value: 'https://d123.cloudfront.net' },
            alb_direct_url: { value: 'http://alb-123.us-east-2.elb.amazonaws.com' },
          }),
        });
      return makeChild({ code: 0 });
    });

    const result = await applyStack({ isHeadless: true, autoApprove: true });

    expect(result).toMatchObject({ ok: true });
    expect(applies).toBe(2);
    expect(clack.mockConfirm).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(tmpDir, 'terraform', 'grada.auto.tfvars'), 'utf8')).toContain('create_oidc_provider = false');
  });

  it('treats spawn errors (missing binary) as apply failure without AWS calls', async () => {
    writeProject();
    mockSpawn.mockImplementation(() =>
      makeChild({ error: new Error('spawn terraform ENOENT') })
    );

    await expect(applyStack({ isHeadless: false })).rejects.toMatchObject({ exitCode: 1 });
    expect(provisionStateBucket).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_applied',
      expect.objectContaining({ success: false })
    );
  });

  it('warns on dry-run when the environment is asleep and still previews (real applies gate instead)', async () => {
    writeProject({
      '.deploy-stack/sleep-state.json': JSON.stringify({ default: { env: 'default' } }),
    });
    const result = await applyStack({ isDryRun: true });
    expect(result).toEqual({ ok: true, dryRun: true });
    const warns = clack.mockLogWarn.mock.calls.map((call) => stripVTControlCharacters(String(call[0]))).join('\n');
    expect(warns).toContain('is asleep');
    expect(warns).toContain('npx grada-run wake');
  });

  it('stays silent about sleep when the environment is awake', async () => {
    writeProject();
    await expect(applyStack({ isDryRun: true })).resolves.toEqual({ ok: true, dryRun: true });
    const warns = clack.mockLogWarn.mock.calls.map((call) => stripVTControlCharacters(String(call[0]))).join('\n');
    expect(warns).not.toContain('is asleep');
  });

  it('is wired into bin/cli.js', () => {
    const cliPath = path.resolve(process.cwd(), 'bin/cli.js');
    // tests run from repo root after chdir restore; resolve from original cwd
    const resolved = path.isAbsolute(cliPath) ? cliPath : path.join(originalCwd, 'bin/cli.js');
    const content = fs.readFileSync(path.join(originalCwd, 'bin/cli.js'), 'utf8');
    expect(resolved).toContain('cli.js');
    expect(content).toContain('applyStack');
    expect(content).toContain("'apply'");
  });
  it('preflight fails fast naming keys colliding with rendered env names', async () => {
    writeProject({
      'terraform/main.tf': [
        'resource "aws_ecs_cluster" "main" {}',
        'environment = [',
        '  { "name" : "PORT", "value" : "3000" },',
        '  { name = "REDIS_URL", value = "redis://x" },',
        ']',
        'secrets = concat([], [])',
        '',
      ].join('\n'),
      'terraform/secret_keys.json': JSON.stringify(['API_KEY', 'REDIS_URL']),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

    try {
      await expect(applyStack({})).rejects.toMatchObject({ exitCode: 1 });
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_applied',
        expect.objectContaining({ success: false, error_code: 'SECRETS_ENV_COLLISION', collision_count: 1 })
      );
      const text = stripVTControlCharacters(logSpy.mock.calls.map((call) => String(call[0])).join('\n'));
      expect(text).toContain('REDIS_URL');
      expect(text).toContain('re-push');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('preflight covers compose-injected env names from the rendered file', async () => {
    writeProject({
      'terraform/main.tf': [
        'resource "aws_ecs_cluster" "main" {}',
        'environment = [',
        '  { "name" : "CUSTOM_COMPOSE_VAR", "value" : "x" },',
        ']',
        'secrets = concat([], [])',
        '',
      ].join('\n'),
      'terraform/secret_keys.json': JSON.stringify(['CUSTOM_COMPOSE_VAR']),
    });
    exitSpy.mockImplementation(() => { });

    const result = await applyStack({});
    expect(result).toMatchObject({ ok: false });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_applied',
      expect.objectContaining({ success: false, error_code: 'SECRETS_ENV_COLLISION' })
    );
  });

  it('preflight rejects malformed keys files before terraform runs', async () => {
    writeProject({
      'terraform/main.tf': 'resource "aws_ecs_cluster" "main" {}\n',
      'terraform/secret_keys.json': JSON.stringify(['OK_KEY', 42]),
    });
    exitSpy.mockImplementation(() => { });

    const result = await applyStack({});
    expect(result).toMatchObject({ ok: false });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_applied',
      expect.objectContaining({ success: false, error_code: 'SECRETS_ENV_COLLISION' })
    );
  });

  it('preflight passes clean trees and skips lambda targets', async () => {
    writeProject({
      'terraform/main.tf': [
        'resource "aws_ecs_cluster" "main" {}',
        'environment = [',
        '  { "name" : "PORT", "value" : "3000" },',
        ']',
        '',
      ].join('\n'),
      'terraform/secret_keys.json': JSON.stringify(['API_KEY']),
    });
    const dryClean = await applyStack({ isDryRun: true });
    expect(dryClean).toEqual({ ok: true, dryRun: true });

    writeProject({
      'terraform/main.tf': [
        'resource "aws_lambda_function" "app" {}',
        'environment { variables = { PORT = "3000" } }',
        '',
      ].join('\n'),
      'terraform/secret_keys.json': JSON.stringify(['PORT']),
    });
    const dryLambda = await applyStack({ isDryRun: true });
    expect(dryLambda).toEqual({ ok: true, dryRun: true });
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('apply: fuzzer hardening', () => {
  it.each([null, 'string', 42, true])('applyStack(%s) behaves like {} instead of throwing', async (bad) => {
    // The repo root has no terraform/ dir, so the no-terraform guard fires
    // before any AWS call — deterministically, without network.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    try {
      const result = await applyStack(bad);
      expect(result).toEqual({ ok: false });
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe('Command: apply on --target lambda projects', () => {
  const originalCwd = process.cwd();
  let tmpDir;
  let exitSpy;

  const LAMBDA_MAIN_TF = [
    'provider "aws" {',
    '  region = "us-east-2"',
    '}',
    'locals {',
    '  app_name = "myapp${local.env_suffix}"',
    '}',
    'resource "aws_lambda_function" "app" {',
    '  function_name = "${local.app_name}-fn"',
    '}',
    '',
  ].join('\n');

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-lambda-test-'));
    fs.mkdirSync(path.join(tmpDir, 'terraform'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'terraform', 'main.tf'), LAMBDA_MAIN_TF);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    exitSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockOutputs(outputs) {
    mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: JSON.stringify(outputs) }));
  }

  function mockAws({ imageExists }) {
    return vi.fn((cmd, args) => {
      if (args[1] === 'describe-images') {
        return imageExists
          ? { status: 0, stdout: '{"imageDetails": [{"imageTags": ["latest"]}]}', stderr: '' }
          : { status: 0, stdout: '{"imageDetails": []}', stderr: '' };
      }
      if (args[1] === 'initiate-layer-upload') return { status: 0, stdout: '{"uploadId": "u"}', stderr: '' };
      return { status: 0, stdout: '{}', stderr: '' };
    });
  }

  it('targets the ECR repo, seeds :latest when missing, and prints the API URL', async () => {
    mockOutputs({
      cloudfront_url: { value: 'https://d123.cloudfront.net' },
      api_gateway_url: { value: 'https://abc.execute-api.us-east-2.amazonaws.com' },
    });
    const terraformCalls = [];
    const runTerraformImpl = vi.fn(async (args) => { terraformCalls.push(args); });
    const spawnSyncImpl = mockAws({ imageExists: false });

    const result = await applyStack({ autoApprove: true, runTerraformImpl, spawnSyncImpl });

    expect(result).toMatchObject({ ok: true });
    expect(terraformCalls[0]).toEqual(['init', '-upgrade']);
    expect(terraformCalls[1]).toEqual(['apply', '-target=aws_ecr_repository.app', '-input=false', '-auto-approve']);
    expect(terraformCalls[2]).toEqual(['apply', '-auto-approve']);
    const awsVerbs = spawnSyncImpl.mock.calls.map(([, args]) => args[1]);
    expect(awsVerbs[0]).toBe('describe-images');
    expect(awsVerbs).toContain('put-image');

    const outroText = stripVTControlCharacters(clack.mockOutro.mock.calls.map((call) => call[0]).join('\n'));
    expect(outroText).toContain('App URL: https://d123.cloudfront.net');
    expect(outroText).toContain('API URL: https://abc.execute-api.us-east-2.amazonaws.com (bypasses the CDN — for debugging)');
    expect(outroText).not.toContain('Direct URL:');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('seeds the suffixed ECR repo on suffixed trees', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'terraform', 'main.tf'),
      LAMBDA_MAIN_TF
        .replace('locals {', 'locals {\n  grada_resource_suffix = "-a1b2c3"')
        .replace('app_name = "myapp${local.env_suffix}"', 'app_name = "myapp${local.env_suffix}${local.grada_resource_suffix}"')
    );
    mockOutputs({ cloudfront_url: { value: 'https://d123.cloudfront.net' } });
    const runTerraformImpl = vi.fn(async () => { });
    const spawnSyncImpl = mockAws({ imageExists: true });

    const result = await applyStack({ autoApprove: true, runTerraformImpl, spawnSyncImpl });

    expect(result).toMatchObject({ ok: true });
    const describe = spawnSyncImpl.mock.calls.find(([, args]) => args[1] === 'describe-images');
    expect(describe).toBeDefined();
    const repoIdx = describe[1].indexOf('--repository-name');
    expect(describe[1][repoIdx + 1]).toBe('myapp-a1b2c3-repo');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints the Site URL when the stack outputs site_url (static target)', async () => {
    mockOutputs({
      site_url: { value: 'https://d456.cloudfront.net' },
    });
    const runTerraformImpl = vi.fn(async () => { });
    const spawnSyncImpl = mockAws({ imageExists: true });

    const result = await applyStack({ autoApprove: true, runTerraformImpl, spawnSyncImpl });

    expect(result).toMatchObject({ ok: true });
    const outroText = stripVTControlCharacters(clack.mockOutro.mock.calls.map((call) => call[0]).join('\n'));
    expect(outroText).toContain('Site URL: https://d456.cloudfront.net (global CDN — share this link)');
    expect(outroText).not.toContain('Direct URL:');
    expect(outroText).not.toContain('API URL:');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('skips seeding when :latest already exists', async () => {
    mockOutputs({ cloudfront_url: { value: 'https://d123.cloudfront.net' } });
    const runTerraformImpl = vi.fn(async () => { });
    const spawnSyncImpl = mockAws({ imageExists: true });

    const result = await applyStack({ autoApprove: true, runTerraformImpl, spawnSyncImpl });

    expect(result).toMatchObject({ ok: true });
    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('fails fast with guidance when Day-0 seeding fails', async () => {
    mockOutputs({});
    const runTerraformImpl = vi.fn(async () => { });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
    exitSpy.mockImplementation((code) => { throw exitError(code); });
    try {
      const spawnSyncImpl = vi.fn(() => ({ status: 254, stdout: '', stderr: 'AccessDeniedException' }));
      await expect(applyStack({ autoApprove: true, runTerraformImpl, spawnSyncImpl })).rejects.toMatchObject({ exitCode: 1 });
      expect(runTerraformImpl).not.toHaveBeenCalledWith(['apply', '-auto-approve']);
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_applied',
        expect.objectContaining({ success: false })
      );
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('upsertAutoTfvar', () => {
  it('creates the file with a managed header', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfvars-'));
    try {
      const out = upsertAutoTfvar(dir, 'create_oidc_provider', false);
      expect(out).toMatchObject({ created: true, changed: true });
      expect(fs.readFileSync(out.path, 'utf8')).toBe(
        '# Managed by grada: machine-written variable overrides. Safe to delete an entry to restore its default.\ncreate_oidc_provider = false\n'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces an existing entry and reports idempotent rewrites as unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfvars-'));
    try {
      upsertAutoTfvar(dir, 'create_oidc_provider', true);
      const flipped = upsertAutoTfvar(dir, 'create_oidc_provider', false);
      expect(flipped).toMatchObject({ created: false, changed: true });
      expect(fs.readFileSync(flipped.path, 'utf8')).toContain('create_oidc_provider = false\n');
      expect(fs.readFileSync(flipped.path, 'utf8')).not.toContain('true');
      const same = upsertAutoTfvar(dir, 'create_oidc_provider', false);
      expect(same).toMatchObject({ created: false, changed: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends new keys while preserving existing entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfvars-'));
    try {
      upsertAutoTfvar(dir, 'create_oidc_provider', false);
      upsertAutoTfvar(dir, 'asleep', true);
      const content = fs.readFileSync(path.join(dir, 'grada.auto.tfvars'), 'utf8');
      expect(content).toContain('create_oidc_provider = false\n');
      expect(content).toContain('asleep = true\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces an indented entry in place instead of duplicating it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfvars-'));
    try {
      fs.writeFileSync(path.join(dir, 'grada.auto.tfvars'), '  create_oidc_provider = true\n');
      const out = upsertAutoTfvar(dir, 'create_oidc_provider', false);
      expect(out).toMatchObject({ created: false, changed: true });
      expect(fs.readFileSync(out.path, 'utf8')).toBe('create_oidc_provider = false\n');
      const again = upsertAutoTfvar(dir, 'create_oidc_provider', false);
      expect(again).toMatchObject({ created: false, changed: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('collapses pre-existing duplicate keys into one copy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfvars-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'grada.auto.tfvars'),
        'create_oidc_provider = false\nasleep = true\ncreate_oidc_provider = false\n'
      );
      const out = upsertAutoTfvar(dir, 'create_oidc_provider', false);
      expect(out).toMatchObject({ created: false, changed: true });
      const content = fs.readFileSync(out.path, 'utf8');
      expect(content.match(/^create_oidc_provider = /gm)).toHaveLength(1);
      expect(content).toContain('asleep = true\n');
      // Converged: a second upsert is a no-op.
      expect(upsertAutoTfvar(dir, 'create_oidc_provider', false)).toMatchObject({ changed: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects non-boolean values and non-identifier keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfvars-'));
    try {
      expect(() => upsertAutoTfvar(dir, 'create_oidc_provider', 'false')).toThrow('booleans');
      expect(() => upsertAutoTfvar(dir, 'a\nb = true', true)).toThrow('identifier');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
