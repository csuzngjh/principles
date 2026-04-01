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
  let waitForRun: ReturnType<typeof vi.fn>;
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
    (manager as any).activeRuns.clear();
    (manager as any).completedSessions.clear();

    run = mockAsyncFn().mockResolvedValue({ runId: 'r1' });
    waitForRun = mockAsyncFn().mockResolvedValue({ status: 'ok' });
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
          waitForRun,
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

    expect(result).toMatch(/^agent:main:subagent:empathy-obs-session-X-\d+$/);
    const sessionKeyArg = (run as any).mock.calls[0][0].sessionKey;
    expect(sessionKeyArg).toMatch(/^agent:main:subagent:empathy-obs-session-X-\d+$/);
  });

  it('spawn returns session key without blocking on waitForRun', async () => {
    run.mockResolvedValue({ runId: 'r1' });

    const resultPromise = manager.spawn(api, 'session-Y', 'test message');
    expect(run).toHaveBeenCalledTimes(1);
    const result = await resultPromise;
    expect(result).toMatch(/^agent:main:subagent:empathy-obs-/);
  });

  it('waitForRun(status=ok) triggers reapBySession with friction tracking', async () => {
    run.mockResolvedValue({ runId: 'r1' });
    waitForRun.mockResolvedValue({ status: 'ok' });
    getSessionMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: '{"damageDetected":true,"severity":"severe","confidence":0.9,"reason":"frustration"}' }],
      assistantTexts: ['{"damageDetected":true,"severity":"severe","confidence":0.9,"reason":"frustration"}'],
    });

    await manager.spawn(api, 'session-Z', 'test message');

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(waitForRun).toHaveBeenCalledWith({ runId: 'r1', timeoutMs: 30000 });
    expect(getSessionMessages).toHaveBeenCalled();
    expect(sessionTracker.trackFriction).toHaveBeenCalledWith(
      'session-Z',
      40,
      'observer_empathy_severe',
      '',
      { source: 'user_empathy' }
    );
  });

  it('waitForRun(status=error) does NOT call deleteSession - treated as pending', async () => {
    run.mockResolvedValue({ runId: 'r1' });
    waitForRun.mockResolvedValue({ status: 'error', error: 'some error' });
    getSessionMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: '{"damageDetected":false}' }],
      assistantTexts: ['{"damageDetected":false}'],
    });

    await manager.spawn(api, 'session-E', 'test message');

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(waitForRun).toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(sessionTracker.trackFriction).not.toHaveBeenCalled();
    // Entry stays in activeRuns to block concurrent spawn
    expect((manager as any).activeRuns.has('session-E')).toBe(true);
    expect((manager as any).sessionLocks.has('session-E')).toBe(false);
  });

  it('waitForRun(status=timeout) does NOT call deleteSession - cleanup deferred', async () => {
    run.mockResolvedValue({ runId: 'r1' });
    waitForRun.mockResolvedValue({ status: 'timeout' });
    getSessionMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: '{"damageDetected":true,"severity":"severe"}' }],
      assistantTexts: ['{"damageDetected":true,"severity":"severe"}'],
    });

    await manager.spawn(api, 'session-T', 'test message');

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(waitForRun).toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(sessionTracker.trackFriction).not.toHaveBeenCalled();
    // Entry stays in activeRuns to block concurrent spawn; sessionLock is released
    expect((manager as any).activeRuns.has('session-T')).toBe(true);
    expect((manager as any).sessionLocks.has('session-T')).toBe(false);
  });

  it('timed-out entry expires after TTL and allows new spawn', async () => {
    run.mockResolvedValue({ runId: 'r1' });
    waitForRun.mockResolvedValue({ status: 'timeout' });

    await manager.spawn(api, 'session-Expire', 'test message');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect((manager as any).activeRuns.has('session-Expire')).toBe(true);
    expect(manager.shouldTrigger(api, 'session-Expire')).toBe(false);

    // Simulate TTL expiry: set observedAt to 6 minutes ago
    const metadata = (manager as any).activeRuns.get('session-Expire');
    metadata.observedAt = Date.now() - 6 * 60 * 1000;

    // After TTL expiry, shouldTrigger should allow new observer
    expect(manager.shouldTrigger(api, 'session-Expire')).toBe(true);
  });

  it('reap does not markCompleted when getSessionMessages fails', async () => {
    run.mockResolvedValue({ runId: 'r1' });
    waitForRun.mockResolvedValue({ status: 'ok' });
    getSessionMessages.mockRejectedValue(new Error('session not ready'));

    const sessionKey = await manager.spawn(api, 'session-Err', 'test message');
    await new Promise(resolve => setTimeout(resolve, 50));

    // When getSessionMessages fails, finalized=false → do NOT delete session.
    // Session is preserved so subagent_ended fallback or TTL expiry can recover.
    expect(deleteSession).not.toHaveBeenCalled();
    expect((manager as any).completedSessions.has(sessionKey)).toBe(false);
    // activeRuns entry is preserved so fallback can retry
    expect((manager as any).activeRuns.has('session-Err')).toBe(true);
  });

  it('marks completed when message reading succeeds even if deleteSession fails', async () => {
    run.mockResolvedValue({ runId: 'r1' });
    waitForRun.mockResolvedValue({ status: 'ok' });
    getSessionMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: '{"damageDetected":true,"severity":"moderate"}' }],
      assistantTexts: ['{"damageDetected":true,"severity":"moderate"}'],
    });
    deleteSession.mockRejectedValue(new Error('cleanup failed'));

    const sessionKey = await manager.spawn(api, 'session-DelFail', 'test message');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(deleteSession).toHaveBeenCalled();
    // finalized=true (message reading succeeded) marks completed regardless of deleteSession outcome
    expect((manager as any).completedSessions.has(sessionKey)).toBe(true);
  });

  it('applies friction on valid observer JSON payload and calls deleteSession', async () => {
    getSessionMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: '{"damageDetected":true,"severity":"severe","confidence":0.9,"reason":"frustration"}' }],
      assistantTexts: ['{"damageDetected":true,"severity":"severe","confidence":0.9,"reason":"frustration"}'],
    });

    const sessionKey = 'agent:main:subagent:empathy-obs-test123-1774856418172';
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

    await manager.reap(api, 'agent:main:subagent:empathy-obs-test456-1234567890', '/workspace/principles');

    expect(sessionTracker.trackFriction).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith({ sessionKey: 'agent:main:subagent:empathy-obs-test456-1234567890' });
  });

  it('does not write user_empathy when damageDetected is false', async () => {
    getSessionMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: '{"damageDetected":false,"severity":"mild","confidence":0.9}' }],
      assistantTexts: ['{"damageDetected":false}'],
    });

    await manager.reap(api, 'agent:main:subagent:empathy-obs-test789-1234567890', '/workspace/principles');

    expect(sessionTracker.trackFriction).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalled();
  });

  it('fallback reap does not double-write for same session', async () => {
    getSessionMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: '{"damageDetected":true,"severity":"mild","confidence":0.9}' }],
      assistantTexts: ['{"damageDetected":true,"severity":"mild","confidence":0.9}'],
    });
    deleteSession.mockResolvedValue(undefined);

    const sessionKey = 'agent:main:subagent:empathy-obs-session-W-1234567890';

    await manager.reap(api, sessionKey, '/workspace/principles');
    expect((manager as any).completedSessions.has(sessionKey)).toBe(true);
    await manager.reap(api, sessionKey, '/workspace/principles');

    expect(sessionTracker.trackFriction).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  it('uses original parentSessionId for business attribution even when session key is sanitized', async () => {
    run.mockResolvedValue({ runId: 'r1' });
    waitForRun.mockResolvedValue({ status: 'ok' });
    getSessionMessages.mockResolvedValue({
      messages: [{ role: 'assistant', content: '{"damageDetected":true,"severity":"moderate","confidence":0.85,"reason":"user seems frustrated"}' }],
      assistantTexts: ['{"damageDetected":true,"severity":"moderate","confidence":0.85,"reason":"user seems frustrated"}'],
    });

    // Session ID with characters that get sanitized in session key
    const originalSessionId = 'session/with:invalid&chars';
    const result = await manager.spawn(api, originalSessionId, 'test message');

    await new Promise(resolve => setTimeout(resolve, 50));

    // trackFriction should be called with ORIGINAL sessionId, not sanitized version
    expect(sessionTracker.trackFriction).toHaveBeenCalledWith(
      originalSessionId,  // NOT 'session_with_invalid_chars'
      25,
      'observer_empathy_moderate',
      '',
      { source: 'user_empathy' }
    );
  });

  it('ok path sets observedAt even when reapBySession fails', async () => {
    run.mockResolvedValue({ runId: 'r1' });
    waitForRun.mockResolvedValue({ status: 'ok' });
    getSessionMessages.mockRejectedValue(new Error('session not ready'));

    await manager.spawn(api, 'session-ObservedAt', 'test message');

    // Poll until activeRuns entry has observedAt (up to 2s)
    await vi.waitFor(() => {
      const metadata = (manager as any).activeRuns.get('session-ObservedAt');
      expect(metadata).toBeDefined();
      expect(metadata.observedAt).toBeGreaterThan(0);
    }, { timeout: 2000, interval: 50 });
  });

  it('ok path reapBySession failure preserves activeRuns so fallback can recover', async () => {
    run.mockResolvedValue({ runId: 'r1' });
    waitForRun.mockResolvedValue({ status: 'ok' });
    getSessionMessages.mockRejectedValue(new Error('session not ready'));

    const sessionKey = await manager.spawn(api, 'session-Fallback', 'test message');

    // Poll until activeRuns entry is preserved with observedAt set (up to 2s)
    await vi.waitFor(() => {
      expect((manager as any).activeRuns.has('session-Fallback')).toBe(true);
      const metadata = (manager as any).activeRuns.get('session-Fallback');
      expect(metadata?.observedAt).toBeGreaterThan(0);
    }, { timeout: 2000, interval: 50 });

    // sessionLock may remain until TTL cleanup (cleanupState is inside reapBySession which threw)
    // This is an accepted trade-off: lock is cleared by isActive() TTL after 5 minutes
    // isCompleted should be false (finalized=false)
    expect((manager as any).completedSessions.has(sessionKey)).toBe(false);
  });

  it('extracts parent session ID correctly from new key format', () => {
    const sessionKey = 'agent:main:subagent:empathy-obs-session_X-1234567890';
    const parentId = manager.extractParentSessionId(sessionKey);
    expect(parentId).toBe('session_X');
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

  describe('buildEmpathyObserverSessionKey', () => {
    it('sanitizes parent session ID', () => {
      const key = manager.buildEmpathyObserverSessionKey('session/with:invalid&chars');
      expect(key).toMatch(/^agent:main:subagent:empathy-obs-session_with_invalid_chars-\d+$/);
    });

    it('truncates long session IDs', () => {
      const longSessionId = 'a'.repeat(100);
      const key = manager.buildEmpathyObserverSessionKey(longSessionId);
      expect(key.length).toBeLessThan(120);
    });
  });
});
