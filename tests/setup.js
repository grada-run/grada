import { vi } from 'vitest';
import { clackPromptsMockFactory } from './helpers/clack.js';
import { telemetryMockFactory } from './helpers/telemetry.js';

// Suite-wide interactive-prompt mock: no test may ever block on (or emit
// through) the real @clack/prompts. Per-file vi.mock('@clack/prompts')
// lines are redundant — but harmless, since a test file's own mock
// registration wins over this one.
vi.mock('@clack/prompts', () => clackPromptsMockFactory());

// Suite-wide telemetry mock: unit tests observe calls, never emit.
// Files testing the real module (telemetry.test.js,
// telemetry-command.test.js) opt out with vi.unmock.
vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));
