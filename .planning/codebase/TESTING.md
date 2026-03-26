# Testing

**Analysis Date:** 2026-03-26

## Test Framework

**Vitest** — Not Jest. Modern Vite-native test framework.

**Configuration** (`vitest.config.ts`):
```typescript
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['tests/**']
    }
  }
})
```

**Run Commands:**
```bash
# Run all tests
cd packages/openclaw-plugin && npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- src/core/trust-engine.test.ts
```

## Test File Organization

**Location:** `packages/openclaw-plugin/tests/`

**Structure mirrors `src/`:**
```
tests/
 ├── core/                    # Tests for src/core/ (trust-engine, evolution-engine, etc.)
 ├── hooks/                   # Tests for src/hooks/ (gate, pain, prompt, etc.)
 ├── commands/                # Tests for src/commands/ (slash commands)
 ├── service/                 # Tests for src/service/ (background workers)
 ├── tools/                   # Tests for src/tools/ (deep-reflect, etc.)
 ├── utils/                   # Tests for src/utils/ (file-lock, io, etc.)
 ├── http/                    # Tests for src/http/
 ├── fixtures/                # Test fixtures and helpers
 ├── index.test.ts            # Plugin registration tests
 ├── index.integration.test.ts # Integration tests
 ├── build-artifacts.test.ts  # Build output validation
 ├── task-compliance.test.ts   # Task compliance tests
 └── hygiene-tracker.test.ts  # Hygiene metrics tests
```

**Total:** 78 test files covering all major modules

**Naming Conventions:**
- `*.test.ts` — Standard unit tests
- `*.e2e.test.ts` — End-to-end tests (e.g., `evolution-e2e.test.ts`)
- `*-integration.test.ts` — Integration tests (e.g., `evolution-engine-gate-integration.test.ts`)

## Test Helpers and Utilities

### Test Context Factory
```typescript
// From tests/test-utils.ts
import { createTestContext } from './test-utils'

// Isolated workspace for each test
const ctx = createTestContext({
  workspaceDir: '/mock/workspace',
  stateDir: '/mock/state',
})

// Factory creates temp dir if not specified
const ctx = createTestContext(); // Creates tmpDir automatically

// Clears cache between tests
WorkspaceContext.clearCache();
```

### Production Mock Generator
**Location:** `tests/fixtures/production-mock-generator.ts`

Extracts patterns from production data to create realistic test fixtures.

**Usage:**
```typescript
import {
  generateTestFixtureFromProduction,
  createMockQueueItem,
  createMockPainFlag,
  validateProductionCompatibility
} from '../fixtures/production-mock-generator'

// Generate fixtures from real production data
const fixtures = generateTestFixtureFromProduction();

// Create mock with production-like structure
const mockItem = createMockQueueItem({
  score: 50,
  source: 'tool_failure',
  reason: 'Test error'
});

// Validate code handles production data correctly
const validation = validateProductionCompatibility();
expect(validation.compatible).toBe(true);
```

**Benefits:**
- Tests match real-world scenarios
- Catches edge cases from production
- Validates backward compatibility when adding new fields

### Mock Patterns

**Vitest mocking:**
```typescript
import { vi, describe, it, expect } from 'vitest'

// Mock a module
vi.mock('../src/core/trajectory', () => ({
  TrajectoryRegistry: {
    get: vi.fn(() => mockTrajectory)
  }
}))

// Use vi.mocked() for typed mocks
vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any)
vi.mocked(fs.existsSync).mockImplementation((p) => p.toString() === configPath)

// Clear mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
})
```

**What to Mock:**
- External dependencies (`fs`, `path`, `os`)
- Services from other modules (`WorkspaceContext`, `EventLogService`)
- Internal utilities (`ioUtils`, `sessionTracker`)

**What NOT to Mock:**
- The module under test (test actual behavior)
- Simple utility functions unless they have side effects

### Assertion Libraries

- **Vitest built-in:** `expect()` with type checking
- **No external assertion library needed** — Vitest's expect is comprehensive

## Test Coverage Standards

**Coverage Configuration:**
- Provider: v8
- Reporters: text, html
- Excluded: tests/, node_modules/, *.d.ts

**Current coverage targets:** Not explicitly enforced, but tests are comprehensive

| Module | Test Coverage |
|--------|---------------|
| Core (trust, evolution) | High — unit + integration tests |
| Hooks (gate, pain, prompt) | High — behavioral tests |
| Commands | Medium — smoke tests |
| Utils (file-lock, io) | High — edge cases |
| Service (evolution-worker) | Medium — integration tests |

## E2E Testing Approach

**Location:** `tests/` root level + `tests/core/evolution-e2e.test.ts`

**E2E test types:**

| File | Scope |
|------|-------|
| `index.integration.test.ts` | Plugin registration and lifecycle |
| `core/evolution-e2e.test.ts` | Full evolution pipeline |
| `core/evolution-user-stories.e2e.test.ts` | User journey tests |
| `fixtures/production-compatibility.test.ts` | Production environment compatibility |

### E2E Test Pattern
```typescript
describe('Evolution E2E', () => {
  it('should detect pain and generate principle', async () => {
    // 1. Create isolated test workspace
    const workspace = await setupTestWorkspace()
    
    // 2. Simulate tool failure (pain signal)
    await simulateToolFailure(workspace, 'git commit', error)
    
    // 3. Trigger evolution
    await runEvolutionWorker(workspace)
    
    // 4. Verify principle generated
    const principles = await readEvolutionLog(workspace)
    expect(principles).toContainEqual(expect.objectContaining({
      type: 'principle_generated'
    }))
  })
})
```

## Integration Testing

**Approach:** Isolated workspace per test using `createTestContext()`

**Setup/Cleanup Pattern:**
```typescript
describe('EventLog', () => {
  let tempDir: string;
  let eventLog: EventLog;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-log-test-'));
    eventLog = new EventLog(tempDir);
  });

  afterEach(() => {
    eventLog.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
```

**Example Integration Test:**
```typescript
it('should accumulate EP on success', async () => {
  const ctx = await createTestContext()

  // Simulate successful task
  await ctx.trustEngine.recordSuccess(ctx.workspaceDir)

  // Verify EP increased
  const trust = await ctx.trustEngine.getTrust(ctx.workspaceDir)
  expect(trust.ep).toBeGreaterThan(0)
})
```

## Coverage Configuration

From `vitest.config.ts`:
```typescript
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        '**/*.d.ts'
      ]
    }
  }
})
```

## Quality Standards

| Standard | Enforcement |
|----------|-------------|
| No `as any` | TypeScript strict mode — compile fails |
| No `@ts-ignore`, `@ts-expect-error` | Prohibited by convention |
| No skipped tests | Convention only — CI does not enforce |
| No empty tests | Convention only |
| Isolated tests | Each test gets its own tempDir via `createTestContext()` |
| Cleanup after tests | `afterEach` removes temp directories |
| Descriptive test names | Convention: `it('should [behavior] when [condition]')` |

**Test Naming Pattern:**
```typescript
// Good: Descriptive
it('should load config from file if it exists')
it('should capture pain on tool error with correct source')
it('should return default values if file does not exist')

// Avoid: Vague names
it('test config')
it('pain detection')
```

---

*Testing analysis: 2026-03-26*
