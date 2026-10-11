import { describe, it, expect } from 'vitest';
import { classifyTerraformError, countRecreateCollisions, getRunbook, ERROR_CODES } from '../src/utils/terraform-errors.js';

describe('R1: terraform error taxonomy', () => {
    it('exposes the named code set', () => {
        for (const code of [
            'STATE_LOCK_HELD',
            'STATE_BUCKET_MISSING',
            'BACKEND_RECONFIGURE_REQUIRED',
            'DESTROY_DEPENDENCY_VIOLATION',
            'DELETION_PROTECTION_ACTIVE',
            'RECREATE_COLLISION',
            'OIDC_PROVIDER_CONFLICT',
        ]) {
            expect(ERROR_CODES).toContain(code);
        }
    });

    it.each([
        ['lock with id', 'Error: Error acquiring the state lock:\nLock Info:\n  ID: lock-9\n', {}, 'STATE_LOCK_HELD', 'lock-9'],
        ['missing bucket', 'Failed to get existing workspaces: NoSuchBucket: The specified bucket does not exist', {}, 'STATE_BUCKET_MISSING', undefined],
        ['gone bucket', 'S3 bucket "x" does not exist', {}, 'STATE_BUCKET_MISSING', undefined],
        ['backend reconfigure', 'Error: Backend initialization required, please run "terraform init"\nReason: Backend configuration changed', {}, 'BACKEND_RECONFIGURE_REQUIRED', undefined],
        ['reconfigure flag', 'run terraform init -reconfigure to proceed', {}, 'BACKEND_RECONFIGURE_REQUIRED', undefined],
        ['destroy dependency', 'Error: deleting VPC: DependencyViolation: The vpc has dependencies and cannot be deleted', {}, 'DESTROY_DEPENDENCY_VIOLATION', undefined],
        ['deletion protection', 'InvalidDBInstanceState: The DB instance has deletion protection enabled and cannot be deleted', {}, 'DELETION_PROTECTION_ACTIVE', undefined],
        ['oidc conflict', 'Error: creating IAM OIDC provider: EntityAlreadyExists: token.actions.githubusercontent.com exists', {}, 'OIDC_PROVIDER_CONFLICT', undefined],
        ['post-recovery collision', 'Error: creating VPC: EntityAlreadyExists: already exists', { postRecovery: true }, 'RECREATE_COLLISION', undefined],
        ['rds collision without recovery', 'Error: creating RDS DB Instance (myapp-db): DBInstanceAlreadyExists: DB instance already exists', {}, 'RECREATE_COLLISION', undefined],
        ['s3 collision without recovery', 'Error: creating S3 bucket (myapp-x): BucketAlreadyExists: The requested bucket name is not available', {}, 'RECREATE_COLLISION', undefined],
        ['ecr collision without recovery', 'Error: creating ECR repository (myapp-repo): RepositoryAlreadyExistsException: The specified repository has already been created', {}, 'RECREATE_COLLISION', undefined],
        ['secrets collision without recovery', 'Error: creating Secrets Manager Secret (myapp-secrets): ResourceExistsException: The specified secret already exists', {}, 'RECREATE_COLLISION', undefined],
        ['security-group duplicate without recovery', 'Error: creating Security Group: InvalidGroup.Duplicate: The specified group already exists', {}, 'RECREATE_COLLISION', undefined],
        ['elb duplicate without recovery', 'Error: creating ELB listener: DuplicateListenerException: A listener already exists', {}, 'RECREATE_COLLISION', undefined],
        ['iam collision without recovery', 'Error: creating IAM Role: EntityAlreadyExists: The role already exists', {}, 'RECREATE_COLLISION', undefined],
        ['cloudfront in progress', 'Error: deleting CloudFront Distribution (E1): PreconditionFailed: distribution is in progress', {}, 'CLOUDFRONT_IN_PROGRESS', undefined],
    ])('classifies %s', (_name, stderr, ctx, code, lockId) => {
        expect(classifyTerraformError(stderr, ctx)).toMatchObject({ code, lockId: lockId ?? null });
    });

    it('returns null for unrecognized stderr (generic fallback retained)', () => {
        expect(classifyTerraformError('some mysterious provider explosion', {})).toBeNull();
        expect(classifyTerraformError('', {})).toBeNull();
        expect(classifyTerraformError(null, {})).toBeNull();
    });

    // The recovery gate retired with the VPN-partition incident: a hung
    // create retried across a network transition collides mid-run, with no
    // recovery involved — gating on postRecovery left those as raw crashes.
    it('classifies collisions in any phase, not only post-recovery', () => {
        expect(classifyTerraformError('Error: creating VPC: EntityAlreadyExists', {})).toMatchObject({ code: 'RECREATE_COLLISION' });
        expect(classifyTerraformError('Error: creating VPC: EntityAlreadyExists', { postRecovery: true })).toMatchObject({ code: 'RECREATE_COLLISION' });
    });

    it('does not mistake terraform-config duplicates for AWS collisions', () => {
        expect(classifyTerraformError('Error: Duplicate resource "aws_s3_bucket" configuration: A aws_s3_bucket resource named "x" was already declared', {})).toBeNull();
        expect(classifyTerraformError('Error: Duplicate variable declaration: A variable named "x" was already declared', {})).toBeNull();
    });

    it('counts every collision marker in one stderr for telemetry', () => {
        expect(countRecreateCollisions('DBInstanceAlreadyExists: x')).toBe(1);
        expect(countRecreateCollisions('EntityAlreadyExists: a\nDBInstanceAlreadyExists: b\nInvalidGroup.Duplicate: c')).toBe(3);
        expect(countRecreateCollisions('some mysterious provider explosion')).toBe(0);
        expect(countRecreateCollisions('')).toBe(0);
    });

    it('every code has a headless-safe runbook variant', () => {
        for (const code of ERROR_CODES) {
            const interactive = getRunbook(code, { headless: false });
            const headless = getRunbook(code, { headless: true });
            expect(interactive.hint).toBeTruthy();
            expect(headless.hint).toBeTruthy();
            expect(headless.hint).not.toMatch(/confirm|prompt/i);
        }
    });

    it('deletion-protection runbook names --allow-data-loss', () => {
        expect(getRunbook('DELETION_PROTECTION_ACTIVE', { headless: true }).hint).toContain('--allow-data-loss');
    });

    it('lock runbook names force-unlock with the id in the interactive variant', () => {
        const runbook = getRunbook('STATE_LOCK_HELD', { headless: false, lockId: 'lock-9' });
        expect(runbook.hint).toContain('force-unlock');
        expect(runbook.hint).toContain('lock-9');
    });

    it('recreate-collision runbook is a terraform import runbook', () => {
        expect(getRunbook('RECREATE_COLLISION', { headless: true }).hint).toContain('terraform import');
    });
});
