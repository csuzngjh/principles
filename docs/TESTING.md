<!-- generated-by: gsd-doc-writer -->
# Testing

This document describes the testing setup and practices for the Principles Disciple OpenClaw plugin.

## Test Framework and Setup

The project uses **Vitest** (v4.1.0) as its test framework, with **V8** for coverage reporting.

**Key dependencies:**
- `vitest` - Test runner
- `@vitest/coverage-v8` - Coverage provider
- `jsdom` - DOM environment for React component tests

The primary test configuration is located at `packages/openclaw-plugin/vitest.config.ts`.

## Running Tests

### Full Test Suite

```bash
cd packages/openclaw-plugin
npm test
```

This runs `vitest run` which executes all tests once with process isolation (pool: 'forks').

### With Coverage

```bash
npm run test:coverage
```

This runs `vitest run --coverage` and generates coverage reports in text, HTML formats.

### Test File Naming Convention

Test files follow the `*.test.ts` pattern and are located in the `packages/openclaw-plugin/tests/` directory:

```
tests/
  commands/
    strategy.test.ts
    evolver.test.ts
  core/
    init.test.ts
    config.test.ts
    evolution-engine.test.ts
  hooks/
    gate.test.ts
    lifecycle.test.ts
  tools/
    model-index.test.ts
  utils/
    io.test.ts
    hashing.test.ts
  ...
```

## Writing New Tests

Place test files in `packages/openclaw-plugin/tests/` following the existing directory structure:

- `tests/commands/` - Command handlers
- `tests/core/` - Core services and business logic
- `tests/hooks/` - Hook implementations
- `tests/tools/` - Tool definitions
- `tests/utils/` - Utility functions
- `tests/service/` - Service layer components

Use the existing test files as reference for import patterns and test structure.

## Coverage Requirements

The project enforces minimum coverage thresholds in CI:

| Type | Threshold |
|------|-----------|
| Lines | 70% |
| Functions | 70% |
| Branches | 60% |
| Statements | 70% |

Coverage is calculated excluding the `tests/` directory itself.

## CI Integration

Tests run automatically via GitHub Actions (`.github/workflows/ci.yml`):

**Workflow Triggers:**
- Push to `main` or `develop` branches
- Pull requests to `main`

**Test Job Matrix:**
- Node.js versions: 18, 20, 22

**Sequence:**
1. `lint` job - ESLint validation
2. `test` job - Runs tests across Node 18/20/22 (needs lint)
3. `build-openclaw-plugin` job - TypeScript compilation (needs test)
4. `test-openclaw-plugin` job - Plugin tests after build (needs build)

The plugin tests run with:

```bash
cd packages/openclaw-plugin
npm install
npm test
```
