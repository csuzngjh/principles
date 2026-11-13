import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the root scripts/ tree. Covers the check-* script tests.
 *
 * Invoked by `npm run test:scripts` (root package.json), which does
 * `cd scripts && vitest run`. Run from the scripts/ directory so the include
 * glob resolves here, not at the repo root.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['test/temp-lifecycle.mjs'],
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.mjs'],
    // PRI-1195: this suite drives real git subprocesses, quarantine renames and
    // a whole-machine /proc scan per cleanup. Unbounded file parallelism on the
    // 4-core CI runner stretched those serial windows until a fail-closed guard
    // intermittently refused the PRI-712 cleanup target. 2 workers is the
    // measured stable ceiling for this suite (the same setting used by the
    // historical scripts-suite acceptance runs); it caps contention without
    // serialising the ~122 files.
    maxWorkers: 2,
  },
});
