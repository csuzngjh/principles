/**
 * Task 3 — Dead letter integration test for `emitPainDetectedEvent`.
 *
 * Spec: .trae/specs/feedback-pipeline-observability/spec.md
 * Scenario: Pain emit fails → dead_letter_pains row + PAIN_DEAD_LETTER log + no throw.
 *
 * Strategy:
 *  - Real temp workspace + real SqliteConnection + real SqliteDeadLetterStore
 *    (exercises the actual dead-letter write path end-to-end).
 *  - Mock PainToPrincipleService.recordPain to reject (simulates pipeline failure).
 *  - Mock loadPdConfigForPlugin / createIntentDocReader to keep the factory I/O-free.
 *  - Spy on SystemLogger.log to assert observable PAIN_DEAD_LETTER / PAIN_SERVICE_ERROR entries.
 *
 * ERR checklist:
 *  - EP-03 / ERR-002 (fail loud): test verifies the hook does NOT silently swallow
 *    the recordPain failure — it must write dead letter + log PAIN_DEAD_LETTER.
 *  - rc-9-no-silent-fallback: deadLetterInserted=true asserted in the log payload.
 *  - rc-1-treat-as-unknown: painData read back from the store is asserted via
 *    objectContaining, not via `as` cast to a typed shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { emitPainDetectedEvent } from '../../src/hooks/pain.js';
import { SystemLogger, disposeAllSystemLoggers } from '../../src/core/system-logger.js';
import type { EvolutionLoopEvent } from '../../src/core/evolution-types.js';
import { SqliteConnection, SqliteDeadLetterStore } from '@principles/core/runtime-v2';

// ── Module mocks ────────────────────────────────────────────────────────────
// Keep SqliteConnection / SqliteDeadLetterStore / evaluateTriggerController real
// (via importActual spread); only override PainToPrincipleService and
// PrincipleTreeLedgerAdapter so the factory does no real I/O before the mock
// recordPain rejects.
vi.mock('@principles/core/runtime-v2', async () => {
  const actual = await vi.importActual<typeof import('@principles/core/runtime-v2')>(
    '@principles/core/runtime-v2',
  );
  return {
    ...actual,
    // Use `function` (not arrow) so `new PainToPrincipleService(...)` works.
    PainToPrincipleService: vi.fn().mockImplementation(function () {
      return {
        recordPain: vi
          .fn()
          .mockRejectedValue(new Error('TEST_INJECTED: pain service unavailable')),
      };
    }),
    PrincipleTreeLedgerAdapter: vi.fn().mockImplementation(function () {
      return {};
    }),
  };
});

vi.mock('../../src/core/pd-config-loader.js', () => ({
  loadPdConfigForPlugin: vi.fn(() => ({
    ok: true,
    source: 'mock',
    effective: {},
    errors: [],
  })),
  loadFeatureFlagFromConfig: vi.fn(() => ({ enabled: false, source: 'mock' })),
}));

vi.mock('../../src/core/intent-doc-reader-adapter.js', () => ({
  createIntentDocReader: vi.fn(() => () => null),
  resolveIntentLang: vi.fn(() => 'en'),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-deadletter-'));
}

function primeStateDb(workspaceDir: string): void {
  // Bootstrap state.db so the dead_letter_pains table exists before the hook
  // opens its own connection inside the catch block.
  const conn = new SqliteConnection({ workspaceDir });
  conn.getDb();
  conn.close();
}

function makePainEvent(overrides: Partial<EvolutionLoopEvent['data']> = {}): EvolutionLoopEvent {
  return {
    ts: new Date().toISOString(),
    type: 'pain_detected',
    data: {
      painId: 'pain_test_dead_letter_001',
      painType: 'tool_failure',
      source: 'write',
      reason: 'TEST: simulated tool failure for dead letter integration test',
      score: 75,
      sessionId: 'sess-test-001',
      ...overrides,
    },
  } as EvolutionLoopEvent;
}

interface StubWctx {
  workspaceDir: string;
  stateDir: string;
  evolutionReducer: { emitSync: ReturnType<typeof vi.fn> };
}

function makeStubWctx(workspaceDir: string): StubWctx {
  return {
    workspaceDir,
    stateDir: path.join(workspaceDir, '.state'),
    evolutionReducer: { emitSync: vi.fn() },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('emitPainDetectedEvent — dead letter on recordPain failure (Task 3, rc-9)', () => {
  let tempWorkspaceDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    tempWorkspaceDir = makeTempWorkspace();
    primeStateDb(tempWorkspaceDir);
    disposeAllSystemLoggers();
    logSpy = vi.spyOn(SystemLogger, 'log');
  });

  afterEach(() => {
    logSpy?.mockRestore();
    disposeAllSystemLoggers();
    try {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    } catch {
      // best-effort on Windows
    }
  });

  it('persists pain data to dead_letter_pains and logs PAIN_DEAD_LETTER when recordPain throws', async () => {
    const painEvent = makePainEvent();
    const wctx = makeStubWctx(tempWorkspaceDir);

    // rc-9: hook must NOT propagate the exception to the caller.
    await expect(emitPainDetectedEvent(wctx as any, painEvent)).resolves.toBeUndefined();

    // ── Assertion 1: PAIN_SERVICE_ERROR log (records the original throw) ──
    expect(logSpy).toHaveBeenCalledWith(
      tempWorkspaceDir,
      'PAIN_SERVICE_ERROR',
      expect.stringContaining('recordPain threw'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      tempWorkspaceDir,
      'PAIN_SERVICE_ERROR',
      expect.stringContaining('TEST_INJECTED: pain service unavailable'),
    );

    // ── Assertion 2: PAIN_DEAD_LETTER log with painId ──
    const deadLetterCalls = logSpy.mock.calls.filter(
      ([, eventType]) => eventType === 'PAIN_DEAD_LETTER',
    );
    expect(deadLetterCalls).toHaveLength(1);
    const [loggedWorkspace, , loggedMessage] = deadLetterCalls[0]!;
    expect(loggedWorkspace).toBe(tempWorkspaceDir);

    const payload = JSON.parse(loggedMessage) as Record<string, unknown>;
    expect(payload.painId).toBe('pain_test_dead_letter_001');
    expect(payload.painType).toBe('tool_failure');
    expect(payload.source).toBe('write');
    expect(payload.score).toBe(75);
    expect(payload.deadLetterInserted).toBe(true);
    expect(typeof payload.error).toBe('string');
    expect(payload.error).toContain('TEST_INJECTED: pain service unavailable');
    expect(typeof payload.nextAction).toBe('string');
    expect(payload.nextAction).toContain('pd pain retry --pain-id pain_test_dead_letter_001');

    // ── Assertion 3: dead_letter_pains table has 1 row with correct shape ──
    const conn = new SqliteConnection({ workspaceDir: tempWorkspaceDir });
    try {
      const store = new SqliteDeadLetterStore(conn);
      const row = store.getByPainId('pain_test_dead_letter_001');
      expect(row).not.toBeNull();
      expect(row?.painId).toBe('pain_test_dead_letter_001');
      expect(row?.retryCount).toBe(0);
      expect(row?.retriedAt).toBeNull();
      expect(row?.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // rc-1: painData is unknown — assert via objectContaining, not `as` cast.
      expect(row?.painData).toEqual(
        expect.objectContaining({
          painId: 'pain_test_dead_letter_001',
          painType: 'tool_failure',
          source: 'write',
          reason: 'TEST: simulated tool failure for dead letter integration test',
          score: 75,
          sessionId: 'sess-test-001',
        }),
      );

      // Only one row for this painId
      const all = store.listDeadLetters();
      expect(all).toHaveLength(1);
    } finally {
      conn.close();
    }
  });

  it('does not propagate exception to the caller (hook continues, rc-9)', async () => {
    // Call emitPainDetectedEvent multiple times — each must resolve cleanly.
    const wctx = makeStubWctx(tempWorkspaceDir);

    const event1 = makePainEvent({ painId: 'pain_continues_A' });
    const event2 = makePainEvent({ painId: 'pain_continues_B' });

    await expect(emitPainDetectedEvent(wctx as any, event1)).resolves.toBeUndefined();
    await expect(emitPainDetectedEvent(wctx as any, event2)).resolves.toBeUndefined();

    // Both pains should be persisted as separate dead letters.
    const conn = new SqliteConnection({ workspaceDir: tempWorkspaceDir });
    try {
      const store = new SqliteDeadLetterStore(conn);
      expect(store.getByPainId('pain_continues_A')).not.toBeNull();
      expect(store.getByPainId('pain_continues_B')).not.toBeNull();
      expect(store.listDeadLetters()).toHaveLength(2);
    } finally {
      conn.close();
    }
  });

  it('does not trigger dead letter write for non-pain_detected events', async () => {
    const wctx = makeStubWctx(tempWorkspaceDir);
    const nonPainEvent = {
      ts: new Date().toISOString(),
      type: 'candidate_created' as const,
      data: {
        painId: 'pain_not_triggered',
        principleId: 'p-1',
        trigger: 't',
        action: 'a',
        status: 'candidate' as const,
      },
    } as EvolutionLoopEvent;

    await expect(emitPainDetectedEvent(wctx as any, nonPainEvent)).resolves.toBeUndefined();

    // No PAIN_DEAD_LETTER log should be emitted for non-pain_detected events.
    const deadLetterCalls = logSpy.mock.calls.filter(
      ([, eventType]) => eventType === 'PAIN_DEAD_LETTER',
    );
    expect(deadLetterCalls).toHaveLength(0);

    // No PAIN_SERVICE_ERROR either — the catch block is only entered when
    // event.type === 'pain_detected'.
    const serviceErrorCalls = logSpy.mock.calls.filter(
      ([, eventType]) => eventType === 'PAIN_SERVICE_ERROR',
    );
    expect(serviceErrorCalls).toHaveLength(0);

    // dead_letter_pains table stays empty.
    const conn = new SqliteConnection({ workspaceDir: tempWorkspaceDir });
    try {
      const store = new SqliteDeadLetterStore(conn);
      expect(store.listDeadLetters()).toEqual([]);
    } finally {
      conn.close();
    }
  });

  it('logs DEAD_LETTER_PERSIST_FAILED and PAIN_DEAD_LETTER with deadLetterInserted=false when insert fails', async () => {
    // Simulate insertDeadLetter failure by spying on the prototype method.
    // (Dropping the table does NOT work because SqliteConnection.initSchema
    //  uses CREATE TABLE IF NOT EXISTS and would re-create it on the next
    //  getDb() call inside the hook's catch block.)
    const insertSpy = vi
      .spyOn(SqliteDeadLetterStore.prototype, 'insertDeadLetter')
      .mockReturnValue({ ok: false, error: 'TEST_INJECTED: insert failed' });

    try {
      const painEvent = makePainEvent({ painId: 'pain_insert_fails' });
      const wctx = makeStubWctx(tempWorkspaceDir);

      // rc-9: even when the dead-letter insert itself fails, the hook must NOT
      // propagate the exception. The PAIN_DEAD_LETTER log must still be emitted
      // with deadLetterInserted=false so the failure is observable.
      await expect(emitPainDetectedEvent(wctx as any, painEvent)).resolves.toBeUndefined();

      // DEAD_LETTER_PERSIST_FAILED log must be present (rc-9: no silent degradation).
      const persistFailedCalls = logSpy.mock.calls.filter(
        ([, eventType]) => eventType === 'DEAD_LETTER_PERSIST_FAILED',
      );
      expect(persistFailedCalls.length).toBeGreaterThan(0);
      expect(persistFailedCalls[0]![2]).toContain('TEST_INJECTED: insert failed');

      // PAIN_DEAD_LETTER must still be emitted with deadLetterInserted=false.
      const deadLetterCalls = logSpy.mock.calls.filter(
        ([, eventType]) => eventType === 'PAIN_DEAD_LETTER',
      );
      expect(deadLetterCalls).toHaveLength(1);
      const payload = JSON.parse(deadLetterCalls[0]![2]) as Record<string, unknown>;
      expect(payload.painId).toBe('pain_insert_fails');
      expect(payload.deadLetterInserted).toBe(false);
      expect(typeof payload.error).toBe('string');

      // dead_letter_pains table stays empty (insert was mocked to fail).
      const conn = new SqliteConnection({ workspaceDir: tempWorkspaceDir });
      try {
        const store = new SqliteDeadLetterStore(conn);
        expect(store.listDeadLetters()).toEqual([]);
      } finally {
        conn.close();
      }
    } finally {
      insertSpy.mockRestore();
    }
  });
});
