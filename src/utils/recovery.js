import fs from 'fs';
import path from 'path';
import { confirm, isCancel } from '@clack/prompts';
import { ensureStateBucketExists } from './aws.js';
import { parseStateBucketBackend } from './terraform-metadata.js';
import { refuseIfNonInteractive, shouldAutoApprove } from './command.js';

// confirm() with the recovery defaults: preselected yes, cancel-safe,
// resolving to a plain boolean.
export async function confirmRecoveryAction(message) {
    const confirmed = await confirm({ message, initialValue: true });
    return !isCancel(confirmed) && confirmed === true;
}

// Runs one in-flow recovery round — refuse-if-headless, approve (auto or
// prompt), act — and reports a discriminated outcome so callers keep owning
// their own retry + runbook rendering:
//
// - { status: 'refused', refusal } — propagate the refusal result as-is.
// - { status: 'recovered', method } — act succeeded; retry the command.
// - { status: 'declined' } — user declined/dismissed; show manual guidance.
// - { status: 'failed', method, error } — act threw; show guidance + cause.
//
// `approve` runs only when --auto-approve is off and resolves to a truthy
// method (confirm) or a method string (select), falsy on decline.
// `autoMethod` is the method taken non-interactively. `act` receives the
// resolved method; anything it needs beyond that (flags for the fallthrough
// notes) it sets through the caller's own scope.
export async function offerInFlowRecovery({ options, refusal, approve, autoMethod = true, act }) {
    const refused = await refuseIfNonInteractive(options, refusal);
    if (refused) return { status: 'refused', refusal: refused };
    const method = shouldAutoApprove(options) ? autoMethod : await approve();
    if (!method) return { status: 'declined' };
    try {
        await act(method);
        return { status: 'recovered', method };
    } catch (error) {
        return { status: 'failed', method, error };
    }
}

// Asks whether to recreate a missing state bucket and resume
// provisioning. Returns true when approved. Has no side effects
// besides the prompt itself — callers own telemetry and the resume.
//
// Non-interactive gate: apply is the sole caller, so the gate lives
// here (apply context) instead of at a call site. Pass `options` (plus
// `projectName` for telemetry) and a headless run without approval
// flags refuses loudly with APPLY_NON_INTERACTIVE — returning the
// failure result for the caller to propagate — instead of abandoning
// the prompt. Callers answering boolean keep working unchanged.
export async function promptStateBucketRecovery({ autoApprove = false, options = null, projectName = null } = {}) {
    if (autoApprove === true || autoApprove === 'true') return true;
    if (options !== null && options !== undefined) {
        const refused = await refuseIfNonInteractive(options, {
            message: `\n✖ apply needs approval to recreate the missing state bucket and resume provisioning.`,
            hint: '  Re-run with --auto-approve to recover non-interactively.\n',
            event: 'infrastructure_applied',
            telemetry: { projectName },
            errorCode: 'APPLY_NON_INTERACTIVE',
        });
        if (refused) return refused;
    }
    const shouldRecreate = await confirm({
        message: 'Do you want to automatically recreate the state bucket and resume provisioning?\nPrevious state is unrecoverable — if infrastructure still exists (bucket deleted out-of-band), apply will try to recreate it.',
        initialValue: true,
    });
    if (isCancel(shouldRecreate) || !shouldRecreate) return false;
    return true;
}

// Wipes the stale local Terraform cache and re-provisions the state
// bucket. The bucket (and its region) is read from backend.tf — never
// re-derived from the project name, which would miss on suffixed trees.
// Throws when the backend names no bucket or provisioning fails;
// callers map the error.
export async function recreateStateBucket({ tfDir, region }) {
    const dotTerraformPath = path.join(tfDir, '.terraform');
    if (fs.existsSync(dotTerraformPath)) {
        fs.rmSync(dotTerraformPath, { recursive: true, force: true });
    }
    const { bucket, region: backendRegion } = parseStateBucketBackend(
        fs.readFileSync(path.join(tfDir, 'backend.tf'), 'utf8')
    );
    if (!bucket) {
        throw new Error('Cannot recreate the state bucket: terraform/backend.tf names no bucket.');
    }
    return ensureStateBucketExists({ region: backendRegion || region, bucket });
}
