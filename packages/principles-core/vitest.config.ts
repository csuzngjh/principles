import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/bdd/**/*.test.ts', 'tests/bdd/**/*.steps.ts', 'tests/**/*.test.ts', 'src/prompt-builder/__tests__/**/*.test.ts', 'src/quality-scorecard/__tests__/**/*.test.ts', 'src/host/__tests__/**/*.test.ts', 'src/runtime-v2/store/**/*.test.ts', 'src/runtime-v2/runner/**/*.test.ts', 'src/runtime-v2/utils/**/*.test.ts', 'src/runtime-v2/adapter/**/*.test.ts', 'src/runtime-v2/diagnostician/**/*.test.ts', 'src/runtime-v2/__tests__/**/*.test.ts', 'src/runtime-v2/gfi/__tests__/**/*.test.ts', 'src/runtime-v2/idle-trigger/__tests__/**/*.test.ts', 'src/runtime-v2/activation/__tests__/**/*.test.ts', 'src/runtime-v2/activation/writers/__tests__/**/*.test.ts', 'src/runtime-v2/internalization/__tests__/**/*.test.ts', 'src/runtime-v2/feature-flags/__tests__/**/*.test.ts', 'src/runtime-v2/observer/__tests__/**/*.test.ts', 'src/runtime-v2/config/__tests__/**/*.test.ts', 'src/runtime-v2/evidence-triage/__tests__/**/*.test.ts', 'src/runtime-v2/pain-gate/__tests__/**/*.test.ts', 'src/runtime-v2/detection/__tests__/**/*.test.ts', 'src/runtime-v2/core-principles/__tests__/**/*.test.ts', 'src/runtime-v2/tools/__tests__/**/*.test.ts', 'src/runtime-v2/feedback/__tests__/**/*.test.ts', 'src/runtime-v2/intent/__tests__/**/*.test.ts', 'src/runtime-v2/risk/__tests__/**/*.test.ts', 'src/runtime-v2/signal-collector/__tests__/**/*.test.ts', 'src/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    benchmark: {
      include: ['tests/bench/**/*.bench.ts'],
      outputJson: 'bench-results.json',
    },
  },
});
