import color from 'picocolors';
import { failCommand } from '../utils/command.js';
import { setActiveCommandName, resetActiveCommandName, telemetryState, writeTelemetryPreference } from '../core/telemetry.js';

export const TELEMETRY_SUBCOMMANDS = ['off', 'on', 'status'];

// This command never emits telemetry itself — not even on failure paths
// (failCommand runs with no event below). A privacy control that phones
// home about its own use would defeat its purpose.
export async function runTelemetry({ subcommand, isHeadless } = {}) {
    setActiveCommandName('telemetry');
    try {
        return await runTelemetryMain({ subcommand, noExit: isHeadless === true });
    } finally {
        resetActiveCommandName();
    }
}

function printStatus(state) {
    if (state.enabled) {
        console.log(`${color.green('Telemetry is enabled.')} Anonymous usage data helps improve grada.`);
        console.log(`Disable anytime: ${color.cyan('grada telemetry off')} (or ${color.cyan('DO_NOT_TRACK=1')} for selected runs).`);
        return;
    }
    if (state.source === 'env') {
        console.log('Telemetry is disabled (DO_NOT_TRACK is set).');
    } else if (state.source === 'vitest') {
        console.log('Telemetry is disabled (test runner detected).');
    } else {
        console.log('Telemetry is disabled (persistent preference).');
        console.log(`Re-enable: ${color.cyan('grada telemetry on')}.`);
    }
}

async function runTelemetryMain({ subcommand, noExit }) {
    const normalized = typeof subcommand === 'string' ? subcommand.trim().toLowerCase() : '';

    if (normalized === 'status') {
        const state = telemetryState();
        printStatus(state);
        return { ok: true, enabled: state.enabled, source: state.source };
    }

    if (normalized === 'off' || normalized === 'on') {
        const enable = normalized === 'on';
        try {
            writeTelemetryPreference(enable);
        } catch (error) {
            return failCommand({
                noExit,
                message: `\n✖ Could not save the telemetry preference: ${error.message}\n`,
                errorCode: 'TELEMETRY_CONFIG_WRITE_FAILED',
                reason: 'telemetry-config-write-failed',
                exitCode: 1,
            });
        }
        const state = telemetryState();
        if (enable && !state.enabled && state.source === 'env') {
            console.log(color.yellow('Preference saved, but DO_NOT_TRACK is set, so telemetry stays off in this environment.'));
        } else if (enable) {
            console.log(color.green('Telemetry is enabled.'));
        } else {
            console.log(`${color.green('Telemetry is disabled.')} No usage data will leave this machine.`);
        }
        return { ok: true, enabled: state.enabled, source: state.source };
    }

    const received = typeof subcommand === 'string' && subcommand.trim() !== '' ? ` "${subcommand.trim()}"` : '';
    return failCommand({
        noExit,
        message: `\n✖ Unknown telemetry subcommand${received}. Usage: grada telemetry <off|on|status>\n`,
        errorCode: 'UNKNOWN_TELEMETRY_SUBCOMMAND',
        reason: 'unknown-telemetry-subcommand',
        exitCode: 1,
    });
}
