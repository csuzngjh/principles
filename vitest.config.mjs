import { defineConfig } from 'vitest/config';

/**
 * Root-level vitest config — exists ONLY so root-level vitest invocations
 * (e.g. `npm run test:guard-contracts`, and the documented
 * `npx vitest run packages/<pkg>/tests/<file>` in WORKFLOW.md) pick up the
 * shared temp lifecycle globalSetup. It must not change which files any
 * invocation selects: no explicit include, so vitest's default discovery —
 * identical to the previous no-root-config behavior — stays in force.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // tests/e2e-fixtures/** are trap fixtures consumed BY tests, not test files.
    // exclude REPLACES vitest's defaults, so they are restated here verbatim
    // (https://vitest.dev/config/#exclude) plus our own entry.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      'tests/e2e-fixtures/**',
    ],
    globalSetup: ['scripts/test/temp-lifecycle.mjs'],
  },
});
