import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // better-sqlite3 native handles don't clean up properly when a fork
    // subprocess exits, causing "Worker exited unexpectedly" on Linux CI.
    // singleFork runs all test files in one process so the native handles
    // are only torn down once, at the end of the entire run.
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
