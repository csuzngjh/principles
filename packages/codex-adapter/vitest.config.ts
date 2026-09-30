import { defineConfig } from 'vitest/config';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    // Never let project-scope fixtures select or mutate the real owner's PD workspace.
    env: { CODEX_HOME: path.join(os.tmpdir(), `pd-codex-test-home-${process.pid}`) },
    globalSetup: ['../../scripts/test/temp-lifecycle.mjs'],
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
