import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Heavy smoke tests (release-asset-smoke, smoke-packaged-install) drive
    // bundle-plugin.mjs and mutate the packaged component trees inside this
    // package; running test files in parallel lets them corrupt each other's
    // fixtures (observed: before/after node_modules snapshots and packaged
    // console dist racing). Serializing files keeps every assertion intact.
    fileParallelism: false,
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
