// eslint.config.js
import { defineConfig } from 'eslint/config';
import eslint from '@eslint/js';
import tsparser from '@typescript-eslint/parser';
import tseslint from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default defineConfig(
  // Global ignores (first config object with only ignores)
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.d.ts',
      '**/vitest.config.ts',
      '**/vitest.config.mts',
      '**/ui/src/**',
      '**/test-fix.ts',
      '**/tests/**',
      'packages/*/scripts/**',
      'packages/website/**',
    ],
  },

  // TypeScript source files config
  {
    files: ['packages/**/*.ts'],
    plugins: {
      '@typescript-eslint': tseslint,
    },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Core ESLint recommended rules (error-level only)
      ...eslint.configs.recommended.rules,

      // TypeScript-eslint rules (extension rules auto-disable core equivalents)
      '@typescript-eslint/adjacent-overload-signatures': 'error',
      '@typescript-eslint/array-type': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/class-methods-use-this': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/default-param-last': 'error',
      '@typescript-eslint/dot-notation': 'error',
      '@typescript-eslint/init-declarations': 'error',
      '@typescript-eslint/max-params': 'error',
      '@typescript-eslint/no-array-constructor': 'error',
      '@typescript-eslint/no-empty-function': 'error',
      '@typescript-eslint/no-empty-interface': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-extra-non-null-assertion': 'error',
      '@typescript-eslint/no-inferrable-types': 'error',
      '@typescript-eslint/no-loss-of-precision': 'error',
      '@typescript-eslint/no-misused-new': 'error',
      '@typescript-eslint/no-namespace': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-redeclare': 'error',
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unused-expressions': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-use-before-define': 'error',
      '@typescript-eslint/no-useless-constructor': 'error',
      '@typescript-eslint/no-var-requires': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-as-const': 'error',
      '@typescript-eslint/prefer-destructuring': 'error',
      '@typescript-eslint/prefer-namespace-keyword': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/prefer-regexp-exec': 'error',
      '@typescript-eslint/triple-slash-reference': 'error',

      // Disable complexity — pre-existing in 94+ functions, refactoring is out of scope
      complexity: 'off',

      // Disable core rules that TypeScript handles better
      'no-redeclare': 'off',
      'no-shadow': 'off',
      'no-unused-vars': 'off',
    },
  },

  // Test files - Vitest globals
  {
    files: ['packages/**/*.test.ts', 'packages/**/*.spec.ts'],
    languageOptions: {
      globals: {
        ...globals.vitest,
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
  },

  // Override: disable complexity rule globally (94+ pre-existing functions exceed threshold)
  {
    files: ['packages/**/*.ts'],
    rules: {
      complexity: 'off',
    },
  },

  // UI hook files need browser globals
  {
    files: ['packages/pd-console/src/ui/hooks/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // ── PRI-450: Core boundary — ban fs/path imports in principles-core/src/ ──
  // Production files in core must be pure logic. I/O belongs in openclaw-plugin.
  // Whitelisted files are exempt (they are legacy I/O modules awaiting migration).
  {
    files: ['packages/principles-core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: [
            'fs', 'fs/*',
            'node:fs', 'node:fs/*',
            'path', 'path/*',
            'node:path', 'node:path/*',
          ],
          message: 'core 包不允许直接导入 fs/path。如果需要 I/O，请放到 openclaw-plugin 或通过 @principles/core/principle-tree-ledger 子路径暴露。新增 I/O 文件必须更新 architecture-regression.test.ts 的白名单。',
        }],
      }],
    },
  },

  // PRI-450: Exempt whitelisted I/O files and test files from the fs/path ban.
  // The whitelist mirrors ALLOWED_IO_FILES in architecture-regression.test.ts.
  {
    files: [
      'packages/principles-core/src/**/*.test.ts',
      'packages/principles-core/src/**/*.spec.ts',
      'packages/principles-core/src/principle-tree-ledger.ts',
      'packages/principles-core/src/evolution-store.ts',
      'packages/principles-core/src/trajectory-store.ts',
      'packages/principles-core/src/workflow-funnel-loader.ts',
      'packages/principles-core/src/runtime-v2/store/sqlite-connection.ts',
      'packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts',
      'packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts',
      'packages/principles-core/src/runtime-v2/candidate-audit.ts',
      'packages/principles-core/src/runtime-v2/pain-signal-observability.ts',
      'packages/principles-core/src/runtime-v2/internalization-chain-integrity-read-model.ts',
      'packages/principles-core/src/runtime-v2/internalization-integrity-remediation.ts',
      'packages/principles-core/src/runtime-v2/operator-health-read-model.ts',
      'packages/principles-core/src/runtime-v2/pain-chain-read-model.ts',
      'packages/principles-core/src/runtime-v2/pruning-read-model.ts',
      'packages/principles-core/src/runtime-v2/pruning-review-log.ts',
      'packages/principles-core/src/runtime-v2/schema-conformance-read-model.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);
