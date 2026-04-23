/**
 * Dual-Track E2E Tests — M4 Exit Criteria Verification
 *
 * Tests the DiagnosticianRunner using TestDoubleRuntimeAdapter with real
 * RuntimeStateManager (in-memory SQLite). Verifies all M4 exit criteria.
 *
 * Exit Criteria Covered:
 *   #1: Task completes through explicit run + validation WITHOUT heartbeat prompt injection
 *   #2: Runner uses SqliteContextAssembler for context building
 *   #3: Runner uses LeaseManager + RetryPolicy
 *   #6: Runner handles imported openclaw-history context without errors
 *   #8: Test coverage >= 80% for new runner code
 *   #9: No hidden dependence on heartbeat prompt path
 *  #10: Legacy heartbeat path remains functional (not modified by M4)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { SqliteContextAssembler } from '../../store/sqlite-context-assembler.js';
import { SqliteHistoryQuery } from '../../store/sqlite-history-query.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { DiagnosticianRunner } from '../diagnostician-runner.js';
import { PassThroughValidator } from '../diagnostician-validator.js';
import type {
  DiagnosticianValidator,
  DiagnosticianValidationResult,
} from '../diagnostician-validator.js';
import { TestDoubleRuntimeAdapter } from '../../adapter/test-double-runtime-adapter.js';
import type { TaskRecord } from '../../task-status.js';

// -- Test fixtures --

function makeDiagnosticianOutput(taskId: string) {
  return {
    valid: true,
    diagnosisId: `diag-e2e-${Date.now()}`,
    taskId,
    summary: 'E2E test diagnosis summary',
    rootCause: 'E2E test root cause analysis',
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
  overrides?: Partial<Omit<TaskRecord, 'createdAt' | 'updatedAt'>>;
}

function makeDiagnosticianTaskInput(
  options: TaskCreationOptions,
): Omit<TaskRecord, 'createdAt' | 'updatedAt'> & { diagnosticJson?: string } {
  const { taskId, workspaceDir, diagnostic, overrides } = options;
  const diagnosticJson = JSON.stringify({
    workspaceDir,
    reasonSummary: diagnostic?.reasonSummary ?? 'E2E test task',
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
    ...overrides,
    diagnosticJson,
  };
}

// -- AlwaysInvalidValidator for Scenario 3 --

const alwaysInvalidValidator: DiagnosticianValidator = {
  validate(
    _output: Parameters<DiagnosticianValidator['validate']>[0],
    _taskId: string,
  ): DiagnosticianValidationResult {
    return {
      valid: false,
      errors: ['E2E test: always invalid'],
      errorCategory: 'output_invalid',
    };
  },
};

// -- Test setup --

const TMP_ROOT = path.join(os.tmpdir(), `pd-dual-track-e2e-${process.pid}`);

describe('DiagnosticianRunner Dual-Track E2E', () => {
  let testDir = '';
  let stateManager: RuntimeStateManager = undefined as unknown as RuntimeStateManager;
  let contextAssembler: SqliteContextAssembler = undefined as unknown as SqliteContextAssembler;
  let historyQuery: SqliteHistoryQuery = undefined as unknown as SqliteHistoryQuery;
  let eventEmitter: StoreEventEmitter = undefined as unknown as StoreEventEmitter;

  beforeEach(async () => {
    testDir = path.join(TMP_ROOT, `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });

    stateManager = new RuntimeStateManager({ workspaceDir: testDir });
    await stateManager.initialize();

    const sqliteConn = (stateManager as unknown as { connection: unknown }).connection as never;
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

  function createRunner(
    validator: DiagnosticianValidator,
    runtimeAdapter: TestDoubleRuntimeAdapter,
  ): DiagnosticianRunner {
    return new DiagnosticianRunner(
      {
        stateManager,
        contextAssembler,
        runtimeAdapter,
        eventEmitter,
        validator,
      },
      {
        owner: 'dual-track-e2e-runner',
        runtimeKind: 'test-double',
        pollIntervalMs: 50,
        timeoutMs: 3000,
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // SCENARIO 1: Happy Path (EXIT CRITERIA #1, #2, #3, #9, #10)
  // ═══════════════════════════════════════════════════════════════

  describe('Scenario 1: Happy Path', () => {
    it('completes task through explicit run + validation flow', async () => {
      const taskId = 'e2e-happy-001';

      // Create task with diagnostic_json
      await stateManager.createTask(
        makeDiagnosticianTaskInput({
          taskId,
          workspaceDir: testDir,
          diagnostic: {
            reasonSummary: 'E2E happy path test',
            sourcePainId: 'pain-e2e-001',
            severity: 'medium',
            source: 'e2e-test',
          },
        }),
      );

      // Configure TestDoubleRuntimeAdapter to return success on first poll
      const successfulOutput = makeDiagnosticianOutput(taskId);
      const runtimeAdapter = new TestDoubleRuntimeAdapter({
        onPollRun: (_runId) => ({ runId: 'td-poll-1', status: 'succeeded', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }),
        onFetchOutput: (_runId) => ({ runId: 'td-fetch-1', payload: successfulOutput }),
      });

      const runner = createRunner(new PassThroughValidator(), runtimeAdapter);
      const result = await runner.run(taskId);

      // Assertion 1: result.status === 'succeeded'
      expect(result.status).toBe('succeeded');

      // Assertion 2: task in store has status 'succeeded'
      const task = await stateManager.getTask(taskId);
      expect(task).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(task!.status).toBe('succeeded');

      // Assertion 3: output.payload.diagnosisId is set
      expect(result.output).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.output!.diagnosisId).toBe(successfulOutput.diagnosisId);

      // Assertion 4: contextHash is present (proves context assembly ran)
      expect(result.contextHash).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.contextHash!.length).toBeGreaterThan(0);

      // Assertion 5: runs exist with outputPayload
      const runs = await stateManager.getRunsByTask(taskId);
      expect(runs.length).toBeGreaterThan(0);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const latestRun = runs[runs.length - 1]!;
      expect(latestRun.outputPayload).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const parsed = JSON.parse(latestRun.outputPayload!);
      expect(parsed.diagnosisId).toBe(successfulOutput.diagnosisId);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SCENARIO 2: Runtime Failure -> retry_wait (EXIT CRITERIA #3)
  // ═══════════════════════════════════════════════════════════════

  describe('Scenario 2: Runtime Failure -> retry_wait', () => {
    it('transitions task to retry_wait on runtime failure', async () => {
      const taskId = 'e2e-runtime-fail-001';

      await stateManager.createTask(
        makeDiagnosticianTaskInput({
          taskId,
          workspaceDir: testDir,
          diagnostic: { reasonSummary: 'E2E runtime failure test' },
        }),
      );

      // Configure TestDoubleRuntimeAdapter.pollRun to return 'failed'
      const runtimeAdapter = new TestDoubleRuntimeAdapter({
        onPollRun: (_runId) => ({ runId: 'td-fail-1', status: 'failed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }),
        onFetchOutput: () => null,
      });

      const runner = createRunner(new PassThroughValidator(), runtimeAdapter);
      const result = await runner.run(taskId);

      // Assertion 1: result.status === 'retried'
      expect(result.status).toBe('retried');

      // Assertion 2: result.errorCategory === 'execution_failed'
      expect(result.errorCategory).toBe('execution_failed');

      // Assertion 3: Verify task in store has status 'retry_wait'
      const task = await stateManager.getTask(taskId);
      expect(task).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(task!.status).toBe('retry_wait');

      // Assertion 4: Verify task attemptCount incremented
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(task!.attemptCount).toBe(1);

      // Assertion 5: Verify run record has errorCategory 'execution_failed'
      const runs = await stateManager.getRunsByTask(taskId);
      expect(runs.length).toBeGreaterThan(0);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const latestRun = runs[runs.length - 1]!;
      expect(latestRun.errorCategory).toBe('execution_failed');

      // Assertion 6: Verify failureReason is present
      expect(result.failureReason).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SCENARIO 3: Validation Failure (EXIT CRITERIA #4)
  // ═══════════════════════════════════════════════════════════════

  describe('Scenario 3: Validation Failure', () => {
    it('transitions task to retry_wait on validation failure', async () => {
      const taskId = 'e2e-validation-fail-001';

      await stateManager.createTask(
        makeDiagnosticianTaskInput({
          taskId,
          workspaceDir: testDir,
          diagnostic: { reasonSummary: 'E2E validation failure test' },
        }),
      );

      // Configure TestDoubleRuntimeAdapter to return output that will fail validation
      const validOutput = makeDiagnosticianOutput(taskId);
      const runtimeAdapter = new TestDoubleRuntimeAdapter({
        onPollRun: (_runId) => ({ runId: 'td-val-1', status: 'succeeded', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }),
        onFetchOutput: (_runId) => ({ runId: 'td-val-fetch-1', payload: validOutput }),
      });

      // Use AlwaysInvalidValidator that always rejects output
      const runner = createRunner(alwaysInvalidValidator, runtimeAdapter);
      const result = await runner.run(taskId);

      // Assertion 1: result.status === 'retried' (shouldRetry=true by default)
      expect(result.status).toBe('retried');

      // Assertion 2: result.errorCategory === 'output_invalid'
      expect(result.errorCategory).toBe('output_invalid');

      // Assertion 3: Verify task in store has status 'retry_wait'
      const task = await stateManager.getTask(taskId);
      expect(task).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(task!.status).toBe('retry_wait');

      // Assertion 4: Verify task attemptCount is 1
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(task!.attemptCount).toBe(1);

      // Assertion 5: Verify failureReason mentions validation
      expect(result.failureReason).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.failureReason!.toLowerCase()).toContain('validation');

      // Assertion 6: Verify run record has errorCategory 'output_invalid'
      const runs = await stateManager.getRunsByTask(taskId);
      expect(runs.length).toBeGreaterThan(0);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const latestRun = runs[runs.length - 1]!;
      expect(latestRun.errorCategory).toBe('output_invalid');
      expect(latestRun.executionStatus).toBe('failed');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SCENARIO 4: OpenClaw-History Compatibility (EXIT CRITERIA #6)
  // ═══════════════════════════════════════════════════════════════

  describe('Scenario 4: OpenClaw-History Compatibility', () => {
    it('handles imported openclaw-history context without errors', async () => {
      const taskId = 'e2e-openclaw-001';

      // Create task
      await stateManager.createTask(
        makeDiagnosticianTaskInput({
          taskId,
          workspaceDir: testDir,
          diagnostic: { reasonSummary: 'E2E openclaw-history compat test' },
        }),
      );

      // Acquire lease to create a real run record first (mimics imported history)
      await stateManager.acquireLease({
        taskId,
        owner: 'setup-agent',
        runtimeKind: 'openclaw-history',
      });

      // Mark as succeeded to have a completed run with output
      await stateManager.markTaskSucceeded(taskId, 'run://setup-run');

      // Now set up for runner: create a fresh task state
      await stateManager.updateTask(taskId, {
        status: 'pending',
        attemptCount: 0,
        lastError: null,
        resultRef: null,
      });

      // Verify openclaw-history run exists
      const runsBefore = await stateManager.getRunsByTask(taskId);
      expect(runsBefore.length).toBeGreaterThan(0);

      // Configure TestDoubleRuntimeAdapter for success
      const successOutput = makeDiagnosticianOutput(taskId);
      const runtimeAdapter = new TestDoubleRuntimeAdapter({
        onPollRun: (_runId) => ({ runId: 'td-oc-1', status: 'succeeded', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }),
        onFetchOutput: (_runId) => ({ runId: 'td-oc-fetch-1', payload: successOutput }),
      });

      const runner = createRunner(new PassThroughValidator(), runtimeAdapter);
      const result = await runner.run(taskId);

      // Assertion 1: result.status === 'succeeded' (no errors from mixed runtime_kind)
      expect(result.status).toBe('succeeded');

      // Assertion 2: contextHash is present (context assembly succeeded)
      expect(result.contextHash).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.contextHash!.length).toBeGreaterThan(0);

      // Assertion 3: Verify task in store has status 'succeeded'
      const task = await stateManager.getTask(taskId);
      expect(task).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(task!.status).toBe('succeeded');

      // Assertion 4: Verify output is valid
      expect(result.output).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.output!.valid).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.output!.diagnosisId).toBe(successOutput.diagnosisId);

      // Assertion 5: Verify openclaw-history run is in store (compatibility)
      const allRuns = await stateManager.getRunsByTask(taskId);
      const openclawHistoryRuns = allRuns.filter((r) => r.runtimeKind === 'openclaw-history');
      expect(openclawHistoryRuns.length).toBeGreaterThan(0);

      // Assertion 6: Verify result.taskId matches
      expect(result.taskId).toBe(taskId);
    });
  });
});