/**
 * Gate Block Helper — PROFILE loading resilience tests
 *
 * Verifies that recordGateBlockAndReturn handles malformed/oversized PROFILE
 * gracefully: try/catch, 1MB size guard, fallback to non-risky, no crash.
 *
 * ERR checklist:
 * - ERR-026: All PROFILE loads have try/catch (gate-block-helper.ts matches pain.ts)
 * - ERR-024/025: Production-path tests for the edge case
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { EventLogService } from '../../src/core/event-log.js';
import { clearSession } from '../../src/core/session-tracker.js';
import { resetPainDiagnosticGateForTest } from '../../src/core/pain-diagnostic-gate.js';

vi.mock('fs');
vi.mock('../../src/utils/io.js', () => ({
  isRisky: vi.fn(() => false),
}));
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
vi.mock('../../src/core/pd-config-loader.js', () => ({
  loadPdConfigForPlugin: vi.fn(() => ({ ok: true, source: 'mock', effective: {}, errors: [] })),
  loadFeatureFlagFromConfig: vi.fn(() => ({ enabled: true, source: 'test' })),
}));

const mockEmitSync = vi.fn();
const mockRecordProbationFeedback = vi.fn();
const mockUpdatePrincipleValueMetrics = vi.fn();

function makeTestWctx(overrides: Record<string, unknown> = {}) {
  return {
    workspaceDir: '/mock/workspace',
    stateDir: '/mock/state',
    config: { get: vi.fn().mockReturnValue(40) },
    eventLog: {
      recordGateBlock: vi.fn(),
      recordPainSignal: vi.fn(),
    },
    trajectory: {
      recordGateBlock: vi.fn(),
      recordPainEvent: vi.fn(),
      recordToolCall: vi.fn(),
    },
    principleTreeLedger: {
      updatePrincipleValueMetrics: mockUpdatePrincipleValueMetrics,
    },
    evolutionReducer: {
      emitSync: mockEmitSync,
      recordProbationFeedback: mockRecordProbationFeedback,
      getPrincipleById: vi.fn(),
    },
    resolve: vi.fn().mockImplementation((key: string) => {
      if (key === 'PROFILE') return '/mock/workspace/PROFILE.json';
      return '';
    }),
    ...overrides,
  };
}

describe('Gate Block Helper — PROFILE Resilience', () => {
  const sessionId = 's-profile-test';

  beforeEach(() => {
    vi.clearAllMocks();
    mockEmitSync.mockReset();
    mockRecordProbationFeedback.mockReset();
    mockUpdatePrincipleValueMetrics.mockReset();
    vi.spyOn(WorkspaceContext, 'fromHookContext').mockReturnValue(makeTestWctx() as any);
    vi.spyOn(EventLogService, 'get').mockReturnValue({} as any);
    clearSession(sessionId);
    resetPainDiagnosticGateForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('malformed PROFILE.json does not throw, returns block result with non-risky fallback', async () => {
    // Arrange: PROFILE exists but contains invalid JSON
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json }');

    // Dynamic import AFTER mocks are set up
    const { recordGateBlockAndReturn } = await import('../../src/hooks/gate-block-helper.js');

    // Act & Assert: does NOT throw
    const result = recordGateBlockAndReturn(
      makeTestWctx() as any,
      {
        filePath: 'src/danger.ts',
        reason: 'Test block reason',
        toolName: 'write',
        sessionId,
      },
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    );

    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('Security Gate Blocked');
    // verify emitPainDetectedEvent was NOT called (triage fell back to non-risky)
    expect(mockEmitSync).not.toHaveBeenCalled();
  });

  it('oversized PROFILE (>1MB) falls back to non-risky without crash', async () => {
    // Arrange: PROFILE > 1MB
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('x'.repeat(1024 * 1024 + 1));

    const { recordGateBlockAndReturn } = await import('../../src/hooks/gate-block-helper.js');

    const result = recordGateBlockAndReturn(
      makeTestWctx() as any,
      {
        filePath: 'src/danger.ts',
        reason: 'Test block reason',
        toolName: 'write',
        sessionId,
      },
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    );

    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    expect(mockEmitSync).not.toHaveBeenCalled();
  });

  it('missing PROFILE.json defaults to non-risky without error', async () => {
    // Arrange: PROFILE does not exist
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const { recordGateBlockAndReturn } = await import('../../src/hooks/gate-block-helper.js');

    const result = recordGateBlockAndReturn(
      makeTestWctx() as any,
      {
        filePath: 'src/danger.ts',
        reason: 'Test block',
        toolName: 'edit',
        sessionId,
      },
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    );

    expect(result).toBeDefined();
    expect(result.block).toBe(true);
  });

  it('fs.readFileSync permission error falls back gracefully', async () => {
    // Arrange: existsSync returns true but readFileSync throws
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const { recordGateBlockAndReturn } = await import('../../src/hooks/gate-block-helper.js');

    const result = recordGateBlockAndReturn(
      makeTestWctx() as any,
      {
        filePath: 'src/danger.ts',
        reason: 'Test block',
        toolName: 'write',
        sessionId,
      },
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    );

    expect(result).toBeDefined();
    expect(result.block).toBe(true);
  });
});
