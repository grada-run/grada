// State-adoption gate for init: a fresh tree pointing at a state bucket that
// already holds a key is either a previous life of this project or another
// project sharing the name. Adopting that state must be an explicit choice —
// never silent in either direction.
import { select, confirm, cancel, isCancel } from '@clack/prompts';
import { HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { trackEvent } from '../core/telemetry.js';

// Must match the backend key in templates/terraform/backend.tf.
export const STATE_KEY = 'state/terraform.tfstate';

function isMissingKeyError(error) {
    const name = error?.name ?? error?.Code;
    if (name === 'NotFound' || name === 'NoSuchKey') return true;
    const status = error?.$metadata?.httpStatusCode ?? error?.statusCode;
    return status === 404;
}

// Probes the state key. A versioned bucket whose top version is a
// delete-marker answers HeadObject with 404, so delete-marker-only history
// correctly reads as empty. Unexpected errors (403, network) rethrow — the
// caller fails closed instead of adopting blind.
export async function stateKeyExists({ s3, bucket, key = STATE_KEY }) {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch (error) {
        if (isMissingKeyError(error)) return false;
        throw error;
    }
}

export async function deleteStateKey({ s3, bucket, key = STATE_KEY }) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// Returns null to proceed, or a failCommand-args object the caller returns.
// Interactive rename/wipe-decline/cancel exit inside (precedent:
// planExistingFiles) since those abort before the tree is touched.
export async function checkStateAdoption({
    s3,
    bucket,
    key = STATE_KEY,
    isFreshTree = false,
    isHeadless = false,
    adoptState = false,
} = {}) {
    // Re-init over an existing tree owns its state; --adopt-state
    // pre-consents (and skips the probe so restricted IAM roles adopting
    // explicitly are never blocked by a 403); without a client (offline or
    // mocked provisioning) there is nothing to probe.
    if (!isFreshTree || adoptState === true || !s3) return null;

    const keyExists = await stateKeyExists({ s3, bucket, key });
    if (!keyExists) return null;

    trackEvent('state_adoption_prompted', {});
    if (isHeadless) {
        return {
            message: `\n✖ Remote state already exists for this project (s3://${bucket}/${key}). Another project may share this name, or a previous life of this one was never destroyed.`,
            hint: '  Re-run with --adopt-state to take over that state, or rename the project so it provisions fresh.\n',
            useErrorStream: true,
            event: 'cli-error',
            telemetry: { step: 'state_adoption' },
            errorCode: 'STATE_ALREADY_EXISTS',
            reason: 'state-already-exists',
        };
    }

    const choice = await select({
        message: `Remote state already exists for this project (s3://${bucket}/${key}). Adopt it, or start fresh?`,
        options: [
            { value: 'adopt', label: 'Adopt the existing state', hint: 'continue; Terraform manages what is already there' },
            { value: 'rename', label: 'Rename my project', hint: 'abort; re-run init with a different name' },
            { value: 'wipe', label: 'Wipe the remote state and start fresh', hint: 'deletes the state key (prior versions stay recoverable in the versioned bucket)' },
        ],
    });
    if (isCancel(choice) || choice === 'rename') {
        cancel('Operation cancelled. Rename the project directory (or package.json name) and re-run init to provision fresh state.');
        process.exit(0);
        return null; // Unreachable in prod (exit above); stops fall-through when exit is mocked.
    }
    if (choice === 'wipe') {
        const wipe = await confirm({
            message: `Permanently delete s3://${bucket}/${key} and start with empty state?`,
            initialValue: false,
        });
        if (wipe !== true || isCancel(wipe)) {
            cancel('Operation cancelled. The remote state was left untouched.');
            process.exit(0);
            return null; // Unreachable in prod (exit above); stops fall-through when exit is mocked.
        }
        await deleteStateKey({ s3, bucket, key });
        trackEvent('state_adoption_wiped', {});
        return null;
    }
    trackEvent('state_adoption_accepted', {});
    return null;
}
