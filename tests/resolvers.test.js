import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTmpDirTracker } from './helpers/tmpdir.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readFileSafe, readTerraformProjectName, readTerraformOidcTrust, readTerraformRegion, resolveProjectName, resolveRegion, resolveLogGroup, resolveHeadless, resolveAppName, resolveCwd, resolveCluster, resolveService, resolveWorkspaceSuffix, detectComputeTargetFromMainTf, readTerraformComputeTarget, readResourceSuffix } from '../src/utils/resolvers.js';

const tmp = createTmpDirTracker();

function makeTmp() {
    return tmp.makeTmp('resolvers-test-');
}

beforeEach(() => {
    tmp.reset();
});

afterEach(() => {
    tmp.cleanup();
});

describe('readTerraformOidcTrust', () => {
    it('returns null when terraform/oidc.tf is missing', () => {
        expect(readTerraformOidcTrust(makeTmp())).toBeNull();
    });

    it('extracts the scoped OIDC sub claim', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'oidc.tf'),
            '"token.actions.githubusercontent.com:sub" : "repo:acme/widgets:*"\n'
        );
        expect(readTerraformOidcTrust(dir)).toBe('repo:acme/widgets:*');
    });

    it('extracts the open repo:* trust verbatim', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'oidc.tf'),
            '"token.actions.githubusercontent.com:sub" : "repo:*"\n'
        );
        expect(readTerraformOidcTrust(dir)).toBe('repo:*');
    });

    it('returns null when the sub claim is absent', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'terraform', 'oidc.tf'), '# empty\n');
        expect(readTerraformOidcTrust(dir)).toBeNull();
    });
});

describe('readTerraformProjectName', () => {
    it('returns null when terraform/main.tf is missing', () => {
        expect(readTerraformProjectName(makeTmp())).toBeNull();
    });

    it('extracts the project name from local.app_name', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "myapp${local.env_suffix}"\n}\n'
        );
        expect(readTerraformProjectName(dir)).toBe('myapp');
    });

    it('falls back to the aws_ecr_repository app name', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'resource "aws_ecr_repository" "app" {\n  name = "fallback-app-repo"\n}\n'
        );
        expect(readTerraformProjectName(dir)).toBe('fallback-app');
    });

    it('returns null when neither pattern matches', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), 'provider "aws" {}\n');
        expect(readTerraformProjectName(dir)).toBeNull();
    });

    it('prefers a plain app_name over the ECR repository heuristic', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "billing-app"\n}\nresource "aws_ecr_repository" "app" {\n  name = "other-repo"\n}\n'
        );
        expect(readTerraformProjectName(dir)).toBe('billing-app');
    });

    it('strips ${...} suffixes and trailing separators from a plain app_name', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "billing-app-${var.env}"\n}\n'
        );
        expect(readTerraformProjectName(dir)).toBe('billing-app');
    });

    it('ignores unrendered template placeholders', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "{{PROJECT_NAME}}"\n}\n'
        );
        expect(readTerraformProjectName(dir)).toBeNull();
    });
});

describe('resolveProjectName', () => {
    it('prefers an explicit --project-name option', () => {
        const dir = makeTmp();
        expect(resolveProjectName({ projectName: 'explicit' }, dir)).toBe('explicit');
    });

    it('reads the rendered terraform/main.tf before the directory basename', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "tf-app${local.env_suffix}"\n}\n'
        );
        expect(resolveProjectName({}, dir)).toBe('tf-app');
    });

    it('falls back to the directory basename', () => {
        const dir = makeTmp();
        expect(resolveProjectName({}, dir)).toBe(path.basename(dir));
    });

    it('still resolves the region from flags as before', () => {
        expect(resolveRegion({ region: 'eu-west-1' }, makeTmp())).toBe('eu-west-1');
    });

    it('reads a plain app_name the same way for every consumer', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "billing-app"\n}\nresource "aws_ecr_repository" "app" {\n  name = "other-repo"\n}\n'
        );
        expect(resolveProjectName({}, dir)).toBe('billing-app');
    });
});

describe('resolveLogGroup', () => {
    it('prefers explicit flags, then env, then the project default', () => {
        const dir = makeTmp();
        expect(resolveLogGroup({ logGroup: '  /custom/group  ' }, dir)).toBe('/custom/group');
        expect(resolveLogGroup({ logGroupName: '/named/group' }, dir)).toBe('/named/group');
        process.env.ECS_LOG_GROUP = '/env/group';
        try {
            expect(resolveLogGroup({}, dir)).toBe('/env/group');
        } finally {
            delete process.env.ECS_LOG_GROUP;
        }
        expect(resolveLogGroup({ projectName: 'myapp' }, dir)).toBe('/ecs/myapp');
    });
});

describe('detectComputeTargetFromMainTf', () => {
    it('returns lambda when main.tf provisions the serverless function', () => {
        expect(detectComputeTargetFromMainTf('resource "aws_lambda_function" "app" {\n}')).toBe('lambda');
    });

    it('returns ecs for ECS content, empty, and non-string inputs', () => {
        expect(detectComputeTargetFromMainTf('resource "aws_ecs_service" "app" {}')).toBe('ecs');
        expect(detectComputeTargetFromMainTf('')).toBe('ecs');
        expect(detectComputeTargetFromMainTf(null)).toBe('ecs');
        expect(detectComputeTargetFromMainTf(undefined)).toBe('ecs');
    });
});

describe('readTerraformComputeTarget', () => {
    it('reads lambda from a lambda project and defaults to ecs when missing', () => {
        const lambdaDir = makeTmp();
        fs.mkdirSync(path.join(lambdaDir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(lambdaDir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "myapp${local.env_suffix}"\n}\nresource "aws_lambda_function" "app" {}\n'
        );
        expect(readTerraformComputeTarget(lambdaDir)).toBe('lambda');
        expect(readTerraformComputeTarget(makeTmp())).toBe('ecs');
    });
});

describe('resolveLogGroup lambda target', () => {
    it('defaults to the Lambda log group on lambda projects', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "myapp${local.env_suffix}"\n}\nresource "aws_lambda_function" "app" {}\n'
        );
        expect(resolveLogGroup({}, dir)).toBe('/aws/lambda/myapp-fn');
        expect(resolveLogGroup({ logGroup: '/custom/group' }, dir)).toBe('/custom/group');
    });
});

describe('resolveHeadless', () => {
    const tty = { isTTY: true };
    const noTty = {};

    it('returns true for explicit headless flags and CI/test envs', () => {
        expect(resolveHeadless({ isHeadless: true }, {}, tty, tty)).toBe(true);
        expect(resolveHeadless({ headless: true }, {}, tty, tty)).toBe(true);
        expect(resolveHeadless({}, { CI: 'true' }, tty, tty)).toBe(true);
        expect(resolveHeadless({}, { VITEST: 'true' }, tty, tty)).toBe(true);
        expect(resolveHeadless({}, { NODE_ENV: 'test' }, tty, tty)).toBe(true);
    });

    it('returns true when stdio is not a TTY', () => {
        expect(resolveHeadless({}, {}, noTty, tty)).toBe(true);
        expect(resolveHeadless({}, {}, tty, noTty)).toBe(true);
        expect(resolveHeadless({}, {}, undefined, undefined)).toBe(true);
    });

    it('returns false for real interactive terminals', () => {
        expect(resolveHeadless({}, {}, tty, tty)).toBe(false);
    });

    it('honors an explicit false override for simulated prompts', () => {
        expect(resolveHeadless({ isHeadless: false }, { CI: 'true', VITEST: 'true' }, noTty, noTty)).toBe(false);
        expect(resolveHeadless({ headless: false }, { NODE_ENV: 'test' }, noTty, noTty)).toBe(false);
    });
});

describe('resolveAppName', () => {
    it('combines the project name with the workspace suffix', () => {
        const dir = makeTmp();
        expect(resolveAppName('myapp', undefined, dir)).toBe('myapp');
        expect(resolveAppName('myapp', 'pr-7', dir)).toBe('myapp-pr-7');
        expect(resolveAppName('myapp', 'default', dir)).toBe('myapp');
    });

    it('auto-detects the workspace from .terraform/environment', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, '.terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.terraform', 'environment'), 'pr-42\n');
        expect(resolveAppName('myapp', undefined, dir)).toBe('myapp-pr-42');
    });
});

describe('resolveCwd', () => {
    it('prefers an explicit string cwd option', () => {
        expect(resolveCwd({ cwd: '/tmp/x' })).toBe('/tmp/x');
    });

    it('falls back to the process cwd for missing or non-string values', () => {
        expect(resolveCwd({})).toBe(process.cwd());
        expect(resolveCwd({ cwd: 42 })).toBe(process.cwd());
        expect(resolveCwd({ cwd: '' })).toBe(process.cwd());
        expect(resolveCwd(null)).toBe(process.cwd());
    });

    it('honors a usable positional fallback before the process cwd', () => {
        const dir = makeTmp();
        expect(resolveCwd({}, dir)).toBe(dir);
        expect(resolveCwd({ cwd: '/tmp/x' }, dir)).toBe('/tmp/x');
        expect(resolveCwd({ cwd: 42 }, dir)).toBe(dir);
        expect(resolveCwd(null, dir)).toBe(dir);
        expect(resolveCwd({}, 42)).toBe(process.cwd());
    });
});

describe('resolvers: fuzzer hardening', () => {
    const BAD_OPTIONS = [null, undefined, 'string', 42, true, { port: 'string' }];

    it.each(BAD_OPTIONS)('resolveProjectName(%s) behaves like {}', (bad) => {
        expect(resolveProjectName(bad)).toBe(resolveProjectName({}));
    });

    it.each(BAD_OPTIONS)('resolveRegion/resolveCluster/resolveService/resolveLogGroup(%s) behave like {}', (bad) => {
        expect(resolveRegion(bad)).toBe(resolveRegion({}));
        expect(resolveCluster(bad)).toBe(resolveCluster({}));
        expect(resolveService(bad)).toBe(resolveService({}));
        expect(resolveLogGroup(bad)).toBe(resolveLogGroup({}));
    });

    it('survives non-string cwd positions', () => {
        const dir = makeTmp();
        expect(resolveProjectName({}, 42)).toBe(resolveProjectName({}));
        expect(resolveProjectName({ cwd: 42 }, dir)).toBe(resolveProjectName({}, dir));
        expect(resolveRegion({}, 42)).toBe(resolveRegion({}));
        expect(resolveWorkspaceSuffix({}, 42)).toBe(resolveWorkspaceSuffix({}));
        expect(resolveWorkspaceSuffix({ cwd: 42 }, dir)).toBe('');
        expect(readTerraformRegion(42)).toBe(readTerraformRegion());
        expect(readTerraformProjectName(42)).toBe(readTerraformProjectName());
    });

    it('resolveHeadless and resolveAppName coerce synthetic inputs', () => {
        const dir = makeTmp();
        expect(typeof resolveHeadless(null)).toBe('boolean');
        expect(typeof resolveHeadless('string')).toBe('boolean');
        expect(resolveAppName(42, 42, dir)).toBe('42');
        expect(resolveAppName(null, null, dir)).toBe('null');
    });

    it('readFileSafe returns null for unusable paths', () => {
        expect(readFileSafe(42)).toBeNull();
        expect(readFileSafe(null)).toBeNull();
        expect(readFileSafe({})).toBeNull();
    });
});

describe('resource suffix (collision-resistant naming)', () => {
    function writeMainTf(dir, suffix) {
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            `locals {\n  grada_resource_suffix = "${suffix}"\n  app_name = "myapp\${local.env_suffix}\${local.grada_resource_suffix}"\n}\n`
        );
    }

    it('reads a minted suffix and rejects anything else', () => {
        const dir = makeTmp();
        writeMainTf(dir, '-a1b2c3');
        expect(readResourceSuffix(dir)).toBe('-a1b2c3');

        for (const bad of ['', 'xyz', '-A1B2C3', '-abc', '-a1b2c3d', 'a1b2c3']) {
            const other = makeTmp();
            writeMainTf(other, bad);
            expect(readResourceSuffix(other)).toBe('');
        }
        expect(readResourceSuffix(makeTmp())).toBe('');
    });

    it('readTerraformProjectName returns the bare name on suffixed trees', () => {
        const dir = makeTmp();
        writeMainTf(dir, '-a1b2c3');
        expect(readTerraformProjectName(dir)).toBe('myapp');
        expect(resolveProjectName({}, dir)).toBe('myapp');
    });

    it('cluster, service, and log group carry the suffix; unsuffixed trees are unchanged', () => {
        const suffixed = makeTmp();
        writeMainTf(suffixed, '-a1b2c3');
        expect(resolveCluster({ projectName: 'myapp' }, suffixed)).toBe('myapp-a1b2c3-cluster');
        expect(resolveService({ projectName: 'myapp' }, suffixed)).toBe('myapp-a1b2c3-service');
        expect(resolveLogGroup({ projectName: 'myapp' }, suffixed)).toBe('/ecs/myapp-a1b2c3');

        const plain = makeTmp();
        fs.mkdirSync(path.join(plain, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(plain, 'terraform', 'main.tf'), 'locals {\n  app_name = "myapp${local.env_suffix}"\n}\n');
        expect(resolveCluster({ projectName: 'myapp' }, plain)).toBe('myapp-cluster');
        expect(resolveService({ projectName: 'myapp' }, plain)).toBe('myapp-service');
        expect(resolveLogGroup({ projectName: 'myapp' }, plain)).toBe('/ecs/myapp');
    });

    it('explicit cluster/service/log-group overrides win over the suffix', () => {
        const dir = makeTmp();
        writeMainTf(dir, '-a1b2c3');
        expect(resolveCluster({ cluster: 'custom' }, dir)).toBe('custom');
        expect(resolveService({ service: 'custom' }, dir)).toBe('custom');
        expect(resolveLogGroup({ logGroup: '/custom' }, dir)).toBe('/custom');
    });

    it('workspace suffix stays ahead of the resource suffix', () => {
        const dir = makeTmp();
        writeMainTf(dir, '-a1b2c3');
        fs.mkdirSync(path.join(dir, '.terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.terraform', 'environment'), 'staging');
        expect(resolveCluster({ projectName: 'myapp-staging' }, dir)).toBe('myapp-staging-a1b2c3-cluster');
    });
});
