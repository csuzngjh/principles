import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the root scripts/ tree (NOT scripts/nocturnal, which has
 * its own package + config). Covers the check-* script tests.
 *
 * Invoked by `npm run test:scripts` (root package.json), which does
 * `cd scripts && vitest run`. Run from the scripts/ directory so the include
 * glob resolves here, not at the repo root.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
});
