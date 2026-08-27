import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // pd-hook.production.test.ts drives real hook processes via spawnSync
    // (~2.5s locally, >5s vitest default on shared CI runners now that the
    // bundle includes host-runtime). Give process-spawning suites an explicit
    // ceiling instead of relying on the default.
    testTimeout: 30000,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
