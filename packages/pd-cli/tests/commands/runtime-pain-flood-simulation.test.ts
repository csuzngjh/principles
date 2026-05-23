import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockRunPainFloodSimulation } = vi.hoisted(() => ({
  mockRunPainFloodSimulation: vi.fn(),
}));

vi.mock('../../src/services/pain-flood-simulation-runner.js', () => ({
  runPainFloodSimulation: mockRunPainFloodSimulation,
}));

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleRuntimePainFlood } from '../../src/commands/runtime-pain-flood-simulation.js';

function makePassedSummary() {
  return {
    status: 'healthy' as const,
    workspaceMode: 'temp' as const,
    generatedAt: new Date().toISOString(),
    inputPainCount: 77,
    acceptedPainCount: 22,
    skippedDuplicateCount: 55,
    candidateCount: 22,
    taskCount: 22,
    maxEvidencePreviewLength: 450,
    contextBudgetSummary: 'moderate (max 450 chars)',
    stages: [
      {
        scenarioName: 'identical_flood' as const,
        status: 'passed' as const,
        inputCount: 10,
        acceptedCount: 1,
        skippedCount: 9,
        taskCount: 1,
        candidateCount: 1,
      },
      {
        scenarioName: 'similar_flood' as const,
        status: 'passed' as const,
        inputCount: 10,
        acceptedCount: 10,
        skippedCount: 0,
        taskCount: 10,
        candidateCount: 10,
      },
      {
        scenarioName: 'duplicate_submission' as const,
        status: 'passed' as const,
        inputCount: 2,
        acceptedCount: 1,
        skippedCount: 1,
        taskCount: 1,
        candidateCount: 1,
      },
      {
        scenarioName: 'tool_failure_flood' as const,
        status: 'passed' as const,
        inputCount: 5,
        acceptedCount: 1,
        skippedCount: 4,
        taskCount: 1,
        candidateCount: 1,
      },
      {
        scenarioName: 'stress_test' as const,
        status: 'passed' as const,
        inputCount: 50,
        acceptedCount: 33,
        skippedCount: 17,
        taskCount: 33,
        candidateCount: 33,
      },
    ],
  };
}

describe('handleRuntimePainFlood (CLI handler)', () => {
  let tempDir = '';
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-pain-flood-test-'));
    mockRunPainFloodSimulation.mockReset();
    process.exitCode = undefined as unknown as number;
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    process.exitCode = originalExitCode;
  });

  it('uses temp workspace when no workspace specified', async () => {
    mockRunPainFloodSimulation.mockResolvedValue({
      ...makePassedSummary(),
      workspaceMode: 'temp',
    });

    await handleRuntimePainFlood({});

    expect(mockRunPainFloodSimulation).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceMode: 'temp' }),
    );
    const calledDir = mockRunPainFloodSimulation.mock.calls[0][0].workspaceDir;
    expect(calledDir).toContain('pd-pain-flood-');
  });

  it('uses explicit workspace when --workspace is provided', async () => {
    mockRunPainFloodSimulation.mockResolvedValue({
      ...makePassedSummary(),
      workspaceMode: 'explicit_workspace',
    });

    await handleRuntimePainFlood({ workspace: tempDir });

    expect(mockRunPainFloodSimulation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: tempDir,
        workspaceMode: 'explicit_workspace',
      }),
    );
  });

  it('--json output contains all expected measurement fields', async () => {
    const summary = makePassedSummary();
    mockRunPainFloodSimulation.mockResolvedValue(summary);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await handleRuntimePainFlood({ json: true });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = logSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('inputPainCount');
      expect(parsed).toHaveProperty('acceptedPainCount');
      expect(parsed).toHaveProperty('skippedDuplicateCount');
      expect(parsed).toHaveProperty('candidateCount');
      expect(parsed).toHaveProperty('taskCount');
      expect(parsed).toHaveProperty('maxEvidencePreviewLength');
      expect(parsed).toHaveProperty('contextBudgetSummary');
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('stages');
      expect(parsed.stages).toHaveLength(5);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('passes count options to the runner', async () => {
    mockRunPainFloodSimulation.mockResolvedValue(makePassedSummary());

    await handleRuntimePainFlood({ identicalCount: 5, similarCount: 3, stressCount: 20 });

    expect(mockRunPainFloodSimulation).toHaveBeenCalledWith(
      expect.objectContaining({
        identicalCount: 5,
        similarCount: 3,
        stressCount: 20,
      }),
    );
  });

  it('sets process.exitCode = 1 when status is degraded', async () => {
    mockRunPainFloodSimulation.mockResolvedValue({
      ...makePassedSummary(),
      status: 'degraded',
      stages: [
        { scenarioName: 'identical_flood', status: 'passed', inputCount: 10, acceptedCount: 1, skippedCount: 9, taskCount: 1, candidateCount: 1 },
        { scenarioName: 'similar_flood', status: 'failed', inputCount: 10, acceptedCount: 0, skippedCount: 10, taskCount: 0, candidateCount: 0, reason: 'bridge error' },
        { scenarioName: 'duplicate_submission', status: 'passed', inputCount: 2, acceptedCount: 1, skippedCount: 1, taskCount: 1, candidateCount: 1 },
        { scenarioName: 'tool_failure_flood', status: 'passed', inputCount: 5, acceptedCount: 1, skippedCount: 4, taskCount: 1, candidateCount: 1 },
        { scenarioName: 'stress_test', status: 'passed', inputCount: 50, acceptedCount: 33, skippedCount: 17, taskCount: 33, candidateCount: 33 },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handleRuntimePainFlood({ workspace: tempDir });
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('sets process.exitCode = 1 when status is error', async () => {
    mockRunPainFloodSimulation.mockResolvedValue({
      ...makePassedSummary(),
      status: 'error',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handleRuntimePainFlood({ workspace: tempDir });
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('cleans up temp workspace on success', async () => {
    mockRunPainFloodSimulation.mockResolvedValue(makePassedSummary());

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await handleRuntimePainFlood({});

      const calledDir = mockRunPainFloodSimulation.mock.calls[0][0].workspaceDir;
      expect(fs.existsSync(calledDir)).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does not delete explicit workspace after run', async () => {
    fs.mkdirSync(path.join(tempDir, '.pd'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.state'), { recursive: true });

    mockRunPainFloodSimulation.mockResolvedValue({
      ...makePassedSummary(),
      workspaceMode: 'explicit_workspace',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await handleRuntimePainFlood({ workspace: tempDir });
      expect(fs.existsSync(tempDir)).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('runner rejection propagates and temp workspace is still cleaned up', async () => {
    mockRunPainFloodSimulation.mockRejectedValue(new Error('EACCES: permission denied, mkdir'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(handleRuntimePainFlood({})).rejects.toThrow('EACCES');
      const calledDir = mockRunPainFloodSimulation.mock.calls[0][0].workspaceDir;
      expect(fs.existsSync(calledDir)).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('injected failure produces structured reason and recommendedNextIssue', async () => {
    mockRunPainFloodSimulation.mockResolvedValue({
      status: 'degraded',
      workspaceMode: 'temp',
      generatedAt: new Date().toISOString(),
      inputPainCount: 77,
      acceptedPainCount: 22,
      skippedDuplicateCount: 55,
      candidateCount: 22,
      taskCount: 22,
      maxEvidencePreviewLength: 0,
      contextBudgetSummary: 'no evidence produced',
      stages: [
        { scenarioName: 'identical_flood', status: 'passed', inputCount: 10, acceptedCount: 1, skippedCount: 9, taskCount: 1, candidateCount: 1 },
        { scenarioName: 'similar_flood', status: 'failed', inputCount: 10, acceptedCount: 0, skippedCount: 10, taskCount: 0, candidateCount: 0, reason: 'Injected failure: stress test overflow' },
        { scenarioName: 'duplicate_submission', status: 'passed', inputCount: 2, acceptedCount: 1, skippedCount: 1, taskCount: 1, candidateCount: 1 },
        { scenarioName: 'tool_failure_flood', status: 'passed', inputCount: 5, acceptedCount: 1, skippedCount: 4, taskCount: 1, candidateCount: 1 },
        { scenarioName: 'stress_test', status: 'passed', inputCount: 50, acceptedCount: 33, skippedCount: 17, taskCount: 33, candidateCount: 33 },
      ],
      recommendedNextIssue: 'PRI-208: Similar pain flood caused unbounded task creation — check dedup and evidence budget',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handleRuntimePainFlood({ json: true });
      const output = logSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.status).toBe('degraded');
      expect(parsed.recommendedNextIssue).toContain('PRI-208');
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});