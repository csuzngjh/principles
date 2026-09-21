import { defineConfig } from 'vitest/config';

/**
 * Root-level vitest config — exists ONLY so `npm run test:guard-contracts`
 * (which runs bare `npx vitest run tests/...` from the repo root) picks up
 * the shared temp lifecycle globalSetup. It must not change which files the
 * guard invocation selects: include stays scoped to tests/, matching the
 * previous no-config default behavior for that command.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js', 'tests/**/*.test.ts'],
    // tests/e2e-fixtures/** are trap fixtures consumed BY tests, not test files.
    exclude: ['**/node_modules/**', 'tests/e2e-fixtures/**'],
    globalSetup: ['scripts/test/temp-lifecycle.mjs'],
  },
});
