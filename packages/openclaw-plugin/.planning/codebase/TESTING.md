# Testing Patterns

**Analysis Date:** 2026-04-15

## Test Framework

**Runner:** Vitest 4.1.0
- Config: `vitest.config.ts`
- Environment: `node`
- Pool: `threads` (required for `better-sqlite3` native handle cleanup)

**Assertion Library:** Vitest built-in (`expect`)

**Coverage:** `@vitest/coverage-v8`
- Thresholds: lines 70%, functions 70%, branches 60%, statements 70%
- Excludes: `tests/**`

**Run Commands:**
```bash
npm test              # Run unit tests (fast, parallel)
npm run test:unit     # Alias for above
npm run test:integration  # Run integration tests only
npm run test:coverage # Run with coverage report
npm run test:all      # Run all tests (unit + integration)
```

## Test File Organization

**Location:**
- Tests co-located in `tests/` directory, mirroring `src/` structure
- `tests/core/`, `tests/commands/`, `tests/hooks/`, `tests/service/`, `tests/utils/`
- Integration tests in `tests/integration/`

**Naming:**
- `*.test.ts` suffix for all test files
- Example: `tests/core/detection-service.test.ts`

**Structure:**
```
tests/
├── commands/     # Command handlers
├── core/         # Core services and logic
├── fixtures/     # Shared fixtures
├── hooks/        # Hook handlers
├── integration/  # End-to-end tests
├── scripts/      # Script tests
└── service/      # Service layer
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('DetectionService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset state between tests
        DetectionService.reset();
    });

    it('should create a new instance on first get', () => {
        // Test implementation
    });
});
```

**Patterns:**
- `beforeEach` for setup, `afterEach` for teardown
- `vi.clearAllMocks()` between tests (not `vi.resetAllMocks()`)
- `vi.useFakeTimers()` / `vi.useRealTimers()` for time-sensitive tests

## Mocking

**Framework:** Vitest's `vi.fn()` and `vi.mock()`

**Module Mocking:**
```typescript
vi.mock('../../src/core/dictionary-service.js');
vi.mock('../../src/core/detection-funnel.js');

// Then configure mock implementations
vi.mocked(DictionaryService.get).mockReturnValue(mockDict as any);
```

**Built-in Module Mocking:**
```typescript
vi.mock('fs');
vi.mocked(fs.existsSync).mockReturnValue(true);
vi.mocked(fs.readFileSync).mockImplementation((p) => {
    if (p.toString() === configPath) return JSON.stringify(mockConfig);
    return '';
});
```

**Mock Reset:**
- `vi.clearAllMocks()` clears call history but keeps implementations
- `vi.resetAllMocks()` clears both (use with caution)
- Reset singleton state: `DetectionService.reset()`, `WorkspaceContext.clearCache()`

**Partial Mocks:**
```typescript
vi.mocked(fs.existsSync).mockImplementation((p) => p.toString() === configPath);
```

## Fixtures and Factories

**Temp Directory Pattern (integration tests):**
```typescript
const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-runtime-summary-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.state', 'sessions'), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

**JSON Fixture Writing:**
```typescript
function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}
```

**Session File Helper:**
```typescript
function writeSession(workspace: string, sessionId: string, payload: Record<string, unknown>): void {
  writeJson(path.join(workspace, '.state', 'sessions', `${sessionId}.json`), {
    sessionId,
    ...payload,
  });
}
```

## Integration Tests

**Requirements:**
- Real SQLite database via `better-sqlite3`
- Thread pool required (not `vm` pool) due to native handle cleanup issues
- Explicit file list in `vitest.config.ts` integration array

**Integration Test Files:**
```typescript
const integrationTests = [
  'tests/core/control-ui-db.test.ts',
  'tests/core/evolution-logger.test.ts',
  'tests/core/nocturnal-e2e.test.ts',
  // ...
];
```

## Common Patterns

**Async Testing with Fake Timers:**
```typescript
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('should retry on retryable error', async () => {
  const fn = vi.fn()
    .mockRejectedValueOnce(new Error('ETIMEDOUT'))
    .mockResolvedValue('success');

  const resultPromise = retryAsync(fn, { initialDelayMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  const result = await resultPromise;
  expect(result).toBe('success');
});
```

**Error Testing:**
```typescript
it('should throw after max retries exceeded', async () => {
  vi.useRealTimers();
  const fn = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));

  await expect(retryAsync(fn, { maxRetries: 1, initialDelayMs: 1, logger: { warn: vi.fn() } }))
    .rejects.toThrow('ETIMEDOUT');
});
```

**Singleton Reset Pattern:**
```typescript
// Many services use singleton pattern requiring reset between tests
DetectionService.reset();
WorkspaceContext.clearCache();
clearSession('live-session');
```

## Test Naming and Documentation

**Descriptive Test Names:**
```typescript
it('should block risk path writes at Seed tier (EP system)', () => { ... });
it('should return default values if file does not exist', () => { ... });
```

**Test Comments for Context:**
```typescript
// Task 4: Default Values Consistency Tests
describe('Gate Default Values Consistency', () => {
  /**
   * PURPOSE: Prove that gate.ts inline defaults match PROFILE_DEFAULTS.
   * If gate.ts has inline defaults that differ from normalizeProfile(),
   * this is a bug - the defaults should come from a single source of truth.
   */
});
```

## Test Isolation

**Environment Variable Injection:**
```typescript
// Set env before module load
process.env.PD_TEST_AGENTS_DIR = TEST_AGENTS_DIR;
```

**Path Traversal Protection Tests:**
```typescript
it('rejects path traversal session IDs', async () => {
  const result = await extractRecentConversation('../../etc/passwd', 'main');
  expect(result).toBe('');
});
```

---

*Testing analysis: 2026-04-15*
