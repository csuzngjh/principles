import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/runtime-v2/store/**/*.test.ts', 'src/runtime-v2/runner/**/*.test.ts', 'src/runtime-v2/utils/**/*.test.ts', 'src/runtime-v2/adapter/**/*.test.ts', 'src/runtime-v2/diagnostician/**/*.test.ts'],
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
