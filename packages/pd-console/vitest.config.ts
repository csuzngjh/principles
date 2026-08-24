import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // PRI-577 round-trip contract test: exercise the REAL v1 EventLog writer
      // from the openclaw-plugin workspace source (no dist build dependency).
      // Production runtime never imports this path — pd-console only reads
      // events_*.jsonl files written by the plugin.
      'principles-disciple/event-log': '../openclaw-plugin/src/core/event-log.ts',
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/ui/utils/__tests__/**/*.test.ts'],
    pool: 'forks',
    teardownTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov', 'html'],
      exclude: ['tests/**', 'src/ui/pages/**', 'src/ui/components/**'],
    },
  },
});
