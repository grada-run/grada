import { SecretsManagerClient, UpdateSecretCommand, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import dotenv from "dotenv";
import fs from 'fs/promises';
import { spinner, confirm, outro, isCancel } from '@clack/prompts';
import color from 'picocolors';
import path from 'path';
import { trackEvent, flushTelemetry, trackSuccess, trackFailure } from '../core/telemetry.js';
import { failCommand } from '../utils/command.js';
import { handleAuthErrorBranch, resolveClient } from '../utils/aws.js';
import { readTerraformComputeTarget, guardComputeTarget } from '../utils/resolvers.js';

// Static sites provision no secrets vault, so push/pull/audit would fail
// obscurely against a Secrets Manager secret that can never exist. One
// shared guard keeps the three entry points consistent.
function secretsTargetGuard(subcommand) {
    return guardComputeTarget({
        cwd: process.cwd(),
        command: `secrets ${subcommand}`,
        supported: ['ecs', 'lambda'],
        hint: 'Static sites provision no secrets vault — static sites needing secrets need an API backend.',
    });
}

function failUnsupportedTarget(guard, event, projectName) {
    return failCommand({
        message: guard.message,
        hint: guard.hint,
        event,
        telemetry: { projectName },
        errorCode: guard.errorCode,
        reason: guard.reason,
    });
}

function resolveSecretsFile(envFilePath) {
    let resolvedFilePath = (typeof envFilePath === 'string' && envFilePath.trim())
        ? envFilePath.trim()
        : '.env';
    if (!resolvedFilePath.includes('.env') && !resolvedFilePath.includes('txt') && !resolvedFilePath.includes('json')) {
        console.log(color.yellow(`⚠️  Warning: "${resolvedFilePath}" does not look like a standard secrets file. Defaulting to ".env"`));
        resolvedFilePath = '.env';
    }
    return resolvedFilePath;
}

function resolveSecretsProject(projectName) {
    return (typeof projectName === 'string' && projectName.trim())
        ? projectName.trim()
        : path.basename(process.cwd());
}

export async function resolveSecretsRegion(options = {}) {
    const fromOptions = typeof options.region === 'string' ? options.region.trim() : '';
    if (fromOptions) return fromOptions;
    for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION']) {
        const value = typeof process.env[key] === 'string' ? process.env[key].trim() : '';
        if (value) return value;
    }
    try {
        const backendTfPath = path.join(process.cwd(), 'terraform', 'backend.tf');
        const backendTfContent = await fs.readFile(backendTfPath, 'utf-8');
        const regionMatch = backendTfContent.match(/region\s*=\s*"([^"]+)"/);
        if (regionMatch && !regionMatch[1].includes('{{')) {
            return regionMatch[1];
        }
    } catch {
        // Fall through to the product default region if the file is missing or unreadable
    }
    return 'us-east-2';
}

function escapeEnvValue(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function serializeEnv(orderedKeys, values) {
    return orderedKeys.map((key) => `${key}="${escapeEnvValue(values[key])}"`).join('\n') + '\n';
}

function normalizeSecretsArgs(projectName, options) {
    // Supports (file, project, opts) and (file, opts) call shapes.
    if (projectName !== null && typeof projectName === 'object' && !Array.isArray(projectName)) {
        return { projectName: undefined, options: projectName };
    }
    return { projectName, options: options && typeof options === 'object' ? options : {} };
}

function resolvePullAuditArgs(projectName, options) {
    const normalized = normalizeSecretsArgs(projectName, options);
    return {
        resolvedProjectName: resolveSecretsProject(normalized.projectName),
        opts: normalized.options,
    };
}

export function diffSecretsEnvs(localSecrets = {}, remoteSecrets = {}) {
    const missingLocally = Object.keys(remoteSecrets).filter((k) => !(k in localSecrets));
    const untrackedLocally = Object.keys(localSecrets).filter((k) => !(k in remoteSecrets));
    const mismatched = Object.keys(remoteSecrets).filter(
        (k) => k in localSecrets && String(localSecrets[k]) !== String(remoteSecrets[k])
    );
    return { missingLocally, mismatched, untrackedLocally };
}

export function resolveEcsCluster(projectName, options = {}) {
    if (typeof options.cluster === 'string' && options.cluster.trim()) return options.cluster.trim();
    if (typeof process.env.ECS_CLUSTER === 'string' && process.env.ECS_CLUSTER.trim()) {
        return process.env.ECS_CLUSTER.trim();
    }
    return `${projectName}-cluster`;
}

export function resolveEcsService(projectName, options = {}) {
    for (const key of ['service', 'serviceName']) {
        if (typeof options[key] === 'string' && options[key].trim()) return options[key].trim();
    }
    if (typeof process.env.ECS_SERVICE === 'string' && process.env.ECS_SERVICE.trim()) {
        return process.env.ECS_SERVICE.trim();
    }
    return `${projectName}-service`;
}

export async function pushSecrets(envFilePath, projectName, options = {}) {
    const pushGuard = secretsTargetGuard('push');
    if (pushGuard) {
        return failUnsupportedTarget(pushGuard, 'secrets_pushed', typeof projectName === 'string' ? projectName : path.basename(process.cwd()));
    }
    const normalized = normalizeSecretsArgs(projectName, options);
    const opts = normalized.options;
    const explicitProjectName = normalized.projectName;
    // Ensure envFilePath is a valid string, defaulting to '.env' if undefined or an object
    let resolvedFilePath = (typeof envFilePath === 'string' && envFilePath.trim())
        ? envFilePath.trim()
        : '.env';

    // Guard against CI injection bugs where "event" or "push" gets passed as the file name
    if (!resolvedFilePath.includes('.env') && !resolvedFilePath.includes('txt') && !resolvedFilePath.includes('json')) {
        console.log(color.yellow(`⚠️  Warning: "${resolvedFilePath}" does not look like a standard secrets file. Defaulting to ".env"`));
        resolvedFilePath = '.env';
    }

    const resolvedProjectName = (typeof explicitProjectName === 'string' && explicitProjectName.trim())
        ? explicitProjectName.trim()
        : path.basename(process.cwd());

    const s = spinner();
    s.start(`Reading ${envFilePath} and pushing to AWS Secrets Manager...`);

    try {
        // 1. Read and parse the local .env file
        const envPath = path.resolve(process.cwd(), resolvedFilePath);
        let envContent;
        try {
            envContent = await fs.readFile(envPath, 'utf-8');
        } catch (fsError) {
            if (fsError.code !== 'ENOENT') throw fsError;
            s.stop('No .env file found.');
            if (opts.isHeadless || process.env.CI) {
                return failCommand({
                    message: 'No .env file found. In automated environments, please ensure the file is generated before running secrets push.',
                    event: 'secrets_pushed',
                    telemetry: {
                        projectName: resolvedProjectName,
                        error_code: 'ENV_FILE_MISSING',
                        reason: 'missing_env_headless',
                    },
                });
            }
            const confirmed = await confirm({
                message: `Would you like to create an empty ${resolvedFilePath} file now to get started?`,
            });
            if (isCancel(confirmed)) {
                console.log(color.dim('Secrets push cancelled. No file was created.'));
                return;
            }
            if (confirmed) {
                await fs.mkdir(path.dirname(envPath), { recursive: true });
                await fs.writeFile(envPath, '# Add your environment variables here\n');
                console.log(color.green(`Created empty ${resolvedFilePath}. Add your variables to it, then re-run secrets push.`));
                await trackFailure('secrets_pushed', {
                    projectName: resolvedProjectName,
                    reason: 'created_empty_file',
                });
                return;
            }
            console.log(color.dim('Secrets push cancelled. No file was created.'));
            return;
        }

        const parsedSecrets = dotenv.parse(envContent);

        if (Object.keys(parsedSecrets).length === 0) {
            s.stop('No secrets found in file.');
            return;
        }

        // 2. Resolve the region (explicit flag > env > backend.tf > default)
        // so the AWS client is never constructed without one.
        const targetRegion = await resolveSecretsRegion(opts);

        // 3. Initialize the AWS Client locked to the correct region
        const client = resolveClient(opts.client, SecretsManagerClient, targetRegion ? { region: targetRegion } : {});

        // 4. Fetch the existing secret payload to detect key changes (safe on new vaults)
        let existingKeys = null;
        try {
            const existingResp = await client.send(new GetSecretValueCommand({
                SecretId: `${resolvedProjectName}-secrets`,
            }));
            if (existingResp.SecretString) {
                try {
                    existingKeys = Object.keys(JSON.parse(existingResp.SecretString));
                } catch {
                    existingKeys = [];
                }
            } else {
                existingKeys = [];
            }
        } catch (fetchError) {
            if (fetchError && fetchError.name === 'ResourceNotFoundException') {
                existingKeys = [];
            } else {
                throw fetchError;
            }
        }

        // 5. Update the secret string in AWS
        const command = new UpdateSecretCommand({
            SecretId: `${resolvedProjectName}-secrets`,
            SecretString: JSON.stringify(parsedSecrets),
        });

        await client.send(command);

        const keys = Object.keys(parsedSecrets);
        const keysFilePath = path.join(process.cwd(), 'terraform', 'secret_keys.json');

        await fs.writeFile(keysFilePath, JSON.stringify(keys, null, 2));

        s.stop(`✅ Successfully pushed ${Object.keys(parsedSecrets).length} secrets to AWS (${targetRegion || 'default region'})!`);

        const sortedExisting = [...(existingKeys ?? [])].sort();
        const sortedNew = [...keys].sort();
        const keysChanged = sortedExisting.length !== sortedNew.length
            || sortedExisting.some((key, index) => key !== sortedNew[index]);

        if (keysChanged) {
            console.log(color.cyan(`\nUpdated ${keysFilePath}`));
            console.log(color.green('Commit this file and push to GitHub to trigger a deployment with your new variables.'));
        } else {
            console.log(color.cyan(`\nUpdated ${keysFilePath}`));
            // Lambda functions read secrets at invocation time, so new values
            // apply to fresh execution environments with no restart to trigger.
            if (readTerraformComputeTarget(process.cwd()) === 'lambda') {
                console.log(color.dim('Lambda target detected: new secret values apply to fresh invocations automatically — no restart needed.'));
                console.log(color.blue(`\n📘 Learn how secrets reach your app: ${color.underline('https://github.com/grada-run/grada/blob/main/apps/docs/src/content/docs/guides/secrets-management.md')}`));
                await trackSuccess('secrets_pushed', {
                    projectName: resolvedProjectName,
                    secret_count: Object.keys(parsedSecrets).length,
                    keys_changed: false,
                    ecs_restart: false
                });
                return { keysChanged: false, restarted: false };
            }
            const shouldRestart = await confirm({
                message: 'Keys are unchanged. Trigger a rolling ECS restart to apply new values immediately?',
                initialValue: false,
            });
            if (shouldRestart) {
                const cluster = resolveEcsCluster(resolvedProjectName, opts);
                const service = resolveEcsService(resolvedProjectName, opts);
                const ecsClient = resolveClient(opts.ecsClient ?? opts.ecs, ECSClient, targetRegion ? { region: targetRegion } : {});
                const restartSpinner = spinner();
                restartSpinner.start('Triggering rolling ECS restart...');
                try {
                    await ecsClient.send(new UpdateServiceCommand({
                        cluster,
                        service,
                        forceNewDeployment: true,
                    }));
                    restartSpinner.stop('✅ ECS rolling restart triggered.');
                    outro(`Rolling restart initiated for ${service} in ${cluster}. ECS will roll tasks with the new secret values.`);
                } catch (ecsError) {
                    restartSpinner.stop(`❌ Failed to trigger ECS restart: ${ecsError.message}`);
                    throw ecsError;
                }
                await trackSuccess('secrets_pushed', {
                    projectName: resolvedProjectName,
                    secret_count: Object.keys(parsedSecrets).length,
                    keys_changed: false,
                    ecs_restart: true
                });
                console.log(color.blue(`\n📘 Learn how secrets reach your app: ${color.underline('https://github.com/grada-run/grada/blob/main/apps/docs/src/content/docs/guides/secrets-management.md')}`));
                return { keysChanged: false, restarted: true, cluster, service };
            }
        }
        console.log(color.blue(`\n📘 Learn how secrets reach your app: ${color.underline('https://github.com/grada-run/grada/blob/main/apps/docs/src/content/docs/guides/secrets-management.md')}`));

        await trackSuccess('secrets_pushed', {
            projectName: resolvedProjectName,
            secret_count: Object.keys(parsedSecrets).length,
            keys_changed: keysChanged
        });
        return { keysChanged };

    } catch (error) {
        await trackFailure('secrets_pushed', {
            projectName: resolvedProjectName,
            error_code: error.code || error.name || 'UNKNOWN',
            error_message: error.message,
            stack_trace: error.name === 'TypeError' ? error.stack : undefined
        });
        if (error.name === 'ResourceNotFoundException') {
            s.stop(color.red(`❌ Secrets Vault "${resolvedProjectName}-secrets" does not exist in AWS yet.`));
            console.log(color.yellow('\n💡 Next Step:'));
            console.log(`Run ${color.cyan('npx --yes grada-run apply')} first to provision the infrastructure and Secrets Manager vault.`);
            console.log(`Once applied, run ${color.cyan(`npx grada-run secrets push ${resolvedFilePath}`)} to upload your environment variables.\n`);
        } else if (handleAuthErrorBranch(error, s, opts)) {
            return;
        } else {
            s.stop(`❌ Failed to push secrets: ${error.message}`);
        }

        return failCommand({ exitCode: 1 });
    }
}

export async function pullSecrets(envFilePath, projectName, options = {}) {
    const pullGuard = secretsTargetGuard('pull');
    if (pullGuard) {
        return failUnsupportedTarget(pullGuard, 'secrets_pull', typeof projectName === 'string' ? projectName : path.basename(process.cwd()));
    }
    const { resolvedProjectName, opts } = resolvePullAuditArgs(projectName, options);
    const resolvedFilePath = resolveSecretsFile(envFilePath);
    const { isHeadless = false, client: injectedClient } = opts;

    const s = spinner();
    s.start('Fetching secrets from AWS...');

    try {
        const targetRegion = await resolveSecretsRegion(opts);
        const client = resolveClient(injectedClient, SecretsManagerClient, targetRegion ? { region: targetRegion } : {});

        const resp = await client.send(new GetSecretValueCommand({
            SecretId: `${resolvedProjectName}-secrets`,
        }));

        let remoteSecrets = {};
        if (resp.SecretString) {
            try {
                remoteSecrets = JSON.parse(resp.SecretString);
            } catch {
                const jsonError = new Error('Remote secret payload is not valid JSON.');
                jsonError.code = 'REMOTE_SECRET_MALFORMED';
                throw jsonError;
            }
        }
        const remoteKeys = Object.keys(remoteSecrets);
        s.stop('Remote secrets fetched.');

        const envPath = path.resolve(process.cwd(), resolvedFilePath);
        let localSecrets = {};
        let localExists = true;
        try {
            const envContent = await fs.readFile(envPath, 'utf-8');
            localSecrets = dotenv.parse(envContent);
        } catch (fsError) {
            if (fsError.code === 'ENOENT') {
                localExists = false;
                localSecrets = {};
            } else {
                throw fsError;
            }
        }

        const { mismatched } = diffSecretsEnvs(localSecrets, remoteSecrets);
        let overwrite = true;
        if (localExists && mismatched.length > 0) {
            if (isHeadless) {
                overwrite = true;
            } else {
                const answer = await confirm({
                    message: 'Conflicting variables found. Overwrite local values with remote?',
                    initialValue: false,
                });
                overwrite = answer === true;
            }
        }

        const merged = { ...localSecrets };
        for (const [key, value] of Object.entries(remoteSecrets)) {
            if (!(key in merged) || overwrite) {
                merged[key] = String(value);
            }
        }

        const orderedKeys = [
            ...Object.keys(localSecrets),
            ...remoteKeys.filter((k) => !(k in localSecrets)),
        ];
        await fs.writeFile(envPath, serializeEnv(orderedKeys, merged));

        outro(`Successfully synced ${remoteKeys.length} secrets to ${resolvedFilePath}`);

        trackEvent('secrets_pull', {
            projectName: resolvedProjectName,
            variablesCount: remoteKeys.length,
        });
        await flushTelemetry();

        return { synced: remoteKeys.length, file: resolvedFilePath, overwritten: overwrite, conflicts: mismatched };
    } catch (error) {
        await trackFailure('secrets_pull', {
            projectName: resolvedProjectName,
            error_code: error.code || error.name || 'UNKNOWN',
            error_message: error.message,
        });
        if (error.name === 'ResourceNotFoundException') {
            s.stop(color.red(`❌ No remote secrets found for "${resolvedProjectName}-secrets".`));
            console.log(color.yellow('\n💡 Next Step:'));
            console.log(`Run ${color.cyan(`npx grada-run secrets push ${resolvedFilePath}`)} first to upload your environment variables.\n`);
        } else if (handleAuthErrorBranch(error, s, opts)) {
            return;
        } else {
            s.stop(`❌ Failed to pull secrets: ${error.message}`);
        }

        return failCommand({ exitCode: 1 });
    }
}

export async function auditSecrets(envFilePath, projectName, options = {}) {
    const auditGuard = secretsTargetGuard('audit');
    if (auditGuard) {
        return failUnsupportedTarget(auditGuard, 'secrets_audit', typeof projectName === 'string' ? projectName : path.basename(process.cwd()));
    }
    const { resolvedProjectName, opts } = resolvePullAuditArgs(projectName, options);
    const resolvedFilePath = resolveSecretsFile(envFilePath);
    const { client: injectedClient } = opts;

    const s = spinner();
    s.start('Auditing local environment against AWS...');

    try {
        const targetRegion = await resolveSecretsRegion(opts);
        const client = resolveClient(injectedClient, SecretsManagerClient, targetRegion ? { region: targetRegion } : {});

        const resp = await client.send(new GetSecretValueCommand({
            SecretId: `${resolvedProjectName}-secrets`,
        }));

        let remoteSecrets = {};
        if (resp.SecretString) {
            try {
                remoteSecrets = JSON.parse(resp.SecretString);
            } catch {
                const jsonError = new Error('Remote secret payload is not valid JSON.');
                jsonError.code = 'REMOTE_SECRET_MALFORMED';
                throw jsonError;
            }
        }

        const envPath = path.resolve(process.cwd(), resolvedFilePath);
        let localSecrets = {};
        try {
            const envContent = await fs.readFile(envPath, 'utf-8');
            localSecrets = dotenv.parse(envContent);
        } catch (fsError) {
            if (fsError.code !== 'ENOENT') throw fsError;
            localSecrets = {};
        }

        s.stop('Audit complete.');

        const { missingLocally, mismatched, untrackedLocally } = diffSecretsEnvs(localSecrets, remoteSecrets);
        const driftCount = missingLocally.length + mismatched.length + untrackedLocally.length;

        if (driftCount === 0) {
            console.log(color.green('No drift detected. Local and remote secrets are in sync.'));
        } else {
            for (const key of missingLocally) {
                console.log(color.green(`+ ${key} (Missing locally)`));
            }
            for (const key of mismatched) {
                console.log(color.yellow(`~ ${key} (Mismatched value)`));
            }
            for (const key of untrackedLocally) {
                console.log(color.dim(`- ${key} (Not tracked in AWS)`));
            }
        }

        outro(`Audit complete. ${driftCount} drifted variable(s) found.`);

        trackEvent('secrets_audit', {
            projectName: resolvedProjectName,
            driftCount,
        });
        await flushTelemetry();

        return { missingLocally, mismatched, untrackedLocally, driftCount };
    } catch (error) {
        await trackFailure('secrets_audit', {
            projectName: resolvedProjectName,
            error_code: error.code || error.name || 'UNKNOWN',
            error_message: error.message,
        });
        if (error.name === 'ResourceNotFoundException') {
            s.stop(color.red(`❌ No remote secrets found for "${resolvedProjectName}-secrets".`));
            console.log(color.yellow('\n💡 Next Step:'));
            console.log(`Run ${color.cyan(`npx grada-run secrets push ${resolvedFilePath}`)} first to upload your environment variables.\n`);
        } else if (handleAuthErrorBranch(error, s, opts)) {
            return;
        } else {
            s.stop(`❌ Failed to audit secrets: ${error.message}`);
        }

        return failCommand({ exitCode: 1 });
    }
}