import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration with test layering
 *
 * LAYERS:
 * - unit: Mock-based tests, no real DB (fast, parallel)
 * - integration: Tests using real SQLite DB (requires threads pool)
 *
 * USAGE:
 * - npm test              → run all tests
 * - npm run test:unit     → run unit tests only (fast)
 * - npm run test:integration → run integration tests only
 *
 * WHY threads pool?
 * better-sqlite3 native handles don't clean up properly in fork subprocesses,
 * causing teardown hangs. Threads pool handles this correctly.
 */

// Integration tests: use real SQLite database
const integrationTests = [
  'tests/core/control-ui-db.test.ts',
  'tests/core/evolution-logger.test.ts',
  'tests/core/nocturnal-e2e.test.ts',
  'tests/core/nocturnal-trajectory-extractor.test.ts',
  'tests/core/replay-engine.test.ts',
  'tests/core/trajectory.test.ts',
  'tests/integration/**/*.test.ts',
  'tests/service/nocturnal-service-code-candidate.test.ts',
  'tests/service/nocturnal-target-selector.test.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    pool: 'threads',
    teardownTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['tests/**'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
    // Workspace projects for layered testing
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
          exclude: integrationTests,
          pool: 'threads',
        },
      },
      {
        test: {
          name: 'integration',
          include: integrationTests,
          pool: 'threads',
        },
      },
    ],
  },
});