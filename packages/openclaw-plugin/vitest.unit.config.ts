import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig, { integrationTests } from './vitest.config.js';

export default mergeConfig(baseConfig, defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...integrationTests,
    ],
  },
}));
