import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkSurfaceGuard,
  isSurfaceEnabled,
  guardHook,
  guardService,
  getSurfaceIdForHook,
  getSurfaceIdForService,
  __resetSurfaceGuardSkipLogStateForTests,
} from '../surface-guard-policy.js';
import { PLUGIN_SURFACE_REGISTRY } from '../plugin-surface-registry.js';

describe('surface-guard', () => {
  beforeEach(() => {
    // Each test starts with a clean surface-guard skip log state so the
    // first-fire assertions are deterministic (PRI-298).
    __resetSurfaceGuardSkipLogStateForTests();
    vi.clearAllMocks();
  });
  describe('getSurfaceIdForHook', () => {
    it('generates correct surface id without label', () => {
      expect(getSurfaceIdForHook('before_tool_call')).toBe('hook:before_tool_call');
    });

    it('generates correct surface id with label', () => {
      expect(getSurfaceIdForHook('after_tool_call', 'trajectory')).toBe('hook:after_tool_call.trajectory');
    });
  });

  describe('getSurfaceIdForService', () => {
    it('generates correct surface id for service', () => {
      expect(getSurfaceIdForService('evolution-worker')).toBe('service:evolution-worker');
    });
  });

  describe('checkSurfaceGuard', () => {
    it('returns passed=true when registry is valid', () => {
      const result = checkSurfaceGuard();
      expect(result.passed).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('includes enabled core surfaces', () => {
      const result = checkSurfaceGuard();
      expect(result.enabledCoreSurfaces.length).toBeGreaterThan(0);
      for (const surfaceId of result.enabledCoreSurfaces) {
        const entry = PLUGIN_SURFACE_REGISTRY.find(s => s.id === surfaceId);
        expect(entry).toBeDefined();
        expect(entry?.category).toBe('core');
      }
    });

    it('includes disabled non-core surfaces', () => {
      const result = checkSurfaceGuard();
      expect(result.disabledNonCoreSurfaces.length).toBeGreaterThan(0);
      for (const surfaceId of result.disabledNonCoreSurfaces) {
        const entry = PLUGIN_SURFACE_REGISTRY.find(s => s.id === surfaceId);
        expect(entry).toBeDefined();
        expect(entry?.category).not.toBe('core');
        expect(entry?.enabledByDefault).toBe(false);
      }
    });

    it('returns violations when non-core surface is enabledByDefault', () => {
      const result = checkSurfaceGuard();
      const nonCoreEnabled = PLUGIN_SURFACE_REGISTRY.filter(
        s => s.category !== 'core' && s.enabledByDefault,
      );
      if (nonCoreEnabled.length > 0) {
        expect(result.violations.length).toBeGreaterThan(0);
      }
    });
  });

  describe('isSurfaceEnabled', () => {
    it('returns enabled=true for core surface without override', () => {
      const result = isSurfaceEnabled('hook:before_prompt_build');
      expect(result.enabled).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('returns enabled=false for quiet surface without override', () => {
      const result = isSurfaceEnabled('hook:after_tool_call.trajectory');
      expect(result.enabled).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('returns reason when surface not found', () => {
      const result = isSurfaceEnabled('hook:nonexistent_hook');
      expect(result.enabled).toBe(false);
      expect(result.reason).toContain('not found in registry');
    });

    it('allows override for quiet surface', () => {
      const result = isSurfaceEnabled('hook:before_reset', {
        'hook:before_reset': true,
      });
      expect(result.enabled).toBe(true);
    });

    it('ignores non-boolean override', () => {
      const result = isSurfaceEnabled('hook:before_prompt_build', {
        'hook:before_prompt_build': 'yes' as unknown as boolean,
      });
      expect(result.enabled).toBe(true);
    });

    it('cannot disable core surface', () => {
      const result = isSurfaceEnabled('hook:before_prompt_build', {
        'hook:before_prompt_build': false,
      });
      expect(result.enabled).toBe(true);
      expect(result.reason).toContain('core');
    });

    it('returns disabledReason for disabled surface', () => {
      const result = isSurfaceEnabled('service:evolution-worker');
      expect(result.enabled).toBe(false);
      expect(result.reason).toContain('evolution_worker');
    });
  });

  describe('guardHook', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns original handler for enabled surface', () => {
      const mockHandler = vi.fn().mockReturnValue('result');
      const guarded = guardHook('hook:before_prompt_build', undefined, mockHandler);
      const result = guarded({}, {});
      expect(mockHandler).toHaveBeenCalled();
      expect(result).toBe('result');
    });

    it('returns no-op for disabled surface without logger', () => {
      const mockHandler = vi.fn();
      const guarded = guardHook('hook:after_tool_call.trajectory', undefined, mockHandler);
      const result = guarded({}, {});
      expect(mockHandler).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('logs when surface is disabled with logger', () => {
      const mockLogger = { info: vi.fn(), debug: vi.fn() };
      const mockHandler = vi.fn();
      const guarded = guardHook('hook:after_tool_call.trajectory', mockLogger, mockHandler);
      guarded({}, {});
      expect(mockLogger.info).toHaveBeenCalled();
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('does not log at guardHook construction time (PRI-298 / chatgpt P2)', () => {
      const mockLogger = { info: vi.fn(), debug: vi.fn() };
      guardHook('hook:after_tool_call.trajectory', mockLogger, vi.fn());
      expect(mockLogger.info).not.toHaveBeenCalled();
    });

    it('logger undefined on first fire does not consume the one-shot slot (PRI-298 / coderabbit Major)', () => {
      const handler1 = guardHook('hook:after_tool_call.trajectory', undefined, vi.fn());
      handler1({}, {});

      const mockLogger = { info: vi.fn(), debug: vi.fn() };
      const handler2 = guardHook('hook:after_tool_call.trajectory', mockLogger, vi.fn());
      handler2({}, {});

      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('[PD:surface-guard] SKIP hook:after_tool_call.trajectory'),
      );

      const handler3 = guardHook('hook:after_tool_call.trajectory', mockLogger, vi.fn());
      handler3({}, {});
      expect(mockLogger.info).toHaveBeenCalledTimes(1);
    });

    it('does not log for enabled surface', () => {
      const mockLogger = { info: vi.fn(), debug: vi.fn() };
      const mockHandler = vi.fn();
      const guarded = guardHook('hook:before_prompt_build', mockLogger, mockHandler);
      guarded({}, {});
      expect(mockLogger.info).not.toHaveBeenCalled();
    });

    it('guards unknown surface with not-found reason', () => {
      const mockLogger = { info: vi.fn(), debug: vi.fn() };
      const guarded = guardHook('hook:unknown_hook', mockLogger, vi.fn());
      guarded({}, {});
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('not found in registry'),
      );
    });

    it('logs once on first fire and stays silent on subsequent fires (PRI-298 rate-limit)', () => {
      const mockLogger = { info: vi.fn(), debug: vi.fn() };
      const mockHandler = vi.fn();
      const guarded = guardHook('hook:after_tool_call.trajectory', mockLogger, mockHandler);

      guarded({}, {});
      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('[PD:surface-guard] SKIP hook:after_tool_call.trajectory'),
      );

      for (let i = 0; i < 5; i += 1) {
        guarded({}, {});
      }
      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('logs first fire per surfaceId independently (one log per quiet surface)', () => {
      const mockLogger = { info: vi.fn(), debug: vi.fn() };
      const handler1 = guardHook('hook:after_tool_call.trajectory', mockLogger, vi.fn());
      const handler2 = guardHook('hook:llm_output.trajectory', mockLogger, vi.fn());
      const handler3 = guardHook('hook:subagent_spawning', mockLogger, vi.fn());

      handler1({}, {});
      handler2({}, {});
      handler3({}, {});

      expect(mockLogger.info).toHaveBeenCalledTimes(3);
      const calls = mockLogger.info.mock.calls.map(c => String(c[0]));
      expect(calls.some(c => c.includes('hook:after_tool_call.trajectory'))).toBe(true);
      expect(calls.some(c => c.includes('hook:llm_output.trajectory'))).toBe(true);
      expect(calls.some(c => c.includes('hook:subagent_spawning'))).toBe(true);
    });
  });

  describe('guardService', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns original service for enabled surface', () => {
      const mockService = { id: 'test-service' };
      const result = guardService('hook:before_prompt_build', mockService);
      expect(result).toBe(mockService);
    });

    it('returns null for disabled surface without logger', () => {
      const mockService = { id: 'test-service' };
      const result = guardService('hook:after_tool_call.trajectory', mockService);
      expect(result).toBeNull();
    });

    it('logs when surface is disabled with logger', () => {
      const mockLogger = { info: vi.fn(), debug: vi.fn() };
      const mockService = { id: 'test-service' };
      const result = guardService('hook:after_tool_call.trajectory', mockService, mockLogger);
      expect(result).toBeNull();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('SKIP service'),
      );
    });

    it('returns null for unknown surface', () => {
      const mockService = { id: 'test-service' };
      const result = guardService('service:nonexistent', mockService);
      expect(result).toBeNull();
    });

    it('logs once per service surface on first registration (PRI-298 rate-limit)', () => {
      const mockLogger = { info: vi.fn(), debug: vi.fn() };
      const service = { id: 'test-service' };

      const first = guardService('service:evolution-worker', service, mockLogger);
      expect(first).toBeNull();
      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('SKIP service service:evolution-worker'),
      );

      guardService('service:evolution-worker', service, mockLogger);
      guardService('service:evolution-worker', service, mockLogger);
      expect(mockLogger.info).toHaveBeenCalledTimes(1);
    });
  });

  describe('PRI-298 disabledReason copy', () => {
    it('no quiet surface disabledReason references "Story A" or "Story A\'"', () => {
      const quietOrNonCore = PLUGIN_SURFACE_REGISTRY.filter(
        s => s.category === 'quiet' || s.category === 'gone' || s.category === 'legacy_retire',
      );
      expect(quietOrNonCore.length).toBeGreaterThan(0);
      for (const surface of quietOrNonCore) {
        expect(surface.disabledReason).toBeDefined();
        expect(surface.disabledReason).not.toMatch(/Story A/);
        expect(surface.disabledReason).not.toMatch(/MVP\s*验收/);
        expect(surface.disabledReason).not.toMatch(/测试任务/);
      }
    });

    it('subagent/shadow hooks removed from registry (PRI-448)', () => {
      const subagent = PLUGIN_SURFACE_REGISTRY.find(
        s => s.id === 'hook:subagent_spawning',
      );
      expect(subagent).toBeUndefined();
    });

    it('no quiet surface disabledReason promises a feature flag override (PRI-298 / chatgpt P2)', () => {
      const quiet = PLUGIN_SURFACE_REGISTRY.filter(s => s.category === 'quiet');
      expect(quiet.length).toBeGreaterThan(0);
      for (const surface of quiet) {
        const reason = (surface.disabledReason ?? '').toLowerCase();
        expect(reason).not.toContain('enable via feature flag');
        expect(reason).not.toMatch(/enable via .* override/);
      }
    });
  });
});
