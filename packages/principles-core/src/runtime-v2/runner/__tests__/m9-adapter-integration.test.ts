/**
 * E2E m9-adapter-integration — PiAiRuntimeAdapter + DiagnosticianRunner integration.
 *
 * Verifies PiAiRuntimeAdapter integrates correctly with DiagnosticianRunner.
 * Tests pain → task → run → DiagnosticianOutputV1 artifact → candidate records.
 * Does NOT go through PainSignalBridge or ledger (plan 01 scope).
 *
 * Uses module-level vi.mock('@mariozechner/pi-ai') — real PiAiRuntimeAdapter
 * code runs, only LLM API calls are intercepted.
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

// ── Module mock (MUST be before imports) ──────────────────────────────────────

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(),
  getProviders: vi.fn(() => ['openrouter', 'anthropic', 'openai']),
  complete: vi.fn(),
}));

import { getModel, complete } from '@mariozechner/pi-ai';
import { PiAiRuntimeAdapter } from '../../adapter/pi-ai-runtime-adapter.js';

const mockComplete = complete as ReturnType<typeof vi.fn>;
const mockGetModel = getModel as ReturnType<typeof vi.fn>;

// ── Test fixtures ──────────────────────────────────────────────────────────────

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
    diagnosisId: `diag-m9-adapter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId,
    summary: 'E2E m9-04 adapter integration test diagnosis summary',
    rootCause: 'E2E m9-04 root cause — adapter integration test',
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

const VALID_DIAGNOSIS = {
  valid: true,
  diagnosisId: 'diag-adapter-integration-1',
  taskId: 'task-adapter-integration-1',
  summary: 'Adapter integration test summary',
  rootCause: 'Adapter integration root cause',
  violatedPrinciples: [],
  evidence: [],
  recommendations: [],
  confidence: 0.9,
};

// ── Test setup ─────────────────────────────────────────────────────────────────

const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-m9-adapter-integration-${process.pid}`);

describe('E2E m9-adapter-integration — PiAiRuntimeAdapter + DiagnosticianRunner', () => {
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let testDir: string;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let stateManager: RuntimeStateManager;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let sqliteConn: SqliteConnection;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let contextAssembler: SqliteContextAssembler;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let historyQuery: SqliteHistoryQuery;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let eventEmitter: StoreEventEmitter;

  beforeEach(async () => {
    testDir = path.join(TMP_ROOT, `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });

    stateManager = new RuntimeStateManager({ workspaceDir: testDir });
    await stateManager.initialize();

    sqliteConn = (stateManager as unknown as { connection: unknown }).connection as SqliteConnection;
    historyQuery = new SqliteHistoryQuery(sqliteConn);
    const taskStore = (stateManager as unknown as { taskStore: unknown }).taskStore as never;
    const runStore = (stateManager as unknown as { runStore: unknown }).runStore as never;
    contextAssembler = new SqliteContextAssembler(taskStore, historyQuery, runStore);
    eventEmitter = new StoreEventEmitter();

    vi.clearAllMocks();
    process.env.TEST_API_KEY = 'test-key-123';
    mockGetModel.mockReturnValue({ id: 'anthropic/claude-sonnet-4' });
    mockComplete.mockResolvedValue(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));
  });

  afterEach(() => {
    stateManager.close();
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
      // ignore Windows cleanup errors
    }
  });

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
        owner: 'e2e-m9-adapter-integration',
        runtimeKind: 'pi-ai',
        pollIntervalMs: 50,
        timeoutMs: 5000,
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST: PiAiRuntimeAdapter + DiagnosticianRunner full chain
  // ═══════════════════════════════════════════════════════════════════════════

  it('PiAiRuntimeAdapter + DiagnosticianRunner: full chain task → artifact → candidates', async () => {
    const taskId = 'diagnosis_test-pain-m9-adapter-01';

    // Create task via stateManager (bridge would normally do this)
    await stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });

    // Configure mock to return diagnosis with candidates
    const output = makeDiagnosticianOutputWithCandidates(taskId);
    mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(output)));

    // Create adapter and runner
    const adapter = new PiAiRuntimeAdapter({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      apiKeyEnv: 'TEST_API_KEY',
      maxRetries: 0,
      timeoutMs: 60_000,
    });

    const runner = createRunner(adapter);
    const result = await runner.run(taskId);

    // Assert runner succeeded
    expect(result.status).toBe('succeeded');
    expect(result.contextHash).toBeDefined();

    // Assert artifact was written
    const db = sqliteConn.getDb();
    const artifacts = db.prepare('SELECT * FROM artifacts WHERE task_id = ?').all(taskId) as { artifact_id: string; artifact_kind: string }[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact_kind).toBe('diagnostician_output');

    // Assert >= 2 candidate records were created
    const artifactId = artifacts[0].artifact_id;
    const candidates = db.prepare('SELECT * FROM principle_candidates WHERE artifact_id = ?').all(artifactId) as { candidate_id: string }[];
    expect(candidates.length).toBeGreaterThanOrEqual(2);
  });
});
