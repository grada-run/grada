import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/e2e/tier2.e2e.test.js'],
        testTimeout: 3600000,
        // The afterAll safety net runs a minutes-long destroy: the 10s
        // default hook/teardown budgets would kill it mid-run.
        hookTimeout: 1800000,
        teardownTimeout: 1800000,
    },
});
