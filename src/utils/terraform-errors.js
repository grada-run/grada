// Unified Grada error taxonomy for Terraform/AWS stderr. String matching
// lives in exactly one module: callers classify once, then render the
// runbook for their mode (headless variants never reference prompts).
// Unrecognized stderr returns null so the generic fallback is retained.

export const ERROR_CODES = [
    'STATE_LOCK_HELD',
    'STATE_BUCKET_MISSING',
    'BACKEND_RECONFIGURE_REQUIRED',
    'DESTROY_DEPENDENCY_VIOLATION',
    'DELETION_PROTECTION_ACTIVE',
    'RECREATE_COLLISION',
    'OIDC_PROVIDER_CONFLICT',
    'CLOUDFRONT_IN_PROGRESS',
    'BUCKET_NOT_EMPTY',
    'SECRET_PENDING_DELETION',
];

// AWS AlreadyExists family: every create-path "reality has what state
// lacks" marker across the resources Grada provisions (RDS, S3, ECR,
// Secrets Manager, IAM, ELB, EC2 security groups). `Duplicate` is
// anchored to API-code shapes (`*Duplicate*Exception`, `.Duplicate`) so
// Terraform's own config errors ("Duplicate resource ... configuration")
// never read as collisions. `ctx` is retained for forward compatibility
// but no longer gates: the VPN-partition incident proved same-run
// collisions (a hung create retried across a network transition) with no
// recovery involved, so any family match classifies in any phase.
const RECREATE_COLLISION_RE = /AlreadyExists|ResourceExistsException|Duplicate[A-Za-z]*Exception|\.Duplicate\b/i;

// Shared with apply's `bucket_recovery_probed` telemetry so the counter
// and the classifier can never drift apart (the old inline counter only
// saw EntityAlreadyExists and undercounted every other family member).
export function countRecreateCollisions(stderr) {
    if (typeof stderr !== 'string' || stderr === '') return 0;
    return stderr.match(new RegExp(RECREATE_COLLISION_RE.source, 'gi'))?.length ?? 0;
}

const COLLISION_NAME_RE = /creating [A-Za-z][A-Za-z0-9 ]*?\(([^)]+)\)/;
const COLLISION_WITH_RE = /^\s*[│|]?\s*with ([A-Za-z0-9_."[\]-]+),/;
const COLLISION_ERROR_RE = /^\s*[╷╵│]?\s*Error:/;

// Guided-import pairs for recreate collisions: each AlreadyExists-style
// marker carries the provider name in parens, and the resource address
// follows on a `with <addr>,` context line. Markers without either are
// skipped — the caller falls back to the manual runbook. Capped so a
// pathological stderr cannot queue unbounded imports.
export function parseCollisionImports(stderr, limit = 20) {
    if (typeof stderr !== 'string' || stderr === '') return [];
    const lines = stderr.split('\n');
    const pairs = [];
    const seen = new Set();
    for (let i = 0; i < lines.length && pairs.length < limit; i++) {
        if (!RECREATE_COLLISION_RE.test(lines[i])) continue;
        const nameMatch = COLLISION_NAME_RE.exec(lines[i]);
        if (!nameMatch) continue;
        for (let j = i + 1; j < Math.min(i + 9, lines.length); j++) {
            if (COLLISION_ERROR_RE.test(lines[j])) break;
            const withMatch = COLLISION_WITH_RE.exec(lines[j]);
            if (withMatch) {
                const address = withMatch[1].replace(/"/g, '');
                if (!seen.has(address)) {
                    seen.add(address);
                    pairs.push({ address, id: nameMatch[1] });
                }
                break;
            }
        }
    }
    return pairs;
}

// Pure classifier over stderr text. Returns `{ code, lockId }` or null.
export function classifyTerraformError(stderr, ctx = {}) {
    const text = typeof stderr === 'string' ? stderr : '';
    if (text === '') return null;

    if (/acquiring the state lock/i.test(text)) {
        const match = text.match(/^\s*ID:\s*(\S+)/m);
        return { code: 'STATE_LOCK_HELD', lockId: match ? match[1] : null };
    }
    if (/EntityAlreadyExists/i.test(text) && /token\.actions\.githubusercontent\.com/i.test(text)) {
        return { code: 'OIDC_PROVIDER_CONFLICT', lockId: null };
    }
    if (RECREATE_COLLISION_RE.test(text)) {
        return { code: 'RECREATE_COLLISION', lockId: null };
    }
    // Re-apply inside the Secrets Manager recovery window: the committed
    // suffix reuses the secret name while deletion is still pending.
    // Disjoint from the collision family ("already scheduled for
    // deletion" carries no AlreadyExists marker).
    if (/scheduled for deletion/i.test(text)) {
        const nameMatch = /Secrets Manager Secret \(([^)]+)\)/.exec(text);
        return { code: 'SECRET_PENDING_DELETION', lockId: null, secretName: nameMatch ? nameMatch[1] : null };
    }
    if (/NoSuchBucket/i.test(text) || /does not exist/i.test(text)) {
        return { code: 'STATE_BUCKET_MISSING', lockId: null };
    }
    if (/-reconfigure\b/i.test(text) || /Backend initialization required/i.test(text) || /Backend configuration changed/i.test(text)) {
        return { code: 'BACKEND_RECONFIGURE_REQUIRED', lockId: null };
    }
    if (/DependencyViolation/i.test(text)) {
        return { code: 'DESTROY_DEPENDENCY_VIOLATION', lockId: null };
    }
    if (/deletion.?protection/i.test(text)) {
        return { code: 'DELETION_PROTECTION_ACTIVE', lockId: null };
    }
    if (/cloudfront/i.test(text) && /in.?progress|in use|precondition/i.test(text)) {
        return { code: 'CLOUDFRONT_IN_PROGRESS', lockId: null };
    }
    if (/BucketNotEmpty/i.test(text)) {
        return { code: 'BUCKET_NOT_EMPTY', lockId: null };
    }
    return null;
}

const RUNBOOKS = {
    STATE_LOCK_HELD: {
        message: 'Terraform state is locked by another run.',
        headless: 'Re-run with --force-unlock <lock-id> (from the Lock Info above) once you have verified no other apply or destroy is running.',
        interactive: 'Approve the unlock when asked (only when no other run holds it), or run this yourself: terraform force-unlock -force <lock-id>',
    },
    STATE_BUCKET_MISSING: {
        message: 'Terraform state bucket is missing.',
        headless: 'Let apply recreate the bucket, then follow the import runbook — objects in a deleted bucket are unrecoverable.',
        interactive: 'Approve the bucket recreate when asked, then follow the import runbook — objects in a deleted bucket are unrecoverable.',
    },
    BACKEND_RECONFIGURE_REQUIRED: {
        message: 'Terraform backend configuration changed.',
        headless: 'Run: cd terraform && terraform init -reconfigure',
        interactive: 'Run: cd terraform && terraform init -reconfigure',
    },
    DESTROY_DEPENDENCY_VIOLATION: {
        message: 'Destroy blocked by dependent AWS resources.',
        headless: 'Delete the dependent resources named above first, then re-run destroy.',
        interactive: 'Delete the dependent resources named above first, then re-run destroy.',
    },
    DELETION_PROTECTION_ACTIVE: {
        message: 'Destroy blocked: the database has deletion protection enabled.',
        headless: 'Re-run destroy with --allow-data-loss to lift protection and destroy the database WITHOUT a final snapshot — all data is permanently destroyed.',
        interactive: 'Re-run destroy with --allow-data-loss to skip the final snapshot and destroy the database immediately (data loss is instant and permanent), or approve the named-cluster data-loss step to snapshot first and then proceed.',
    },
    RECREATE_COLLISION: {
        message: 'Resources already exist that the Terraform state does not know about.',
        headless: 'Run terraform import for each collided address (see the runbook above), or re-run with --force-resume to attempt provisioning anyway.',
        interactive: 'Run terraform import for each collided address (see the runbook above), or re-run with --force-resume to attempt provisioning anyway.',
    },
    OIDC_PROVIDER_CONFLICT: {
        message: 'GitHub OIDC provider already exists in this account.',
        headless: 'Re-run with --auto-approve to adopt it, or set create_oidc_provider = false in terraform/grada.auto.tfvars.',
        interactive: 'Adopt it when prompted, or set create_oidc_provider = false in terraform/grada.auto.tfvars.',
    },
    CLOUDFRONT_IN_PROGRESS: {
        message: 'CloudFront is still converging a previous change.',
        headless: 'Wait 5–15 minutes for the distribution to settle, then re-run the same command.',
        interactive: 'Wait 5–15 minutes for the distribution to settle, then re-run the same command.',
    },
    BUCKET_NOT_EMPTY: {
        message: 'Terraform destroy failed twice: an S3 bucket still holds object versions.',
        headless: 'Re-run destroy — drained buckets usually read empty within a minute; if it persists, empty the bucket by hand in the AWS Console.',
        interactive: 'Re-run destroy — drained buckets usually read empty within a minute; if it persists, empty the bucket by hand in the AWS Console.',
    },
    SECRET_PENDING_DELETION: {
        message: 'A Secrets Manager secret is scheduled for deletion.',
        headless: 'Restore it (aws secretsmanager restore-secret --secret-id <name>, then cd terraform && terraform import aws_secretsmanager_secret.app_secrets <arn>) or force-delete without recovery (aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery) and re-apply + push — fetch the ARN via aws secretsmanager describe-secret --secret-id <name> --query ARN --output text. Grada never force-deletes: the window protects against accidental loss.',
        interactive: 'Restore it (aws secretsmanager restore-secret --secret-id <name>, then cd terraform && terraform import aws_secretsmanager_secret.app_secrets <arn>) or force-delete without recovery (aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery) and re-apply + push — fetch the ARN via aws secretsmanager describe-secret --secret-id <name> --query ARN --output text. Grada never force-deletes: the window protects against accidental loss.',
    },
};

// Returns `{ message, hint }` for a named code, or null for unknown
// codes. `headless` selects the variant; `lockId` fills the interactive
// lock runbook. Resource identifiers stay in the rendered hint (stdout),
// never in telemetry payloads.
export function getRunbook(code, { headless = false, lockId = null, secretName = null } = {}) {
    const runbook = RUNBOOKS[code];
    if (!runbook) return null;
    let hint = headless ? runbook.headless : runbook.interactive;
    if (code === 'STATE_LOCK_HELD' && lockId) {
        hint = hint.replace(/<lock-id>/g, String(lockId));
    }
    if (code === 'SECRET_PENDING_DELETION' && secretName) {
        hint = hint.replace(/<name>/g, String(secretName));
    }
    return { message: runbook.message, hint };
}
