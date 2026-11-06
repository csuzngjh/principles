import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['../../scripts/test/temp-lifecycle.mjs'],
    include: ['tests/bdd/**/*.test.ts', 'tests/bdd/**/*.steps.ts', 'tests/**/*.test.ts', 'src/prompt-builder/__tests__/**/*.test.ts', 'src/quality-scorecard/__tests__/**/*.test.ts', 'src/host/__tests__/**/*.test.ts', 'src/runtime/store/**/*.test.ts', 'src/runtime/runner/**/*.test.ts', 'src/runtime/utils/**/*.test.ts', 'src/runtime/adapter/**/*.test.ts', 'src/runtime/diagnostician/**/*.test.ts', 'src/runtime/__tests__/**/*.test.ts', 'src/runtime/gfi/__tests__/**/*.test.ts', 'src/runtime/activation/__tests__/**/*.test.ts', 'src/runtime/activation/writers/__tests__/**/*.test.ts', 'src/runtime/internalization/__tests__/**/*.test.ts', 'src/runtime/feature-flags/__tests__/**/*.test.ts', 'src/runtime/observer/__tests__/**/*.test.ts', 'src/runtime/config/__tests__/**/*.test.ts', 'src/runtime/evidence-triage/__tests__/**/*.test.ts', 'src/runtime/detection/__tests__/**/*.test.ts', 'src/runtime/core-principles/__tests__/**/*.test.ts', 'src/runtime/tools/__tests__/**/*.test.ts', 'src/runtime/feedback/__tests__/**/*.test.ts', 'src/runtime/intent/__tests__/**/*.test.ts', 'src/runtime/risk/__tests__/**/*.test.ts', 'src/runtime/signal-collector/__tests__/**/*.test.ts', 'src/runtime/owner-decision/__tests__/**/*.test.ts', 'src/runtime/principle-reuse/__tests__/**/*.test.ts', 'src/*.test.ts'],
    // tests/fixtures/** holds generated-mirror replay assets (Gate A
    // reproducibility fixtures). They import `../core-mirror/...`, a
    // gitignored `git archive` snapshot that only exists after
    // `node tests/fixtures/gate-a-reproducibility/prepare-mirror.mjs`.
    // Excluded from default discovery so a clean checkout cannot fail on a
    // missing mirror; run them explicitly (see the fixture README).
    exclude: ['tests/fixtures/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
