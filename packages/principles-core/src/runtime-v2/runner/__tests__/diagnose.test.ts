/**
 * CLI diagnose module tests.
 *
 * Tests 3 scenarios:
 *   1. run() delegates to DiagnosticianRunner.run() and returns RunnerResult
 *   2. status() returns key TaskRecord fields (taskId, status, attemptCount, maxAttempts, lastError)
 *   3. status() returns null when task does not exist
 */
import { describe, it, expect, vi } from 'vitest';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { DiagnosticianRunnerLike } from '../../pain-signal-bridge.js';
import type { RunnerResult } from '../runner-result.js';
import type { TaskRecord } from '../../task-status.js';
import type { CandidateRecord } from '../../store/candidate/candidate-store.js';
import type { RunRecord } from '../../store/run/run-store.js';
import { run, status, candidateShow } from '../../cli/diagnose.js';

// ── Test fixtures ──────────────────────────────────────────────────────────────

function makeTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task-cli-001',
    taskKind: 'diagnostician',
    status: 'succeeded',
    createdAt: '2026-04-23T00:00:00Z',
    updatedAt: '2026-04-23T00:00:00Z',
    attemptCount: 2,
    maxAttempts: 3,
    lastError: undefined,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('cli/diagnose', () => {
  // 1. run() delegates to runner.run()
  it('run() delegates to DiagnosticianRunner.run() and returns RunnerResult', async () => {
    const TASK_ID = 'task-run-001';
    const mockRunnerResult: RunnerResult = {
      status: 'succeeded',
      taskId: TASK_ID,
      contextHash: 'hash123',
      attemptCount: 1,
    };

    const runMock = vi.fn<(taskId: string) => Promise<RunnerResult>>().mockResolvedValue(mockRunnerResult);
    const mockRunner = { run: runMock } as unknown as DiagnosticianRunnerLike;

    const mockStateManager = {} as unknown as RuntimeStateManager;

    const result = await run({ taskId: TASK_ID, runner: mockRunner, stateManager: mockStateManager });

    expect(result).toBe(mockRunnerResult);
    expect(runMock).toHaveBeenCalledWith(TASK_ID);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  // 2. status() returns key TaskRecord fields
  it('status() returns taskId, status, attemptCount, maxAttempts, lastError from TaskRecord', async () => {
    const TASK_ID = 'task-status-001';
    const taskRecord = makeTaskRecord({
      taskId: TASK_ID,
      status: 'failed',
      attemptCount: 3,
      maxAttempts: 5,
      lastError: 'execution_failed',
    });

    const getTaskMock = vi.fn<() => Promise<TaskRecord | null>>().mockResolvedValue(taskRecord);
    const mockStateManager = { getTask: getTaskMock } as unknown as RuntimeStateManager;

    const _mockRunner = {} as unknown as DiagnosticianRunnerLike;

    const result = await status({ taskId: TASK_ID, stateManager: mockStateManager });

    expect(result).toEqual({
      taskId: TASK_ID,
      status: 'failed',
      attemptCount: 3,
      maxAttempts: 5,
      lastError: 'execution_failed',
      commitId: null,
      artifactId: null,
      candidateCount: null,
    });
    expect(getTaskMock).toHaveBeenCalledWith(TASK_ID);
  });

  // 3. status() returns null when task not found
  it('status() returns null when task does not exist', async () => {
    const TASK_ID = 'task-nonexistent';

    const getTaskMock = vi.fn<() => Promise<TaskRecord | null>>().mockResolvedValue(null);
    const mockStateManager = { getTask: getTaskMock } as unknown as RuntimeStateManager;

    const _mockRunner = {} as unknown as DiagnosticianRunnerLike;

    const result = await status({ taskId: TASK_ID, stateManager: mockStateManager });

    expect(result).toBeNull();
    expect(getTaskMock).toHaveBeenCalledWith(TASK_ID);
  });
});

// ── F10-1: candidateShow source_run_id validation ────────────────────────────

function makeCandidateRecord(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    candidateId: 'c-test-001',
    artifactId: 'art-test-001',
    taskId: 'task-test-001',
    sourceRunId: 'run-test-001',
    title: 'Test candidate',
    description: 'Test description',
    confidence: 0.85,
    sourceRecommendationJson: '{}',
    recommendationKind: 'principle',
    status: 'consumed',
    createdAt: '2026-06-30T00:00:00Z',
    ...overrides,
  };
}

function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-test-001',
    taskId: 'task-test-001',
    runtimeKind: 'openclaw',
    executionStatus: 'succeeded',
    startedAt: '2026-06-30T00:00:00Z',
    endedAt: '2026-06-30T00:01:00Z',
    attemptNumber: 1,
    createdAt: '2026-06-30T00:00:00Z',
    updatedAt: '2026-06-30T00:00:00Z',
    ...overrides,
  };
}

describe('candidateShow — F10-1 source_run_id validation', () => {
  it('returns null when candidate not found', async () => {
    const getCandidateMock = vi.fn().mockResolvedValue(null);
    const mockStateManager = { getCandidate: getCandidateMock } as unknown as RuntimeStateManager;

    const result = await candidateShow({ candidateId: 'nonexistent', stateManager: mockStateManager });

    expect(result).toBeNull();
  });

  it('F10-1: adds warning when sourceRunId does not exist in runs (dangling)', async () => {
    const candidate = makeCandidateRecord({ sourceRunId: 'run-does-not-exist' });
    const getCandidateMock = vi.fn().mockResolvedValue(candidate);
    const getRunMock = vi.fn().mockResolvedValue(null); // run not found → dangling
    const mockStateManager = {
      getCandidate: getCandidateMock,
      getRun: getRunMock,
    } as unknown as RuntimeStateManager;

    const result = await candidateShow({ candidateId: 'c-test-001', stateManager: mockStateManager });

    expect(result).not.toBeNull();
    if (!result) return; // narrow for TypeScript
    expect(result.warning).toContain('does not exist in runs table');
    expect(result.warning).toContain('run-does-not-exist');
    expect(result.reason).toContain('dangling_source_run_id');
    expect(result.nextAction).toContain('pd runtime internalization integrity');
    expect(result.sourceRunId).toBe('run-does-not-exist'); // still returns the value
  });

  it('F10-1: does NOT add warning when sourceRunId exists (negative case)', async () => {
    const candidate = makeCandidateRecord({ sourceRunId: 'run-exists' });
    const runRecord = makeRunRecord({ runId: 'run-exists' });
    const getCandidateMock = vi.fn().mockResolvedValue(candidate);
    const getRunMock = vi.fn().mockResolvedValue(runRecord); // run found → valid
    const mockStateManager = {
      getCandidate: getCandidateMock,
      getRun: getRunMock,
    } as unknown as RuntimeStateManager;

    const result = await candidateShow({ candidateId: 'c-test-001', stateManager: mockStateManager });

    expect(result).not.toBeNull();
    if (!result) return; // narrow for TypeScript
    expect(result.warning).toBeUndefined();
    expect(result.reason).toBeUndefined();
    expect(result.nextAction).toBeUndefined();
  });

  it('F10-1: treats getRun throw as dangling (fail loud, rc-9)', async () => {
    const candidate = makeCandidateRecord({ sourceRunId: 'run-throw' });
    const getCandidateMock = vi.fn().mockResolvedValue(candidate);
    const getRunMock = vi.fn().mockRejectedValue(new Error('DB corruption'));
    const mockStateManager = {
      getCandidate: getCandidateMock,
      getRun: getRunMock,
    } as unknown as RuntimeStateManager;

    const result = await candidateShow({ candidateId: 'c-test-001', stateManager: mockStateManager });

    expect(result).not.toBeNull();
    if (!result) return; // narrow for TypeScript
    expect(result.warning).toContain('could not be verified');
    expect(result.reason).toContain('source_run_id_lookup_failed');
    expect(result.nextAction).toContain('database integrity');
  });
});
