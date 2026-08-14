import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

/**
 * Vitest config for the host-runtime parity test.
 *
 * The parity test runs two files together:
 *   1. tests/package/published-host-runtime-bundle.test.ts — runs `npm pack`
 *      and installs the bundled plugin (spawns child processes, ~14s).
 *   2. tests/bdd/openclaw-shared-host-runtime-parity.steps.test.ts — uses
 *      real better-sqlite3 handles via SqliteConnection.
 *
 * Running these in separate forks causes "Worker exited unexpectedly" on Linux
 * because better-sqlite3 native handles don't clean up properly when a fork
 * subprocess exits. maxWorkers: 1 forces both files into the same worker so
 * native handles are only torn down once, at the end of the run.
 * (vitest 4.x ignores the legacy poolOptions.forks.singleFork flag.)
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      maxWorkers: 1,
    },
  })
);
