import { defineConfig } from 'vitest/config';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    // Never let project-scope fixtures select or mutate the real owner's home:
    // workspace resolution derives the governance dir from os.homedir(), so
    // the whole suite runs against a per-process temp home. Per-test spawns
    // additionally override USERPROFILE/HOME explicitly.
    env: {
      USERPROFILE: path.join(os.tmpdir(), `pd-workbuddy-test-home-${process.pid}`),
      HOME: path.join(os.tmpdir(), `pd-workbuddy-test-home-${process.pid}`),
    },
    globalSetup: ['../../scripts/test/temp-lifecycle.mjs'],
    // Production and entry suites spawn real hook processes (node boot +
    // better-sqlite3 native module) — give them an explicit ceiling instead
    // of relying on the vitest default.
    testTimeout: 30000,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
