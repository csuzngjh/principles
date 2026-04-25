/**
 * E2E m6-06 — OpenClawCliRuntimeAdapter + FakeCliProcessRunner
 *
 * Unit-level E2E with FakeCliProcessRunner — prove the openclaw-cli adapter path
 * works end-to-end without spawning a real openclaw binary.
 *
 * Covers:
 *   E2EV-01: FakeCliProcessRunner proves adapter path (fake runner intercepts runCliProcess)
 *   E2EV-02: Full chain task -> run -> DiagnosticianOutputV1 -> artifact -> candidates
 *   E2EV-03: TestDoubleRuntimeAdapter regression (dual-track-e2e reference still passes)
 *   HG-3: Both 'local' and 'gateway' runtimeModes produce correct CLI args
 *
 * Test file per m6-06-01-PLAN.md.
 * vi.mock pattern mirrors m5-05-e2e.test.ts setup.
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
import { OpenClawCliRuntimeAdapter } from '../../adapter/openclaw-cli-runtime-adapter.js';
import { TestDoubleRuntimeAdapter } from '../../adapter/test-double-runtime-adapter.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';
import type { CandidateRecord } from '../../store/runtime-state-manager.js';

// Typed status constant for SQL query parameters (avoids magic strings)
const PENDING_STATUS: CandidateRecord['status'] = 'pending';

// ── Module mock setup ──────────────────────────────────────────────────────────
// vi.mock MUST be called before importing the module under test.
// This intercepts runCliProcess so no real CLI binary is spawned.

 
vi.mock('../../utils/cli-process-runner.js', () => {
  return {
    runCliProcess: vi.fn(),
  };
});

// Import after vi.mock so the mock is active
import { runCliProcess } from '../../utils/cli-process-runner.js';
import type { CliOutput } from '../../utils/cli-process-runner.js';

// ── Test fixtures ──────────────────────────────────────────────────────────────

function makeFakeCliOutput(
  overrides: Partial<CliOutput> = {},
): CliOutput {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 100,
    ...overrides,
  };
}

/**
 * Create DiagnosticianOutputV1 with >= 2 kind='principle' recommendations.
 * Schema-valid (passes Value.Check(DiagnosticianOutputV1Schema, output)).
 */
function makeDiagnosticianOutputWithCandidates(taskId: string): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: `diag-m6e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId,
    summary: 'E2E m6-06 test diagnosis summary',
    rootCause: 'E2E m6-06 root cause — missing validation before tool call',
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

interface DiagnosticFields {
  reasonSummary?: string;
  sourcePainId?: string;
  severity?: string;
  source?: string;
}

interface TaskCreationOptions {
  taskId: string;
  workspaceDir: string;
  diagnostic?: DiagnosticFields;
}

function makeDiagnosticianTaskInput(
  options: TaskCreationOptions,
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
): Omit<import('../../task-status.js').TaskRecord, 'createdAt' | 'updatedAt'> & { diagnosticJson?: string } {
  const { taskId, workspaceDir, diagnostic } = options;
  const diagnosticJson = JSON.stringify({
    workspaceDir,
    reasonSummary: diagnostic?.reasonSummary ?? 'E2E m6-06 test task',
    sourcePainId: diagnostic?.sourcePainId,
    severity: diagnostic?.severity,
    source: diagnostic?.source,
  });
  return {
    taskId,
    taskKind: 'diagnostician',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson,
  };
}

// ── Test setup ─────────────────────────────────────────────────────────────────

const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-m6-06-${process.pid}`);

describe('E2E m6-06 — OpenClawCliRuntimeAdapter + FakeCliProcessRunner', () => {
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

    // Reset mock before each test
    vi.mocked(runCliProcess).mockReset();
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
   * pollIntervalMs: 50, timeoutMs: 3000 per m5-05-e2e.test.ts pattern.
   */
  function createRunner(
    runtimeAdapter: PDRuntimeAdapter,
    validator: DiagnosticianValidator = new PassThroughValidator(),
  ): DiagnosticianRunner {
    const committer = new SqliteDiagnosticianCommitter(sqliteConn);
    return new DiagnosticianRunner(
      {
        stateManager,
        contextAssembler,
        runtimeAdapter,
        eventEmitter,
        validator,
        committer,
      },
      {
        owner: 'e2e-m6-06-runner',
        runtimeKind: 'openclaw-cli',
        pollIntervalMs: 50,
        timeoutMs: 3000,
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 1: FakeCliProcessRunner Proves Adapter Path (E2EV-01, E2EV-02)
  // ═══════════════════════════════════════════════════════════════════════════
  // Verifies E2EV-01: FakeCliProcessRunner intercepts runCliProcess without real binary
  // Verifies E2EV-02: Full chain task -> run -> DiagnosticianOutputV1 -> artifact -> candidates

  describe('Scenario 1: FakeCliProcessRunner Proves Adapter Path (E2EV-01, E2EV-02)', () => {
    it('full chain with FakeCliProcessRunner — openclaw-cli adapter path', async () => {
      const taskId = randomUUID();

      // Create task
      await stateManager.createTask(
        makeDiagnosticianTaskInput({
          taskId,
          workspaceDir: testDir,
          diagnostic: {
            reasonSummary: 'E2EV-01 happy path test',
            sourcePainId: 'pain-e2ev01-001',
            severity: 'high',
            source: 'e2e-test',
          },
        }),
      );

      // Configure fake output with >= 2 kind='principle' recommendations
      const output = makeDiagnosticianOutputWithCandidates(taskId);

      // Configure FakeCliProcessRunner mock — returns success with DiagnosticianOutputV1 JSON
      vi.mocked(runCliProcess).mockResolvedValue(
        makeFakeCliOutput({
          stdout: JSON.stringify(output),
          exitCode: 0,
          timedOut: false,
        }),
      );

      // Create OpenClawCliRuntimeAdapter with local mode
      const runtimeAdapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: 'local',
        workspaceDir: testDir,
      });

      const runner = createRunner(runtimeAdapter);
      const result = await runner.run(taskId);

      // E2EV-01/E2EV-02 assertion 1: result.status === 'succeeded'
      expect(result.status).toBe('succeeded');

      // E2EV-01/E2EV-02 assertion 2: task.resultRef starts with 'commit://'
      const task = await stateManager.getTask(taskId);
      expect(task).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(task!.resultRef).toMatch(/^commit:\/\/.+/);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const commitId = task!.resultRef!.replace('commit://', '');

      // E2EV-01/E2EV-02 assertion 3: task status is 'succeeded'
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(task!.status).toBe('succeeded');

      // E2EV-02 assertion 4: artifact row exists with correct artifact_kind
      const db = sqliteConn.getDb();
      const artifactRow = db.prepare('SELECT * FROM artifacts WHERE task_id = ?').get(taskId) as {
        artifact_id: string;
        run_id: string;
        task_id: string;
        artifact_kind: string;
        content_json: string;
      } | undefined;
      expect(artifactRow).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(artifactRow!.artifact_kind).toBe('diagnostician_output');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const artifactId = artifactRow!.artifact_id;

      // E2EV-02 assertion 5: >= 2 candidate rows exist (from kind='principle' recommendations)
      const candidateRows = db.prepare(
        'SELECT * FROM principle_candidates WHERE artifact_id = ? AND status = ?',
      ).all(artifactId, PENDING_STATUS) as { candidate_id: string; description: string }[];
      expect(candidateRows).toHaveLength(2);
      expect(candidateRows.every((c) => c.description.length > 0)).toBe(true);

      // E2EV-02 assertion 6: commit row links task to artifact with status === 'committed'
      const commitRow = db.prepare('SELECT * FROM commits WHERE commit_id = ?').get(commitId) as {
        commit_id: string;
        task_id: string;
        artifact_id: string;
        status: string;
      } | undefined;
      expect(commitRow).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(commitRow!.artifact_id).toBe(artifactId);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(commitRow!.task_id).toBe(taskId);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(commitRow!.status).toBe('committed');

      // E2EV-01 CRITICAL: runCliProcess was called (fake was invoked, no real binary)
      expect(vi.mocked(runCliProcess)).toHaveBeenCalled();

      // E2EV-01 CRITICAL: command was 'openclaw'
      const [[firstCall]] = vi.mocked(runCliProcess).mock.calls;
      expect(firstCall.command).toBe('openclaw');

      // E2EV-01 CRITICAL: args include '--local' when runtimeMode is 'local'
      expect(firstCall.args).toContain('--local');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 2: HG-3 — Both RuntimeModes Produce Correct CLI Args
  // ═══════════════════════════════════════════════════════════════════════════
  // Verifies HG-3: No silent fallback. '--local' only passed when mode === 'local'.

  describe('Scenario 2: HG-3 — Both RuntimeModes Produce Correct CLI Args', () => {
    it('local mode passes --local, gateway mode omits --local', async () => {
      // ── Sub-case: local mode ────────────────────────────────────────────────
      const taskIdLocal = randomUUID();

      await stateManager.createTask(
        makeDiagnosticianTaskInput({
          taskId: taskIdLocal,
          workspaceDir: testDir,
          diagnostic: { reasonSummary: 'HG-3 local mode test' },
        }),
      );

      const outputLocal = makeDiagnosticianOutputWithCandidates(taskIdLocal);
      vi.mocked(runCliProcess).mockResolvedValue(
        makeFakeCliOutput({
          stdout: JSON.stringify(outputLocal),
          exitCode: 0,
          timedOut: false,
        }),
      );

      const localAdapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: 'local',
        workspaceDir: testDir,
      });
      const localRunner = createRunner(localAdapter);
      const localResult = await localRunner.run(taskIdLocal);

      expect(localResult.status).toBe('succeeded');

      // HG-3 CRITICAL: args include '--local'
      const [[localCall]] = vi.mocked(runCliProcess).mock.calls;
      expect(localCall.args).toContain('--local');

      // ── Sub-case: gateway mode ──────────────────────────────────────────────
      const taskIdGateway = randomUUID();

      await stateManager.createTask(
        makeDiagnosticianTaskInput({
          taskId: taskIdGateway,
          workspaceDir: testDir,
          diagnostic: { reasonSummary: 'HG-3 gateway mode test' },
        }),
      );

      const outputGateway = makeDiagnosticianOutputWithCandidates(taskIdGateway);
      vi.mocked(runCliProcess).mockClear();
      vi.mocked(runCliProcess).mockResolvedValue(
        makeFakeCliOutput({
          stdout: JSON.stringify(outputGateway),
          exitCode: 0,
          timedOut: false,
        }),
      );

      const gatewayAdapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: 'gateway',
        workspaceDir: testDir,
      });
      const gatewayRunner = createRunner(gatewayAdapter);
      const gatewayResult = await gatewayRunner.run(taskIdGateway);

      expect(gatewayResult.status).toBe('succeeded');

      // HG-3 CRITICAL: args do NOT include '--local'
      const [[gatewayCall]] = vi.mocked(runCliProcess).mock.calls;
      expect(gatewayCall.args).not.toContain('--local');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 3: TestDoubleRuntimeAdapter Regression (E2EV-03)
  // ═══════════════════════════════════════════════════════════════════════════
  // Verifies E2EV-03: TestDoubleRuntimeAdapter path still works after
  // OpenClawCliRuntimeAdapter changes (dual-track-e2e.test.ts Scenario 1 regression)

  describe('Scenario 3: TestDoubleRuntimeAdapter Regression (E2EV-03)', () => {
    it('E2EV-03: TestDoubleRuntimeAdapter path unaffected — dual-track-e2e regression', async () => {
      const taskId = randomUUID();

      // Create task
      await stateManager.createTask(
        makeDiagnosticianTaskInput({
          taskId,
          workspaceDir: testDir,
          diagnostic: {
            reasonSummary: 'E2EV-03 TestDoubleRuntimeAdapter regression test',
            sourcePainId: 'pain-e2ev03-001',
            severity: 'medium',
            source: 'e2e-test',
          },
        }),
      );

      // Configure output with >= 2 kind='principle' recommendations
      const output = makeDiagnosticianOutputWithCandidates(taskId);

      // Configure TestDoubleRuntimeAdapter — same pattern as dual-track-e2e.test.ts Scenario 1
      const runtimeAdapter = new TestDoubleRuntimeAdapter({
        onPollRun: () => ({
          runId: 'td-poll-m6e2e-1',
          status: 'succeeded',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        }),
        onFetchOutput: () => ({
          runId: 'td-fetch-m6e2e-1',
          payload: output,
        }),
      });

      const runner = createRunner(runtimeAdapter);
      const result = await runner.run(taskId);

      // E2EV-03 assertion 1: result.status === 'succeeded'
      expect(result.status).toBe('succeeded');

      // E2EV-03 assertion 2: task.status === 'succeeded'
      const task = await stateManager.getTask(taskId);
      expect(task).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(task!.status).toBe('succeeded');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(task!.resultRef).toMatch(/^commit:\/\/.+/);

      // E2EV-03 assertion 3: artifact exists in DB
      const db = sqliteConn.getDb();
      const artifactRow = db.prepare('SELECT * FROM artifacts WHERE task_id = ?').get(taskId) as {
        artifact_id: string;
        artifact_kind: string;
      } | undefined;
      expect(artifactRow).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(artifactRow!.artifact_kind).toBe('diagnostician_output');

      // E2EV-03 assertion 4: >= 2 candidate rows exist
      const candidateRows = db.prepare(
        'SELECT * FROM principle_candidates WHERE artifact_id = ? AND status = ?',
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      ).all(artifactRow!.artifact_id, PENDING_STATUS) as { candidate_id: string }[];
      expect(candidateRows).toHaveLength(2);

      // E2EV-03 assertion 5: output.payload.diagnosisId matches committed output
      expect(result.output).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.output!.diagnosisId).toBe(output.diagnosisId);

      // E2EV-03 assertion 6: contextHash is present (proves context assembly ran)
      expect(result.contextHash).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.contextHash!.length).toBeGreaterThan(0);
    });
  });
});
