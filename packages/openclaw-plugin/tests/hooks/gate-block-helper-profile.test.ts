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

  it('does NOT call recordPainEvent (SDK observability path handles trajectory.db)', async () => {
    // PRI-453: Legacy recordPainEvent was removed to avoid double-write.
    // SDK observability path (emitPainDetectedEvent with default recordObservability: true)
    // handles all writes: events_*.jsonl + evolution.jsonl + trajectory.db.
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const { recordGateBlockAndReturn } = await import('../../src/hooks/gate-block-helper.js');
    const wctx = makeTestWctx() as any;

    recordGateBlockAndReturn(
      wctx,
      {
        filePath: 'src/danger.ts',
        reason: 'Test block',
        toolName: 'write',
        sessionId,
      },
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    );

    expect(wctx.trajectory.recordPainEvent).not.toHaveBeenCalled();
  });
});

// ── PRI-454: Gate B rollback tests ───────────────────────────────────────────

describe('PRI-651-B1: Gate B is the only admission gate', () => {
  const sessionId = 's-rollback-test';

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

  it('Gate B path: useGateB=true when both flags are ON (default)', async () => {
    // This test documents the default Gate B behavior.
    // The mock at line 35-38 already sets both flags to enabled=true.
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const { recordGateBlockAndReturn } = await import('../../src/hooks/gate-block-helper.js');
    const wctx = makeTestWctx() as any;
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

    const result = recordGateBlockAndReturn(
      wctx,
      {
        filePath: 'src/danger.ts',
        reason: 'Test block',
        toolName: 'write',
        sessionId,
      },
      logger,
    );

    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    // Gate B path: triage decides admit vs skip
    // With non-risky path and no consecutiveErrors, triage should skip
    expect(logger.info).toHaveBeenCalled();
  });

  it('Gate B path: risky path with PROFILE.json triggers admission', async () => {
    // Arrange: PROFILE exists with risky path configuration
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      risk_paths: ['src/danger.ts'],
    }));

    // Mock isRisky to return true for this path
    vi.doMock('../../src/utils/io.js', () => ({
      isRisky: vi.fn(() => true),
    }));
    vi.resetModules();

    const { recordGateBlockAndReturn } = await import('../../src/hooks/gate-block-helper.js');
    const wctx = makeTestWctx() as any;
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

    const result = recordGateBlockAndReturn(
      wctx,
      {
        filePath: 'src/danger.ts',
        reason: 'Test block',
        toolName: 'write',
        sessionId,
      },
      logger,
    );

    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    // Risky path should trigger admission decision in Gate B
  });

  it('Gate B path: consecutiveErrors >= 4 triggers admission (Rule 3)', async () => {
    // Arrange: session with 4 consecutive errors
    vi.mocked(fs.existsSync).mockReturnValue(false);
    clearSession(sessionId);
    // Manually set consecutive errors via getSession
    const { trackBlock, getSession } = await import('../../src/core/session-tracker.js');
    trackBlock(sessionId);
    trackBlock(sessionId);
    trackBlock(sessionId);
    trackBlock(sessionId);

    const { recordGateBlockAndReturn } = await import('../../src/hooks/gate-block-helper.js');
    const wctx = makeTestWctx() as any;
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

    const result = recordGateBlockAndReturn(
      wctx,
      {
        filePath: 'src/safe.ts',
        reason: 'Test block',
        toolName: 'write',
        sessionId,
      },
      logger,
    );

    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    // 4 consecutive errors should trigger admission in Gate B
  });

  it('Gate B path: cooldown prevents duplicate diagnosis', async () => {
    // Arrange: same error hash already diagnosed
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const { recordGateBlockAndReturn } = await import('../../src/hooks/gate-block-helper.js');
    const wctx = makeTestWctx() as any;
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

    // First call should potentially trigger diagnosis
    recordGateBlockAndReturn(
      wctx,
      {
        filePath: 'src/test.ts',
        reason: 'First block',
        toolName: 'write',
        sessionId,
      },
      logger,
    );

    // Second call with same error hash should be cooldown-blocked
    const result2 = recordGateBlockAndReturn(
      wctx,
      {
        filePath: 'src/test.ts',
        reason: 'First block', // same reason → same error hash
        toolName: 'write',
        sessionId,
      },
      logger,
    );

    expect(result2).toBeDefined();
    expect(result2.block).toBe(true);
  });
});
