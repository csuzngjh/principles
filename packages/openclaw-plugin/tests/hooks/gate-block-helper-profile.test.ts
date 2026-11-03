/**
 * Gate Block Helper — Phase A contract
 *
 * A RuleHost block is a real technical fact. The helper must keep the block,
 * persist gate_blocks (EventLog + trajectory) and session GFI tracking, while
 * never creating an automatic Pain event or Diagnostician task.
 *
 * ERR checklist:
 * - ERR-024/025: Production-path tests for the block contract
 * - rc-9: persistence warnings stay observable
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { EventLogService } from '../../src/core/event-log.js';
import { clearSession } from '../../src/core/session-tracker.js';

vi.mock('../../src/core/pd-config-loader.js', () => ({
  loadPdConfigForPlugin: vi.fn(() => ({ ok: true, source: 'mock', effective: {}, errors: [] })),
  loadFeatureFlagFromConfig: vi.fn(() => ({ enabled: false, source: 'test' })),
}));

const mockEmitSync = vi.fn();
const mockUpdatePrincipleValueMetrics = vi.fn();
const mockRecordGateBlock = vi.fn();
const mockRecordPainEvent = vi.fn();

function makeTestWctx() {
  return {
    workspaceDir: '/mock/workspace',
    stateDir: '/mock/state',
    config: { get: vi.fn().mockReturnValue(40) },
    eventLog: {
      recordGateBlock: vi.fn(),
      recordPainSignal: vi.fn(),
    },
    trajectory: {
      recordGateBlock: mockRecordGateBlock,
      recordPainEvent: mockRecordPainEvent,
      recordToolCall: vi.fn(),
    },
    principleTreeLedger: {
      updatePrincipleValueMetrics: mockUpdatePrincipleValueMetrics,
    },
    evolutionReducer: {
      emitSync: mockEmitSync,
      getPrincipleById: vi.fn(),
    },
    resolve: vi.fn().mockImplementation((key: string) => {
      if (key === 'PROFILE') return '/mock/workspace/PROFILE.json';
      return '';
    }),
  };
}

describe('Gate Block Helper — Phase A (block fact, never automatic Pain)', () => {
  const sessionId = 's-phase-a-gate';

  beforeEach(() => {
    vi.clearAllMocks();
    mockEmitSync.mockReset();
    mockUpdatePrincipleValueMetrics.mockReset();
    mockRecordGateBlock.mockReset();
    mockRecordPainEvent.mockReset();
    vi.spyOn(WorkspaceContext, 'fromHookContext').mockReturnValue(makeTestWctx() as any);
    vi.spyOn(EventLogService, 'get').mockReturnValue({} as any);
    clearSession(sessionId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a correct block: block=true, gate_blocks persisted, zero Pain', async () => {
    const { recordGateBlockAndReturn } = await import('../../src/hooks/gate-block-helper.js');
    const wctx = makeTestWctx() as any;

    const result = recordGateBlockAndReturn(
      wctx,
      { filePath: 'src/danger.ts', reason: 'RuleHost denied write', toolName: 'write', sessionId },
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    );

    expect(result.block).toBe(true);
    expect(result.blockReason).toContain('Security Gate Blocked');
    expect(wctx.eventLog.recordGateBlock).toHaveBeenCalledWith(sessionId, expect.objectContaining({ toolName: 'write', filePath: 'src/danger.ts' }));
    expect(mockRecordGateBlock).toHaveBeenCalledWith(expect.objectContaining({ sessionId, toolName: 'write', filePath: 'src/danger.ts', reason: 'RuleHost denied write' }));
    expect(mockRecordPainEvent).not.toHaveBeenCalled();
    expect(wctx.eventLog.recordPainSignal).not.toHaveBeenCalled();
    expect(mockEmitSync).not.toHaveBeenCalled();
  });

  it('never admits Pain even for a risky path (PROFILE is no longer consulted)', async () => {
    const { recordGateBlockAndReturn } = await import('../../src/hooks/gate-block-helper.js');
    const wctx = makeTestWctx() as any;

    const result = recordGateBlockAndReturn(
      wctx,
      { filePath: '/etc/passwd', reason: 'absolute-path block', toolName: 'write', sessionId },
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    );

    expect(result.block).toBe(true);
    expect(mockRecordPainEvent).not.toHaveBeenCalled();
    expect(mockEmitSync).not.toHaveBeenCalled();
    expect(mockUpdatePrincipleValueMetrics).not.toHaveBeenCalled();
  });

  it('never escalates after repeated blocks (consecutiveErrors >= 4 retired)', async () => {
    const { trackBlock } = await import('../../src/core/session-tracker.js');
    trackBlock(sessionId);
    trackBlock(sessionId);
    trackBlock(sessionId);
    trackBlock(sessionId);

    const { recordGateBlockAndReturn } = await import('../../src/hooks/gate-block-helper.js');
    const wctx = makeTestWctx() as any;
    const result = recordGateBlockAndReturn(
      wctx,
      { filePath: 'src/safe.ts', reason: 'Test block', toolName: 'write', sessionId },
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    );

    expect(result.block).toBe(true);
    expect(mockEmitSync).not.toHaveBeenCalled();
    expect(mockRecordPainEvent).not.toHaveBeenCalled();
  });

  it('keeps session health tracking for every block', async () => {
    const { recordGateBlockAndReturn } = await import('../../src/hooks/gate-block-helper.js');
    const { getSession } = await import('../../src/core/session-tracker.js');
    const before = getSession(sessionId)?.blockedAttempts ?? 0;

    recordGateBlockAndReturn(
      makeTestWctx() as any,
      { filePath: 'src/danger.ts', reason: 'blocked', toolName: 'write', sessionId },
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    );

    expect(getSession(sessionId)?.blockedAttempts ?? 0).toBe(before + 1);
  });

  it('survives a missing trajectory collector (event-log row retained)', async () => {
    const { recordGateBlockAndReturn } = await import('../../src/hooks/gate-block-helper.js');
    const wctx = makeTestWctx() as any;
    wctx.trajectory = undefined;
    const warn = vi.fn();

    const result = recordGateBlockAndReturn(
      wctx,
      { filePath: 'src/danger.ts', reason: 'blocked', toolName: 'write', sessionId },
      { warn, error: vi.fn(), info: vi.fn() },
    );

    expect(result.block).toBe(true);
    expect(wctx.eventLog.recordGateBlock).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trajectory_collector_unmounted'));
  });
});
