import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmpathyObserverManager, isEmpathyObserverSession } from '../../src/service/empathy-observer-manager.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as sessionTracker from '../../src/core/session-tracker.js';

vi.mock('../../src/core/workspace-context.js');
vi.mock('../../src/core/session-tracker.js', () => ({
  trackFriction: vi.fn(),
}));

describe('EmpathyObserverManager', () => {
  let manager: EmpathyObserverManager;

  let run: ReturnType<typeof vi.fn>;
  let getSessionMessages: ReturnType<typeof vi.fn>;
  let deleteSession: ReturnType<typeof vi.fn>;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  let api: any;

  const mockAsyncFn = <T extends (...args: any[]) => Promise<any>>(
    impl: ReturnType<typeof vi.fn>
  ) => {
    const fn = vi.fn() as unknown as impl;
    Object.defineProperty(fn, 'constructor', {
      value: function AsyncFunction() {},
      writable: true,
      configurable: true,
    });
    return fn;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    manager = EmpathyObserverManager.getInstance();
    (manager as any).sessionLocks.clear();

    run = mockAsyncFn().mockResolvedValue({ runId: 'r1' });
    getSessionMessages = mockAsyncFn().mockResolvedValue({
      messages: [],
      assistantTexts: [],
    });
    deleteSession = mockAsyncFn().mockResolvedValue(undefined);

    api = {
      config: {
        empathy_engine: {
          enabled: true,
        },
      },
      runtime: {
        subagent: {
          run,
          getSessionMessages,
          deleteSession,
        },
      },
      logger,
    };

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

    expect(first).toMatch(/^agent:main:subagent:empathy-obs-/);
    expect(second).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('generates session key with new format', async () => {
    run.mockResolvedValue({ runId: 'r1' });

    const result = await manager.spawn(api, 'session-X', 'test message');

    expect(result).toMatch(/^agent:main:subagent:empathy-obs-.*-\d+_[a-z0-9]+$/);
    const sessionKeyArg = (run as any).mock.calls[0][0].sessionKey;
    expect(sessionKeyArg).toMatch(/^agent:main:subagent:empathy-obs-session-X-/);
  });

  it('applies friction on valid observer JSON payload and calls deleteSession', async () => {
    getSessionMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: '{"damageDetected":true,"severity":"severe","confidence":0.9,"reason":"frustration"}' }],
      assistantTexts: ['{"damageDetected":true,"severity":"severe","confidence":0.9,"reason":"frustration"}'],
    });

    const sessionKey = 'agent:main:subagent:empathy-obs-test123-1774856418172_g6vwos';
    await manager.reap(api, sessionKey, '/workspace/principles');

    expect(sessionTracker.trackFriction).toHaveBeenCalledWith(
      'test123',
      40,
      'observer_empathy_severe',
      '/workspace/principles',
      { source: 'user_empathy' }
    );
    const wctx = vi.mocked(WorkspaceContext.fromHookContext).mock.results[0]?.value as any;
    expect(wctx.eventLog.recordPainSignal).toHaveBeenCalled();
    expect(wctx.trajectory.recordPainEvent).toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith({ sessionKey });
  });

  it('returns null and does not spawn when user message is empty', async () => {
    const result = await manager.spawn(api, 'session-D', '   ');

    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('gracefully degrades when observer JSON parse fails and still calls deleteSession', async () => {
    getSessionMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: 'not-json-response' }],
      assistantTexts: ['not-json-response'],
    });

    await manager.reap(api, 'agent:main:subagent:empathy-obs-test456', '/workspace/principles');

    expect(sessionTracker.trackFriction).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith({ sessionKey: 'agent:main:subagent:empathy-obs-test456' });
  });

  it('does not write user_empathy when damageDetected is false', async () => {
    getSessionMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: '{"damageDetected":false,"severity":"mild","confidence":0.9}' }],
      assistantTexts: ['{"damageDetected":false}'],
    });

    await manager.reap(api, 'agent:main:subagent:empathy-obs-test789', '/workspace/principles');

    expect(sessionTracker.trackFriction).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalled();
  });

  describe('isEmpathyObserverSession', () => {
    it('returns true for empathy observer session keys', () => {
      expect(isEmpathyObserverSession('agent:main:subagent:empathy-obs-abc123')).toBe(true);
      expect(isEmpathyObserverSession('agent:main:subagent:empathy-obs-xyz789')).toBe(true);
    });

    it('returns false for non-empathy session keys', () => {
      expect(isEmpathyObserverSession('agent:main:subagent:worker-123')).toBe(false);
      expect(isEmpathyObserverSession('agent:diagnostician:session-456')).toBe(false);
      expect(isEmpathyObserverSession('empathy_obs:old-format')).toBe(false);
    });
  });
});
