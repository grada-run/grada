import { describe, it, expect } from 'vitest';
import { classifyTerraformError, countRecreateCollisions, getRunbook, ERROR_CODES, parseCollisionImports } from '../src/utils/terraform-errors.js';

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
            'BUCKET_NOT_EMPTY',
            'SECRET_PENDING_DELETION',
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
        ['bucket not empty', 'Error: deleting S3 Bucket (myapp-storage-123): BucketNotEmpty: The bucket you tried to delete is not empty. You must delete all versions in the bucket.', {}, 'BUCKET_NOT_EMPTY', undefined],
        ['pending-deletion secret', 'Error: creating Secrets Manager Secret (myapp-secrets-ab12cd): InvalidRequestException: You tried to create a secret that is already scheduled for deletion', {}, 'SECRET_PENDING_DELETION', undefined],
    ])('classifies %s', (_name, stderr, ctx, code, lockId) => {
        expect(classifyTerraformError(stderr, ctx)).toMatchObject({ code, lockId: lockId ?? null });
    });

    it('returns the secret name for pending-deletion errors', () => {
        expect(classifyTerraformError('Error: creating Secrets Manager Secret (myapp-secrets-ab12cd): InvalidRequestException: already scheduled for deletion', {}))
            .toMatchObject({ code: 'SECRET_PENDING_DELETION', secretName: 'myapp-secrets-ab12cd' });
        expect(classifyTerraformError('Error: something already scheduled for deletion', {}))
            .toMatchObject({ code: 'SECRET_PENDING_DELETION', secretName: null });
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

    it('pending-deletion runbook names restore and force-delete paths', () => {
        for (const headless of [true, false]) {
            const hint = getRunbook('SECRET_PENDING_DELETION', { headless }).hint;
            expect(hint).toContain('restore-secret');
            expect(hint).toContain('force-delete');
        }
    });

    it('pending-deletion runbook scopes force-delete to an explicit choice', () => {
        for (const headless of [true, false]) {
            const hint = getRunbook('SECRET_PENDING_DELETION', { headless }).hint;
            expect(hint).toContain('only force-deletes when you explicitly choose it');
            expect(hint).not.toContain('never force-deletes:');
        }
    });

    it('pending-deletion runbook interpolates the secret name when known', () => {
        for (const headless of [true, false]) {
            const hint = getRunbook('SECRET_PENDING_DELETION', { headless, secretName: 'myapp-secrets-ab12cd' }).hint;
            expect(hint).toContain('restore-secret --secret-id myapp-secrets-ab12cd');
            expect(hint).toContain('aws_secretsmanager_secret.app_secrets');
            expect(hint).not.toContain('<name>');
        }
        const fallback = getRunbook('SECRET_PENDING_DELETION', { headless: true }).hint;
        expect(fallback).toContain('<name>');
    });

    it('pending-deletion runbook prints the indexed import address quoted for shells', () => {
        for (const headless of [true, false]) {
            const hint = getRunbook('SECRET_PENDING_DELETION', { headless, secretName: 'myapp-secrets-ab12cd' }).hint;
            expect(hint).toContain(`terraform import 'aws_secretsmanager_secret.app_secrets[0]'`);
            expect(hint).not.toContain('terraform import aws_secretsmanager_secret.app_secrets ');
        }
    });

    it('pairs with-lines to collision markers for guided import', () => {
        const stderr = [
            'Error: creating S3 Bucket (myapp-x): BucketAlreadyExists: The requested bucket name is not available',
            '│ ',
            '│   with aws_s3_bucket.assets,',
            '│   on main.tf line 12, in resource "aws_s3_bucket" "assets":',
            'Error: creating IAM Role (myapp-task-role): EntityAlreadyExists: The role already exists',
            '│   with aws_iam_role.task,',
        ].join('\n');
        expect(parseCollisionImports(stderr)).toEqual([
            { address: 'aws_s3_bucket.assets', id: 'myapp-x' },
            { address: 'aws_iam_role.task', id: 'myapp-task-role' },
        ]);
    });

    it('skips markers without names or addresses', () => {
        expect(parseCollisionImports('Error: creating ELB listener: DuplicateListenerException: A listener already exists')).toEqual([]);
        expect(parseCollisionImports('Error: creating S3 Bucket (myapp-x): BucketAlreadyExists: taken')).toEqual([]);
        expect(parseCollisionImports('')).toEqual([]);
        expect(parseCollisionImports(null)).toEqual([]);
    });
});
