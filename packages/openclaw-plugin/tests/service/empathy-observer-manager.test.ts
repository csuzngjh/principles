import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmpathyObserverManager } from '../../src/service/empathy-observer-manager.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as sessionTracker from '../../src/core/session-tracker.js';

vi.mock('../../src/core/workspace-context.js');
vi.mock('../../src/core/session-tracker.js', () => ({
  trackFriction: vi.fn(),
}));

describe('EmpathyObserverManager', () => {
  let manager: EmpathyObserverManager;

  const run = vi.fn();
  const getSessionMessages = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const api: any = {
    config: {
      empathy_engine: {
        enabled: true,
      },
    },
    runtime: {
      subagent: {
        run,
        getSessionMessages,
      },
    },
    logger,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    manager = EmpathyObserverManager.getInstance();
    (manager as any).sessionLocks.clear();

    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue({
      config: {
        get: vi.fn((key: string) => {
          if (key === 'empathy_engine.penalties.mild') return 10;
          if (key === 'empathy_engine.penalties.moderate') return 25;
          if (key === 'empathy_engine.penalties.severe') return 40;
          return undefined;
        }),
      },
      eventLog: {
        recordPainSignal: vi.fn(),
      },
      trajectory: {
        recordPainEvent: vi.fn(),
      },
    } as any);
  });

  it('enforces per-session concurrency lock', async () => {
    run.mockResolvedValue({ runId: 'r1' });

    const first = await manager.spawn(api, 'session-A', 'user msg');
    const second = await manager.spawn(api, 'session-A', 'user msg 2');

    expect(first).toMatch(/^empathy_obs:session-A:\d+$/);
    expect(second).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });



  it('applies friction on valid observer JSON payload', async () => {
    getSessionMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: '{"damageDetected":true,"severity":"severe","confidence":0.9,"reason":"frustration"}' }],
      assistantTexts: ['{"damageDetected":true,"severity":"severe","confidence":0.9,"reason":"frustration"}'],
    });

    await manager.reap(api, 'empathy_obs:session-C:123', '/workspace/principles');

    expect(sessionTracker.trackFriction).toHaveBeenCalledWith(
      'session-C',
      40,
      'observer_empathy_severe',
      '/workspace/principles',
      { source: 'user_empathy' }
    );
    const wctx = vi.mocked(WorkspaceContext.fromHookContext).mock.results[0]?.value as any;
    expect(wctx.eventLog.recordPainSignal).toHaveBeenCalledWith(
      'session-C',
      expect.objectContaining({
        score: 40,
        source: 'user_empathy',
        origin: 'system_infer',
        severity: 'severe',
        confidence: 0.9,
        detection_mode: 'structured',
        deduped: false,
      })
    );
    expect(wctx.trajectory.recordPainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-C',
        source: 'user_empathy',
        score: 40,
        origin: 'system_infer',
      })
    );
  });

  it('returns null and does not spawn when user message is empty', async () => {
    const result = await manager.spawn(api, 'session-D', '   ');

    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('gracefully degrades when observer JSON parse fails', async () => {
    getSessionMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: 'not-json-response' }],
      assistantTexts: ['not-json-response'],
    });

    await manager.reap(api, 'empathy_obs:session-B:123', '/workspace/principles');

    expect(sessionTracker.trackFriction).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
