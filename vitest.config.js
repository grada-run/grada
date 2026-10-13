import { defineConfig, defaultExclude } from 'vitest/config';

export default defineConfig({
    test: {
        env: {
            FORCE_COLOR: '1',
        },
        exclude: [...defaultExclude, 'tests/e2e/**'],
        setupFiles: ['./tests/setup.js'],
    },
});
