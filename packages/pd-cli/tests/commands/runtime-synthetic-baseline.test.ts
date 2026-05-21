import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockRunSyntheticBaseline } = vi.hoisted(() => ({
  mockRunSyntheticBaseline: vi.fn(),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  runSyntheticBaseline: mockRunSyntheticBaseline,
}));

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleRuntimeSyntheticBaseline } from '../../src/commands/runtime-synthetic-baseline.js';

function makePassedSummary() {
  return {
    status: 'passed' as const,
    workspaceMode: 'temp' as const,
    generatedAt: new Date().toISOString(),
    stages: [
      { name: 'pain_intake' as const, status: 'passed' as const },
      { name: 'diagnostician_task_created' as const, status: 'passed' as const },
      { name: 'candidate_created' as const, status: 'passed' as const },
      { name: 'ledger_consistent' as const, status: 'passed' as const },
      { name: 'internalization_queue_ready' as const, status: 'passed' as const },
      { name: 'canary_health' as const, status: 'passed' as const },
    ],
  };
}

describe('handleRuntimeSyntheticBaseline (CLI handler)', () => {
  let tempDir = '';
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-synth-test-'));
    mockRunSyntheticBaseline.mockReset();
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
    mockRunSyntheticBaseline.mockResolvedValue({
      ...makePassedSummary(),
      workspaceMode: 'temp',
    });

    await handleRuntimeSyntheticBaseline({});

    expect(mockRunSyntheticBaseline).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceMode: 'temp' }),
    );
    const calledDir = mockRunSyntheticBaseline.mock.calls[0][0].workspaceDir;
    expect(calledDir).toContain('pd-synth-baseline-');
  });

  it('uses explicit workspace when --workspace is provided', async () => {
    mockRunSyntheticBaseline.mockResolvedValue({
      ...makePassedSummary(),
      workspaceMode: 'explicit_workspace',
    });

    await handleRuntimeSyntheticBaseline({ workspace: tempDir });

    expect(mockRunSyntheticBaseline).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: tempDir,
        workspaceMode: 'explicit_workspace',
      }),
    );
  });

  it('--json output contains status, workspaceMode, generatedAt, stages', async () => {
    const summary = makePassedSummary();
    mockRunSyntheticBaseline.mockResolvedValue(summary);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await handleRuntimeSyntheticBaseline({ json: true });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = logSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('workspaceMode');
      expect(parsed).toHaveProperty('generatedAt');
      expect(parsed).toHaveProperty('stages');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('sets process.exitCode = 1 when status is failed', async () => {
    mockRunSyntheticBaseline.mockResolvedValue({
      ...makePassedSummary(),
      status: 'failed',
      stages: [
        { name: 'pain_intake', status: 'failed', reason: 'test failure' },
        { name: 'diagnostician_task_created', status: 'failed', reason: 'prerequisite' },
        { name: 'candidate_created', status: 'failed', reason: 'prerequisite' },
        { name: 'ledger_consistent', status: 'failed', reason: 'prerequisite' },
        { name: 'internalization_queue_ready', status: 'failed', reason: 'prerequisite' },
        { name: 'canary_health', status: 'failed', reason: 'prerequisite' },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handleRuntimeSyntheticBaseline({ workspace: tempDir });
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('sets process.exitCode = 1 when status is degraded', async () => {
    mockRunSyntheticBaseline.mockResolvedValue({
      ...makePassedSummary(),
      status: 'degraded',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handleRuntimeSyntheticBaseline({ workspace: tempDir });
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('cleans up temp workspace on success', async () => {
    mockRunSyntheticBaseline.mockResolvedValue(makePassedSummary());

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await handleRuntimeSyntheticBaseline({});

      const calledDir = mockRunSyntheticBaseline.mock.calls[0][0].workspaceDir;
      expect(fs.existsSync(calledDir)).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does not delete explicit workspace after run', async () => {
    fs.mkdirSync(path.join(tempDir, '.pd'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.state'), { recursive: true });

    mockRunSyntheticBaseline.mockResolvedValue({
      ...makePassedSummary(),
      workspaceMode: 'explicit_workspace',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await handleRuntimeSyntheticBaseline({ workspace: tempDir });
      expect(fs.existsSync(tempDir)).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
