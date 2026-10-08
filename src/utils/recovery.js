import fs from 'fs';
import path from 'path';
import { confirm, isCancel } from '@clack/prompts';
import { provisionStateBucket } from './aws.js';

// Asks whether to recreate a missing state bucket and resume
// provisioning. Returns true when approved. Has no side effects
// besides the prompt itself — callers own telemetry and the resume.
export async function promptStateBucketRecovery({ autoApprove = false } = {}) {
    if (autoApprove === true || autoApprove === 'true') return true;
    const shouldRecreate = await confirm({
        message: 'Do you want to automatically recreate the state bucket and resume provisioning?\nPrevious state is unrecoverable — if infrastructure still exists (bucket deleted out-of-band), apply will try to recreate it.',
        initialValue: true,
    });
    if (isCancel(shouldRecreate) || !shouldRecreate) return false;
    return true;
}

// Wipes the stale local Terraform cache and re-provisions the state
// bucket. Throws when provisioning fails — callers map the error.
export async function recreateStateBucket({ tfDir, region, projectName }) {
    const dotTerraformPath = path.join(tfDir, '.terraform');
    if (fs.existsSync(dotTerraformPath)) {
        fs.rmSync(dotTerraformPath, { recursive: true, force: true });
    }
    return provisionStateBucket(region, projectName);
}
