import color from 'picocolors';
import { setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { failCommand, isProgrammaticCall } from '../utils/command.js';
import { normalizeOptions, normalizeArgv } from '../utils/args.js';
import { runQueueRedrive, parseQueueRedriveArgs } from './queue/redrive.js';

// Dispatcher + re-export barrel for the `queue` subcommands. Existing imports
// of `../src/commands/queue.js` (bin/cli.js, tests) keep working unchanged.
export { runQueueRedrive, parseQueueRedriveArgs } from './queue/redrive.js';

export const QUEUE_SUBCOMMANDS = ['redrive'];

function printQueueUsage() {
    console.log('Usage:');
    console.log('  grada queue redrive [--project-name <name>] [--workspace <name>] [--region <region>] [--yes]');
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
// Leaf subcommands restamp with their own name while they run (the command
// stack restores 'queue' when they return); the dispatcher stamp covers the
// guard and unknown-subcommand paths that never reach a leaf.
export async function runQueue(argv = [], extraOptions = {}) {
    setActiveCommandName('queue');
    try {
        return await runQueueMain(argv, extraOptions);
    } finally {
        resetActiveCommandName();
    }
}

async function runQueueMain(argv = [], extraOptions = {}) {
    const args = normalizeArgv(argv);
    const extra = normalizeOptions(extraOptions);
    if (args[0] === 'queue') args.shift();
    // Help wins over every leaf: a help request must print usage without
    // dispatching, guarding, or emitting failure telemetry — symmetric
    // with the top-level --help handling in bin/cli.js.
    if (args.includes('--help') || args.includes('-h')) {
        printQueueUsage();
        return { ok: true };
    }
    const subcommand = args[0] && !String(args[0]).startsWith('-') ? args[0] : undefined;
    const noExit = isProgrammaticCall(extra);

    if (subcommand === 'redrive') {
        return runQueueRedrive({ ...parseQueueRedriveArgs(argv), ...extra });
    }

    if (subcommand === undefined) {
        // Bare invocation is help-seeking, not an error: usage + exit
        // 0, untracked like --help (keeps probe noise out of error
        // telemetry).
        console.log(color.yellow('\n⚠ Missing queue subcommand.'));
        console.log('');
        printQueueUsage();
        console.log('');
        return { ok: true };
    }

    return failCommand({
        noExit,
        print: () => {
            console.log(color.red(`\n✖ Unknown queue subcommand "${subcommand}".`));
            console.log('');
            printQueueUsage();
            console.log('');
        },
        event: 'queue_run',
        telemetry: { subcommand },
        errorCode: 'UNKNOWN_QUEUE_SUBCOMMAND',
        reason: 'unknown-queue-subcommand',
        resultExtra: { subcommand },
    });
}
