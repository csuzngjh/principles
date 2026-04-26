/**
 * Legacy openclaw-history Import Regression Test — M6 E2E E2EV-08
 *
 * Verifies that DiagnosticianRunner can handle tasks with openclaw-history
 * runtime kind (imported from existing openclaw conversations) without errors.
 *
 * This is a regression test for the legacy openclaw-history import path.
 * Based on dual-track-e2e.test.ts Scenario 4 pattern.
 *
 * Requirement: E2EV-08
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
import type { DiagnosticianCommitter } from '../../store/diagnostician-committer.js';
import type { DiagnosticianValidator } from '../diagnostician-validator.js';
import { TestDoubleRuntimeAdapter } from '../../adapter/test-double-runtime-adapter.js';
import type { TaskRecord } from '../../task-status.js';

// -- Test fixtures --

function makeDiagnosticianOutput(taskId: string) {
  return {
    valid: true,
    diagnosisId: `diag-legacy-${Date.now()}`,
    taskId,
    summary: 'Legacy openclaw-history regression test diagnosis summary',
    rootCause: 'Legacy openclaw-history regression test root cause analysis',
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
    reasonSummary: diagnostic?.reasonSummary ?? 'Legacy openclaw-history regression test',
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

// -- Mock committer --

const mockCommitter: DiagnosticianCommitter = {
  commit: async () => ({
    commitId: 'legacy-test-commit-id',
    artifactId: 'legacy-test-artifact-id',
    candidateCount: 0,
  }),
};

// -- Test setup --

const TMP_ROOT = path.join(os.tmpdir(), `pd-legacy-e2e-${process.pid}`);

describe('E2E m6-06 — Legacy openclaw-history Import Regression (E2EV-08)', () => {
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

  beforeEach(async () => {
    testDir = path.join(TMP_ROOT, `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    runtimeAdapter: TestDoubleRuntimeAdapter,
    validator: DiagnosticianValidator = new PassThroughValidator(),
  ): DiagnosticianRunner {
    return new DiagnosticianRunner(
      {
        stateManager,
        contextAssembler,
        runtimeAdapter,
        eventEmitter,
        validator,
        committer: mockCommitter,
      },
      {
        owner: 'legacy-e2e-runner',
        runtimeKind: 'test-double',
        pollIntervalMs: 50,
        timeoutMs: 3000,
      },
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // E2EV-08: openclaw-history runtime imported context does not break DiagnosticianRunner
  // ═══════════════════════════════════════════════════════════════

  it('E2EV-08: openclaw-history runtime imported context does not break DiagnosticianRunner', async () => {
    const taskId = 'e2e-legacy-001';

    // Step 1: Create a task
    await stateManager.createTask(
      makeDiagnosticianTaskInput({
        taskId,
        workspaceDir: testDir,
        diagnostic: { reasonSummary: 'E2EV-08 legacy import regression test' },
      }),
    );

    // Step 2: Acquire a lease with runtimeKind 'openclaw-history'
    // This simulates importing an existing openclaw conversation
    await stateManager.acquireLease({
      taskId,
      owner: 'setup-agent',
      runtimeKind: 'openclaw-history',
    });

    // Step 3: Mark task succeeded to create a completed run with output
    // (mimics imported openclaw-history context)
    await stateManager.markTaskSucceeded(taskId, 'run://setup-run');

    // Step 4: Reset task to pending state for the runner to process
    await stateManager.updateTask(taskId, {
      status: 'pending',
      attemptCount: 0,
      lastError: null,
      resultRef: null,
    });

    // Step 5: Verify openclaw-history run exists (pre-condition check)
    const runsBefore = await stateManager.getRunsByTask(taskId);
    expect(runsBefore.length).toBeGreaterThan(0);

    // Step 6: Configure TestDoubleRuntimeAdapter for success
    const successOutput = makeDiagnosticianOutput(taskId);
    const runtimeAdapter = new TestDoubleRuntimeAdapter({
      onPollRun: (_runId) => ({
        runId: 'td-legacy-1',
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      }),
      onFetchOutput: (_runId) => ({
        runId: 'td-legacy-fetch-1',
        payload: successOutput,
      }),
    });

    // Step 7: Create DiagnosticianRunner
    const runner = createRunner(runtimeAdapter, new PassThroughValidator());

    // Step 8: Call runner.run(taskId)
    const result = await runner.run(taskId);

    // Assertion 1: result.status === 'succeeded'
    expect(result.status).toBe('succeeded');

    // Assertion 2: result.contextHash is defined and non-empty
    // (context assembly ran without errors from openclaw-history run)
    expect(result.contextHash).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.contextHash!.length).toBeGreaterThan(0);

    // Assertion 3: result.output.valid === true
    expect(result.output).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.output!.valid).toBe(true);

    // Assertion 4: Verify task in store has status === 'succeeded'
    const task = await stateManager.getTask(taskId);
    expect(task).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(task!.status).toBe('succeeded');

    // Assertion 5: Verify at least one run with runtimeKind === 'openclaw-history' exists
    const allRuns = await stateManager.getRunsByTask(taskId);
    const openclawHistoryRuns = allRuns.filter((r) => r.runtimeKind === 'openclaw-history');
    expect(openclawHistoryRuns.length).toBeGreaterThan(0);

    // Assertion 6: Verify result.taskId matches
    expect(result.taskId).toBe(taskId);
  });
});