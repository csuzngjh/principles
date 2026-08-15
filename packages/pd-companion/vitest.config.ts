import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/bdd/**/*.steps.ts'],
    environment: 'node',
  },
});
