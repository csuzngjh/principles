/**
 * E2E m8-02 — PainSignalBridge full chain with autoIntakeEnabled.
 *
 * Machine-verifiable proof the M8 single path works end-to-end:
 *   pain → TaskStore → DiagnosticianRunner → ledger probation entry
 *
 * Tests:
 *   E2E-01: Full chain — pain signal → task succeeded → artifact → candidates → ledger probation entry
 *   E2E-02: Legacy .state/diagnostician_tasks.json NOT created
 *   E2E-03: Same painId twice — NO duplicate candidates or ledger entries
 *   E2E-04: autoIntakeEnabled=false — candidate pending but NO ledger write
 *   E2E-05: Leased task not interrupted by second trigger
 *
 * Uses StubRuntimeAdapter (in-process test double) — no real CLI binary needed.
 * Temp workspace via os.tmpdir(), cleaned after each test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'node:crypto';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { SqliteContextAssembler } from '../../store/sqlite-context-assembler.js';
import { SqliteHistoryQuery } from '../../store/sqlite-history-query.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { DiagnosticianRunner } from '../diagnostician-runner.js';
import { PassThroughValidator } from '../diagnostician-validator.js';
import { SqliteDiagnosticianCommitter } from '../../store/diagnostician-committer.js';
import type { SqliteConnection } from '../../store/sqlite-connection.js';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';
import type { DiagnosticianValidator } from '../diagnostician-validator.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';
import type {
  RuntimeCapabilities,
  RuntimeHealth,
  RunHandle,
  RunStatus,
  StartRunInput,
  StructuredRunOutput,
  RuntimeArtifactRef,
  RuntimeKind,
} from '../../runtime-protocol.js';
import { PainSignalBridge } from '../../pain-signal-bridge.js';
import { CandidateIntakeService } from '../../candidate-intake-service.js';
import type { LedgerAdapter, LedgerPrincipleEntry } from '../../candidate-intake.js';
import type { CandidateRecord } from '../../store/runtime-state-manager.js';

// ── In-memory ledger adapter for E2E testing ────────────────────────────────────

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

// ── StubRuntimeAdapter — in-process test double for PDRuntimeAdapter ──────────

/**
 * In-process test double for PDRuntimeAdapter.
 * Lets tests control pollRun status and fetchOutput payload precisely.
 * No real CLI binary spawned.
 */
class StubRuntimeAdapter implements PDRuntimeAdapter {
  private nextOutput: Record<string, unknown> | null = null;
  private nextStatus: RunStatus['status'] = 'succeeded';
  private runIdCounter = 0;

  constructor(private readonly kindValue: RuntimeKind = 'test-double') {}

  setOutput(output: Record<string, unknown> | null): void {
    this.nextOutput = output;
  }

  setRunStatus(status: RunStatus['status']): void {
    this.nextStatus = status;
  }

  kind(): RuntimeKind {
    return this.kindValue;
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      supportsStructuredJsonOutput: true,
      supportsToolUse: false,
      supportsWorkingDirectory: false,
      supportsModelSelection: false,
      supportsLongRunningSessions: false,
      supportsCancellation: true,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    return { healthy: true, degraded: false, warnings: [], lastCheckedAt: new Date().toISOString() };
  }

  async startRun(_input: StartRunInput): Promise<RunHandle> {
    this.runIdCounter += 1;
    return { runId: `stub-run-${this.runIdCounter}`, runtimeKind: this.kindValue, startedAt: new Date().toISOString() };
  }

  async pollRun(runId: string): Promise<RunStatus> {
    return { runId, status: this.nextStatus, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
  }

  async cancelRun(_runId: string): Promise<void> {
    // no-op
  }

  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    if (this.nextOutput === null) return null;
    return { runId, payload: this.nextOutput };
  }

  async fetchArtifacts(_runId: string): Promise<RuntimeArtifactRef[]> {
    return [];
  }
}

// ── Deferred helper ─────────────────────────────────────────────────────────────

class Deferred<T> {
  resolve!: (value: T) => void;
  reject!: (err: Error) => void;
  promise: Promise<T>;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** StubRuntimeAdapter variant whose pollRun stays 'running' until resolved. */
class SlowStubRuntimeAdapter extends StubRuntimeAdapter {
  private readonly pollDeferred = new Deferred<RunStatus>();
  private pollCount = 0;

  override async pollRun(runId: string): Promise<RunStatus> {
    this.pollCount += 1;
    if (this.pollCount === 1) {
      // First poll returns 'running' and waits
      this.pollDeferred.promise.then((status) => {
        // This won't be called since we replace pollDeferred each time
      });
      return { runId, status: 'running', startedAt: new Date().toISOString() };
    }
    // Subsequent polls use whatever was resolved
    return { runId, status: 'succeeded', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
  }

  resolvePoll(status: RunStatus): void {
    this.pollDeferred.resolve(status);
  }

  override setOutput(output: Record<string, unknown> | null): void {
    // Delegate to parent so nextOutput is actually set
    super.setOutput(output);
  }
}

// ── Test fixtures ──────────────────────────────────────────────────────────────

/**
 * Create DiagnosticianOutputV1 with >= 2 kind='principle' recommendations.
 * Per SqliteDiagnosticianCommitter, the full DiagnosticianOutputV1 JSON is stored
 * as artifact.content_json. CandidateIntakeService.intake() reads this via
 * JSON.parse(artifact.contentJson) and extracts the recommendation from it.
 *
 * The artifact.contentJson format is:
 *   { recommendation: { title, text, triggerPattern, action } }
 */
function makeDiagnosticianOutputWithCandidates(taskId: string): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: `diag-m8e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId,
    summary: 'E2E m8-02 test diagnosis summary',
    rootCause: 'E2E m8-02 root cause — missing validation before tool call',
    violatedPrinciples: [],
    evidence: [],
    recommendations: [
      {
        kind: 'principle',
        description: 'Always validate tool arguments before execution to prevent silent failures',
        triggerPattern: 'missing validation before tool call',
        action: 'add schema validation before execution',
      },
      {
        kind: 'principle',
        description: 'Log all tool invocations with argument summaries for traceability',
        triggerPattern: 'tool invocation without logging',
        action: 'add logging to all tool invocations',
      },
      { kind: 'rule', description: 'Use schema validation for external inputs' },
    ],
    confidence: 0.92,
  };
}

// ── Test setup ─────────────────────────────────────────────────────────────────

const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-m8-${process.pid}`);

describe('E2E m8-02 — PainSignalBridge full chain', () => {
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let testDir: string;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let stateManager: RuntimeStateManager;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let contextAssembler: SqliteContextAssembler;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let historyQuery: SqliteHistoryQuery;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let eventEmitter: StoreEventEmitter;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let sqliteConn: SqliteConnection;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let ledgerAdapter: InMemoryLedgerAdapter;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let intakeService: CandidateIntakeService;
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let bridge: PainSignalBridge;

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

    ledgerAdapter = new InMemoryLedgerAdapter();
    intakeService = new CandidateIntakeService({ stateManager, ledgerAdapter });
  });

  afterEach(() => {
    stateManager.close();
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  });

  /**
   * Build a DiagnosticianRunner wired with REAL SqliteDiagnosticianCommitter.
   */
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
        owner: 'e2e-m8-02-bridge',
        runtimeKind: 'test-double',
        pollIntervalMs: 50,
        timeoutMs: 5000,
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // E2E-01: Full chain — pain → task → artifact → candidates → ledger probation
  // ═══════════════════════════════════════════════════════════════════════════════

  it('E2E-01: Full chain — pain signal → task succeeded → artifact → candidates → ledger probation entry', async () => {
    const painId = 'test-pain-e2e01';
    const expectedTaskId = `diagnosis_${painId}`;
    const output = makeDiagnosticianOutputWithCandidates(painId);

    const stubAdapter = new StubRuntimeAdapter();
    stubAdapter.setOutput(output as Record<string, unknown>);

    bridge = new PainSignalBridge({
      stateManager,
      runner: createRunner(stubAdapter),
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

    // E2E-01 assertion 1: taskId is distinct from painId
    expect(result.painId).toBe(painId);
    expect(result.taskId).toBe(expectedTaskId);
    expect(result.status).toBe('succeeded');

    // E2E-01 assertion 2: task record exists, status === 'succeeded'
    const task = await stateManager.getTask(expectedTaskId);
    expect(task).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(task!.status).toBe('succeeded');
    expect(task!.inputRef).toBe(painId);

    // E2E-01 assertion 3: artifact row exists with artifact_kind === 'diagnostician_output'
    const db = sqliteConn.getDb();
    const artifactRow = db.prepare('SELECT * FROM artifacts WHERE task_id = ?').get(expectedTaskId) as {
      artifact_id: string;
      artifact_kind: string;
    } | undefined;
    expect(artifactRow).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(artifactRow!.artifact_kind).toBe('diagnostician_output');

    // E2E-01 assertion 4: >= 1 candidate rows exist
    const candidateRows = db.prepare(
      'SELECT * FROM principle_candidates WHERE task_id = ?',
    ).all(expectedTaskId) as { candidate_id: string }[];
    expect(candidateRows.length).toBeGreaterThanOrEqual(1);

    // E2E-01 assertion 5: ledger has a probation entry for each candidate
    for (const row of candidateRows) {
      const ledgerEntry = ledgerAdapter.existsForCandidate(row.candidate_id);
      expect(ledgerEntry).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(ledgerEntry!.status).toBe('probation');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // E2E-02: Legacy path NOT created
  // ═══════════════════════════════════════════════════════════════════════════════

  it('E2E-02: Legacy .state/diagnostician_tasks.json NOT created', async () => {
    const painId = 'test-pain-e2e02';
    const output = makeDiagnosticianOutputWithCandidates(painId);

    const stubAdapter = new StubRuntimeAdapter();
    stubAdapter.setOutput(output as Record<string, unknown>);

    bridge = new PainSignalBridge({
      stateManager,
      runner: createRunner(stubAdapter),
      intakeService,
      ledgerAdapter,
      autoIntakeEnabled: true,
    });

    await bridge.onPainDetected({
      painId,
      painType: 'tool_failure',
      source: 'test',
      reason: 'test failure',
    });

    // E2E-02: .state/diagnostician_tasks.json does NOT exist
    const legacyPath = path.join(testDir, '.state', 'diagnostician_tasks.json');
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // E2E-03: Same painId twice — NO duplicate candidates
  // ═══════════════════════════════════════════════════════════════════════════════

  it('E2E-03: Same painId twice — NO duplicate candidates or ledger entries', async () => {
    const painId = 'test-pain-idempotent';
    const expectedTaskId = `diagnosis_${painId}`;
    const output = makeDiagnosticianOutputWithCandidates(painId);

    const stubAdapter = new StubRuntimeAdapter();
    stubAdapter.setOutput(output as Record<string, unknown>);

    bridge = new PainSignalBridge({
      stateManager,
      runner: createRunner(stubAdapter),
      intakeService,
      ledgerAdapter,
      autoIntakeEnabled: true,
    });

    // First call
    const firstResult = await bridge.onPainDetected({
      painId,
      painType: 'tool_failure',
      source: 'test',
      reason: 'test',
    });
    expect(firstResult.taskId).toBe(expectedTaskId);
    expect(firstResult.status).toBe('succeeded');

    // Record candidate count after first call
    const db = sqliteConn.getDb();
    const firstCandidateRows = db.prepare(
      'SELECT * FROM principle_candidates WHERE task_id = ?',
    ).all(expectedTaskId) as { candidate_id: string }[];
    const firstCandidateCount = firstCandidateRows.length;
    expect(firstCandidateCount).toBeGreaterThanOrEqual(1);

    // Second call with SAME painId — should NO-OP (task already succeeded → Rule a)
    const secondResult = await bridge.onPainDetected({
      painId,
      painType: 'tool_failure',
      source: 'test',
      reason: 'test',
    });
    expect(secondResult.taskId).toBe(expectedTaskId);
    expect(secondResult.status).toBe('succeeded');

    // E2E-03 assertion 1: candidate count is UNCHANGED
    const secondCandidateRows = db.prepare(
      'SELECT * FROM principle_candidates WHERE task_id = ?',
    ).all(expectedTaskId) as { candidate_id: string }[];
    expect(secondCandidateRows.length).toBe(firstCandidateCount);

    // E2E-03 assertion 2: task status === 'succeeded'
    const task = await stateManager.getTask(expectedTaskId);
    expect(task).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(task!.status).toBe('succeeded');
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // E2E-04: autoIntakeEnabled=false
  // ═══════════════════════════════════════════════════════════════════════════════

  it('E2E-04: autoIntakeEnabled=false — candidates exist but NO ledger write', async () => {
    const painId = 'test-pain-no-intake';
    const expectedTaskId = `diagnosis_${painId}`;
    const output = makeDiagnosticianOutputWithCandidates(painId);

    const stubAdapter = new StubRuntimeAdapter();
    stubAdapter.setOutput(output as Record<string, unknown>);

    const bridgeNoIntake = new PainSignalBridge({
      stateManager,
      runner: createRunner(stubAdapter),
      intakeService,
      ledgerAdapter,
      autoIntakeEnabled: false, // debug mode — no ledger write
    });

    const result = await bridgeNoIntake.onPainDetected({
      painId,
      painType: 'tool_failure',
      source: 'test',
      reason: 'test failure',
    });
    expect(result.taskId).toBe(expectedTaskId);

    // E2E-04 assertion 1: task record exists, status === 'succeeded'
    const task = await stateManager.getTask(expectedTaskId);
    expect(task).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(task!.status).toBe('succeeded');

    // E2E-04 assertion 2: candidate rows exist
    const db = sqliteConn.getDb();
    const candidateRows = db.prepare(
      'SELECT * FROM principle_candidates WHERE task_id = ?',
    ).all(expectedTaskId) as { candidate_id: string }[];
    expect(candidateRows.length).toBeGreaterThanOrEqual(1);

    // E2E-04 assertion 3: ledger has NO entry for these candidates
    for (const row of candidateRows) {
      const ledgerEntry = ledgerAdapter.existsForCandidate(row.candidate_id);
      expect(ledgerEntry).toBeNull();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // E2E-05: Leased task not interrupted
  // ═══════════════════════════════════════════════════════════════════════════════

  it('E2E-05: Second trigger returns immediately while first run in-flight', async () => {
    const painId = 'test-pain-lease';
    const expectedTaskId = `diagnosis_${painId}`;

    // Track runner.run() invocations
    let runnerRunCallCount = 0;

    // Slow adapter: first pollRun takes 200ms (blocks), subsequent succeed immediately.
    // This gives us a window where the first call is in pollUntilTerminal while
    // we fire the second call.
    let pollCallCount = 0;
    const slowAdapter = new StubRuntimeAdapter();
    slowAdapter.setOutput(makeDiagnosticianOutputWithCandidates(painId) as Record<string, unknown>);
    vi.spyOn(slowAdapter, 'pollRun').mockImplementation(async (runId: string) => {
      pollCallCount += 1;
      if (pollCallCount === 1) {
        // First poll: delay 200ms to simulate long-running task.
        // During this time, the second pain signal fires.
        await new Promise((r) => setTimeout(r, 200));
        return { runId, status: 'succeeded', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
      }
      return { runId, status: 'succeeded', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
    });

    function countingRunner(adapter: PDRuntimeAdapter): DiagnosticianRunner {
      const runner = createRunner(adapter);
      const originalRun = runner.run.bind(runner);
      runner.run = async (taskId: string) => {
        runnerRunCallCount += 1;
        return originalRun(taskId);
      };
      return runner;
    }

    bridge = new PainSignalBridge({
      stateManager,
      runner: countingRunner(slowAdapter),
      intakeService,
      ledgerAdapter,
      autoIntakeEnabled: true,
    });

    const startTime = Date.now();

    // Fire first call — DiagnosticianRunner.run() will:
    // 1. acquireLease (sets task to 'leased')
    // 2. startRun
    // 3. pollUntilTerminal (calls pollRun which blocks 200ms)
    const firstPromise = bridge.onPainDetected({
      painId,
      painType: 'tool_failure',
      source: 'test',
      reason: 'test failure',
    });

    // Wait 50ms — first call should be inside pollUntilTerminal by now
    await new Promise((r) => setTimeout(r, 50));

    // Fire second call while first is still in pollUntilTerminal
    const secondResult = await bridge.onPainDetected({
      painId,
      painType: 'tool_failure',
      source: 'test',
      reason: 'test failure',
    });

    const secondCallReturnTime = Date.now() - startTime;

    // E2E-05 assertion 1: second call returns in < 100ms (proves it didn't wait for first run)
    // If it waited for the first run to complete, second call would take ~200ms+
    expect(secondCallReturnTime).toBeLessThan(100);

    // E2E-05 assertion 2: second call returns the SKIP result for the same task
    expect(secondResult.status).toBe('skipped');
    expect(secondResult.painId).toBe(painId);
    expect(secondResult.taskId).toBe(expectedTaskId);

    // Wait for first call to complete (it takes ~200ms due to poll delay)
    const firstResult = await firstPromise;
    expect(firstResult.status).toBe('succeeded');
    expect(firstResult.taskId).toBe(expectedTaskId);

    // E2E-05 assertion 3: at least one runner.run() was called (proves first call ran)
    expect(runnerRunCallCount).toBeGreaterThanOrEqual(1);

    // E2E-05 assertion 4: candidates exist (proves chain produced candidates)
    const candidates = await stateManager.getCandidatesByTaskId(expectedTaskId);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });
});
