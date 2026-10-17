import { SecretsManagerClient, UpdateSecretCommand, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import dotenv from "dotenv";
import fs from 'fs/promises';
import { spinner, confirm, outro, isCancel } from '@clack/prompts';
import color from 'picocolors';
import path from 'path';
import { trackEvent, flushTelemetry, trackSuccess, trackFailure, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { failCommand, refuseIfNonInteractive } from '../utils/command.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { handleAuthErrorBranch, resolveClient } from '../utils/aws.js';
import { readTerraformComputeTarget, guardComputeTarget, readResourceSuffix } from '../utils/resolvers.js';
import { requireManagedTree } from '../utils/terraform-metadata.js';

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

// Ejected trees are user-owned: push/pull/audit refuse unless --force.
// Returns the refusal result, or null when the caller may proceed.
async function secretsManagedTreeGuard(subcommand, event, projectName, options = {}) {
    const managedTree = await requireManagedTree({
        cwd: process.cwd(),
        command: `secrets ${subcommand}`,
        options,
        event,
        projectName: resolveSecretsProject(projectName),
    });
    if (!managedTree.proceed) return managedTree.result;
    return null;
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

// Vault identifiers carry the tree's resource suffix (matching the
// Terraform secret name); telemetry keeps the bare project name.
function secretVaultId(projectName) {
    return `${projectName}${readResourceSuffix()}-secrets`;
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

// Quote one value so `dotenv.parse` reads it back byte-identical. Plain
// values keep the legacy double-quote style; values holding a double
// quote switch to a literal style (single or backtick) because dotenv
// keeps `\"` verbatim instead of unescaping it. Returns null when no
// style round-trips — the caller must refuse to write rather than
// corrupt the file.
export function quoteEnvValue(value) {
    const text = String(value ?? '');
    const hasSingle = text.includes("'");
    const hasDouble = text.includes('"');
    const hasBacktick = text.includes('`');
    if (hasDouble) {
        if (hasSingle && hasBacktick) return null;
        if (hasSingle) return `\`${text}\``;
        return `'${text}'`;
    }
    if (hasSingle) {
        // Literal backslash-n/r sequences are indistinguishable from escaped
        // newlines inside double quotes, so they force the literal styles.
        if (/\\[nr]/.test(text)) return hasBacktick ? null : `\`${text}\``;
        return `"${text.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
    }
    if (text.includes('\\')) return `'${text}'`;
    return `"${text.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

function serializeEnv(orderedKeys, values) {
    return orderedKeys.map((key) => `${key}=${quoteEnvValue(values[key])}`).join('\n') + '\n';
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
    // Own-property checks: `in` matches inherited names (toString,
    // __proto__), which would misclassify real vault keys.
    const missingLocally = Object.keys(remoteSecrets).filter((k) => !Object.hasOwn(localSecrets, k));
    const untrackedLocally = Object.keys(localSecrets).filter((k) => !Object.hasOwn(remoteSecrets, k));
    const mismatched = Object.keys(remoteSecrets).filter(
        (k) => Object.hasOwn(localSecrets, k) && String(localSecrets[k]) !== String(remoteSecrets[k])
    );
    return { missingLocally, mismatched, untrackedLocally };
}

// Shared failure tail for push/pull/audit: identical telemetry stamps,
// not-found guidance, auth branch, and spinner/exit routing, so the
// three subcommands cannot drift apart again.
async function handleSecretsCatch({
    error,
    event,
    verb,
    s,
    opts,
    projectName,
    notFoundMessage,
    notFoundGuidance,
    spinnerStopped = false,
    stackTraceOnTypeError = false,
}) {
    await trackFailure(event, {
        projectName,
        error_code: error.code || error.name || 'UNKNOWN',
        error_message: error.message,
        ...(stackTraceOnTypeError ? { stack_trace: error.name === 'TypeError' ? error.stack : undefined } : {}),
    });
    if (error.name === 'ResourceNotFoundException') {
        s.stop(color.red(notFoundMessage));
        console.log(color.yellow('\n💡 Next Step:'));
        for (const line of notFoundGuidance) console.log(line);
    } else if (handleAuthErrorBranch(error, s, opts)) {
        return;
    } else if (spinnerStopped) {
        // The spinner already stopped, so its stop is a no-op —
        // route the message through the failure stamp instead.
        return failCommand({ message: `❌ Failed to ${verb} secrets: ${error.message}`, exitCode: 1 });
    } else {
        s.stop(`❌ Failed to ${verb} secrets: ${error.message}`);
    }

    return failCommand({ exitCode: 1 });
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

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function pushSecrets(envFilePath, projectName, options = {}) {
    setActiveCommandName('secrets_push');
    try {
        return await pushSecretsMain(envFilePath, projectName, options);
    } finally {
        resetActiveCommandName();
    }
}

async function pushSecretsMain(envFilePath, projectName, options = {}) {
    const refused = await secretsManagedTreeGuard('push', 'secrets_pushed', projectName, options);
    if (refused) return refused;
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
            const refused = await refuseIfNonInteractive(opts, {
                message: `\n✖ secrets push needs an .env file before pushing.`,
                hint: '  Generate the .env file before pushing, or run interactively to create an empty one.\n',
                event: 'secrets_pushed',
                telemetry: { projectName: resolvedProjectName },
                errorCode: 'SECRETS_NON_INTERACTIVE',
            });
            if (refused) return refused;
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
                SecretId: `${secretVaultId(resolvedProjectName)}`,
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
            SecretId: `${secretVaultId(resolvedProjectName)}`,
            SecretString: JSON.stringify(parsedSecrets),
        });

        await client.send(command);

        const keys = Object.keys(parsedSecrets);
        const keysFilePath = path.join(process.cwd(), 'terraform', 'secret_keys.json');

        await atomicWriteFile(keysFilePath, JSON.stringify(keys, null, 2));

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
            // Automated runs cannot answer prompts: skip the restart (fresh
            // deploys pick up the values) instead of hanging on confirm.
            if (opts.isHeadless || process.env.CI) {
                console.log(color.dim('Headless environment detected: skipping the ECS restart prompt — new values apply on the next deployment or restart.'));
                console.log(color.blue(`\n📘 Learn how secrets reach your app: ${color.underline('https://github.com/grada-run/grada/blob/main/apps/docs/src/content/docs/guides/secrets-management.md')}`));
                await trackSuccess('secrets_pushed', {
                    projectName: resolvedProjectName,
                    secret_count: Object.keys(parsedSecrets).length,
                    keys_changed: false,
                    ecs_restart: false
                });
                return { keysChanged: false, restarted: false };
            }
            const refused = await refuseIfNonInteractive(opts, {
                message: `\n✖ secrets push needs approval before triggering the ECS restart.`,
                hint: '  Re-run with --headless to skip the restart non-interactively (values apply on the next deployment), or run interactively to decide.\n',
                event: 'secrets_pushed',
                telemetry: { projectName: resolvedProjectName },
                errorCode: 'SECRETS_NON_INTERACTIVE',
            });
            if (refused) return refused;
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
        return handleSecretsCatch({
            error,
            event: 'secrets_pushed',
            verb: 'push',
            s,
            opts,
            projectName: resolvedProjectName,
            notFoundMessage: `❌ Secrets Vault "${secretVaultId(resolvedProjectName)}" does not exist in AWS yet.`,
            notFoundGuidance: [
                `Run ${color.cyan('npx --yes grada-run apply')} first to provision the infrastructure and Secrets Manager vault.`,
                `Once applied, run ${color.cyan(`npx grada-run secrets push ${resolvedFilePath}`)} to upload your environment variables.\n`,
            ],
            stackTraceOnTypeError: true,
        });
    }
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function pullSecrets(envFilePath, projectName, options = {}) {
    setActiveCommandName('secrets_pull');
    try {
        return await pullSecretsMain(envFilePath, projectName, options);
    } finally {
        resetActiveCommandName();
    }
}

async function pullSecretsMain(envFilePath, projectName, options = {}) {
    const refused = await secretsManagedTreeGuard('pull', 'secrets_pull', projectName, options);
    if (refused) return refused;
    const pullGuard = secretsTargetGuard('pull');
    if (pullGuard) {
        return failUnsupportedTarget(pullGuard, 'secrets_pull', typeof projectName === 'string' ? projectName : path.basename(process.cwd()));
    }
    const { resolvedProjectName, opts } = resolvePullAuditArgs(projectName, options);
    const resolvedFilePath = resolveSecretsFile(envFilePath);
    const { isHeadless = false, client: injectedClient } = opts;

    const s = spinner();
    s.start('Fetching secrets from AWS...');
    let remoteFetched = false;

    try {
        const targetRegion = await resolveSecretsRegion(opts);
        const client = resolveClient(injectedClient, SecretsManagerClient, targetRegion ? { region: targetRegion } : {});

        const resp = await client.send(new GetSecretValueCommand({
            SecretId: `${secretVaultId(resolvedProjectName)}`,
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
        remoteFetched = true;

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
                const refused = await refuseIfNonInteractive(opts, {
                    message: `\n✖ secrets pull needs approval before overwriting local values.`,
                    hint: '  Re-run with --headless to overwrite non-interactively, or run interactively to review conflicts.\n',
                    event: 'secrets_pull',
                    telemetry: { projectName: resolvedProjectName },
                    errorCode: 'SECRETS_NON_INTERACTIVE',
                });
                if (refused) return refused;
                const answer = await confirm({
                    message: 'Conflicting variables found. Overwrite local values with remote?',
                    initialValue: false,
                });
                overwrite = answer === true;
            }
        }

        // Null-prototype map: a `__proto__` vault key lands as an own data
        // property instead of mutating the merge target's prototype.
        const merged = Object.assign(Object.create(null), localSecrets);
        for (const [key, value] of Object.entries(remoteSecrets)) {
            if (!Object.hasOwn(merged, key) || overwrite) {
                merged[key] = String(value);
            }
        }

        const orderedKeys = [
            ...Object.keys(localSecrets),
            ...remoteKeys.filter((k) => !Object.hasOwn(localSecrets, k)),
        ];
        const unrepresentable = orderedKeys.filter((key) =>
            key === '__proto__' || quoteEnvValue(merged[key]) === null
        );
        if (unrepresentable.length > 0) {
            const abort = new Error(
                `Refusing to write ${resolvedFilePath}: ${unrepresentable.length} entr${unrepresentable.length === 1 ? 'y' : 'ies'} ` +
                `cannot round-trip through .env quoting (${unrepresentable.join(', ')}). ` +
                'Rename or re-encode them in the vault and retry.'
            );
            abort.code = 'SECRETS_PULL_UNREPRESENTABLE_VALUE';
            throw abort;
        }
        await fs.writeFile(envPath, serializeEnv(orderedKeys, merged));

        outro(`Successfully synced ${remoteKeys.length} secrets to ${resolvedFilePath}`);

        trackEvent('secrets_pull', {
            projectName: resolvedProjectName,
            variablesCount: remoteKeys.length,
        });
        await flushTelemetry();

        return { synced: remoteKeys.length, file: resolvedFilePath, overwritten: overwrite, conflicts: mismatched };
    } catch (error) {
        return handleSecretsCatch({
            error,
            event: 'secrets_pull',
            verb: 'pull',
            s,
            opts,
            projectName: resolvedProjectName,
            notFoundMessage: `❌ No remote secrets found for "${secretVaultId(resolvedProjectName)}".`,
            notFoundGuidance: [
                `Run ${color.cyan(`npx grada-run secrets push ${resolvedFilePath}`)} first to upload your environment variables.\n`,
            ],
            spinnerStopped: remoteFetched,
        });
    }
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function auditSecrets(envFilePath, projectName, options = {}) {
    setActiveCommandName('secrets_audit');
    try {
        return await auditSecretsMain(envFilePath, projectName, options);
    } finally {
        resetActiveCommandName();
    }
}

async function auditSecretsMain(envFilePath, projectName, options = {}) {
    const refused = await secretsManagedTreeGuard('audit', 'secrets_audit', projectName, options);
    if (refused) return refused;
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
            SecretId: `${secretVaultId(resolvedProjectName)}`,
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
        return handleSecretsCatch({
            error,
            event: 'secrets_audit',
            verb: 'audit',
            s,
            opts,
            projectName: resolvedProjectName,
            notFoundMessage: `❌ No remote secrets found for "${secretVaultId(resolvedProjectName)}".`,
            notFoundGuidance: [
                `Run ${color.cyan(`npx grada-run secrets push ${resolvedFilePath}`)} first to upload your environment variables.\n`,
            ],
        });
    }
}