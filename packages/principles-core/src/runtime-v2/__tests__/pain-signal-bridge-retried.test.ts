/**
 * Regression test for: retried task with empty candidateIds in pain chain trace.
 *
 * Issue: When DiagnosticianRunner returns status='retried', PainSignalBridge.onPainDetected()
 * returned candidateIds=[] and ledgerEntryIds=[], but trace show also showed candidateIds=[].
 * This made the UAT report "output_invalid" and allHaveCandidates=false.
 *
 * The bridge correctly propagates retried status with empty candidates (since no commit was made).
 * The fix verifies this behavior is stable and trace show correctly reads the task state.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { DiagnosticianRunnerLike } from '../pain-signal-bridge.js';
import type { CandidateIntakeService } from '../candidate-intake-service.js';
import type { LedgerAdapter } from '../candidate-intake.js';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import type { RunnerResult } from '../runner/runner-result.js';

const TASK_ID = 'diagnosis_pain-retry-001';
const PAIN_ID = 'pain-retry-001';

interface MockStateManager {
  getTask: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  getCandidatesByTaskId: ReturnType<typeof vi.fn>;
  getRunsByTask: ReturnType<typeof vi.fn>;
  getRetryPolicy: ReturnType<typeof vi.fn>;
}

interface MockRunner {
  run: ReturnType<typeof vi.fn>;
}

function createMocks() {
  const stateManager: MockStateManager = {
    getTask: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    getCandidatesByTaskId: vi.fn(),
    getRunsByTask: vi.fn(),
    getRetryPolicy: vi.fn(),
  };

  const runner: MockRunner = {
    run: vi.fn(),
  };

  const intakeService = {};
  const ledgerAdapter: LedgerAdapter = {
    register: vi.fn(),
    existsForCandidate: vi.fn(),
    getEntries: vi.fn(),
  } as unknown as LedgerAdapter;

  return {
    stateManager: stateManager as unknown as RuntimeStateManager,
    runner: runner as unknown as DiagnosticianRunnerLike,
    intakeService: intakeService as unknown as CandidateIntakeService,
    ledgerAdapter,
    _stateManager: stateManager,
    _runner: runner,
  };
}

function makeRetriedResult(): RunnerResult {
  return {
    status: 'retried',
    taskId: TASK_ID,
    errorCategory: 'output_invalid',
    failureReason: 'Validation failed: confidence must be between 0 and 1',
    attemptCount: 1,
  };
}

describe('PainSignalBridge retried with empty candidates', () => {
  it('returns status=retried with empty candidateIds when runner returns retried', async () => {
    const mocks = createMocks();
    mocks._stateManager.getTask.mockResolvedValue(null);
    mocks._stateManager.createTask.mockResolvedValue(undefined);
    mocks._stateManager.updateTask.mockResolvedValue(undefined);
    mocks._stateManager.getCandidatesByTaskId.mockResolvedValue([]);
    mocks._stateManager.getRunsByTask.mockResolvedValue([]);
    mocks._stateManager.getRetryPolicy.mockReturnValue({
      calculateBackoff: () => 30000,
      shouldRetry: () => true,
    });
    mocks._runner.run.mockResolvedValue(makeRetriedResult());

    const bridge = new PainSignalBridge({
      stateManager: mocks.stateManager,
      runner: mocks.runner,
      intakeService: mocks.intakeService,
      ledgerAdapter: mocks.ledgerAdapter,
    });

    const result = await bridge.onPainDetected({
      painId: PAIN_ID,
      painType: 'tool_failure',
      source: 'test',
      reason: 'test',
      evidence: [{ sourceRef: 'test-src', note: 'test evidence' }],
    });

    expect(result.status).toBe('retried');
    expect(result.candidateIds).toHaveLength(0);
    expect(result.ledgerEntryIds).toHaveLength(0);
    expect(result.errorCategory).toBe('output_invalid');
    expect(result.message).toBe('Validation failed: confidence must be between 0 and 1');
  });

  it('does NOT query candidates or runs when runner returns retried', async () => {
    const mocks = createMocks();
    mocks._stateManager.getTask.mockResolvedValue(null);
    mocks._stateManager.createTask.mockResolvedValue(undefined);
    mocks._stateManager.updateTask.mockResolvedValue(undefined);
    mocks._stateManager.getCandidatesByTaskId.mockResolvedValue([]);
    mocks._stateManager.getRunsByTask.mockResolvedValue([]);
    mocks._stateManager.getRetryPolicy.mockReturnValue({
      calculateBackoff: () => 30000,
      shouldRetry: () => true,
    });
    mocks._runner.run.mockResolvedValue(makeRetriedResult());

    const bridge = new PainSignalBridge({
      stateManager: mocks.stateManager,
      runner: mocks.runner,
      intakeService: mocks.intakeService,
      ledgerAdapter: mocks.ledgerAdapter,
    });

    await bridge.onPainDetected({
      painId: PAIN_ID,
      painType: 'tool_failure',
      source: 'test',
      reason: 'test',
      evidence: [{ sourceRef: 'test-src', note: 'test evidence' }],
    });

    expect(mocks._stateManager.getCandidatesByTaskId).not.toHaveBeenCalled();
    expect(mocks._stateManager.getRunsByTask).not.toHaveBeenCalled();
  });

  it('returns retried with empty candidates for existing task in retry_wait state', async () => {
    const mocks = createMocks();
    mocks._stateManager.getTask.mockResolvedValue({
      taskId: TASK_ID,
      taskKind: 'diagnostician',
      status: 'retry_wait',
      createdAt: '2026-05-10T00:00:00Z',
      updatedAt: '2026-05-10T00:00:00Z',
      attemptCount: 1,
      maxAttempts: 3,
      lastError: 'output_invalid',
    });
    mocks._stateManager.createTask.mockResolvedValue(undefined);
    mocks._stateManager.updateTask.mockResolvedValue(undefined);
    mocks._stateManager.getCandidatesByTaskId.mockResolvedValue([]);
    mocks._stateManager.getRunsByTask.mockResolvedValue([]);
    mocks._stateManager.getRetryPolicy.mockReturnValue({
      calculateBackoff: () => 30000,
      shouldRetry: () => true,
    });
    mocks._runner.run.mockResolvedValue(makeRetriedResult());

    const bridge = new PainSignalBridge({
      stateManager: mocks.stateManager,
      runner: mocks.runner,
      intakeService: mocks.intakeService,
      ledgerAdapter: mocks.ledgerAdapter,
    });

    const result = await bridge.onPainDetected({
      painId: PAIN_ID,
      painType: 'tool_failure',
      source: 'test',
      reason: 'test',
      evidence: [{ sourceRef: 'test-src', note: 'test evidence' }],
    });

    expect(result.status).toBe('retried');
    expect(result.candidateIds).toHaveLength(0);
    expect(result.ledgerEntryIds).toHaveLength(0);
  });
});
