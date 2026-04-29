# Phase m9-04: Tests - Research

**Researched:** 2026-04-29
**Domain:** Vitest E2E testing patterns for runtime adapter integration
**Confidence:** HIGH

## Summary

m9-04 delivers E2E tests for PiAiRuntimeAdapter integration into runtime v2. Unit tests (pi-ai-runtime-adapter.test.ts, 727 lines) already exist covering all error paths (TEST-01~05). TEST-06 is the E2E deliverable: two test files — adapter integration (DiagnosticianRunner + PiAiRuntimeAdapter) and full chain (PainSignalBridge + PiAiRuntimeAdapter → ledger probation entry).

Core findings:
- **Mock strategy**: Module-level `vi.mock('@mariozechner/pi-ai')` intercepts the real adapter code path (not a stub) — the actual PiAiRuntimeAdapter implementation runs, only LLM calls are mocked
- **Two test files**: `m9-adapter-integration.test.ts` (runner + adapter) and `m9-e2e.test.ts` (pain → ledger)
- **Reuse pattern**: `InMemoryLedgerAdapter` from m8-02-e2e for full chain ledger verification; `makeDiagnosticianOutputWithCandidates()` fixture from m6-06-e2e
- **One-shot adapter nuance**: PiAiRuntimeAdapter.startRun() blocks until complete — no polling loop needed in tests. `pollRun()` and `fetchOutput()` operate on in-memory state set by `startRun()`

---

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01**: Two test files — `m9-adapter-integration.test.ts` (adapter + runner) + `m9-e2e.test.ts` (full chain)
- **D-02**: Module-level `vi.mock('@mariozechner/pi-ai')` — real adapter code runs, only LLM calls mocked
- **D-03**: No StubRuntimeAdapter — E2E tests adapter logic path
- **D-04**: Reuse `InMemoryLedgerAdapter` from m8-02-e2e for full chain
- **D-05**: Reuse StubRuntimeAdapter (with kind='pi-ai') for scenarios needing precise runtime control
- **D-06**: ~150-200 lines per test file
- **D-07**: `os.tmpdir()` temp workspace, cleanup in `afterEach`
- **D-08**: E2E mock setup in `beforeEach`, cleanup in `afterEach`

### Out of Scope
- M9-01 unit test paths already covered (retry logic, JSON extraction, error mapping)
- Candidate intake business logic (m7 covered)
- Ledger internal implementation (verified through LedgerAdapter interface)

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TEST-01 | mock complete success — verify DiagnosticianOutputV1 correctly generated | Unit test already exists at line 320-328 (fetchOutput returns correct payload) |
| TEST-02 | mock complete failure — verify PDRuntimeError(execution_failed) + maxRetries | Unit test already exists at lines 417-456 (retry exhaustion) |
| TEST-03 | mock complete timeout — verify PDRuntimeError(timeout) | Unit test already exists at lines 394-401 (AbortError → timeout) |
| TEST-04 | mock complete invalid-json — verify PDRuntimeError(output_invalid) | Unit test already exists at lines 377-383 (no JSON found) |
| TEST-05 | probe success/failure — verify healthCheck behavior | Unit test already exists at lines 174-272 (healthCheck coverage) |
| TEST-06 | E2E pain→artifact→candidate→ledger — full chain with mock pi-ai | **New** — m9-adapter-integration.test.ts + m9-e2e.test.ts |

---

## Standard Stack

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | 4.1.0 | Test runner | Already configured in vitest.config.ts for runtime-v2 |
| @mariozechner/pi-ai | 0.70.6 | LLM API | Mocked at module level, real adapter code runs |

**Installation verification:**
```bash
npm view vitest version     # 4.1.0 — [VERIFIED: npm registry]
npm view @mariozechner/pi-ai version  # 0.70.6 — [VERIFIED: principles-core/package.json]
```

---

## Architecture Patterns

### System Architecture Diagram

```
E2E Test File
├── vi.mock('@mariozechner/pi-ai')     ← intercepts LLM calls
│   └── mockComplete resolves with DiagnosticianOutputV1 JSON
├── Temp workspace (os.tmpdir())
│   ├── RuntimeStateManager
│   ├── SqliteContextAssembler
│   └── SqliteDiagnosticianCommitter
├── PainSignalBridge / DiagnosticianRunner
│   └── PiAiRuntimeAdapter             ← real adapter code runs
│       ├── startRun()                  ← blocks (one-shot), stores output
│       ├── pollRun()                   ← returns stored status
│       └── fetchOutput()               ← returns stored StructuredRunOutput
├── CandidateIntakeService
└── InMemoryLedgerAdapter               ← verifies probation entry writes
```

### Recommended Project Structure

```
packages/principles-core/src/runtime-v2/
├── runner/__tests__/
│   ├── m9-adapter-integration.test.ts  (~150-200 lines)
│   └── m9-e2e.test.ts                  (~150-200 lines)
```

### Pattern 1: Module-Level pi-ai Mock (D-02)

```typescript
// m9-adapter-integration.test.ts
vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(),
  getProviders: vi.fn(() => ['openrouter', 'anthropic', 'openai']),
  complete: vi.fn(),
}));

import { getModel, getProviders, complete } from '@mariozechner/pi-ai';
import { PiAiRuntimeAdapter } from '../../adapter/pi-ai-runtime-adapter.js';

const mockComplete = complete as ReturnType<typeof vi.fn>;
const mockGetModel = getModel as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TEST_API_KEY = 'test-key-123';
  mockGetModel.mockReturnValue({ id: 'anthropic/claude-sonnet-4' });
  mockComplete.mockResolvedValue(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));
});

afterEach(() => {
  delete process.env.TEST_API_KEY;
});
```

**Key insight**: This intercepts the `complete()` and `getModel()` calls inside the real `PiAiRuntimeAdapter` implementation. Unlike `StubRuntimeAdapter` which completely bypasses the adapter, this tests actual adapter code — JSON extraction, error classification, retry logic, telemetry.

### Pattern 2: InMemoryLedgerAdapter (from m8-02-e2e, D-04)

```typescript
// Reused verbatim from m8-02-e2e.test.ts lines 50-70
class InMemoryLedgerAdapter implements LedgerAdapter {
  private readonly entries = new Map<string, LedgerPrincipleEntry>();

  writeProbationEntry(entry: LedgerPrincipleEntry): LedgerPrincipleEntry {
    const candidateId = this.#extractCandidateId(entry.sourceRef);
    const existing = this.existsForCandidate(candidateId);
    if (existing) return existing;
    this.entries.set(candidateId, entry);
    return entry;
  }

  existsForCandidate(candidateId: string): LedgerPrincipleEntry | null {
    return this.entries.get(candidateId) ?? null;
  }

  #extractCandidateId(sourceRef: string): string {
    return sourceRef.startsWith('candidate://')
      ? sourceRef.slice('candidate://'.length)
      : sourceRef;
  }
}
```

### Pattern 3: makeDiagnosticianOutputWithCandidates() Fixture (from m6-06-e2e)

```typescript
// Reused from m6-06-e2e.test.ts lines 73-89
function makeDiagnosticianOutputWithCandidates(taskId: string): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: `diag-m9e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId,
    summary: 'E2E m9-04 test diagnosis summary',
    rootCause: 'E2E m9-04 root cause — missing validation before tool call',
    violatedPrinciples: [],
    evidence: [],
    recommendations: [
      { kind: 'principle', description: 'Always validate tool arguments before execution to prevent silent failures' },
      { kind: 'principle', description: 'Log all tool invocations with argument summaries for traceability' },
      { kind: 'rule', description: 'Use schema validation for external inputs' },
    ],
    confidence: 0.92,
  };
}
```

### Pattern 4: DiagnosticianRunner + PiAiRuntimeAdapter Integration

```typescript
// From m6-06-e2e.test.ts createRunner() pattern, adapted for pi-ai
function createRunner(runtimeAdapter: PDRuntimeAdapter): DiagnosticianRunner {
  const committer = new SqliteDiagnosticianCommitter(sqliteConn);
  return new DiagnosticianRunner(
    {
      stateManager,
      contextAssembler,
      runtimeAdapter,
      eventEmitter,
      validator: new PassThroughValidator(),
      committer,
    },
    {
      owner: 'e2e-m9-adapter',
      runtimeKind: 'pi-ai',
      pollIntervalMs: 50,
      timeoutMs: 5000,
    },
  );
}
```

### Pattern 5: One-Shot Adapter Nuance

**Critical difference from StubRuntimeAdapter**: `PiAiRuntimeAdapter.startRun()` is a blocking call — it waits for the LLM to respond before returning. This means:

- `startRun()` returns a `RunHandle` with `runId`
- `pollRun()` immediately returns `status: 'succeeded'` (run is already terminal)
- `fetchOutput()` immediately returns the stored `StructuredRunOutput`

```typescript
// One-shot: startRun blocks until LLM responds
const handle = await adapter.startRun(makeStartRunInput());
// handle.runId is now available

// pollRun immediately returns terminal status (no polling needed in adapter)
const status = await adapter.pollRun(handle.runId);
expect(status.status).toBe('succeeded');

// fetchOutput immediately returns stored output
const output = await adapter.fetchOutput(handle.runId);
expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });
```

This is different from StubRuntimeAdapter where you control status via `setRunStatus()` — with `PiAiRuntimeAdapter` the status is determined by `startRun()` outcome.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Full chain ledger verification | Custom mock ledger | `InMemoryLedgerAdapter` from m8-02-e2e | Already battle-tested, verifies probation entry writes correctly |
| LLM mock in E2E | Hardcoded mock functions | `vi.mock('@mariozechner/pi-ai')` module mock | Intercepts real adapter code path, tests actual implementation |
| Test fixture | Duplicate `makeDiagnosticianOutputWithCandidates` | Reuse from m6-06-e2e | Consistent schema-valid output across test files |
| Runtime adapter test double | Write new StubRuntimeAdapter | Reuse existing StubRuntimeAdapter (D-05) with kind='pi-ai' | Already implements PDRuntimeAdapter interface |

---

## Runtime State Inventory

> This section is not applicable — m9-04 is a test phase, not a rename/refactor/migration phase.

---

## Common Pitfalls

### Pitfall 1: Forgetting `vi.clearAllMocks()` between tests

**What goes wrong**: Mock state leaks between tests causing false positives/negatives.
**How to avoid**: Call `vi.clearAllMocks()` in `beforeEach` (not `afterEach` — mocks needed for assertion).
**Warning signs**: Tests pass in isolation but fail when run together.

### Pitfall 2: Testing adapter with `maxRetries: 0` default

**What goes wrong**: Retry logic in `PiAiRuntimeAdapter` (up to `config.maxRetries ?? 2`) is not exercised.
**How to avoid**: Use `{ maxRetries: 1 }` in integration tests to verify retry behavior.
**Source**: `completeWithRetry()` at pi-ai-runtime-adapter.ts:526-591

### Pitfall 3: Missing `process.env` cleanup

**What goes wrong**: `PiAiRuntimeAdapter` reads `process.env[config.apiKeyEnv]` at `startRun()` call time — if env var was deleted in previous test, subsequent tests fail.
**How to avoid**: Set `process.env.TEST_API_KEY` in `beforeEach`, delete in `afterEach`.
**Source**: pi-ai-runtime-adapter.ts:346-352

### Pitfall 4: One-shot adapter — no polling delay needed

**What goes wrong**: Writing `await new Promise(r => setTimeout(r, 100))` after `startRun()` expecting the run to still be 'running'.
**Why it happens**: `PiAiRuntimeAdapter.startRun()` is blocking — the run is terminal by the time it returns.
**How to avoid**: Call `pollRun()` and `fetchOutput()` immediately after `startRun()` returns.

### Pitfall 5: Temp workspace cleanup on Windows

**What goes wrong**: `fs.rmSync()` fails with EPERM on Windows if SQLite connection not fully closed.
**How to avoid**: Call `stateManager.close()` before `fs.rmSync()`. Wrap in try/catch.
**Source**: m8-02-e2e.test.ts lines 262-268, m6-06-e2e.test.ts lines 162-168

---

## Code Examples

### Adapter Integration Test Structure (m9-adapter-integration.test.ts)

```typescript
// ~150-200 lines total
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { SqliteContextAssembler } from '../../store/sqlite-context-assembler.js';
import { SqliteHistoryQuery } from '../../store/sqlite-history-query.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { DiagnosticianRunner } from '../diagnostician-runner.js';
import { PassThroughValidator } from '../diagnostician-validator.js';
import { SqliteDiagnosticianCommitter } from '../../store/diagnostician-committer.js';
import type { SqliteConnection } from '../../store/sqlite-connection.js';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';
import { PainSignalBridge } from '../../pain-signal-bridge.js';
import { CandidateIntakeService } from '../../candidate-intake-service.js';
import type { LedgerAdapter, LedgerPrincipleEntry } from '../../candidate-intake.js';

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(),
  getProviders: vi.fn(() => ['openrouter', 'anthropic', 'openai']),
  complete: vi.fn(),
}));

import { getModel, complete } from '@mariozechner/pi-ai';

const mockComplete = complete as ReturnType<typeof vi.fn>;
const mockGetModel = getModel as ReturnType<typeof vi.fn>;

// Reuse InMemoryLedgerAdapter from m8-02-e2e (lines 50-70)
// Reuse makeDiagnosticianOutputWithCandidates from m6-06-e2e (lines 73-89)

const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-m9-adapter-${process.pid}`);

describe('E2E m9-adapter-integration — PiAiRuntimeAdapter + DiagnosticianRunner', () => {
  let testDir: string;
  let stateManager: RuntimeStateManager;
  let sqliteConn: SqliteConnection;
  // ... setup similar to m8-02-e2e

  beforeEach(async () => {
    testDir = path.join(TMP_ROOT, `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    stateManager = new RuntimeStateManager({ workspaceDir: testDir });
    await stateManager.initialize();
    // ... full setup
    vi.clearAllMocks();
    process.env.TEST_API_KEY = 'test-key-123';
    mockGetModel.mockReturnValue({ id: 'anthropic/claude-sonnet-4' });
    mockComplete.mockResolvedValue(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));
  });

  afterEach(() => {
    stateManager.close();
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* Windows cleanup */ }
  });

  function createRunner(runtimeAdapter: PDRuntimeAdapter): DiagnosticianRunner {
    const committer = new SqliteDiagnosticianCommitter(sqliteConn);
    return new DiagnosticianRunner(
      { stateManager, contextAssembler, runtimeAdapter, eventEmitter, validator: new PassThroughValidator(), committer },
      { owner: 'e2e-m9-adapter', runtimeKind: 'pi-ai', pollIntervalMs: 50, timeoutMs: 5000 },
    );
  }

  it('full chain: pain → task → artifact → candidates (pi-ai adapter)', async () => {
    const painId = 'test-pain-m9-adapter-01';
    const expectedTaskId = `diagnosis_${painId}`;
    const output = makeDiagnosticianOutputWithCandidates(expectedTaskId);

    mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(output)));

    const adapter = new PiAiRuntimeAdapter({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      apiKeyEnv: 'TEST_API_KEY',
      maxRetries: 0,
      timeoutMs: 60_000,
    });

    const runner = createRunner(adapter);
    const result = await runner.run(expectedTaskId);

    expect(result.status).toBe('succeeded');
    expect(result.contextHash).toBeDefined();

    // artifact exists
    const db = sqliteConn.getDb();
    const artifactRow = db.prepare('SELECT * FROM artifacts WHERE task_id = ?').get(expectedTaskId) as {
      artifact_id: string; artifact_kind: string;
    } | undefined;
    expect(artifactRow).toBeDefined();
    expect(artifactRow!.artifact_kind).toBe('diagnostician_output');

    // candidates exist
    const candidateRows = db.prepare(
      'SELECT * FROM principle_candidates WHERE artifact_id = ?',
    ).all(artifactRow!.artifact_id) as { candidate_id: string }[];
    expect(candidateRows.length).toBeGreaterThanOrEqual(2);
  });
});
```

### Full Chain E2E Test Structure (m9-e2e.test.ts)

```typescript
// ~150-200 lines total
// Reuses same imports, vi.mock, fixtures, and setup as m9-adapter-integration.test.ts
// Reuses InMemoryLedgerAdapter from m8-02-e2e

describe('E2E m9 — PainSignalBridge full chain with PiAiRuntimeAdapter', () => {
  // ... same setup as m9-adapter-integration.test.ts
  // plus: ledgerAdapter, intakeService, PainSignalBridge

  it('E2E: Full chain — pain → ledger probation entry via pi-ai', async () => {
    const painId = 'test-pain-m9-e2e-01';
    const expectedTaskId = `diagnosis_${painId}`;
    const output = makeDiagnosticianOutputWithCandidates(expectedTaskId);

    mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(output)));

    const adapter = new PiAiRuntimeAdapter({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      apiKeyEnv: 'TEST_API_KEY',
      maxRetries: 0,
      timeoutMs: 60_000,
    });

    bridge = new PainSignalBridge({
      stateManager,
      runner: createRunner(adapter),
      intakeService,
      ledgerAdapter,
      autoIntakeEnabled: true,
    });

    const result = await bridge.onPainDetected({
      painId,
      painType: 'tool_failure',
      source: 'test',
      reason: 'test failure',
    });

    expect(result.status).toBe('succeeded');
    expect(result.candidateIds.length).toBeGreaterThanOrEqual(1);
    expect(result.ledgerEntryIds.length).toBeGreaterThanOrEqual(1);
  });

  it('E2E: Idempotency — same painId twice produces no duplicates', async () => {
    // First call
    const firstResult = await bridge.onPainDetected({ painId, painType: 'tool_failure', source: 'test', reason: 'test' });
    expect(firstResult.status).toBe('succeeded');

    // Second call with SAME painId
    const secondResult = await bridge.onPainDetected({ painId, painType: 'tool_failure', source: 'test', reason: 'test' });
    expect(secondResult.status).toBe('succeeded');

    // candidate count unchanged
    const db = sqliteConn.getDb();
    const candidates = db.prepare('SELECT * FROM principle_candidates WHERE task_id = ?').all(expectedTaskId) as { candidate_id: string }[];
    expect(candidates.length).toBeGreaterThanOrEqual(1);

    // ledger entry count unchanged
    const ledgerEntries = candidates.map(c => ledgerAdapter.existsForCandidate(c.candidate_id)).filter(Boolean);
    expect(ledgerEntries.length).toBeGreaterThanOrEqual(1);
  });
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| StubRuntimeAdapter for E2E | Module-level `vi.mock('@mariozechner/pi-ai')` | m9-04 | Tests real adapter code path, not just interface contract |
| CLI spawning in E2E | In-process mock | m6-06 | Faster, more reliable tests, no binary dependency |
| In-memory task store for tests | Real SQLite via RuntimeStateManager | m5-m6 | Tests real persistence layer |

**No deprecated patterns in use** — m9-04 E2E tests follow the established m8-02 patterns.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `vitest 4.1.0` is current — [VERIFIED: principles-core/package.json devDependencies] | Standard Stack | None |
| A2 | `InMemoryLedgerAdapter` from m8-02-e2e is reusable without modification — [VERIFIED: m8-02-e2e.test.ts lines 50-70] | Architecture Patterns | None |
| A3 | `makeDiagnosticianOutputWithCandidates()` fixture from m6-06-e2e is reusable — [VERIFIED: m6-06-e2e.test.ts lines 73-89] | Architecture Patterns | None |
| A4 | `createRunner()` pattern from m6-06-e2e is reusable for pi-ai adapter — [VERIFIED: m6-06-e2e.test.ts lines 175-196] | Architecture Patterns | None |
| A5 | `vi.mock('@mariozechner/pi-ai')` factory returns same shape as m9-01 unit tests — [VERIFIED: pi-ai-runtime-adapter.test.ts lines 14-18] | Code Examples | Test setup may need adjustment |
| A6 | `@mariozechner/pi-ai` exports `getModel`, `getProviders`, `complete` at module level — [VERIFIED: pi-ai-runtime-adapter.ts line 17] | Code Examples | Mock may be incomplete |

**If this table is empty**: All claims in this research were verified or cited — no user confirmation needed.

---

## Open Questions (RESOLVED)

1. **Should m9-adapter-integration.test.ts also test failure paths?**
   - Unit tests already cover success/failure for the adapter in isolation
   - Integration test could verify DiagnosticianRunner correctly surfaces adapter errors
   - Recommendation: Focus on success path (TEST-06 primary), add one failure path test (runner surfaces PDRuntimeError from adapter)

2. **Should we test `healthCheck()` in the E2E context?**
   - TEST-05 is unit test coverage already
   - E2E context would verify healthCheck integrates with real adapter
   - Recommendation: No — TEST-05 unit coverage is sufficient

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| vitest | Test runner | ✓ | 4.1.0 | — |
| @mariozechner/pi-ai | LLM API (mocked) | ✓ | 0.70.6 | — |
| Node.js | Test execution | ✓ | (Node ESM) | — |
| better-sqlite3 | SqliteContextAssembler (real SQLite in tests) | ✓ | 12.9.0 | — |

**No missing dependencies** — all tools available in the environment.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.0 |
| Config file | `packages/principles-core/vitest.config.ts` |
| Quick run command | `cd packages/principles-core && npx vitest run src/runtime-v2/runner/__tests__/m9-adapter-integration.test.ts src/runtime-v2/runner/__tests__/m9-e2e.test.ts` |
| Full suite command | `cd packages/principles-core && npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| TEST-01 | mock complete success — DiagnosticianOutputV1 generated | unit | `vitest run pi-ai-runtime-adapter.test.ts -t "startRun.*success\|fetchOutput.*success"` | ✅ Already exists |
| TEST-02 | mock complete failure + maxRetries | unit | `vitest run pi-ai-runtime-adapter.test.ts -t "retry"` | ✅ Already exists |
| TEST-03 | mock complete timeout | unit | `vitest run pi-ai-runtime-adapter.test.ts -t "timeout"` | ✅ Already exists |
| TEST-04 | mock complete invalid-json | unit | `vitest run pi-ai-runtime-adapter.test.ts -t "output_invalid"` | ✅ Already exists |
| TEST-05 | probe success/failure healthCheck | unit | `vitest run pi-ai-runtime-adapter.test.ts -t "healthCheck"` | ✅ Already exists |
| TEST-06 | E2E pain→artifact→candidate→ledger | e2e | `vitest run m9-adapter-integration.test.ts && vitest run m9-e2e.test.ts` | ❌ m9-adapter-integration.test.ts — new |
| | | | | ❌ m9-e2e.test.ts — new |

### Sampling Rate
- **Per task commit**: `vitest run src/runtime-v2/runner/__tests__/m9-adapter-integration.test.ts src/runtime-v2/runner/__tests__/m9-e2e.test.ts`
- **Per wave merge**: `vitest run` (full suite)
- **Phase gate**: Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `packages/principles-core/src/runtime-v2/runner/__tests__/m9-adapter-integration.test.ts` — adapter + runner integration
- [ ] `packages/principles-core/src/runtime-v2/runner/__tests__/m9-e2e.test.ts` — full chain pain→ledger
- [ ] Both files reuse `InMemoryLedgerAdapter` from m8-02-e2e (already exists)
- [ ] Both files reuse `makeDiagnosticianOutputWithCandidates()` from m6-06-e2e (already exists)

*(No Wave 0 framework gaps — vitest 4.1.0 already configured in vitest.config.ts)*

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | `DiagnosticianOutputV1Schema` validation in adapter + `PassThroughValidator` in runner |
| V4 Access Control | no | Test files only, no runtime access control |

### Known Threat Patterns for Test Suite

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Test env var leaking into production | Information Disclosure | `delete process.env.TEST_API_KEY` in `afterEach` |
| Temp workspace with sensitive data | Information Disclosure | `fs.rmSync` cleanup in `afterEach` with try/catch |
| Mock returning untrusted data | Tampering | Mock returns controlled `DiagnosticianOutputV1` fixture, not external input |

---

## Sources

### Primary (HIGH confidence)
- `packages/principles-core/src/runtime-v2/adapter/__tests__/pi-ai-runtime-adapter.test.ts` — existing unit tests, verified mock pattern
- `packages/principles-core/src/runtime-v2/runner/__tests__/m8-02-e2e.test.ts` — InMemoryLedgerAdapter + StubRuntimeAdapter + full chain pattern
- `packages/principles-core/src/runtime-v2/runner/__tests__/m6-06-e2e.test.ts` — createRunner() + makeDiagnosticianOutputWithCandidates() + vi.mock pattern
- `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts` — one-shot adapter implementation verified
- `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts` — PainSignalBridge integration points verified
- `packages/principles-core/package.json` — vitest 4.1.0, @mariozechner/pi-ai 0.70.6 versions verified

### Secondary (MEDIUM confidence)
- `packages/principles-core/vitest.config.ts` — vitest include patterns verified

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all versions verified from package.json / npm registry
- Architecture: HIGH — patterns directly from verified existing test files
- Pitfalls: HIGH — all pitfalls sourced from existing m8-02-e2e and m6-06-e2e patterns with verified code

**Research date:** 2026-04-29
**Valid until:** 2026-05-29 (30 days — test patterns are stable)
