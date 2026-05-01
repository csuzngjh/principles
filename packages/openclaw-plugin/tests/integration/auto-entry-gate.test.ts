/**
 * Auto-Entry Gate Integration Tests
 *
 * Verifies that the PainDiagnosticGate → emitPainDetectedEvent → PainSignalBridge
 * path behaves correctly under various conditions.
 *
 * TC1: Trivial tool failure → no diagnosis (GFI below threshold)
 * TC2: Repeated failures → diagnosis triggered
 * TC3: High GFI event → enters Runtime V2
 * TC4: Gate rejection → structured log with gfi, reason, threshold
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { handleAfterToolCall } from '../../src/hooks/pain.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { EventLogService } from '../../src/core/event-log.js';
import { resetPainDiagnosticGateForTest, evaluatePainDiagnosticGate } from '../../src/core/pain-diagnostic-gate.js';
import * as ioUtils from '../../src/utils/io.js';

vi.mock('fs');
vi.mock('../../src/utils/io.js');
vi.mock('../../src/core/evolution-engine.js', () => ({
  recordEvolutionSuccess: vi.fn(),
  recordEvolutionFailure: vi.fn(),
}));
vi.mock('../../src/core/evolution-logger.js', () => ({
  createTraceId: vi.fn(() => 'trace-123'),
  getEvolutionLogger: vi.fn(() => ({
    logPainDetected: vi.fn(),
  })),
}));

const mockEmitSync = vi.fn();
const mockRecordProbationFeedback = vi.fn();
const mockUpdatePrincipleValueMetrics = vi.fn();

describe('Auto-Entry Gate Integration', () => {
  const workspaceDir = '/mock/workspace';
  const mockEventLog = {
    recordToolCall: vi.fn(),
    recordPainSignal: vi.fn(),
  };
  const mockConfig = {
    get: vi.fn().mockReturnValue(30),
  };

  const mockWctx = {
    workspaceDir,
    stateDir: '/mock/state',
    config: mockConfig,
    eventLog: mockEventLog,
    trajectory: {
      recordToolCall: vi.fn(),
      recordPainEvent: vi.fn(),
    },
    principleTreeLedger: {
      updatePrincipleValueMetrics: mockUpdatePrincipleValueMetrics,
    },
    evolutionReducer: {
      emitSync: mockEmitSync,
      recordProbationFeedback: mockRecordProbationFeedback,
      getPrincipleById: vi.fn().mockReturnValue(null),
      getActivePrinciples: vi.fn().mockReturnValue([]),
    },
    resolve: vi.fn().mockImplementation((key) => {
      if (key === 'PROFILE') return path.join(workspaceDir, '.principles', 'PROFILE.json');
      return '';
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEmitSync.mockReset();
    mockRecordProbationFeedback.mockReset();
    mockUpdatePrincipleValueMetrics.mockReset();
    vi.spyOn(WorkspaceContext, 'fromHookContext').mockReturnValue(mockWctx as any);
    vi.spyOn(EventLogService, 'get').mockReturnValue(mockEventLog as any);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    resetPainDiagnosticGateForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── TC1: Trivial tool failure → no diagnosis ─────────────────────────

  it('TC1: trivial tool failure does not trigger diagnosis (GFI below threshold)', () => {
    const mockCtx = { workspaceDir, sessionId: 's-tc1', api: { logger: {} } };
    const mockEvent = {
      toolName: 'write',
      params: { file_path: 'src/utils.ts' },
      error: 'Permission denied',
      result: { exitCode: 1 },
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('src/utils.ts');
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    // No pain_detected event should be emitted
    expect(mockEmitSync).not.toHaveBeenCalled();
    expect(mockEventLog.recordPainSignal).not.toHaveBeenCalled();
    expect(mockWctx.trajectory.recordPainEvent).not.toHaveBeenCalled();
  });

  // ── TC2: Repeated failures → diagnosis triggered ──────────────────────

  it('TC2: repeated same-file write failures trigger diagnosis', () => {
    const mockCtx = { workspaceDir, sessionId: 's-tc2', api: { logger: {} } };
    const mockEvent = {
      toolName: 'write',
      params: { file_path: 'src/main.ts' },
      error: 'EACCES: permission denied',
      result: { exitCode: 1 },
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('src/main.ts');
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);

    // First failure — accumulates GFI, does not emit
    handleAfterToolCall(mockEvent as any, mockCtx as any);
    expect(mockEmitSync).not.toHaveBeenCalled();

    // Second failure — repeated, should emit
    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(mockEmitSync).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pain_detected',
        data: expect.objectContaining({
          painType: 'tool_failure',
          source: 'write',
          reason: expect.stringContaining('diagnosticGate=high_gfi'),
        }),
      }),
    );
  });

  // ── TC3: High GFI event → enters Runtime V2 ───────────────────────────

  it('TC3: high GFI event enters Runtime V2 via PainDiagnosticGate', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'tool_failure',
      score: 60,
      currentGfi: 80,
      consecutiveErrors: 3,
      sessionId: 's-tc3',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: true,
      reason: 'high_gfi',
    });
    expect(decision.detail).toContain('GFI');
  });

  it('TC3: risky high-score operation enters Runtime V2', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'tool_failure',
      score: 75,
      currentGfi: 0,
      isRisky: true,
      sessionId: 's-tc3-risky',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: true,
      reason: 'risky_high_score',
    });
  });

  // ── TC4: Gate rejection structured log ─────────────────────────────────

  it('TC4: gate rejection produces structured detail with gfi and reason', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'tool_failure',
      score: 50,
      currentGfi: 32,
      consecutiveErrors: 1,
      sessionId: 's-tc4',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: false,
      reason: 'below_gate',
    });

    // The detail string contains score and gfi
    expect(decision.detail).toContain('score=50');
    expect(decision.detail).toContain('gfi=32');
  });

  it('TC4: gate rejection on low-signal subagent error', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'subagent_error',
      score: 30,
      currentGfi: 0,
      sessionId: 's-tc4-subagent',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: false,
      reason: 'below_gate',
    });
  });

  // ── Manual pain bypasses gate ──────────────────────────────────────────

  it('manual pain always bypasses gate (except cooldown)', () => {
    const decision = evaluatePainDiagnosticGate({
      source: 'manual',
      score: 1,
      currentGfi: 0,
      sessionId: 's-manual',
    });

    expect(decision).toMatchObject({
      shouldDiagnose: true,
      reason: 'manual',
    });
  });

  // ── Cooldown deduplication ─────────────────────────────────────────────

  it('cooldown prevents duplicate diagnosis within window', () => {
    const input = {
      source: 'tool_failure',
      score: 50,
      currentGfi: 80,
      sessionId: 's-cooldown',
      errorHash: 'same-error',
      nowMs: 1_000,
    };

    const first = evaluatePainDiagnosticGate(input);
    expect(first.shouldDiagnose).toBe(true);

    const second = evaluatePainDiagnosticGate({ ...input, nowMs: 2_000 });
    expect(second).toMatchObject({
      shouldDiagnose: false,
      reason: 'cooldown',
    });
  });
});
