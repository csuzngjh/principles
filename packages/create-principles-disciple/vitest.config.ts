import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Heavy smoke tests (release-asset-smoke, smoke-packaged-install) drive
    // bundle-plugin.mjs and mutate the packaged component trees inside this
    // package; running test files in parallel lets them corrupt each other's
    // fixtures (observed: before/after node_modules snapshots and packaged
    // console dist racing). Serializing files keeps every assertion intact.
    fileParallelism: false,
    globalSetup: ['../../scripts/test/temp-lifecycle.mjs'],
    // Real-home zero-write sentinel for every installer/update test file:
    // a fixture that escapes its sandbox (HOME pinned but not USERPROFILE, or
    // no pin at all) fails the run instead of corrupting ~/.pd/active.json.
    setupFiles: ['tests/helpers/home-write-sentinel.setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/bdd/**/*.steps.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/plugin/templates/**',
      '**/pd-cli/**',
      '**/console/**',
      '**/core/**',
    ],
  },
});
