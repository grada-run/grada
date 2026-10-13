// Centralized `@clack/prompts` mock for the test suite.
//
// Registered suite-wide in tests/setup.js — test files import handles
// directly (mockConfirm, clackMocks, ...) with no per-file vi.mock line.
// A file needing custom prompt behavior keeps its own vi.mock, which wins
// over the suite registration (terraform-lifecycle.test.js).
//
// Every handle is a stable per-file singleton (Vitest isolates modules per
// test file).
//
// Rules preserved from the previously hand-rolled blocks:
// - Bare defaults: no preset return values. Tests needing a specific answer
//   override per-test (e.g. `mockConfirm.mockResolvedValue(true)`).
// - `isCancel` keeps the real behavior (`typeof value === 'symbol'`), wrapped
//   in a `vi.fn` so files like apply.test.js can still override it.
// - The spinner returns a fresh per-call instance (isolated start/stop/
//   message) that also forwards into the shared aggregate handles, so both
//   per-instance assertions (`spin.stop`) and aggregate assertions
//   (`mockSpinnerStart`) keep working. Every instance is pushed to
//   `createdSpinners` for message-sequence assertions.
import { vi } from 'vitest';

export const mockIntro = vi.fn();
export const mockOutro = vi.fn();
export const mockText = vi.fn();
export const mockSelect = vi.fn();
export const mockConfirm = vi.fn();
export const mockPassword = vi.fn();
export const mockMultiselect = vi.fn();
export const mockNote = vi.fn();
export const mockGroup = vi.fn();
export const mockCancel = vi.fn();
export const mockIsCancel = vi.fn((value) => typeof value === 'symbol');

export const mockSpinnerStart = vi.fn();
export const mockSpinnerStop = vi.fn();
export const mockSpinnerMessage = vi.fn();

export const mockLogInfo = vi.fn();
export const mockLogWarn = vi.fn();
export const mockLogMessage = vi.fn();
export const mockLogSuccess = vi.fn();
export const mockLogError = vi.fn();

export const createdSpinners = [];

export const mockSpinner = vi.fn(() => {
    const instance = {
        start: vi.fn((...args) => mockSpinnerStart(...args)),
        stop: vi.fn((...args) => mockSpinnerStop(...args)),
        message: vi.fn((...args) => mockSpinnerMessage(...args)),
    };
    createdSpinners.push(instance);
    return instance;
});

// Back-compat handle map for files written against the `clack.mockXxx`
// hoisted-object naming (apply, destroy, gc, headless). Import as:
//   import { clackMocks as clack } from './helpers/clack.js';
export const clackMocks = {
    mockIntro,
    mockOutro,
    mockText,
    mockSelect,
    mockConfirm,
    mockPassword,
    mockMultiselect,
    mockNote,
    mockGroup,
    mockCancel,
    mockIsCancel,
    mockSpinner,
    mockSpinnerStart,
    mockSpinnerStop,
    mockSpinnerMessage,
    mockLogInfo,
    mockLogWarn,
    mockLogMessage,
    mockLogSuccess,
    mockLogError,
};

export function clackPromptsMockFactory() {
    return {
        intro: mockIntro,
        outro: mockOutro,
        text: mockText,
        select: mockSelect,
        confirm: mockConfirm,
        password: mockPassword,
        multiselect: mockMultiselect,
        note: mockNote,
        group: mockGroup,
        cancel: mockCancel,
        isCancel: mockIsCancel,
        spinner: mockSpinner,
        log: {
            info: mockLogInfo,
            warn: mockLogWarn,
            message: mockLogMessage,
            success: mockLogSuccess,
            error: mockLogError,
        },
    };
}
