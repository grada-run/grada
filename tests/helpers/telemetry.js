// Centralized `src/core/telemetry.js` mock for the test suite.
//
// Usage (one-liner per test file):
//   import { telemetryMockFactory } from './helpers/telemetry.js';
//   vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));
//
// `trackSuccess`/`trackFailure` mirror the real delegation (calling through
// to `trackEvent` + `flushTelemetry`) so success/failure-path assertions that
// observe `trackEvent.mock.calls` keep working. `isActiveEnvValue`,
// `detectCiProvider`, `getCliVersion`, and the active-command pair pass
// through to the real module, covering the union of what mocked consumers
// import.
//
// Do NOT use this in tests/telemetry.test.js (it tests the real module).
import { vi } from 'vitest';

export const mockTrackEvent = vi.fn();
export const mockFlushTelemetry = vi.fn().mockResolvedValue();
export const mockTrackSuccess = vi.fn(async (event, properties) => {
    mockTrackEvent(event, { ...properties, success: true });
    await mockFlushTelemetry();
});
export const mockTrackFailure = vi.fn(async (event, properties) => {
    mockTrackEvent(event, { ...properties, success: false });
    await mockFlushTelemetry();
});

export async function telemetryMockFactory(importOriginal) {
    const actual = await importOriginal();
    return {
        trackEvent: mockTrackEvent,
        flushTelemetry: mockFlushTelemetry,
        trackSuccess: mockTrackSuccess,
        trackFailure: mockTrackFailure,
        isActiveEnvValue: actual.isActiveEnvValue,
        detectCiProvider: actual.detectCiProvider,
        getCliVersion: actual.getCliVersion,
        setActiveCommandName: actual.setActiveCommandName,
        resetActiveCommandName: actual.resetActiveCommandName,
    };
}
