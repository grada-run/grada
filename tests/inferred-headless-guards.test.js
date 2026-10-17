import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { mockConfirm } from './helpers/clack.js';
import { createTmpDirTracker } from './helpers/tmpdir.js';
import { guardSleepingEnv, writeSleepState } from '../src/utils/sleep-state.js';
import { writeEjectedMarker, requireManagedTree } from '../src/utils/terraform-metadata.js';
import { trackEvent } from '../src/core/telemetry.js';



const tmp = createTmpDirTracker();
let exitSpy;
let logSpy;

beforeEach(() => {
    tmp.reset();
    vi.clearAllMocks();
    mockConfirm.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    tmp.cleanup();
});

describe('inferred-headless shared guards', () => {
    it('refuses inferred-headless apply on a sleeping env with SLEEPING_ENVIRONMENT', async () => {
        const dir = tmp.makeTmp('sleep-guard-test-');
        writeSleepState(dir, { default: { env: 'default', sleptAt: new Date().toISOString() } });
        const wakeImpl = vi.fn(async () => ({ ok: true }));
        const { proceed, result } = await guardSleepingEnv({
            cwd: dir,
            envKey: 'default',
            options: {},
            command: 'apply',
            event: 'infrastructure_applied',
            projectName: 'myapp',
            wakeImpl,
        });
        expect(proceed).toBe(false);
        expect(result).toMatchObject({ ok: false, reason: 'sleeping-environment' });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('infrastructure_applied', expect.objectContaining({
            error_code: 'SLEEPING_ENVIRONMENT',
        }));
        expect(mockConfirm).not.toHaveBeenCalled();
        expect(wakeImpl).not.toHaveBeenCalled();
    });

    it('refuses inferred-headless commands on an ejected tree with EJECTED_PROJECT', async () => {
        const dir = tmp.makeTmp('managed-tree-test-');
        writeEjectedMarker(dir);
        const { proceed, result } = await requireManagedTree({
            cwd: dir,
            command: 'apply',
            options: {},
            event: 'infrastructure_applied',
            projectName: 'myapp',
        });
        expect(proceed).toBe(false);
        expect(result).toMatchObject({ ok: false, reason: 'ejected-project' });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('managed_tree_refused', expect.objectContaining({ command: 'apply' }));
        expect(mockConfirm).not.toHaveBeenCalled();
    });
});
