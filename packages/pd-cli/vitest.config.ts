import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['../../scripts/test/temp-lifecycle.mjs'],
    include: ['tests/bdd/**/*.{test,steps}.ts', 'tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
