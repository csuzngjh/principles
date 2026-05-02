/**
 * E2E m9 — PainSignalBridge + PiAiRuntimeAdapter full chain.
 * Pain → task → run → DiagnosticianOutputV1 artifact → candidates → ledger probation entry.
 * Idempotency: same painId twice produces no duplicate candidates/ledger entries.
 * Uses vi.mock('@mariozechner/pi-ai') — real adapter code, only LLM calls intercepted.
 */
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
import { PiAiRuntimeAdapter } from '../../adapter/pi-ai-runtime-adapter.js';

const mockComplete = complete as ReturnType<typeof vi.fn>;
const mockGetModel = getModel as ReturnType<typeof vi.fn>;

// ── In-memory ledger adapter ──────────────────────────────────────────────────
class InMemoryLedgerAdapter implements LedgerAdapter {
  private readonly entries = new Map<string, LedgerPrincipleEntry>();
  writeProbationEntry(entry: LedgerPrincipleEntry): LedgerPrincipleEntry {
    const candidateId = this.#extractCandidateId(entry.sourceRef);
    const existing = this.existsForCandidate(candidateId);
    if (existing) return existing;
    this.entries.set(candidateId, entry); return entry;
  }
  existsForCandidate(candidateId: string): LedgerPrincipleEntry | null { return this.entries.get(candidateId) ?? null; }
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  #extractCandidateId(sourceRef: string): string { return sourceRef.startsWith('candidate://') ? sourceRef.slice('candidate://'.length) : sourceRef; }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
function makeAssistantMessage(text: string, overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text }],
    role: 'assistant' as const,
    stopReason: 'stop' as const,
    api: 'openai-completions',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeDiagnosticianOutputWithCandidates(taskId: string): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: `diag-m9-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId,
    summary: 'E2E m9-04 full chain test diagnosis summary',
    rootCause: 'E2E m9-04 full chain root cause — missing validation before tool call',
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

// ── Test setup ─────────────────────────────────────────────────────────────────
const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-m9-${process.pid}`);

describe('E2E m9 — PainSignalBridge + PiAiRuntimeAdapter full chain', () => {
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let testDir: string;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let stateManager: RuntimeStateManager;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let sqliteConn: SqliteConnection;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let contextAssembler: SqliteContextAssembler;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let eventEmitter: StoreEventEmitter;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let ledgerAdapter: InMemoryLedgerAdapter;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let intakeService: CandidateIntakeService;

  beforeEach(async () => {
    testDir = path.join(TMP_ROOT, `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    stateManager = new RuntimeStateManager({ workspaceDir: testDir });
    await stateManager.initialize();
    sqliteConn = (stateManager as unknown as { connection: unknown }).connection as SqliteConnection;
    const historyQuery = new SqliteHistoryQuery(sqliteConn);
    const taskStore = (stateManager as unknown as { taskStore: unknown }).taskStore as never;
    const runStore = (stateManager as unknown as { runStore: unknown }).runStore as never;
    contextAssembler = new SqliteContextAssembler(taskStore, historyQuery, runStore);
    eventEmitter = new StoreEventEmitter();
    ledgerAdapter = new InMemoryLedgerAdapter();
    intakeService = new CandidateIntakeService({ stateManager, ledgerAdapter });
    vi.clearAllMocks();
    process.env.TEST_API_KEY = 'test-key-123';
    mockGetModel.mockReturnValue({ id: 'anthropic/claude-sonnet-4' });
  });

  afterEach(() => {
    stateManager.close();
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function createRunner(runtimeAdapter: PDRuntimeAdapter): DiagnosticianRunner {
    const committer = new SqliteDiagnosticianCommitter(sqliteConn);
    return new DiagnosticianRunner(
      { stateManager, contextAssembler, runtimeAdapter, eventEmitter, validator: new PassThroughValidator(), committer },
      { owner: 'e2e-m9-full-chain', runtimeKind: 'pi-ai', pollIntervalMs: 50, timeoutMs: 5000 },
    );
  }

  function makePiAiAdapter(): PiAiRuntimeAdapter {
    return new PiAiRuntimeAdapter({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4', apiKeyEnv: 'TEST_API_KEY', maxRetries: 0, timeoutMs: 60_000 });
  }

  // TEST 1: Full chain
  it('full chain: pain → task → artifact → candidates → ledger probation entry via pi-ai', async () => {
    const painId = 'test-pain-m9-e2e-01';
    const expectedTaskId = `diagnosis_${painId}`;
    const output = makeDiagnosticianOutputWithCandidates(expectedTaskId);
    mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(output)));

    const bridge = new PainSignalBridge({
      stateManager,
      runner: createRunner(makePiAiAdapter()),
      intakeService,
      ledgerAdapter,
      autoIntakeEnabled: true,
    });

    const result = await bridge.onPainDetected({ painId, painType: 'tool_failure', source: 'test', reason: 'test failure' });

    expect(result.status).toBe('succeeded');
    expect(result.painId).toBe(painId);
    expect(result.taskId).toBe(expectedTaskId);
    expect(result.candidateIds.length).toBeGreaterThanOrEqual(1);
    expect(result.ledgerEntryIds.length).toBeGreaterThanOrEqual(1);

    const db = sqliteConn.getDb();
    const artifacts = db.prepare('SELECT * FROM artifacts WHERE task_id = ?').all(expectedTaskId) as { artifact_id: string; artifact_kind: string }[];
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0] as { artifact_id: string; artifact_kind: string };
    expect(artifact.artifact_kind).toBe('diagnostician_output');

    const candidates = db.prepare('SELECT * FROM principle_candidates WHERE task_id = ?').all(expectedTaskId) as { candidate_id: string }[];
    expect(candidates.length).toBeGreaterThanOrEqual(1);

    for (const row of candidates) {
      const ledgerEntry = ledgerAdapter.existsForCandidate(row.candidate_id);
      expect(ledgerEntry).not.toBeNull();
      const entry = ledgerEntry as { status: string };
      expect(entry.status).toBe('probation');
    }
  });

  // TEST 2: Idempotency
  it('idempotency: same painId twice produces no duplicate candidates or ledger entries', async () => {
    const painId = 'test-pain-m9-e2e-idempotent';
    const expectedTaskId = `diagnosis_${painId}`;
    const output = makeDiagnosticianOutputWithCandidates(expectedTaskId);
    mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(output)));

    const bridge = new PainSignalBridge({
      stateManager,
      runner: createRunner(makePiAiAdapter()),
      intakeService,
      ledgerAdapter,
      autoIntakeEnabled: true,
    });

    const result1 = await bridge.onPainDetected({ painId, painType: 'tool_failure', source: 'test', reason: 'test' });
    expect(result1.status).toBe('succeeded');

    const db = sqliteConn.getDb();
    const firstCandidates = db.prepare('SELECT * FROM principle_candidates WHERE task_id = ?').all(expectedTaskId) as { candidate_id: string }[];
    const firstCandidateCount = firstCandidates.length;
    const firstLedgerCount = result1.ledgerEntryIds.length;

    // Second call — same painId, NOOP path (task already succeeded)
    const result2 = await bridge.onPainDetected({ painId, painType: 'tool_failure', source: 'test', reason: 'test' });
    expect(result2.status).toBe('succeeded');

    const secondCandidates = db.prepare('SELECT * FROM principle_candidates WHERE task_id = ?').all(expectedTaskId) as { candidate_id: string }[];
    expect(secondCandidates.length).toBe(firstCandidateCount);
    expect(result2.ledgerEntryIds.length).toBe(firstLedgerCount);
  });
});
