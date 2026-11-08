import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/e2e/tier2.e2e.test.js'],
        testTimeout: 3600000,
    },
});
