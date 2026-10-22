import fs from 'fs';
import path from 'path';
import { intro, outro, confirm, spinner, cancel } from '@clack/prompts';
import color from 'picocolors';
import { trackEvent, flushTelemetry, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { failCommand, refuseIfNonInteractive, refuseUnknownFlags, shouldAutoApprove } from '../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import {
    stripTerraformMetadata,
    stripGitignoreMetadata,
    writeEjectedMarker,
    writeEjectedSentinel,
    parseStateBucketBackend,
} from '../utils/terraform-metadata.js';
import { readSleepState, writeSleepState, LEDGER_LOCK_SCOPE } from '../utils/sleep-state.js';
import { ensureGitignoreRules, GITIGNORE_RULE_GRADA_DIR } from '../utils/gitignore.js';
import { withProjectLock } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { runWake } from './wake.js';

export function parseEjectArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'eject') args.shift();
    const { options, unknown } = parseFlags(args, { boolean: ['force'] });
    if (unknown.length > 0) options.unknownFlags = unknown;
    return { force: false, ...options };
}

// Re-exported so existing importers (tests) keep working unchanged.
export { stripTerraformMetadata, stripGitignoreMetadata };

// Grada's own backups are exactly `<name>.bak.<Date.now()>` — match that
// shape only so user files merely containing `.bak.` survive the purge.
export function isGradaBackupName(fileName) {
    return /^.+\.bak\.\d+$/.test(String(fileName ?? ''));
}

function collectTerraformFiles(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) collectTerraformFiles(fullPath, out);
        else if (entry.isFile() && entry.name.endsWith('.tf')) out.push(fullPath);
    }
    return out;
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function ejectStack(input = {}) {
    setActiveCommandName('eject');
    try {
        return await ejectStackMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function ejectStackMain(input = {}) {
    const options = normalizeOptions(input);
    const unknownRefusal = await refuseUnknownFlags(options, { command: 'eject', event: 'project_ejected' });
    if (unknownRefusal) return unknownRefusal;
    intro(color.bgRed(color.white(' grada eject ⏏️  ')));

    console.log(color.yellow('This will permanently decouple your infrastructure from the grada CLI.'));
    console.log(color.gray('It removes all ManagedBy tags and tool-specific metadata from your local files.'));
    console.log(color.gray('Your infrastructure will remain fully operational as raw, standalone Terraform.'));

    const targetDir = process.cwd();
    const projectName = path.basename(targetDir);
    const forced = options.force === true || options.force === 'true';

    // Asleep preflight (before the eject confirm): ejecting a slept stack
    // hands over Terraform that disagrees with live state (ECS at 0, RDS
    // stopped), so a raw `terraform apply` would half-wake it. Headless
    // refuses unless --force; interactive offers wake-first or abort.
    const asleepEntries = Object.entries(readSleepState(targetDir))
        .filter(([, entry]) => entry && typeof entry === 'object');
    if (asleepEntries.length > 0 && !forced) {
        const [firstEnv, firstEntry] = asleepEntries[0];
        const services = firstEntry.services && typeof firstEntry.services === 'object' ? firstEntry.services : {};
        const dbNote = firstEntry.dbId
            ? `, RDS ${firstEntry.dbId} (${firstEntry.dbKind ?? 'unknown kind'}, stopped)`
            : '';
        console.log(color.yellow(`\n⚠ This stack is ASLEEP (env "${firstEnv}": ECS app=${services.app ?? '?'} worker=${services.worker ?? '?'}${dbNote}).`));
        console.log(color.yellow('  Ejecting now would hand you Terraform that disagrees with live state — a raw apply would start tasks against a stopped database.'));
        if (shouldAutoApprove(options)) {
            trackEvent('eject_asleep_preflight', { projectName, decision: 'refused' });
            await flushTelemetry();
            return failCommand({
                message: `\n✖ Refusing to eject env "${firstEnv}" while it is asleep.`,
                hint: '  Run npx grada-run wake first, or re-run with --force to eject anyway (the ledger migrates to SLEEPING.md).\n',
                event: 'project_ejected',
                telemetry: { projectName },
                errorCode: 'EJECT_WHILE_ASLEEP',
                reason: 'eject-while-asleep',
            });
        }
        const refused = await refuseIfNonInteractive(options, {
            message: `\n✖ eject needs approval before waking the asleep stack.`,
            hint: '  Run npx grada-run wake first, or re-run with --force to eject anyway (the ledger migrates to SLEEPING.md).\n',
            event: 'project_ejected',
            telemetry: { projectName },
            errorCode: 'EJECT_NON_INTERACTIVE',
        });
        if (refused) return refused;
        const wakeFirst = await confirm({
            message: 'The stack is asleep. Wake it now and continue with eject?',
            initialValue: true,
        });
        if (wakeFirst !== true) {
            trackEvent('eject_asleep_preflight', { projectName, decision: 'wake-declined' });
            await flushTelemetry();
            cancel('Eject aborted. The stack is still asleep.');
            process.exit(0);
            return { ok: false, reason: 'cancelled' };
        }
        trackEvent('eject_asleep_preflight', { projectName, decision: 'wake-accepted' });
        await flushTelemetry();
        const wakeImpl = options.wakeImpl || runWake;
        const woken = await wakeImpl({ cwd: targetDir, env: firstEnv });
        if (!woken || woken.ok !== true) {
            return failCommand({
                message: '\n✖ Wake did not complete — eject aborted.',
                hint: '  Resolve the wake failure, then re-run eject.\n',
                event: 'project_ejected',
                telemetry: { projectName },
                errorCode: 'WAKE_FAILED',
                reason: 'wake-failed',
                resultExtra: { env: firstEnv, wakeReason: woken?.reason ?? null },
            });
        }
    } else if (asleepEntries.length > 0) {
        trackEvent('eject_asleep_preflight', { projectName, decision: 'forced' });
        await flushTelemetry();
    }

    if (!shouldAutoApprove(options)) {
        const refused = await refuseIfNonInteractive(options, {
            message: `\n✖ eject needs confirmation before decoupling infrastructure from the grada CLI.`,
            hint: '  Re-run with --yes to eject non-interactively.\n',
            event: 'project_ejected',
            telemetry: { projectName },
            errorCode: 'EJECT_NON_INTERACTIVE',
        });
        if (refused) return refused;
    }
    const shouldEject = shouldAutoApprove(options) ? true : await confirm({
        message: 'Are you sure you want to eject? (This cannot be undone)',
        initialValue: false,
    });

    if (!shouldEject || typeof shouldEject === 'symbol') {
        cancel('Eject cancelled. You are still managed by grada.');
        process.exit(0);
        return { ok: false, reason: 'cancelled' };
    }

    const s = spinner();
    s.start('Ejecting grada metadata...');

    const tfDir = path.join(targetDir, 'terraform');
    const gitignorePath = path.join(targetDir, '.gitignore');

    // Steps 1–3 share every .tf file with concurrent `add`/`domain`
    // runs: serialize the whole mutation under the project lock.
    await withProjectLock(targetDir, async () => {
        // 1. Clean every Terraform file (main.tf headers and tag blocks,
        // addon headers in either brand variant).
        for (const tfPath of collectTerraformFiles(tfDir)) {
            const content = fs.readFileSync(tfPath, 'utf8');
            const cleaned = stripTerraformMetadata(content);
            if (cleaned !== content) {
                atomicWriteFileSync(tfPath, cleaned.trim() + '\n');
            }
        }

        // 2. Clean up .gitignore
        if (fs.existsSync(gitignorePath)) {
            let gitignore = fs.readFileSync(gitignorePath, 'utf8');
            // Remove the exact block we injected in backup.js
            gitignore = stripGitignoreMetadata(gitignore);
            atomicWriteFileSync(gitignorePath, gitignore.trim() + '\n');
        }

        // 3. Purge all local `.bak` files to leave a pristine directory
        const cleanBackups = (dir) => {
            if (!fs.existsSync(dir)) return;
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                if (isGradaBackupName(file)) {
                    fs.rmSync(fullPath, { recursive: true, force: true });
                } else if (fs.statSync(fullPath).isDirectory() && file !== 'node_modules' && file !== '.git') {
                    cleanBackups(fullPath); // Recursively check subdirectories like .github/workflows
                }
            }
        };

        cleanBackups(targetDir);
    }, { scope: 'terraform' });

    // 4. Record the ejection in gitignored local state so later `add` /
    // `init` runs can warn instead of silently re-managing the tree.
    writeEjectedMarker(targetDir);

    // 4b. Commit the eject sentinel: fresh clones (which never receive
    // `.grada/`) refuse to re-manage instead of silently adopting the tree.
    writeEjectedSentinel(targetDir);

    // 5. Hand over the state-bucket runbook. Eject never deletes the bucket
    // (the state is the user's only map of live infra), so the exact
    // manual commands plus secrets-rotation notes land in a committed doc.
    // Re-reads the ledger: a wake-first run above may have cleared it.
    const postEjectEntries = Object.entries(readSleepState(targetDir))
        .filter(([, entry]) => entry && typeof entry === 'object');
    let backendContent = '';
    try {
        backendContent = fs.readFileSync(path.join(tfDir, 'backend.tf'), 'utf8');
    } catch {
        backendContent = '';
    }
    const { bucket, region } = parseStateBucketBackend(backendContent);
    const cleanupRegion = region ?? 'us-east-2';
    const rdsCommands = [];
    for (const [, entry] of postEjectEntries) {
        if (!entry.dbId) continue;
        if (entry.dbKind === 'cluster') {
            rdsCommands.push(`aws rds start-db-cluster --db-cluster-identifier ${entry.dbId} --region ${cleanupRegion}`);
        } else if (entry.dbKind === 'instance') {
            rdsCommands.push(`aws rds start-db-instance --db-instance-identifier ${entry.dbId} --region ${cleanupRegion}`);
        } else {
            rdsCommands.push(`# ${entry.dbId}: recorded without a kind — try one of:`,
                `aws rds start-db-instance --db-instance-identifier ${entry.dbId} --region ${cleanupRegion}`,
                `aws rds start-db-cluster --db-cluster-identifier ${entry.dbId} --region ${cleanupRegion}`);
        }
    }
    const cleanupDoc = [
        '# State bucket cleanup (grada eject handoff)',
        '',
        'Eject intentionally leaves your Terraform state bucket in place: it is',
        'the only map of your live infrastructure. Delete it only when you are',
        'done with this stack entirely.',
        '',
        '## Bucket',
        '',
        bucket
            ? `- Bucket: \`${bucket}\``
            : '- Bucket: unknown — no `terraform/backend.tf` bucket found; list buckets in the AWS console (S3).',
        `- Region: \`${cleanupRegion}\``,
        '',
        '## Delete it (versioned buckets)',
        '',
        bucket
            ? [
                'The bucket is versioned: `rb` alone leaves every version behind.',
                'Purge versions and delete markers first, then remove the bucket:',
                '',
                '```sh',
                `aws s3api list-object-versions --bucket ${bucket} --region ${cleanupRegion} \\`,
                '  --query \'{Objects: Versions[].{Key:Key,VersionId:VersionId}}\' --output json > /tmp/grada-versions.json',
                `aws s3api delete-objects --bucket ${bucket} --region ${cleanupRegion} --delete file:///tmp/grada-versions.json`,
                'aws s3api list-object-versions \\',
                `  --bucket ${bucket} --region ${cleanupRegion} \\`,
                '  --query \'{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}\' --output json > /tmp/grada-markers.json',
                `aws s3api delete-objects --bucket ${bucket} --region ${cleanupRegion} --delete file:///tmp/grada-markers.json`,
                `aws s3 rb s3://${bucket} --force --region ${cleanupRegion}`,
                '```',
            ].join('\n')
            : 'Resolve the bucket name first (see above), then purge versions before `aws s3 rb`.',
        '',
        '## Secrets rotation notes',
        '',
        '- The inherited state history still contains every historical secret',
        '  value: treat old state copies as sensitive until rotated.',
        '- `secrets.tf` uses `ignore_changes = [secret_string]`, so Terraform',
        '  never reconciles secret drift: rotate out-of-band and do not trust',
        '  stale versions lingering in state.',
        '- If the tree encrypts secrets with a `pgp_key`, keep the key',
        '  available until rotation completes, then retire it.',
        ...(rdsCommands.length > 0
            ? [
                '',
                '## Stopped databases (the stack was asleep)',
                '',
                'Start each recorded database before applying, or fresh tasks',
                'will crash-loop against a stopped endpoint:',
                '',
                '```sh',
                ...rdsCommands,
                '```',
            ]
            : []),
        '',
    ].join('\n');
    atomicWriteFileSync(path.join(targetDir, 'STATE_BUCKET_CLEANUP.md'), cleanupDoc);
    trackEvent('eject_cleanup_emitted', { projectName, bucket_parsed: bucket !== null });

    // 6. Migrate a surviving asleep ledger (force-eject, or a wake-first
    // that left entries behind) into committed SLEEPING.md, then clear the
    // local entries: grada no longer owns this tree.
    if (postEjectEntries.length > 0) {
        const sleepingDoc = [
            '# Sleeping stack (grada eject handoff)',
            '',
            'This stack was ASLEEP when ejected: ECS services are scaled to 0',
            'and any database below is stopped. Wake it (see commands) before',
            'running raw `terraform apply`, or the apply will half-wake the',
            'stack — tasks up, database still down.',
            '',
            ...postEjectEntries.flatMap(([env, entry]) => {
                const services = entry.services && typeof entry.services === 'object' ? entry.services : {};
                return [
                    `## ${env}`,
                    '',
                    `- Slept at: \`${entry.sleptAt ?? 'unknown'}\``,
                    `- Services: app=${services.app ?? '?'} worker=${services.worker ?? '?'}`,
                    entry.dbId
                        ? `- Database: \`${entry.dbId}\` (${entry.dbKind ?? 'unknown kind'}, stopped)`
                        : '- Database: none recorded',
                    '',
                ];
            }),
            '## Waking without grada',
            '',
            '- Start stopped databases with the `aws rds start-db-*` commands',
            '  in STATE_BUCKET_CLEANUP.md, then `terraform apply` to restore',
            '  desired counts (delete `terraform/sleep.auto.tfvars` first if',
            '  present — it pins desired counts to 0 while asleep).',
            '',
        ].join('\n');
        atomicWriteFileSync(path.join(targetDir, 'SLEEPING.md'), sleepingDoc);
        await withProjectLock(targetDir, async () => {
            writeSleepState(targetDir, {});
        }, { scope: LEDGER_LOCK_SCOPE });
        trackEvent('sleep_entry_cleared', { projectName, by: 'eject' });
    }

    // 7. Keep `.grada/` (local marker, locks) out of git even when sleep
    // never ran — eject-without-sleep used to leave it committable.
    ensureGitignoreRules(targetDir, [GITIGNORE_RULE_GRADA_DIR]);

    s.stop('Ejection complete.');

    trackEvent('project_ejected', {
        projectName
    });
    await flushTelemetry();

    outro(`
    ${color.green('✅ Successfully ejected from grada!')}
    
    Your Terraform and CI/CD files are now 100% vanilla. 
    
    ${color.blue('Next Step:')}
    Run ${color.cyan('terraform apply')} inside your terraform/ folder. 
    AWS will sync your state and automatically remove the 'ManagedBy' tags from your live cloud resources.

    ${color.magenta('Godspeed! You are now the sole owner of your infrastructure.')}
    `);
}