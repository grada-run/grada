import { SQSClient, GetQueueUrlCommand, GetQueueAttributesCommand, StartMessageMoveTaskCommand } from '@aws-sdk/client-sqs';
import fsSync from 'fs';
import path from 'path';
import color from 'picocolors';
import { intro, outro, spinner, confirm, cancel } from '@clack/prompts';
import { trackSuccess, setActiveCommandName, resetActiveCommandName } from '../../core/telemetry.js';
import { failCommand, failAwsError, trackAwsFailure, failProjectNotInitialized, refuseUnknownFlags, isProgrammaticCall } from '../../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../../utils/args.js';
import { isAuthError, handleAuthErrorBranch, resolveClient } from '../../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveHeadless, resolveCwd, resolveNamespacedProject, readResourceSuffix, safeSuffixedName } from '../../utils/resolvers.js';

const QUEUE_NOT_FOUND_NAMES = new Set(['QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue']);

export function parseQueueRedriveArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'queue') args.shift();
    if (args[0] === 'redrive') args.shift();
    const { options, rest, unknown } = parseFlags(args, {
        string: [
            { name: 'project-name', key: 'projectName' },
            { name: 'region', key: 'region' },
            { name: 'workspace', key: 'workspace' },
        ],
        boolean: ['yes', 'headless'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0) options.unexpectedPositionals = positionals;
    if (unknown.length > 0) options.unknownFlags = unknown;
    return options;
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runQueueRedrive(input = {}) {
    setActiveCommandName('queue_redrive');
    try {
        return await runQueueRedriveMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runQueueRedriveMain(input = {}) {
    const options = normalizeOptions(input);
    const noExit = isProgrammaticCall(options);
    const unknownRefusal = await refuseUnknownFlags(options, { command: 'queue redrive', event: 'queue_redrive_run' });
    if (unknownRefusal) return unknownRefusal;
    let cwd;
    let region;
    let projectName;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'queue_redrive_run', noExit });
    }
    const headless = resolveHeadless(options);

    intro(color.bgCyan(color.black(' grada queue redrive ↩️  ')));

    if (Array.isArray(options.unexpectedPositionals) && options.unexpectedPositionals.length > 0) {
        return failCommand({
            noExit,
            message: `\n✖ Unexpected argument "${options.unexpectedPositionals[0]}". Redrive takes flags only: queue redrive [--project-name <name>] [--workspace <name>] [--region <region>] [--yes].\n`,
            event: 'queue_redrive_run',
            telemetry: { projectName },
            errorCode: 'UNEXPECTED_POSITIONAL_ARGS',
            reason: 'unexpected-positional-args',
            resultExtra: { region },
        });
    }

    // Fail fast on a missing SQS addon file before any AWS calls.
    const sqsTf = path.join(cwd, 'terraform', 'sqs.tf');
    try {
        if (!fsSync.existsSync(sqsTf)) throw new Error('missing');
    } catch {
        return failCommand({
            noExit,
            message: `\n✖ ${color.cyan('terraform/sqs.tf')} not found. Run ${color.green('npx grada-run add queue:sqs')} first.\n`,
            event: 'queue_redrive_run',
            telemetry: { projectName },
            errorCode: 'SQS_TF_NOT_FOUND',
            reason: 'sqs-tf-not-found',
            resultExtra: { region },
        });
    }

    const base = `${resolveNamespacedProject(projectName, options, cwd)}${readResourceSuffix(cwd) || ''}`;
    const queueName = safeSuffixedName(base, '-queue', 80);
    const dlqName = safeSuffixedName(base, '-dlq', 80);
    const sqsClient = resolveClient(options.sqsClient, SQSClient, { region });
    const s = spinner();
    s.start('Resolving queue URLs...');

    const queueUrlOf = async (name) => {
        try {
            const out = await sqsClient.send(new GetQueueUrlCommand({ QueueName: name }));
            return out.QueueUrl;
        } catch (error) {
            if (error && QUEUE_NOT_FOUND_NAMES.has(error.name)) return null;
            throw error;
        }
    };

    try {
        const queueUrl = await queueUrlOf(queueName);
        const dlqUrl = queueUrl === null ? null : await queueUrlOf(dlqName);
        const missing = queueUrl === null ? queueName : dlqUrl === null ? dlqName : null;
        if (missing) {
            s.stop(color.yellow('Queue not found.'));
            return failCommand({
                noExit,
                message: `\n✖ Queue "${missing}" does not exist in ${color.cyan(region)}. Run ${color.green('npx grada-run apply')} first.\n`,
                event: 'queue_redrive_run',
                telemetry: { projectName },
                errorCode: 'QUEUE_NOT_FOUND',
                reason: 'queue-not-found',
                resultExtra: { queueName, region },
            });
        }

        s.message('Reading DLQ depth...');
        const [dlqAttrs, queueAttrs] = await Promise.all([
            sqsClient.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['ApproximateNumberOfMessagesVisible', 'QueueArn'] })),
            sqsClient.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] })),
        ]);
        const depth = Number(dlqAttrs.Attributes?.ApproximateNumberOfMessagesVisible ?? 0);
        if (!Number.isFinite(depth) || depth <= 0) {
            s.stop(color.green('DLQ empty.'));
            console.log(color.green('\n✅ DLQ is empty — nothing to redrive.'));
            await trackSuccess('queue_redrive_run', { projectName, moved: 0 });
            outro(color.green('Done.'));
            return { ok: true, moved: 0 };
        }

        // Re-injected poison messages can crash-loop the consumer, so
        // redrive confirms like every destructive action (explicit --yes
        // skips prompting).
        if (options.yes !== true && options.yes !== 'true') {
            if (headless) {
                s.stop(color.yellow('Confirmation required.'));
                return failCommand({
                    noExit,
                    message: '\n✖ Redrive requires confirmation. Re-run with --yes.\n',
                    event: 'queue_redrive_run',
                    telemetry: { projectName },
                    errorCode: 'CONFIRMATION_REQUIRED',
                    reason: 'confirmation-required',
                    resultExtra: { queueName, region },
                });
            }
            s.stop('DLQ depth read.');
            console.log(color.yellow(`\n⚠ This will move ${depth} message${depth === 1 ? '' : 's'} from ${color.cyan(dlqName)} back to ${color.cyan(queueName)}.`));
            console.log('  Fix the consumer first — redriving into a still-broken consumer just refills the DLQ.\n');
            const confirmed = await confirm({
                message: `Redrive ${depth} message${depth === 1 ? '' : 's'} to ${queueName}?`,
                initialValue: false,
            });
            if (confirmed !== true) {
                cancel('Cancelled. No messages were moved.');
                return { ok: false, reason: 'cancelled', queueName, region };
            }
        } else {
            s.stop('DLQ depth read.');
        }

        s.start(`Moving ${depth} message${depth === 1 ? '' : 's'} back to ${queueName}...`);
        const move = await sqsClient.send(new StartMessageMoveTaskCommand({
            SourceArn: dlqAttrs.Attributes.QueueArn,
            DestinationArn: queueAttrs.Attributes.QueueArn,
        }));
        s.stop(color.green('Move task started.'));
        console.log(color.green(`\n✅ Redrive started for ${depth} message${depth === 1 ? '' : 's'}.`));
        console.log(`  Task handle: ${color.cyan(move.TaskHandle)}`);
        console.log('  The alarm clears once the DLQ drains. If it refires immediately, the consumer still rejects the messages.\n');
        await trackSuccess('queue_redrive_run', { projectName, moved: depth });
        outro(color.green('Done.'));
        return { ok: true, moved: depth, taskHandle: move.TaskHandle };
    } catch (error) {
        if (isAuthError(error)) {
            await trackAwsFailure('queue_redrive_run', error, { projectName });
            handleAuthErrorBranch(error, s, options);
            return { ok: false, reason: 'error', queueName, region };
        }
        try { s.stop(color.red('❌ Queue redrive failed.')); } catch { /* spinner already stopped */ }
        return failAwsError({
            event: 'queue_redrive_run',
            error,
            noExit,
            telemetry: { projectName },
            reason: 'redrive-failed',
            resultExtra: { queueName, region },
        });
    }
}
