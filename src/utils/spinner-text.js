// Terminal-width truncation for spinner frames. Clack re-renders the
// current frame every ~80ms, and any frame wider than the terminal
// wraps — on viewers that split frames into lines (harness PTYs, log
// capture) each wrapped frame fossilizes as extra scrollback lines.
// Every dynamic spinner message goes through here so over-width
// frames can never wall, on any terminal width.

// Spinner chrome around the message: glyph + animated dots + padding.
export const SPINNER_FRAME_OVERHEAD = 9;

// Wide terminals keep the historical 120-column cap.
export const SPINNER_TEXT_MAX = 120;

// Visible columns available for spinner text: the terminal width
// minus caller-reserved fixed text (e.g. a `Prefix - ` stem, counted
// via fixedOverhead) and spinner chrome. Floored so tiny terminals
// still show something; falls back to 80 when piped.
export function spinnerTextBudget({ columns = process.stdout?.columns ?? 80, fixedOverhead = SPINNER_FRAME_OVERHEAD } = {}) {
    return Math.max(20, Math.min(SPINNER_TEXT_MAX, columns - fixedOverhead));
}

// Cuts text to the spinner budget (with `...`), code-point safe so
// emoji survive. Pass uncolored text and color after: ANSI escapes
// would count as visible columns and slicing could split them.
export function truncateSpinnerText(text, options = {}) {
    const chars = Array.from(String(text ?? ''));
    const budget = spinnerTextBudget(options);
    if (chars.length <= budget) return chars.join('');
    return `${chars.slice(0, budget - 3).join('')}...`;
}
