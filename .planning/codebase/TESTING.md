# TESTING.md - Test Structure & Practices

## Framework & Configuration

- **Framework**: Vitest 4.x (`vitest.config.ts`)
- **Environment**: Node.js (`environment: 'node'`)
- **Parallelism**: `pool: 'forks'` (each test file runs in separate process)
- **Coverage**: v8 provider
  - Thresholds: lines/functions/statements 70%, branches 60%
- **Test files**: `tests/**/*.test.ts` and `tests/**/*.test.tsx`

## Test Scale

- **143 test files**
- **2524+ test cases** (`describe`/`it`/`test`)
- Test directory structure mirrors `src/`:
  - `tests/core/` — Core logic tests (largest)
  - `tests/hooks/` — Hook tests
  - `tests/commands/` — Command tests
  - `tests/service/` — Service tests
  - `tests/integration/` — Integration tests
  - `tests/http/` — HTTP route tests
  - `tests/scripts/` — Script tests
  - `tests/utils/` — Utility tests

## Test Patterns

```typescript
// Standard test structure
describe('EvolutionEngine', () => {
  let workspace: string;
  let engine: EvolutionEngine;

  beforeEach(() => {
    workspace = createTempWorkspace();
    engine = new EvolutionEngine(workspace);
  });

  afterEach(() => {
    disposeAllEvolutionEngines();
    cleanupWorkspace(workspace);
  });

  test('should start at Seed tier with 0 points', () => { ... });
});
```

- **Temp directory isolation**: Uses `os.tmpdir()` for test isolation
- **`it.todo()`**: Marks unimplemented tests (e.g., `nocturnal-workflow-manager.test.ts` L435-437 — 3 Trinity state transition tests)
- **E2E tests**: `evolution-e2e.test.ts`, `evolution-user-stories.e2e.test.ts`

## Coverage Thresholds

| Metric | Threshold |
|--------|-----------|
| Lines | 70% |
| Functions | 70% |
| Statements | 70% |
| Branches | 60% |

## Test Commands

```bash
# Run all tests
npm test

# Run with coverage
npm run coverage

# Run specific test file
npx vitest run tests/core/evolution-engine.test.ts
```
