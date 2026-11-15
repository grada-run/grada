import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { clackMocks as clack } from './helpers/clack.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

// --- Deep mock for child_process.spawn (no real terraform binary) ---
const { mockSpawn, mockExecSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExecSync: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: mockSpawn,
    execSync: mockExecSync,
  };
});

// --- Silence interactive UI; confirm is controllable per test ---

// --- Never touch AWS or the network ---
vi.mock('../src/utils/aws.js', () => ({
  checkAwsCredentials: vi.fn().mockResolvedValue({
    accountId: '123456789012',
    awsAccountId: '123456789012',
    region: 'us-east-2',
  }),
  provisionStateBucket: vi.fn().mockResolvedValue({
    awsAccountId: '123456789012',
    stateBucketName: 'mock-tf-state-bucket',
  }),
  teardownStateBucket: vi.fn().mockResolvedValue(true),
  drainBucketObjects: vi.fn().mockResolvedValue({ deleted: 0, failed: [] }),
  // Tests that inject no client exercise the no-database path (the
  // pre-destroy hook no-ops); hook tests inject a scripted client.
  resolveClient: (injected) => injected ?? {
    send: async (command) => {
      const name = command.constructor.name;
      if (name === 'DescribeDBInstancesCommand') {
        throw Object.assign(new Error('DBInstanceNotFound'), { name: 'DBInstanceNotFound' });
      }
      if (name === 'DescribeDBClustersCommand') {
        throw Object.assign(new Error('DBClusterNotFoundFault'), { name: 'DBClusterNotFoundFault' });
      }
      if (name === 'ListObjectVersionsCommand') {
        return { Versions: [], DeleteMarkers: [] };
      }
      throw new Error(`unexpected command ${name}`);
    },
  },
}));

vi.mock('../src/utils/system.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    checkDependency: vi.fn().mockResolvedValue(true),
    pollUntil: actual.pollUntil,
  };
});


import { destroyStack, handleDestroyTerraformError } from '../src/commands/destroy.js';
import { teardownStateBucket, drainBucketObjects } from '../src/utils/aws.js';
import { checkDependency } from '../src/utils/system.js';
import { trackEvent } from '../src/core/telemetry.js';

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

describe('Command: destroy (mocked terraform spawn)', () => {
  const originalCwd = process.cwd();
  let tmpDir;
  let exitSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    checkDependency.mockResolvedValue(true);
    teardownStateBucket.mockResolvedValue(true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw exitError(code);
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'destroy-test-'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    exitSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeBackend(bucket = 'myapp-tfstate-123', region = 'us-east-2') {
    fs.mkdirSync(path.join(tmpDir, 'terraform'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'terraform', 'backend.tf'),
      `terraform {\n  backend "s3" {\n    bucket = "${bucket}"\n    region = "${region}"\n  }\n}\n`
    );
    process.chdir(tmpDir);
  }

  it('exits 1 when terraform/backend.tf is missing', async () => {
    process.chdir(tmpDir); // empty tmpdir
    await expect(destroyStack()).rejects.toMatchObject({ exitCode: 1 });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when terraform is not installed', async () => {
    writeBackend();
    checkDependency.mockResolvedValue(false);
    await expect(destroyStack()).rejects.toMatchObject({ exitCode: 1 });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('warns about the secrets recovery window when the tree has secrets', async () => {
    writeBackend();
    fs.writeFileSync(path.join(tmpDir, 'terraform', 'secrets.tf'), '# secrets\n');
    clack.mockConfirm.mockResolvedValue(false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(destroyStack({ isHeadless: false })).rejects.toMatchObject({ exitCode: 0 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('30-day recovery window'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stays silent about secrets when the tree has none', async () => {
    writeBackend();
    clack.mockConfirm.mockResolvedValue(false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(destroyStack({ isHeadless: false })).rejects.toMatchObject({ exitCode: 0 });
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('30-day recovery window'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('cancels cleanly when the user declines the confirm prompt', async () => {
    writeBackend();
    clack.mockConfirm.mockResolvedValue(false);
    await expect(destroyStack({ isHeadless: false })).rejects.toMatchObject({ exitCode: 0 });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(teardownStateBucket).not.toHaveBeenCalled();
    expect(clack.mockCancel).toHaveBeenCalled();
  });

  it('cancels cleanly when the user escapes the confirm prompt (cancel symbol)', async () => {
    writeBackend();
    clack.mockConfirm.mockResolvedValue(Symbol('clack:cancel'));
    await expect(destroyStack({ isHeadless: false })).rejects.toMatchObject({ exitCode: 0 });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(teardownStateBucket).not.toHaveBeenCalled();
    expect(clack.mockCancel).toHaveBeenCalled();
  });

  it('refuses loudly when headless without approval flags instead of abandoning the confirm prompt', async () => {
    writeBackend();
    // No-op exit so the refusal result returns instead of throwing.
    exitSpy.mockImplementation(() => { });
    const result = await destroyStack({});

    expect(result).toEqual({ ok: false, reason: 'non-interactive' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_destroyed',
      expect.objectContaining({ success: false, error_code: 'DESTROY_NON_INTERACTIVE', reason: 'non-interactive' })
    );
    expect(clack.mockConfirm).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(teardownStateBucket).not.toHaveBeenCalled();
  });

  it('destroys compute and retains the state bucket when declined', async () => {
    writeBackend('retain-bucket-123', 'eu-west-1');
    clack.mockConfirm
      .mockResolvedValueOnce(true) // proceed with destroy
      .mockResolvedValueOnce(false); // retain bucket
    mockSpawn.mockImplementation((cmd, args = []) => {
      expect(cmd).toBe('terraform');
      if (args[0] === 'init') return makeChild({ code: 0, stdout: 'init ok' });
      if (args[0] === 'show') return makeChild({ code: 0, stdout: '{}' });
      expect(args).toEqual(['destroy', '-auto-approve']);
      return makeChild({ code: 0, stdout: 'destroy complete' });
    });

    await destroyStack({ isHeadless: false }); // success path calls outro, not process.exit

    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(teardownStateBucket).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_destroyed',
      expect.objectContaining({ success: true, retained_state_bucket: true })
    );
    expect(clack.mockOutro).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('forces spinner animation through to terraform with --progress=spinner', async () => {
    writeBackend();
    clack.mockConfirm
      .mockResolvedValueOnce(true) // proceed with destroy
      .mockResolvedValueOnce(false); // retain bucket
    mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: 'destroy complete\n' }));

    await destroyStack({ isHeadless: false, progress: 'spinner' });

    // Under the test runner stdout is not a TTY, so spinner frames can
    // only fire when --progress=spinner threads through lifecycleOpts.
    expect(clack.mockSpinnerMessage).toHaveBeenCalledWith(expect.stringContaining('destroy complete'));
  });

  it('destroys compute and deletes the state bucket when confirmed', async () => {
    writeBackend('delete-me-123', 'us-east-2');
    clack.mockConfirm
      .mockResolvedValueOnce(true) // proceed
      .mockResolvedValueOnce(true); // delete bucket
    mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: 'destroy complete' }));

    await destroyStack({ isHeadless: false });

    expect(teardownStateBucket).toHaveBeenCalledWith('us-east-2', 'delete-me-123');
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_destroyed',
      expect.objectContaining({ success: true, retained_state_bucket: false })
    );
  });

  it('exits 1 and tracks failure when terraform destroy exits non-zero', async () => {
    writeBackend();
    clack.mockConfirm.mockResolvedValueOnce(true);
    mockSpawn.mockImplementation(() =>
      makeChild({ code: 1, stderr: 'Error: destroy failed dramatically' })
    );

    await expect(destroyStack({ isHeadless: false })).rejects.toMatchObject({ exitCode: 1 });
    expect(teardownStateBucket).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_destroyed',
      expect.objectContaining({ success: false })
    );
  });

  it('headless destroy refuses a stale state lock with a named code', async () => {
    writeBackend();
    mockSpawn.mockImplementation(() =>
      makeChild({ code: 1, stderr: 'Error: Error acquiring the state lock:\nLock Info:\n  ID:        destroy-lock-1\n' })
    );

    await expect(destroyStack({ isHeadless: true })).rejects.toMatchObject({ exitCode: 1 });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(teardownStateBucket).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'state_lock_detected',
      expect.objectContaining({ command: 'destroy' })
    );
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_destroyed',
      expect.objectContaining({ error_code: 'STATE_LOCK_HELD' })
    );
  });

  it('programmatic destroy refusal returns a shaped failure before terraform', async () => {
    writeBackend();
    // json:true is programmatic (noExit) without approving: the refusal
    // must come back shaped, not as success-like undefined.
    const result = await destroyStack({ json: true });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'non-interactive', exitCode: 1 }));
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(teardownStateBucket).not.toHaveBeenCalled();
  });

  it('lock-refusal honors the {retried,result} contract for programmatic callers', async () => {
    // The state-lock unlock prompt is unreachable once the pre-terraform
    // confirm gate refuses, so this contracts the handler directly: a
    // raw refusal here would surface as success-shaped undefined.
    const handled = await handleDestroyTerraformError({
      options: { json: true },
      tfDirPath: path.join(tmpDir, 'terraform'),
      attemptDestroy: vi.fn(),
      error: Object.assign(new Error('Error acquiring the state lock'), {
        code: 'STATE_LOCK_HELD',
        lockId: 'destroy-lock-9',
      }),
    });
    expect(handled.retried).toBe(false);
    expect(handled.result).toEqual(expect.objectContaining({ ok: false, reason: 'non-interactive', exitCode: 1 }));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('interactive destroy confirms, unlocks, and retries once', async () => {
    writeBackend();
    clack.mockConfirm
      .mockResolvedValueOnce(true) // proceed with destroy
      .mockResolvedValueOnce(true) // force-unlock the stale lock
      .mockResolvedValueOnce(false); // retain bucket
    const seen = [];
    mockSpawn.mockImplementation((cmd, args = []) => {
      seen.push(args[0]);
      if (args[0] === 'force-unlock') return makeChild({ code: 0, stdout: 'unlocked' });
      if (seen.filter((a) => a === 'destroy').length === 1) {
        return makeChild({ code: 1, stderr: 'Error: Error acquiring the state lock:\nLock Info:\n  ID:        destroy-lock-2\n' });
      }
      return makeChild({ code: 0, stdout: 'destroy complete' });
    });

    await destroyStack({ isHeadless: false });

    expect(seen).toEqual(['init', 'show', 'destroy', 'force-unlock', 'destroy']);
    const unlockCall = mockSpawn.mock.calls.find(([, args]) => args[0] === 'force-unlock');
    expect(unlockCall[1]).toContain('destroy-lock-2');
    expect(trackEvent).toHaveBeenCalledWith(
      'state_lock_force_unlocked',
      expect.objectContaining({ mode: 'interactive' })
    );
    expect(teardownStateBucket).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('headless destroy with forceUnlock unlocks without prompting', async () => {
    writeBackend();
    const seen = [];
    mockSpawn.mockImplementation((cmd, args = []) => {
      seen.push(args[0]);
      if (args[0] === 'force-unlock') return makeChild({ code: 0, stdout: 'unlocked' });
      if (seen.filter((a) => a === 'destroy').length === 1) {
        return makeChild({ code: 1, stderr: 'Error: Error acquiring the state lock:\nLock Info:\n  ID:        destroy-lock-3\n' });
      }
      return makeChild({ code: 0, stdout: 'destroy complete' });
    });

    await destroyStack({ isHeadless: true, forceUnlock: 'destroy-lock-3' });

    expect(seen).toEqual(['init', 'show', 'destroy', 'force-unlock', 'destroy']);
    expect(clack.mockConfirm).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'state_lock_force_unlocked',
      expect.objectContaining({ mode: 'flag' })
    );
  });

  it('stamps the retry-terminal failure with a stable reason', async () => {
    writeBackend();
    const seen = [];
    mockSpawn.mockImplementation((cmd, args = []) => {
      seen.push(args[0]);
      if (args[0] === 'force-unlock') return makeChild({ code: 0, stdout: 'unlocked' });
      if (args[0] === 'destroy' && seen.filter((a) => a === 'destroy').length === 1) {
        return makeChild({ code: 1, stderr: 'Error: Error acquiring the state lock:\nLock Info:\n  ID:        destroy-lock-9\n' });
      }
      if (args[0] === 'destroy') {
        return makeChild({ code: 1, stderr: 'Error: persistent failure' });
      }
      return makeChild({ code: 0, stdout: 'ok' });
    });

    await expect(destroyStack({ isHeadless: true, forceUnlock: 'destroy-lock-9' })).rejects.toMatchObject({ exitCode: 1 });
    expect(seen.filter((a) => a === 'destroy')).toHaveLength(2);
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_destroyed',
      expect.objectContaining({ success: false, reason: 'destroy-retry-failed' })
    );
  });

  it('treats spawn errors (missing binary) as destroy failure', async () => {
    writeBackend();
    clack.mockConfirm.mockResolvedValueOnce(true);
    mockSpawn.mockImplementation(() =>
      makeChild({ error: new Error('spawn terraform ENOENT') })
    );

    await expect(destroyStack({ isHeadless: false })).rejects.toMatchObject({ exitCode: 1 });
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_destroyed',
      expect.objectContaining({ success: false })
    );
  });

  it('survives S3 bucket deletion errors and still reports success', async () => {
    writeBackend('flaky-bucket', 'us-east-2');
    clack.mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: 'destroy ok' }));
    teardownStateBucket.mockRejectedValueOnce(new Error('AccessDenied'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await destroyStack({ isHeadless: false });
      expect(teardownStateBucket).toHaveBeenCalled();
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_destroyed',
        expect.objectContaining({ success: true })
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('is wired into bin/cli.js', () => {
    const content = fs.readFileSync(path.join(originalCwd, 'bin/cli.js'), 'utf8');
    expect(content).toContain('destroyStack');
    expect(content).toContain("'destroy'");
  });

  describe('pre-destroy database wake hook', () => {
    const noopSleep = async () => {};

    // Scripted RDS client: `statuses` is the status sequence returned by
    // Describe calls (first call feeds findDbTarget, the rest feed the
    // wait loops); Start calls are recorded in `seen`. Instances carry
    // DBInstanceStatus, clusters carry Status (true SDK shapes).
    function scriptedRdsClient({ kind = 'instance', statuses = [], modifyError = null, snapshotStatuses = ['available'] } = {}) {
      const seen = [];
      const sent = [];
      let calls = 0;
      const nextStatus = () => statuses[Math.min(calls++, statuses.length - 1)];
      let snapshotCalls = 0;
      const nextSnapshotStatus = () => snapshotStatuses[Math.min(snapshotCalls++, snapshotStatuses.length - 1)];
      return {
        seen,
        sent,
        send: vi.fn(async (command) => {
          const name = command.constructor.name;
          seen.push(name);
          sent.push(command);
          if (name === 'DescribeDBInstancesCommand') {
            if (kind !== 'instance') {
              throw Object.assign(new Error('DBInstanceNotFound'), { name: 'DBInstanceNotFound' });
            }
            return { DBInstances: [{ DBInstanceStatus: nextStatus(), Engine: 'postgres' }] };
          }
          if (name === 'DescribeDBClustersCommand') {
            if (kind !== 'cluster') {
              throw Object.assign(new Error('DBClusterNotFoundFault'), { name: 'DBClusterNotFoundFault' });
            }
            return { DBClusters: [{ Status: nextStatus(), Engine: 'aurora-postgresql' }] };
          }
          if (name === 'StartDBInstanceCommand' || name === 'StartDBClusterCommand') return {};
          if (name === 'CreateDBSnapshotCommand' || name === 'CreateDBClusterSnapshotCommand') return {};
          if (name === 'DescribeDBSnapshotsCommand') {
            return { DBSnapshots: [{ Status: nextSnapshotStatus() }] };
          }
          if (name === 'DescribeDBClusterSnapshotsCommand') {
            return { DBClusterSnapshots: [{ Status: nextSnapshotStatus() }] };
          }
          if (name === 'ModifyDBInstanceCommand' || name === 'ModifyDBClusterCommand') {
            if (modifyError) throw modifyError;
            return {};
          }
          throw new Error(`unexpected command ${name}`);
        }),
      };
    }

    function confirmDestroy() {
      clack.mockConfirm
        .mockResolvedValueOnce(true) // proceed with destroy
        .mockResolvedValueOnce(false); // retain bucket
      mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: 'destroy complete' }));
    }

    it('starts a stopped instance and waits for available before destroying', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'instance', statuses: ['stopped', 'starting', 'available'] });

      await destroyStack({ rdsClient, sleepFn: noopSleep, isHeadless: false });

      expect(rdsClient.seen).toContain('StartDBInstanceCommand');
      expect(rdsClient.seen).not.toContain('StartDBClusterCommand');
      expect(clack.mockSpinnerStart).toHaveBeenCalledWith('Waking database before destruction...');
      expect(mockSpawn).toHaveBeenCalledTimes(3);
      expect(clack.mockOutro).toHaveBeenCalled();
    });

    it('settles a stopping cluster to stopped before starting it', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'cluster', statuses: ['stopping', 'stopping', 'stopped', 'starting', 'available'] });

      await destroyStack({ rdsClient, sleepFn: noopSleep, isHeadless: false });

      // Start fires only after the settle loop observed `stopped`
      // (describe, describe, describe, start, ...).
      expect(rdsClient.seen.indexOf('StartDBClusterCommand')).toBeGreaterThan(2);
      expect(rdsClient.seen).not.toContain('StartDBInstanceCommand');
      expect(mockSpawn).toHaveBeenCalledTimes(3);
    });

    it('waits for a starting database without sending Start', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'instance', statuses: ['starting', 'available'] });

      await destroyStack({ rdsClient, sleepFn: noopSleep, isHeadless: false });

      expect(rdsClient.seen).not.toContain('StartDBInstanceCommand');
      expect(rdsClient.seen).not.toContain('StartDBClusterCommand');
      expect(mockSpawn).toHaveBeenCalledTimes(3);
    });

    it('exits the settle loop on DBInstanceStatus available (true SDK shape)', async () => {
      // P2 live incident: the loop read `Status` off instance records, got
      // undefined forever, and hung till timeout. True-shaped SDK responses
      // must settle the loop instead. Own inline client (true shape) so this
      // test reds independently of the shared scripted client above.
      writeBackend();
      confirmDestroy();
      const seen = [];
      let calls = 0;
      const statuses = ['creating', 'available'];
      const rdsClient = {
        seen,
        send: vi.fn(async (command) => {
          const name = command.constructor.name;
          seen.push(name);
          if (name === 'DescribeDBInstancesCommand') {
            return { DBInstances: [{ DBInstanceStatus: statuses[Math.min(calls++, statuses.length - 1)], Engine: 'postgres' }] };
          }
          if (name === 'DescribeDBClustersCommand') {
            throw Object.assign(new Error('DBClusterNotFoundFault'), { name: 'DBClusterNotFoundFault' });
          }
          if (name === 'StartDBInstanceCommand' || name === 'StartDBClusterCommand') return {};
          if (name === 'CreateDBSnapshotCommand' || name === 'CreateDBClusterSnapshotCommand') return {};
          if (name === 'DescribeDBSnapshotsCommand') {
            return { DBSnapshots: [{ Status: 'available' }] };
          }
          if (name === 'DescribeDBClusterSnapshotsCommand') {
            return { DBClusterSnapshots: [{ Status: 'available' }] };
          }
          throw new Error(`unexpected command ${name}`);
        }),
      };

      await destroyStack({ rdsClient, sleepFn: noopSleep, pollIntervalMs: 1, timeoutMs: 500, dbSettleTimeoutMs: 500, isHeadless: false });

      expect(seen).not.toContain('StartDBInstanceCommand');
      expect(mockSpawn).toHaveBeenCalledTimes(3);
    });

    it('skips the hook when the database is already available', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'instance', statuses: ['available'] });

      await destroyStack({ rdsClient, sleepFn: noopSleep, isHeadless: false });

      expect(rdsClient.seen).not.toContain('StartDBInstanceCommand');
      expect(clack.mockSpinnerStart).not.toHaveBeenCalledWith('Waking database before destruction...');
      expect(mockSpawn).toHaveBeenCalledTimes(3);
    });

    it('aborts destroy when the database never becomes available', async () => {
      writeBackend();
      clack.mockConfirm.mockResolvedValueOnce(true);
      mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: 'destroy complete' }));
      const rdsClient = scriptedRdsClient({ kind: 'instance', statuses: ['stopped'] });

      await expect(destroyStack({ rdsClient, sleepFn: noopSleep, timeoutMs: 0, isHeadless: false })).rejects.toMatchObject({ exitCode: 1 });
      expect(mockSpawn.mock.calls.filter(([, args]) => args[0] === 'destroy')).toHaveLength(0);
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_destroyed',
        expect.objectContaining({ success: false, error_code: 'RDS_DESTROY_PREFLIGHT_TIMEOUT' })
      );
    });

    it('proceeds immediately when the database is already deleting', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'instance', statuses: ['deleting'] });

      await destroyStack({ rdsClient, sleepFn: noopSleep, isHeadless: false });

      expect(rdsClient.seen).not.toContain('StartDBInstanceCommand');
      expect(rdsClient.seen).not.toContain('CreateDBSnapshotCommand');
      expect(clack.mockSpinnerStart).not.toHaveBeenCalledWith('Waking database before destruction...');
      expect(mockSpawn).toHaveBeenCalledTimes(3);
      expect(trackEvent).toHaveBeenCalledWith(
        'rds_preflight_skipped',
        expect.objectContaining({ reason: 'deleting' })
      );
    });

    it('waits out a creating database with the settle budget', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'cluster', statuses: ['creating', 'creating', 'available'] });

      await destroyStack({ rdsClient, sleepFn: noopSleep, isHeadless: false });

      expect(rdsClient.seen).not.toContain('StartDBClusterCommand');
      expect(rdsClient.seen).toContain('CreateDBClusterSnapshotCommand');
      expect(mockSpawn).toHaveBeenCalledTimes(3);
      expect(trackEvent).toHaveBeenCalledWith(
        'rds_preflight_waited',
        expect.objectContaining({ from_state: 'creating' })
      );
    });

    it('lifts deletion protection on the instance before terraform destroy', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'instance', statuses: ['available'] });

      await destroyStack({ rdsClient, sleepFn: noopSleep, allowDataLoss: true, pollIntervalMs: 1, timeoutMs: 500, dbSettleTimeoutMs: 500, isHeadless: false });

      const modify = rdsClient.sent.find((c) => c.constructor.name === 'ModifyDBInstanceCommand');
      expect(modify.input).toMatchObject({ DBInstanceIdentifier: expect.any(String), DeletionProtection: false, ApplyImmediately: true });
      expect(rdsClient.seen).not.toContain('CreateDBSnapshotCommand');
      expect(mockSpawn).toHaveBeenCalledTimes(3);
      expect(trackEvent).toHaveBeenCalledWith(
        'deletion_protection_lifted',
        expect.objectContaining({ db_kind: 'instance', via: 'flag' })
      );
    });

    it('lifts deletion protection on the cluster before terraform destroy', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'cluster', statuses: ['available'] });

      await destroyStack({ rdsClient, sleepFn: noopSleep, allowDataLoss: true, pollIntervalMs: 1, timeoutMs: 500, dbSettleTimeoutMs: 500, isHeadless: false });

      const modify = rdsClient.sent.find((c) => c.constructor.name === 'ModifyDBClusterCommand');
      expect(modify.input).toMatchObject({ DBClusterIdentifier: expect.any(String), DeletionProtection: false, ApplyImmediately: true });
      expect(mockSpawn).toHaveBeenCalledTimes(3);
      expect(trackEvent).toHaveBeenCalledWith(
        'deletion_protection_lifted',
        expect.objectContaining({ db_kind: 'cluster', via: 'flag' })
      );
    });

    it('lifts protection on the interactive-confirm path too (after the snapshot)', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'instance', statuses: ['available'] });

      await destroyStack({ rdsClient, sleepFn: noopSleep, pollIntervalMs: 1, timeoutMs: 500, dbSettleTimeoutMs: 500, isHeadless: false });

      expect(rdsClient.seen).toContain('CreateDBSnapshotCommand');
      expect(rdsClient.seen).toContain('ModifyDBInstanceCommand');
      expect(mockSpawn).toHaveBeenCalledTimes(3);
      expect(trackEvent).toHaveBeenCalledWith(
        'deletion_protection_lifted',
        expect.objectContaining({ via: 'prompt' })
      );
    });

    it('waits for the snapshot to reach available before destroying', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({
        kind: 'instance',
        statuses: ['available'],
        snapshotStatuses: ['creating', 'creating', 'available'],
      });

      await destroyStack({ rdsClient, sleepFn: noopSleep, pollIntervalMs: 1, timeoutMs: 500, dbSettleTimeoutMs: 500, isHeadless: false });

      expect(rdsClient.seen).toContain('DescribeDBSnapshotsCommand');
      expect(rdsClient.seen.filter((name) => name === 'DescribeDBSnapshotsCommand')).toHaveLength(3);
      expect(mockSpawn).toHaveBeenCalledTimes(3);
    });

    // The snapshot wait re-started the already-running
    // shared spinner — clack overwrites the interval handle, leaking
    // the first interval so the session never exits. One start per
    // phase; the wait re-messages instead.
    it('starts the spinner once across the snapshot phase', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({
        kind: 'instance',
        statuses: ['available'],
        snapshotStatuses: ['creating', 'available'],
      });

      await destroyStack({ rdsClient, sleepFn: noopSleep, pollIntervalMs: 1, timeoutMs: 500, dbSettleTimeoutMs: 500, isHeadless: false });

      const snapshotStarts = clack.mockSpinnerStart.mock.calls.filter(([msg]) => String(msg).includes('napshot'));
      expect(snapshotStarts).toHaveLength(1);
      // The wait re-messages (initial + per-tick) instead of re-starting.
      const snapshotMessages = clack.mockSpinnerMessage.mock.calls.filter(([msg]) => String(msg).includes('Waiting for snapshot'));
      expect(snapshotMessages.length).toBeGreaterThanOrEqual(2);
    });

    // Surface PercentProgress during the snapshot wait.
    it('shows snapshot percent progress while waiting', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'instance', statuses: ['available'] });
      const baseSend = rdsClient.send;
      let snapshotCalls = 0;
      rdsClient.send = vi.fn(async (command) => {
        if (command.constructor.name === 'DescribeDBSnapshotsCommand') {
          snapshotCalls += 1;
          return snapshotCalls === 1
            ? { DBSnapshots: [{ Status: 'creating', PercentProgress: 42 }] }
            : { DBSnapshots: [{ Status: 'available', PercentProgress: 100 }] };
        }
        return baseSend(command);
      });

      // Wide terminal: the percent suffix must survive truncation to be
      // asserted (narrow-terminal floors are a standing residual).
      const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
      Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
      try {
        await destroyStack({ rdsClient, sleepFn: noopSleep, pollIntervalMs: 1, timeoutMs: 500, dbSettleTimeoutMs: 500, isHeadless: false });
      } finally {
        if (descriptor) Object.defineProperty(process.stdout, 'columns', descriptor);
        else delete process.stdout.columns;
      }

      expect(clack.mockSpinnerMessage).toHaveBeenCalledWith(expect.stringContaining('42% complete'));
    });

    // "spin this back up" overstated recovery — the bucket
    // confirm must name the snapshot (apply never restores the data).
    it('names the pre-destroy snapshot in the state-bucket confirm', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'instance', statuses: ['available'] });

      await destroyStack({ rdsClient, sleepFn: noopSleep, pollIntervalMs: 1, timeoutMs: 500, dbSettleTimeoutMs: 500, isHeadless: false });

      const bucketConfirm = clack.mockConfirm.mock.calls[1][0];
      expect(String(bucketConfirm.message)).toContain('pre-destroy snapshot');
      expect(String(bucketConfirm.message)).toContain('manual restore');
    });

    it('refuses the destroy when the snapshot fails', async () => {
      writeBackend();
      clack.mockConfirm.mockResolvedValueOnce(true); // proceed with destroy
      mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: 'destroy complete' }));
      const rdsClient = scriptedRdsClient({
        kind: 'instance',
        statuses: ['available'],
        snapshotStatuses: ['creating', 'failed'],
      });

      await expect(destroyStack({ rdsClient, sleepFn: noopSleep, pollIntervalMs: 1, timeoutMs: 500, dbSettleTimeoutMs: 500, isHeadless: false }))
        .rejects.toMatchObject({ exitCode: 1 });
      // init ran; the destroy itself never started.
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_destroyed',
        expect.objectContaining({ success: false, error_code: 'DB_SNAPSHOT_FAILED' })
      );
    });

    it('refuses the destroy when the snapshot times out', async () => {
      writeBackend();
      clack.mockConfirm.mockResolvedValueOnce(true); // proceed with destroy
      mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: 'destroy complete' }));
      const rdsClient = scriptedRdsClient({ kind: 'instance', statuses: ['available'], snapshotStatuses: ['creating'] });

      await expect(destroyStack({ rdsClient, sleepFn: noopSleep, pollIntervalMs: 1, timeoutMs: 500, dbSettleTimeoutMs: 500, snapshotTimeoutMs: 0, isHeadless: false }))
        .rejects.toMatchObject({ exitCode: 1 });
      // init ran; the destroy itself never started.
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_destroyed',
        expect.objectContaining({ success: false, error_code: 'DB_SNAPSHOT_TIMEOUT' })
      );
    });

    it('warns and proceeds when the protection lift fails', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({
        kind: 'instance',
        statuses: ['available'],
        modifyError: Object.assign(new Error('InvalidDBInstanceState'), { name: 'InvalidDBInstanceState' }),
      });

      await destroyStack({ rdsClient, sleepFn: noopSleep, allowDataLoss: true, pollIntervalMs: 1, timeoutMs: 500, dbSettleTimeoutMs: 500, isHeadless: false });

      expect(mockSpawn).toHaveBeenCalledTimes(3);
      expect(trackEvent).toHaveBeenCalledWith(
        'deletion_protection_lift_failed',
        expect.objectContaining({ error_code: 'InvalidDBInstanceState' })
      );
    });

    it('skips the lift when no database exists or it is already deleting', async () => {
      writeBackend();
      confirmDestroy();
      const noDb = scriptedRdsClient({ kind: 'none' });
      await destroyStack({ rdsClient: noDb, sleepFn: noopSleep, allowDataLoss: true, isHeadless: false });
      expect(noDb.seen).not.toContain('ModifyDBInstanceCommand');
      expect(noDb.seen).not.toContain('ModifyDBClusterCommand');

      const deleting = scriptedRdsClient({ kind: 'instance', statuses: ['deleting'] });
      confirmDestroy();
      await destroyStack({ rdsClient: deleting, sleepFn: noopSleep, allowDataLoss: true, isHeadless: false });
      expect(deleting.seen).not.toContain('ModifyDBInstanceCommand');
    });

    it('--force skips the database preflight entirely', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = { send: vi.fn(async () => { throw new Error('boom'); }) };

      await destroyStack({ rdsClient, sleepFn: noopSleep, force: true, isHeadless: false });

      expect(rdsClient.send).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledTimes(3);
      expect(trackEvent).toHaveBeenCalledWith(
        'rds_preflight_skipped',
        expect.objectContaining({ reason: 'force' })
      );
    });

    it('aborts destroy when the database lookup fails', async () => {
      writeBackend();
      clack.mockConfirm.mockResolvedValueOnce(true);
      mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: 'destroy complete' }));
      const rdsClient = { send: vi.fn(async () => { throw new Error('boom'); }) };

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(destroyStack({ rdsClient, sleepFn: noopSleep })).rejects.toMatchObject({ exitCode: 1 });
      } finally {
        consoleSpy.mockRestore();
      }
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_destroyed',
        expect.objectContaining({ success: false, error_code: 'RDS_DESTROY_PREFLIGHT_FAILED' })
      );
    });

    it('prints the credentials hint when the database lookup fails', async () => {
      writeBackend();
      clack.mockConfirm.mockResolvedValueOnce(true);
      mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: 'destroy complete' }));
      const rdsClient = { send: vi.fn(async () => { throw new Error('boom'); }) };

      const lines = [];
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { lines.push(args.join(' ')); });
      try {
        await expect(destroyStack({ rdsClient, sleepFn: noopSleep })).rejects.toMatchObject({ exitCode: 1 });
      } finally {
        consoleSpy.mockRestore();
      }
      expect(lines.join('\n')).toContain('Check your AWS credentials and region');
    });

    it('prints the credentials hint when the pre-destroy database wait fails', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = {
        send: vi.fn(async (command) => {
          const name = command.constructor.name;
          if (name === 'DescribeDBInstancesCommand') {
            return { DBInstances: [{ DBInstanceStatus: 'stopped', Engine: 'postgres' }] };
          }
          if (name === 'DescribeDBClustersCommand') {
            throw Object.assign(new Error('DBClusterNotFoundFault'), { name: 'DBClusterNotFoundFault' });
          }
          throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        }),
      };

      const lines = [];
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { lines.push(args.join(' ')); });
      try {
        await expect(destroyStack({ rdsClient, sleepFn: noopSleep, allowDataLoss: true, isHeadless: false })).rejects.toMatchObject({ exitCode: 1 });
      } finally {
        consoleSpy.mockRestore();
      }
      expect(lines.join('\n')).toContain('Check your AWS credentials and region');
      // The hint must not cost the specific code: .code still beats the
      // fallback, and beats failAwsError's .name-derived stamp.
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_destroyed',
        expect.objectContaining({ success: false, error_code: 'ECONNRESET' })
      );
    });
  });

  describe('pre-destroy S3 bucket drain', () => {
    const SHOW_JSON = JSON.stringify({
      values: {
        root_module: {
          resources: [
            { type: 'aws_s3_bucket', values: { bucket: 'myapp-storage-123' } },
            { type: 'aws_s3_bucket', values: { bucket: 'myapp-tfstate-123' } },
            { type: 'aws_ecs_cluster', values: { name: 'x' } },
          ],
        },
      },
    });

    function confirmAndSucceed(showStdout = '{}') {
      // Abort paths below never reach the second confirm, and neither do
      // failures in earlier describes — reset the once-queue so leftovers
      // can't decline a later proceed prompt.
      clack.mockConfirm.mockReset();
      clack.mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mockSpawn.mockImplementation((cmd, args = []) => {
        if (args[0] === 'show') return makeChild({ code: 0, stdout: showStdout });
        return makeChild({ code: 0, stdout: 'ok' });
      });
    }

    it('drains managed buckets before destroy, excluding the state bucket', async () => {
      writeBackend('myapp-tfstate-123', 'us-east-2');
      confirmAndSucceed(SHOW_JSON);
      drainBucketObjects.mockImplementation(async () => {
        expect(mockSpawn.mock.calls.some(([, args]) => args[0] === 'destroy')).toBe(false);
        return { deleted: 1100, failed: [] };
      });

      await destroyStack({ isHeadless: false });

      expect(drainBucketObjects).toHaveBeenCalledTimes(1);
      expect(drainBucketObjects).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'myapp-storage-123' }));
      expect(mockSpawn.mock.calls.some(([, args]) => args[0] === 'destroy')).toBe(true);
      expect(trackEvent).toHaveBeenCalledWith(
        'bucket_drain_completed',
        expect.objectContaining({ bucket_count: 1, deleted_count: 1100 })
      );
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('skips silently when state holds no buckets', async () => {
      writeBackend();
      confirmAndSucceed('{}');

      await destroyStack({ isHeadless: false });

      expect(drainBucketObjects).not.toHaveBeenCalled();
      expect(mockSpawn.mock.calls.some(([, args]) => args[0] === 'destroy')).toBe(true);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('aborts with BUCKET_DRAIN_FAILED when the drain throws, before terraform runs', async () => {
      writeBackend();
      confirmAndSucceed(SHOW_JSON);
      drainBucketObjects.mockRejectedValue(Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' }));

      await expect(destroyStack({ isHeadless: false })).rejects.toMatchObject({ exitCode: 1 });
      expect(mockSpawn.mock.calls.some(([, args]) => args[0] === 'destroy')).toBe(false);
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_destroyed',
        expect.objectContaining({ success: false, error_code: 'BUCKET_DRAIN_FAILED' })
      );
    });

    it('aborts with the residual inventory when keys fail to delete', async () => {
      writeBackend();
      confirmAndSucceed(SHOW_JSON);
      drainBucketObjects.mockResolvedValue({ deleted: 3, failed: [{ key: 'locked', reason: 'AccessDenied' }] });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      let logged;
      try {
        await expect(destroyStack({ isHeadless: false })).rejects.toMatchObject({ exitCode: 1 });
        logged = consoleSpy.mock.calls.flat().join('\n');
      } finally {
        consoleSpy.mockRestore();
      }
      expect(mockSpawn.mock.calls.some(([, args]) => args[0] === 'destroy')).toBe(false);
      expect(logged).toContain('locked');
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_destroyed',
        expect.objectContaining({ success: false, error_code: 'BUCKET_DRAIN_FAILED' })
      );
    });

    it('treats a manually deleted bucket as drained and proceeds', async () => {
      writeBackend();
      confirmAndSucceed(SHOW_JSON);
      drainBucketObjects.mockRejectedValue(Object.assign(new Error('nope'), { name: 'NoSuchBucket' }));

      await destroyStack({ isHeadless: false });

      expect(mockSpawn.mock.calls.some(([, args]) => args[0] === 'destroy')).toBe(true);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('polls drained buckets to empty before running terraform destroy', async () => {
      writeBackend('myapp-tfstate-123', 'us-east-2');
      confirmAndSucceed(SHOW_JSON);
      drainBucketObjects.mockResolvedValue({ deleted: 5, failed: [] });
      const seen = [];
      const s3Client = {
        send: async (command) => {
          expect(command.constructor.name).toBe('ListObjectVersionsCommand');
          seen.push(command.input.Bucket);
          // First read still shows a version (S3 visibility race), then empty.
          return seen.length === 1
            ? { Versions: [{ Key: 'a', VersionId: 'v1' }], DeleteMarkers: [] }
            : { Versions: [], DeleteMarkers: [] };
        },
      };

      await destroyStack({ isHeadless: false, s3Client, drainSettleIntervalMs: 0 });

      expect(seen).toEqual(['myapp-storage-123', 'myapp-storage-123']);
      expect(mockSpawn.mock.calls.some(([, args]) => args[0] === 'destroy')).toBe(true);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('fails closed when a drained bucket never reads empty', async () => {
      writeBackend('myapp-tfstate-123', 'us-east-2');
      confirmAndSucceed(SHOW_JSON);
      drainBucketObjects.mockResolvedValue({ deleted: 5, failed: [] });
      const s3Client = {
        send: async () => ({ Versions: [{ Key: 'a', VersionId: 'v1' }], DeleteMarkers: [] }),
      };

      await expect(destroyStack({ isHeadless: false, s3Client, drainSettleTimeoutMs: 0 })).rejects.toMatchObject({ exitCode: 1 });
      expect(mockSpawn.mock.calls.some(([, args]) => args[0] === 'destroy')).toBe(false);
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_destroyed',
        expect.objectContaining({ success: false, error_code: 'BUCKET_DRAIN_UNSETTLED' })
      );
    });
  });

  describe('BucketNotEmpty retry', () => {
    it('settles and retries destroy once, then reports success', async () => {
      const attemptDestroy = vi.fn().mockResolvedValueOnce(undefined);
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const handled = await handleDestroyTerraformError({
        options: { json: true, sleepFn },
        tfDirPath: path.join(tmpDir, 'terraform'),
        attemptDestroy,
        error: new Error('Error: deleting S3 Bucket (x): BucketNotEmpty: The bucket you tried to delete is not empty.'),
      });
      expect(sleepFn).toHaveBeenCalledTimes(1);
      expect(attemptDestroy).toHaveBeenCalledTimes(1);
      expect(handled).toEqual({ retried: true });
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('fails terminally when the retry hits BucketNotEmpty again (no loops)', async () => {
      const attemptDestroy = vi.fn().mockRejectedValue(new Error('BucketNotEmpty: still not empty'));
      const handled = await handleDestroyTerraformError({
        options: { json: true, sleepFn: vi.fn().mockResolvedValue(undefined) },
        tfDirPath: path.join(tmpDir, 'terraform'),
        attemptDestroy,
        error: new Error('BucketNotEmpty: The bucket you tried to delete is not empty.'),
      });
      expect(handled.retried).toBe(false);
      await expect(handled.result).rejects.toMatchObject({ exitCode: 1 });
      expect(attemptDestroy).toHaveBeenCalledTimes(1);
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_destroyed',
        expect.objectContaining({ error_code: 'BUCKET_NOT_EMPTY' })
      );
    });
  });

  describe('DependencyViolation enumeration', () => {
    const projectTags = () => [
      { Key: 'ManagedBy', Value: 'grada' },
      { Key: 'GradaProject', Value: path.basename(process.cwd()) },
    ];
    function scriptedEc2Client({ vpcs, enis = [], sgs = [] } = {}) {
      return {
        send: vi.fn(async (command) => {
          const name = command.constructor.name;
          if (name === 'DescribeVpcsCommand') return { Vpcs: vpcs ?? [{ VpcId: 'vpc-1' }] };
          if (name === 'DescribeNetworkInterfacesCommand') return { NetworkInterfaces: enis };
          if (name === 'DescribeSecurityGroupsCommand') return { SecurityGroups: sgs };
          if (name === 'DeleteSecurityGroupCommand') return {};
          throw new Error(`unexpected ${name}`);
        }),
      };
    }
    const dependencyError = () => new Error('Error: deleting VPC: DependencyViolation: The vpc has dependencies and cannot be deleted');

    it('deletes grada-owned blockers and retries destroy once', async () => {
      const attemptDestroy = vi.fn().mockResolvedValueOnce(undefined);
      const ec2Client = scriptedEc2Client({
        sgs: [{ GroupId: 'sg-1', GroupName: 'myapp-extra', Tags: projectTags() }],
      });
      // Reset first: earlier tests queue one-shot answers that
      // clearAllMocks does not drain, and a stale answer would win
      // over this test's own.
      clack.mockConfirm.mockReset();
      clack.mockConfirm.mockResolvedValue(true);
      const handled = await handleDestroyTerraformError({
        options: { isHeadless: false, ec2Client },
        tfDirPath: path.join(tmpDir, 'terraform'),
        attemptDestroy,
        error: dependencyError(),
      });
      expect(handled).toEqual({ retried: true });
      expect(attemptDestroy).toHaveBeenCalledTimes(1);
      expect(ec2Client.send).toHaveBeenCalledWith(expect.objectContaining({
        input: expect.objectContaining({ GroupId: 'sg-1' }),
      }));
      expect(trackEvent).toHaveBeenCalledWith(
        'dependency_blockers_removed',
        expect.objectContaining({ count: 1 })
      );
    });

    it('names foreign blockers and never deletes them', async () => {
      const attemptDestroy = vi.fn();
      const ec2Client = scriptedEc2Client({
        enis: [{ NetworkInterfaceId: 'eni-9', Attachment: { InstanceId: 'i-9' }, TagSet: [] }],
        sgs: [{ GroupId: 'sg-9', GroupName: 'foreign', Tags: [] }],
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const handled = await handleDestroyTerraformError({
          options: { json: true, ec2Client },
          tfDirPath: path.join(tmpDir, 'terraform'),
          attemptDestroy,
          error: dependencyError(),
        });
        expect(handled.retried).toBe(false);
        await expect(handled.result).rejects.toMatchObject({ exitCode: 1 });
        expect(attemptDestroy).not.toHaveBeenCalled();
        expect(ec2Client.send).not.toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ GroupId: expect.anything() }) }));
        const printed = errorSpy.mock.calls.map((args) => String(args[0])).join('\n');
        expect(printed).toContain('eni-9');
        expect(printed).toContain('sg-9');
        expect(trackEvent).toHaveBeenCalledWith(
          'infrastructure_destroyed',
          expect.objectContaining({ error_code: 'DESTROY_DEPENDENCY_VIOLATION' })
        );
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('falls back to the runbook when enumeration fails', async () => {
      const attemptDestroy = vi.fn();
      const ec2Client = { send: vi.fn().mockRejectedValue(new Error('network down')) };
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const handled = await handleDestroyTerraformError({
          options: { json: true, ec2Client },
          tfDirPath: path.join(tmpDir, 'terraform'),
          attemptDestroy,
          error: dependencyError(),
        });
        expect(handled.retried).toBe(false);
        await expect(handled.result).rejects.toMatchObject({ exitCode: 1 });
        const printed = errorSpy.mock.calls.map((args) => String(args[0])).join('\n');
        expect(printed).toContain('blocked');
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('selects the prod VPC by Name tag when preview VPCs exist', async () => {
      fs.mkdirSync(path.join(tmpDir, 'terraform'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'terraform', 'main.tf'),
        'locals {\n  app_name = "myapp${local.env_suffix}${local.grada_resource_suffix}"\n  grada_resource_suffix = "-abc123"\n}\n'
      );
      process.chdir(tmpDir);
      const vpcs = [
        { VpcId: 'vpc-prod', Tags: [{ Key: 'Name', Value: 'myapp-abc123-vpc' }] },
        { VpcId: 'vpc-pr', Tags: [{ Key: 'Name', Value: 'myapp-pr-3-abc123-vpc' }] },
      ];
      const sgTags = [
        { Key: 'ManagedBy', Value: 'grada' },
        { Key: 'GradaProject', Value: 'myapp' },
      ];
      const ec2Client = {
        send: vi.fn(async (command) => {
          const name = command.constructor.name;
          // Faithful filter emulation: AWS narrows by the tag filters.
          if (name === 'DescribeVpcsCommand') {
            const filters = command.input?.Filters || [];
            const nameFilter = filters.find((f) => f.Name === 'tag:Name');
            const found = nameFilter
              ? vpcs.filter((v) => (v.Tags || []).some((t) => t.Key === 'Name' && nameFilter.Values.includes(t.Value)))
              : vpcs;
            return { Vpcs: found };
          }
          if (name === 'DescribeNetworkInterfacesCommand') return { NetworkInterfaces: [] };
          if (name === 'DescribeSecurityGroupsCommand') {
            return { SecurityGroups: [{ GroupId: 'sg-1', GroupName: 'myapp-extra', Tags: sgTags }] };
          }
          if (name === 'DeleteSecurityGroupCommand') return {};
          throw new Error(`unexpected ${name}`);
        }),
      };
      clack.mockConfirm.mockReset();
      clack.mockConfirm.mockResolvedValue(true);
      const handled = await handleDestroyTerraformError({
        options: { isHeadless: false, ec2Client },
        tfDirPath: path.join(tmpDir, 'terraform'),
        attemptDestroy: vi.fn().mockResolvedValueOnce(undefined),
        error: dependencyError(),
      });
      expect(handled).toEqual({ retried: true });
      const describeCall = ec2Client.send.mock.calls.find(([cmd]) => cmd.constructor.name === 'DescribeVpcsCommand');
      expect(JSON.stringify(describeCall[0].input.Filters)).toContain('myapp-abc123-vpc');
    });
  });
});
