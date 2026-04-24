/**
 * E2E m5-05 — DiagnosticianCommitter full chain verification.
 *
 * Verifies all 4 E2E hard-gate criteria (E2EV-01 through E2EV-04):
 *   E2EV-01: Happy path — full chain traversable
 *   E2EV-02: Idempotency — same task twice → one artifact, same commitId
 *   E2EV-03: Failure path — mid-transaction failure → no orphaned rows, task NOT succeeded
 *   E2EV-04: Traceability — full chain via SQL + CLI function visibility
 *
 * Based on dual-track-e2e.test.ts pattern (D-01).
 * Test file per D-03 — phase boundaries kept clean.
 * Scenario structure per D-02.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import type { DiagnosticianCommitter } from '../../store/diagnostician-committer.js';
import type { SqliteConnection } from '../../store/sqlite-connection.js';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';
import type { DiagnosticianValidator } from '../diagnostician-validator.js';
import { TestDoubleRuntimeAdapter } from '../../adapter/test-double-runtime-adapter.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';
import { PDRuntimeError } from '../../error-categories.js';
import { candidateList } from '../../cli/diagnose.js';
import type { CandidateRecord } from '../../store/runtime-state-manager.js';

// Typed status constant for SQL query parameters (avoids magic strings)
const PENDING_STATUS: CandidateRecord['status'] = 'pending';

// ── Test fixtures ──────────────────────────────────────────────────────────────

/**
 * Create DiagnosticianOutputV1 with >= 2 principle recommendations.
 * Per D-07 and E2EV-01 specific: output.recommendations includes >= 2 kind='principle' items.
 */
function makeDiagnosticianOutputWithCandidates(taskId: string): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: `diag-m5e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId,
    summary: 'E2E m5-05 test diagnosis summary',
    rootCause: 'E2E m5-05 root cause — missing validation before tool call',
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

/** Standard output without principle candidates (for failure injection scenarios). */
function _makeDiagnosticianOutput(taskId: string): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: `diag-m5e2e-std-${Date.now()}`,
    taskId,
    summary: 'Standard E2E test diagnosis summary',
    rootCause: 'Test root cause analysis',
    violatedPrinciples: [],
    evidence: [],
    recommendations: [],
    confidence: 0.85,
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
    reasonSummary: diagnostic?.reasonSummary ?? 'E2E m5-05 test task',
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

const TMP_ROOT = path.join(os.tmpdir(), `pd-e2e-m5-05-${process.pid}`);

describe('E2E m5-05', () => {
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
   * Per D-04: real committer so full artifact + candidate pipeline runs.
   * pollIntervalMs: 50, timeoutMs: 3000 per D-19.
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
        owner: 'e2e-m5-05-runner',
        runtimeKind: 'test-double',
        pollIntervalMs: 50,
        timeoutMs: 3000,
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // SCENARIO 1: Happy Path — Full chain (E2EV-01)
  // ═══════════════════════════════════════════════════════════════
  // Verifies D-04, D-05, D-06, D-07

  describe('Scenario 1: Happy Path (E2EV-01)', () => {
    it('completes full chain: task -> run -> output -> artifact -> candidates -> resultRef', async () => {
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

      // Configure adapter with output containing >= 2 kind='principle' recommendations (D-07)
      const output = makeDiagnosticianOutputWithCandidates(taskId);
      const runtimeAdapter = new TestDoubleRuntimeAdapter({
        onPollRun: () => ({
          runId: 'td-poll-1',
          status: 'succeeded',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        }),
        onFetchOutput: () => ({
          runId: 'td-fetch-1',
          payload: output,
        }),
      });

      const runner = createRunner(runtimeAdapter);
      const result = await runner.run(taskId);

      // E2EV-01 assertion 1: result.status === 'succeeded'
      expect(result.status).toBe('succeeded');

      // E2EV-01 assertion 2: task.resultRef starts with 'commit://' (D-05)
      const task = await stateManager.getTask(taskId);
      expect(task).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(task!.resultRef).toMatch(/^commit:\/\/.+/);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const commitId = task!.resultRef!.replace('commit://', '');

      // E2EV-01 assertion 3: task status is 'succeeded'
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(task!.status).toBe('succeeded');

      // E2EV-01 assertion 3b: run's output_payload matches committed output (updateRunOutput was called)
      const db = sqliteConn.getDb();
      const runsForTask = db.prepare('SELECT run_id, output_payload FROM runs WHERE task_id = ?').all(taskId) as Record<string, unknown>[];
      expect(runsForTask.length).toBeGreaterThan(0);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const latestRun = runsForTask[runsForTask.length - 1]!;
      expect(latestRun.output_payload).not.toBeNull();
      const parsedOutput = JSON.parse(latestRun.output_payload as string);
      expect(parsedOutput.diagnosisId).toBe(output.diagnosisId);
      expect(parsedOutput.summary).toBe(output.summary);

      // E2EV-01 assertion 4: artifact row exists in DB (D-06)
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
      expect(artifactRow!.task_id).toBe(taskId);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const artifactId = artifactRow!.artifact_id;

      // E2EV-01 assertion 5: candidates exist in DB (D-07)
      // Output has 2 kind='principle' recommendations → expect 2 candidate rows
      const candidateRows = db.prepare(
        'SELECT * FROM principle_candidates WHERE artifact_id = ? AND status = ?',
      ).all(artifactId, PENDING_STATUS) as { candidate_id: string; description: string }[];
      expect(candidateRows).toHaveLength(2);
      expect(candidateRows.every((c) => c.description.length > 0)).toBe(true);

      // E2EV-01 assertion 6: commit row links task to artifact
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
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SCENARIO 2: Idempotency — Same taskId+runId committed twice (E2EV-02)
  // ═══════════════════════════════════════════════════════════════
  // Verifies D-08, D-09
  // Note: runner.run() cannot be called twice on a succeeded task (lease_conflict).
  // Idempotency is tested at the committer level by calling commit() twice with same
  // taskId+runId and verifying same commitId is returned.

  describe('Scenario 2: Idempotency (E2EV-02)', () => {
    it('committing the same task twice produces one artifact, no duplicates, same commitId', async () => {
      const taskId = randomUUID();
      const runId = 'td-poll-idem';

      await stateManager.createTask(
        makeDiagnosticianTaskInput({
          taskId,
          workspaceDir: testDir,
          diagnostic: { reasonSummary: 'E2EV-02 idempotency test' },
        }),
      );

      // Also create a run record so the committer doesn't fail FK constraint
      const db = sqliteConn.getDb();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, attempt_number, created_at, updated_at)
        VALUES (?, ?, ?, 'running', ?, 1, ?, ?)
      `).run(runId, taskId, 'test-double', now, now, now);

      const output = makeDiagnosticianOutputWithCandidates(taskId);
      const committer = new SqliteDiagnosticianCommitter(sqliteConn);
      const idempotencyKey = `${taskId}:${runId}`;

      // First commit
      const result1 = await committer.commit({ runId, taskId, output, idempotencyKey });
      expect(result1.candidateCount).toBe(2);
      const firstCommitId = result1.commitId;

      // Second commit with same taskId+runId — idempotency should return same result
      const result2 = await committer.commit({ runId, taskId, output, idempotencyKey });
      expect(result2.commitId).toBe(firstCommitId); // E2EV-02 assertion 1: same commitId (D-09)
      expect(result2.candidateCount).toBe(2);

      // E2EV-02 assertion 2: only one artifact row exists
      const artifactCount = db.prepare('SELECT COUNT(*) as cnt FROM artifacts WHERE task_id = ?').get(taskId) as { cnt: number };
      expect(artifactCount.cnt).toBe(1);

      // E2EV-02 assertion 3: only 2 candidate rows (no duplicates on re-commit)
      const artifactRow = db.prepare('SELECT artifact_id FROM artifacts WHERE task_id = ?').get(taskId) as { artifact_id: string };
      const candidateCount = db.prepare('SELECT COUNT(*) as cnt FROM principle_candidates WHERE artifact_id = ?').get(artifactRow.artifact_id) as { cnt: number };
      expect(candidateCount.cnt).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SCENARIO 3: Failure Path — Mid-transaction failure (E2EV-03)
  // ═══════════════════════════════════════════════════════════════
  // Verifies D-10, D-11, D-12, D-13

  describe('Scenario 3: Failure Path (E2EV-03)', () => {
    it('commit failure leaves no orphaned rows, task NOT succeeded, error is artifact_commit_failed', async () => {
      const taskId = randomUUID();

      await stateManager.createTask(
        makeDiagnosticianTaskInput({
          taskId,
          workspaceDir: testDir,
          diagnostic: { reasonSummary: 'E2EV-03 failure path test' },
        }),
      );

      const output = makeDiagnosticianOutputWithCandidates(taskId);
      const runtimeAdapter = new TestDoubleRuntimeAdapter({
        onPollRun: () => ({
          runId: 'td-poll-fail',
          status: 'succeeded',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        }),
        onFetchOutput: () => ({ runId: 'td-fetch-fail', payload: output }),
      });

      // Committer wrapper that throws after artifact insert (D-10)
      // Uses db.transaction() so the artifact insert rolls back on throw
      const failingCommitter: DiagnosticianCommitter = {
        commit: async (input) => {
          const db = sqliteConn.getDb();
          const artifactId = `fail-artifact-${Date.now()}`;
          const now = new Date().toISOString();
          db.transaction(() => {
            db.prepare(`
              INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(artifactId, input.runId, input.taskId, 'diagnostician_output', JSON.stringify(input.output), now);
            throw new PDRuntimeError(
              'artifact_commit_failed',
              'Simulated mid-transaction failure for E2EV-03',
            );
          })();
          // Never reached
          return { commitId: '', artifactId: '', candidateCount: 0 };
        },
      };

      const runner = new DiagnosticianRunner(
        {
          stateManager,
          contextAssembler,
          runtimeAdapter,
          eventEmitter,
          validator: new PassThroughValidator(),
          committer: failingCommitter,
        },
        {
          owner: 'e2e-m5-05-runner',
          runtimeKind: 'test-double',
          pollIntervalMs: 50,
          timeoutMs: 3000,
        },
      );

      const result = await runner.run(taskId);

      // E2EV-03 assertion 1: result.status is NOT 'succeeded' (D-11)
      expect(result.status).not.toBe('succeeded');

      // E2EV-03 assertion 2: error is artifact_commit_failed (D-13)
      expect(result.errorCategory).toBe('artifact_commit_failed');

      // E2EV-03 assertion 3: task status is NOT 'succeeded'
      const task = await stateManager.getTask(taskId);
      expect(task).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(task!.status).not.toBe('succeeded');

      // E2EV-03 assertion 4: no orphaned artifact rows (D-12)
      const db = sqliteConn.getDb();
      const artifactRows = db.prepare('SELECT * FROM artifacts WHERE task_id = ?').all(taskId);
      expect(artifactRows.length).toBe(0); // Transaction rolled back, no orphaned artifacts
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SCENARIO 4: Traceability — Full chain + CLI visibility (E2EV-04)
  // ═══════════════════════════════════════════════════════════════
  // Verifies D-14, D-15, D-16, D-17

  describe('Scenario 4: Traceability + CLI Visibility (E2EV-04)', () => {
    it('full chain traversable via SQL + candidateList CLI function shows candidates', async () => {
      const taskId = randomUUID();

      await stateManager.createTask(
        makeDiagnosticianTaskInput({
          taskId,
          workspaceDir: testDir,
          diagnostic: {
            reasonSummary: 'E2EV-04 traceability test',
            sourcePainId: 'pain-e2ev04-001',
            severity: 'critical',
            source: 'e2e-test',
          },
        }),
      );

      const output = makeDiagnosticianOutputWithCandidates(taskId);
      const runtimeAdapter = new TestDoubleRuntimeAdapter({
        onPollRun: () => ({
          runId: 'td-poll-trace',
          status: 'succeeded',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        }),
        onFetchOutput: () => ({ runId: 'td-fetch-trace', payload: output }),
      });

      const runner = createRunner(runtimeAdapter);
      const result = await runner.run(taskId);
      expect(result.status).toBe('succeeded');

      // E2EV-04 Step 1: task.resultRef = 'commit://<commitId>' (D-14)
      const task = await stateManager.getTask(taskId);
      expect(task).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(task!.resultRef).toMatch(/^commit:\/\/.+/);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const commitId = task!.resultRef!.replace('commit://', '');

      // E2EV-04 Step 2: Direct SQL — commit -> artifact (D-15)
      const db = sqliteConn.getDb();
      const commitRow = db.prepare('SELECT * FROM commits WHERE commit_id = ?').get(commitId) as {
        commit_id: string;
        artifact_id: string;
        task_id: string;
        status: string;
      } | undefined;
      expect(commitRow).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(commitRow!.commit_id).toBe(commitId); // commitId in DB matches resultRef
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(commitRow!.status).toBe('committed');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const artifactId = commitRow!.artifact_id;

      // E2EV-04 Step 3: Direct SQL — artifact row (D-15)
      const artifactRow = db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(artifactId) as {
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
      expect(artifactRow!.task_id).toBe(taskId);

      // E2EV-04 Step 4: Direct SQL — candidates (D-16)
      const candidateRows = db.prepare(
        'SELECT * FROM principle_candidates WHERE artifact_id = ?',
      ).all(artifactId) as { candidate_id: string; title: string; description: string; status: string }[];
      expect(candidateRows.length).toBeGreaterThanOrEqual(2);
      expect(candidateRows.every((c) => c.status === PENDING_STATUS)).toBe(true);

      // E2EV-04 Step 5: CLI visibility via candidateList function (D-17)
      const listResult = await candidateList({ taskId, stateManager });
      expect(listResult.candidates.length).toBeGreaterThanOrEqual(2);
      expect(listResult.taskId).toBe(taskId);

      // E2EV-04 Step 6: Each candidate has required fields
      for (const candidate of listResult.candidates) {
        expect(candidate.candidateId.length).toBeGreaterThan(0);
        expect(candidate.title.length).toBeGreaterThan(0);
        expect(candidate.description.length).toBeGreaterThan(0);
        expect(['pending', 'consumed', 'expired'] as const).toContain(candidate.status);
      }
    });
  });
});
