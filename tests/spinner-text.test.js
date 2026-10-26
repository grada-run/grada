import { describe, it, expect } from 'vitest';
import { truncateSpinnerText, spinnerTextBudget, SPINNER_FRAME_OVERHEAD } from '../src/utils/spinner-text.js';

describe('spinnerTextBudget', () => {
    it('reserves frame chrome and caps at the historical 120', () => {
        expect(spinnerTextBudget({ columns: 131 })).toBe(120);
        expect(spinnerTextBudget({ columns: 200 })).toBe(120);
        expect(spinnerTextBudget({ columns: 80 })).toBe(71);
    });

    it('subtracts caller-reserved fixed stems', () => {
        // `Provisioning - ` (15) + chrome: a 131-column terminal fits 107.
        expect(spinnerTextBudget({ columns: 131, fixedOverhead: 15 + SPINNER_FRAME_OVERHEAD })).toBe(107);
        expect(spinnerTextBudget({ columns: 80, fixedOverhead: 15 + SPINNER_FRAME_OVERHEAD })).toBe(56);
    });

    it('floors tiny terminals at 20 and falls back to 80 columns when piped', () => {
        expect(spinnerTextBudget({ columns: 25 })).toBe(20);
        const stdout = process.stdout;
        const descriptor = Object.getOwnPropertyDescriptor(stdout, 'columns');
        delete stdout.columns;
        try {
            expect(spinnerTextBudget({})).toBe(71);
        } finally {
            if (descriptor) Object.defineProperty(stdout, 'columns', descriptor);
        }
    });
});

describe('truncateSpinnerText', () => {
    it('passes short text through untouched', () => {
        expect(truncateSpinnerText('Provisioning...', { columns: 80 })).toBe('Provisioning...');
        expect(truncateSpinnerText('', { columns: 80 })).toBe('');
    });

    it('cuts long lines to the budget with an ellipsis', () => {
        const line = 'x'.repeat(130);
        const cut = truncateSpinnerText(line, { columns: 131 });
        expect(cut).toHaveLength(120);
        expect(cut.endsWith('...')).toBe(true);
        // 80-column terminal: 71 visible + frame fits.
        expect(truncateSpinnerText(line, { columns: 80 })).toHaveLength(71);
    });

    it('never splits surrogate pairs', () => {
        const line = `${'y'.repeat(120)}🐳`;
        const cut = truncateSpinnerText(line, { columns: 131 });
        expect(Array.from(cut)).toHaveLength(120);
        expect(cut.endsWith('...')).toBe(true);
        expect(cut).not.toContain('�');
    });

    it('coerces nullish input to empty', () => {
        expect(truncateSpinnerText(null, { columns: 80 })).toBe('');
        expect(truncateSpinnerText(undefined, { columns: 80 })).toBe('');
    });
});
