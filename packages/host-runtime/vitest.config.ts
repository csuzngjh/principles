import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // better-sqlite3 native handles don't clean up properly when a fork
    // subprocess exits, causing "Worker exited unexpectedly" on Linux CI.
    // maxWorkers: 1 forces all test files into a single fork worker so the
    // native handles are only torn down once, at the end of the entire run.
    // (vitest 4.x ignores the legacy poolOptions.forks.singleFork flag.)
    maxWorkers: 1,
  },
});
