import { describe, it, expect } from 'vitest';
import { chunkArray } from '../src/utils/batch.js';

describe('batch helpers', () => {
    it('chunks evenly and with a remainder', () => {
        expect(chunkArray([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
        expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
        expect(chunkArray([], 1000)).toEqual([]);
    });

    it('rejects non-positive sizes', () => {
        expect(() => chunkArray([1], 0)).toThrow();
        expect(() => chunkArray([1], -1)).toThrow();
    });
});
