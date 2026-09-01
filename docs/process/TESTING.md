<!-- generated-by: gsd-doc-writer -->
# Testing

This document describes the testing setup, quality infrastructure, and practices for the Principles Disciple project.

## Test Framework and Setup

The project uses **Vitest** (v4.1.x) as its test framework, with **V8** for coverage reporting.

**Key dependencies:**
- `vitest` - Test runner
- `@vitest/coverage-v8` - Coverage provider
- `better-sqlite3` - Native SQLite for integration tests

Each package has its own `vitest.config.ts`:

| Package | Config | Notes |
|---------|--------|-------|
| principles-core | `packages/principles-core/vitest.config.ts` | - |
| openclaw-plugin | `packages/openclaw-plugin/vitest.config.ts` | Unit/integration split, coverage thresholds |
| pd-cli | `packages/pd-cli/vitest.config.ts` | - |
| pd-console | `packages/pd-console/vitest.config.ts` | Uses forks pool for better-sqlite3 |
| create-principles-disciple | `packages/create-principles-disciple/vitest.config.ts` | - |

## Running Tests

### Per-package tests

```bash
# principles-core
cd packages/principles-core && npm test

# openclaw-plugin (all tests)
cd packages/openclaw-plugin && npm test

# openclaw-plugin (unit only)
cd packages/openclaw-plugin && npm run test:unit

# openclaw-plugin (integration only)
cd packages/openclaw-plugin && npm run test:integration

# openclaw-plugin (with coverage)
cd packages/openclaw-plugin && npm run test:coverage

# pd-cli
cd packages/pd-cli && npm test

# pd-console
cd packages/pd-console && npm test

# create-principles-disciple
cd packages/create-principles-disciple && npm test
```

### Test File Naming Convention

Test files follow the `*.test.ts` pattern. Test locations vary by package:

- `packages/<pkg>/tests/**/*.test.ts` - Test directory
- `packages/<pkg>/src/**/__tests__/**/*.test.ts` - Co-located tests
- `packages/<pkg>/tests/integration/**/*.test.ts` - Integration tests (openclaw-plugin)
- `packages/<pkg>/tests/e2e/*.test.ts` - E2E tests (pd-cli)

## Coverage Requirements

### openclaw-plugin (enforced thresholds)

| Type | Threshold |
|------|-----------|
| Lines | 58% |
| Functions | 65% |
| Branches | 45% |
| Statements | 57% |

Coverage is calculated excluding the `tests/` directory itself.

### Other packages

principles-core, pd-console have coverage configuration but no enforced thresholds. pd-cli and create-principles-disciple have no coverage configuration.

## TypeScript Strictness

All packages use `strict: true`. Additionally, `noUncheckedIndexedAccess: true` is enabled in **all 5 packages** to catch `array[i]` undefined bugs at compile time.

This decision was made to:
- Catch potential `undefined` array access bugs at compile time
- Force explicit handling of undefined cases (using `if (!item)` guards or `array.at(i)`)
- Align with Runtime Contract Rule 2 (no `as` bypass) — developers must use type guards, not assertions

## CI Integration

Tests run automatically via GitHub Actions (`.github/workflows/ci.yml`):

**Workflow Triggers:**
- Push to `main` or `develop` branches
- Pull requests to `main`

**Test Job Matrix:**
- Node.js versions: 20, 22

**CI Jobs (11 total):**
1. `verify-merge` - Canonical merge gate (`npm run verify:merge`)
2. `release-parity` - npm pack dry-run validation
3. `lint` - ESLint validation
4. `test` - Matrix test (Node 20/22)
5. `test-principles-core` - Core tests with coverage
6. `test-pd-cli` - CLI tests
7. `test-pd-console` - Console tests with coverage
8. `test-create-principles-disciple` - Installer tests
9. `build-openclaw-plugin` - Build + TypeScript check
10. `typecheck-pd-console` - TypeScript check
11. `test-openclaw-plugin-unit/integration/coverage` - Plugin tests (3 jobs)

## Quality Infrastructure

### Codecov Coverage Upload

CI uploads coverage reports to [Codecov](https://codecov.io) for the following packages:
- `principles-core` (flag: `principles-core`)
- `openclaw-plugin` (flag: `openclaw-plugin`)
- `pd-console` (flag: `pd-console`)

Coverage reports use `json` and `lcov` formats. Uploads use `codecov/codecov-action@v4` with `fail_ci_if_error: false` (coverage service failures do not block CI).

**Setup required:** Add `CODECOV_TOKEN` secret in GitHub repository settings.

### Performance Benchmark (retired)

The vitest benchmark suite and its CI job were retired in PRI-639: the last
benchmark file (`adapter-performance.bench.ts`) was removed together with the
orphaned `PainSignalAdapter` seam it measured, and no production module has an
active performance benchmark. Re-introduce `vitest bench` + baseline
comparison only when a performance budget area needs an executable suite.

### E2E Nightly CI

`.github/workflows/e2e-nightly.yml` runs daily at UTC 02:00 (Beijing 10:00):
- Executes `npm run e2e:story-a -- --trap trap-03`
- Validates full Story A' pipeline: pain → diagnosis → candidate → admission
- Uses LLM model specified in `E2E_LLM_MODEL` secret (or default if empty)
- On failure: creates/updates GitHub Issue `[E2E Nightly] Story A' pipeline failure`
- On success: auto-closes any open failure Issue
- Does not block regular PR pipeline

**Setup required:** Add `OPENAI_API_KEY` and `E2E_LLM_MODEL` secrets in GitHub repository settings.

### Monthly Quality Report

Generate a monthly quality report:

```bash
npm run quality:report
```

This creates `docs/quality-reports/YYYY-MM.md` with:
1. **Error Experience Handbook stats** — ERR total, recurring count, recurrence rate
2. **Test coverage** — Test file count per package
3. **Code coverage** — Lines/functions/branches/statements per package
4. **Module coupling** — Graph nodes, edges, god nodes from `graphify-out/graph.json`

### Verify Merge Gate

`npm run verify:merge` runs 9 checks before allowing merge:
1. `check:generated-artifacts` — Generated artifacts consistency
2. `check:error-handbook` — Error handbook integrity
3. `check:repo-hygiene` — Repository hygiene (no temp files, DB files)
4. `check:runtime-contract` — Runtime Contract incremental scan
5. `lint` — ESLint
6. `build` — Build core + plugin
7. `build:pd-cli` — Build CLI
8. `typecheck:openclaw-plugin` — TypeScript check
9. `typecheck:pd-console` — TypeScript check

### Git Hooks (lefthook)

- **pre-commit**: ESLint `--fix` on staged `.ts` files + repo-hygiene check
- **pre-push**: `protect-main` (protect main branch) + `verify:merge` (full merge gate)
