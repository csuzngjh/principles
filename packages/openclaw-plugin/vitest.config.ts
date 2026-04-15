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
// These tests require better-sqlite3 to be compiled
const integrationTests = [
  // Core DB tests
  'tests/core/control-ui-db.test.ts',
  'tests/core/evolution-logger.test.ts',
  'tests/core/nocturnal-e2e.test.ts',
  'tests/core/nocturnal-trajectory-extractor.test.ts',
  'tests/core/replay-engine.test.ts',
  'tests/core/trajectory.test.ts',
  'tests/core/workspace-context.test.ts',
  // Service tests with DB dependencies
  'tests/service/nocturnal-service-code-candidate.test.ts',
  'tests/service/nocturnal-target-selector.test.ts',
  'tests/service/evolution-worker.nocturnal.test.ts',
  'tests/service/evolution-worker.timeout.test.ts',
  'tests/service/data-endpoints-regression.test.ts',
  'tests/service/control-ui-query-service.test.ts',
  'tests/service/keyword-optimization-service.test.ts',
  // Hook tests with DB dependencies
  'tests/hooks/subagent.test.ts',
  'tests/hooks/gate-pipeline-integration.test.ts',
  'tests/hooks/gate-rule-host-pipeline.test.ts',
  // Script tests with DB
  'tests/scripts/validate-live-path.test.ts',
  // Integration test directory
  'tests/integration/**/*.test.ts',
  'tests/integration/**/*.test.tsx',
];

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Use threads pool for better performance
    pool: 'threads',
    teardownTimeout: 30000,
    globalSetup: ['./tests/globalSetup.ts'],
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
  },
});