import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  PLUGIN_SURFACE_REGISTRY,
  validateSurfaceRegistry,
  findUnclassifiedSurfaces,
  getSurfacesByCategory,
  getSurfacesByKind,
} from '@principles/core/runtime-v2';

function findRepoRoot(cwd: string): string {
  let dir = cwd;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return cwd;
}

const repoRoot = findRepoRoot(process.cwd());

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

interface ApiOnRegistration {
  event: string;
  surfaceId: string | null;
  rawLine: string;
  index: number;
}

function extractApiOnRegistrations(source: string): ApiOnRegistration[] {
  const registrations: ApiOnRegistration[] = [];
  const apiOnPattern = /api\.on\s*\(\s*['"]([^'"]+)['"]\s*,\s*/g;
  let match: RegExpExecArray | null;
  let regIndex = 0;
  while ((match = apiOnPattern.exec(source)) !== null) {
    const event = match[1];
    const afterMatch = source.slice(match.index + match[0].length);
    const guardHookMatch = afterMatch.match(/^guardHook\s*\(\s*['"]([^'"]+)['"]\s*,/);
    registrations.push({
      event,
      surfaceId: guardHookMatch ? guardHookMatch[1] : null,
      rawLine: match[0],
      index: regIndex++,
    });
  }
  return registrations;
}

interface ServiceRegistration {
  surfaceId: string;
  index: number;
}

function extractServiceRegistrations(source: string): ServiceRegistration[] {
  const registrations: ServiceRegistration[] = [];
  const servicePattern = /guardService\s*\(\s*['"]([^'"]+)['"]\s*,/g;
  let match: RegExpExecArray | null;
  let serviceIndex = 0;
  while ((match = servicePattern.exec(source)) !== null) {
    registrations.push({
      surfaceId: match[1],
      index: serviceIndex++,
    });
  }
  return registrations;
}

describe('MVP Surface Registry Guard (PRI-289)', () => {
  describe('registry self-validation', () => {
    it('PLUGIN_SURFACE_REGISTRY passes validateSurfaceRegistry', () => {
      const result = validateSurfaceRegistry(PLUGIN_SURFACE_REGISTRY);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('has no duplicate surface ids', () => {
      const ids = PLUGIN_SURFACE_REGISTRY.map(s => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('core surfaces are all enabledByDefault', () => {
      const coreSurfaces = getSurfacesByCategory(PLUGIN_SURFACE_REGISTRY, 'core');
      for (const surface of coreSurfaces) {
        expect(surface.enabledByDefault).toBe(true);
      }
    });

    it('non-core surfaces are not enabledByDefault', () => {
      const nonCore = PLUGIN_SURFACE_REGISTRY.filter(s => s.category !== 'core');
      for (const surface of nonCore) {
        expect(surface.enabledByDefault).toBe(false);
      }
    });

    it('quiet/gone/legacy_retire surfaces have disabledReason', () => {
      const disabled = PLUGIN_SURFACE_REGISTRY.filter(
        s => s.category === 'quiet' || s.category === 'gone' || s.category === 'legacy_retire',
      );
      for (const surface of disabled) {
        expect(surface.disabledReason).toBeDefined();
        expect(typeof surface.disabledReason).toBe('string');
        expect(surface.disabledReason!.length).toBeGreaterThan(0);
      }
    });

    it('no disabledReason references Story A / Story A\' / MVP 验收 / 测试任务 (PRI-298)', () => {
      const disabled = PLUGIN_SURFACE_REGISTRY.filter(
        s => s.category === 'quiet' || s.category === 'gone' || s.category === 'legacy_retire',
      );
      expect(disabled.length).toBeGreaterThan(0);
      for (const surface of disabled) {
        expect(surface.disabledReason).toBeDefined();
        expect(surface.disabledReason).not.toMatch(/Story A/);
        expect(surface.disabledReason).not.toMatch(/MVP\s*验收/);
        expect(surface.disabledReason).not.toMatch(/测试任务/);
      }
    });

    it('disabledReason copy is opt-in / feature-flag oriented for quiet surfaces (PRI-298)', () => {
      const quiet = PLUGIN_SURFACE_REGISTRY.filter(s => s.category === 'quiet');
      expect(quiet.length).toBeGreaterThan(0);
      for (const surface of quiet) {
        // Every quiet surface should anchor its reason in at least one
        // stable, long-lived framing so the log copy can live in the product
        // long after MVP. Acceptable framings:
        //   - opt-in / disabled language (new quiet entries),
        //   - feature-flag path (most existing entries),
        //   - ADR reference (entries gated by a specific ADR section).
        // What we still reject: ephemeral MVP-phase copy (covered by the
        // Story A / MVP 验收 test above).
        const reason = surface.disabledReason!.toLowerCase();
        const hasOptInOrDisabled = /opt-?in|disabled/.test(reason);
        const hasFeatureFlag = reason.includes('feature flag');
        const hasAdrReference = /adr-?\d+|adr\s+\d+/.test(reason);
        expect(
          hasOptInOrDisabled || hasFeatureFlag || hasAdrReference,
          `quiet surface ${surface.id} disabledReason must reference opt-in, feature flag, or an ADR: "${surface.disabledReason}"`,
        ).toBe(true);
      }
    });
  });

  describe('api.on() registration coverage — every hook must be guarded', () => {
    const source = read('packages/openclaw-plugin/src/index.ts');
    const registrations = extractApiOnRegistrations(source);

    it('has at least one api.on registration', () => {
      expect(registrations.length).toBeGreaterThan(0);
    });

    it('every api.on() handler is wrapped with guardHook()', () => {
      const unguarded = registrations.filter(r => r.surfaceId === null);
      if (unguarded.length > 0) {
        const details = unguarded.map(r => `api.on('${r.event}', ...) #${r.index} — NOT wrapped with guardHook`);
        throw new Error(
          `Found ${unguarded.length} unguarded api.on() registration(s):\n${details.join('\n')}\n` +
          `Every api.on() handler MUST be wrapped with guardHook('<surfaceId>', api.logger, ...) per PRI-289.`,
        );
      }
    });

    it('every guardHook surface id exists in PLUGIN_SURFACE_REGISTRY', () => {
      const guarded = registrations.filter(r => r.surfaceId !== null);
      const registeredIds = new Set(PLUGIN_SURFACE_REGISTRY.map(s => s.id));
      const unclassified: string[] = [];
      for (const reg of guarded) {
        if (!registeredIds.has(reg.surfaceId!)) {
          unclassified.push(reg.surfaceId!);
        }
      }
      expect(unclassified).toEqual([]);
    });

    it('each individual api.on registration is covered (no dedup by event name)', () => {
      const guarded = registrations.filter(r => r.surfaceId !== null);
      const registeredIds = new Set(PLUGIN_SURFACE_REGISTRY.map(s => s.id));
      for (const reg of guarded) {
        expect(registeredIds.has(reg.surfaceId!)).toBe(true);
      }
    });

    it('after_tool_call has one registration: core only', () => {
      const afterToolCallRegs = registrations.filter(r => r.event === 'after_tool_call');
      expect(afterToolCallRegs.length).toBe(1);
      expect(afterToolCallRegs[0].surfaceId).toBe('hook:after_tool_call');
    });

    it('llm_output has one registration: core only', () => {
      const llmOutputRegs = registrations.filter(r => r.event === 'llm_output');
      expect(llmOutputRegs.length).toBe(1);
      expect(llmOutputRegs[0].surfaceId).toBe('hook:llm_output');
    });

    it('total api.on registrations with guardHook match registry hook count', () => {
      const guarded = registrations.filter(r => r.surfaceId !== null);
      const registryHookCount = PLUGIN_SURFACE_REGISTRY.filter(s => s.kind === 'hook').length;
      expect(guarded.length).toBe(registryHookCount);
    });

    it('all guardHook calls pass api.logger as second argument', () => {
      const guardHookWithLogger = /guardHook\s*\(\s*['"][^'"]+['"]\s*,\s*api\.logger\s*,/g;
      const guardHookTotal = /guardHook\s*\(\s*['"][^'"]+['"]\s*,/g;
      const withLoggerCount = (source.match(guardHookWithLogger) ?? []).length;
      const totalCount = (source.match(guardHookTotal) ?? []).length;
      expect(withLoggerCount).toBe(totalCount);
    });
  });

  describe('service registration coverage — per-registration', () => {
    it('every guardService() call in index.ts has a classified surface id', () => {
      const source = read('packages/openclaw-plugin/src/index.ts');
      const registrations = extractServiceRegistrations(source);

      expect(registrations.length).toBeGreaterThan(0);

      const registeredIds = new Set(
        PLUGIN_SURFACE_REGISTRY.filter(s => s.kind === 'service').map(s => s.id),
      );

      const unclassified: string[] = [];
      for (const reg of registrations) {
        if (!registeredIds.has(reg.surfaceId)) {
          unclassified.push(reg.surfaceId);
        }
      }

      expect(unclassified).toEqual([]);
    });

    it('registered service IDs match expected MVP set', () => {
      // Quiet/disabled services (e.g. evolution-worker per PRI-294) exist in the
      // registry but are NOT registered via guardService in index.ts.
      const source = read('packages/openclaw-plugin/src/index.ts');
      const registrations = extractServiceRegistrations(source);

      const registeredIds = registrations.map(r => r.surfaceId).sort();
      const expectedIds = [
        'service:central-sync',
        'service:correction-observer',
        'service:internalization-auto-consumer',
        'service:pd-task',
        'service:trajectory',
      ].sort();

      expect(registeredIds).toEqual(expectedIds);
    });
  });

  describe('ADR-0014 compliance', () => {
    it('only MVP-Core surfaces are enabledByDefault', () => {
      const enabledByDefault = PLUGIN_SURFACE_REGISTRY.filter(s => s.enabledByDefault);
      for (const surface of enabledByDefault) {
        expect(surface.category).toBe('core');
      }
    });

    it('core hooks match ADR-0014 MVP-Core activation paths', () => {
      const coreHooks = getSurfacesByKind(PLUGIN_SURFACE_REGISTRY, 'hook')
        .filter(s => s.category === 'core')
        .map(s => s.id);

      expect(coreHooks).toContain('hook:before_prompt_build');
      expect(coreHooks).toContain('hook:before_tool_call');
      expect(coreHooks).toContain('hook:after_tool_call');
      expect(coreHooks).toContain('hook:llm_output');
    });

    it('evolution-worker service is MVP-Quiet (PRI-288/ADR-0014 alignment)', () => {
      const ew = PLUGIN_SURFACE_REGISTRY.find(s => s.id === 'service:evolution-worker');
      expect(ew).toBeDefined();
      expect(ew!.category).toBe('quiet');
      expect(ew!.enabledByDefault).toBe(false);
      expect(ew!.disabledReason).toContain('PRI-288');
    });

    it('evolution-worker startup is MVP-Quiet (PRI-288/ADR-0014 alignment)', () => {
      const ew = PLUGIN_SURFACE_REGISTRY.find(s => s.id === 'startup:evolution-worker');
      expect(ew).toBeDefined();
      expect(ew!.category).toBe('quiet');
      expect(ew!.enabledByDefault).toBe(false);
      expect(ew!.disabledReason).toContain('PRI-288');
    });

    it('trajectory hooks are MVP-Quiet (ADR-0014 §2.5)', () => {
      const trajectoryHooks = PLUGIN_SURFACE_REGISTRY.filter(
        s => s.kind === 'hook' && s.id.includes('trajectory'),
      );
      for (const hook of trajectoryHooks) {
        expect(hook.category).toBe('quiet');
        expect(hook.enabledByDefault).toBe(false);
      }
    });

    it('subagent/shadow hooks are MVP-Quiet (ADR-0014 §2.5)', () => {
      const shadowHooks = PLUGIN_SURFACE_REGISTRY.filter(
        s => s.kind === 'hook' && (s.id.includes('subagent') || s.id.includes('shadow')),
      );
      for (const hook of shadowHooks) {
        expect(hook.category).toBe('quiet');
        expect(hook.enabledByDefault).toBe(false);
      }
    });

    it('lifecycle hooks are MVP-Quiet (ADR-0014 §2.5)', () => {
      const lifecycleHooks = PLUGIN_SURFACE_REGISTRY.filter(
        s => s.kind === 'hook' && (s.id.includes('reset') || s.id.includes('compaction')),
      );
      for (const hook of lifecycleHooks) {
        expect(hook.category).toBe('quiet');
        expect(hook.enabledByDefault).toBe(false);
      }
    });

    it('central-sync service is MVP-Quiet (ADR-0014 §2.5: single workspace)', () => {
      const centralSync = PLUGIN_SURFACE_REGISTRY.find(s => s.id === 'service:central-sync');
      expect(centralSync).toBeDefined();
      expect(centralSync!.category).toBe('quiet');
      expect(centralSync!.enabledByDefault).toBe(false);
    });
  });

  describe('surface guard runtime', () => {
    let resetSurfaceGuardLogState: () => void;

    beforeEach(async () => {
      // Lazy import so the module state is freshly required per describe and
      // we can reset the PRI-298 rate-limit bookkeeping before every runtime
      // assertion that depends on the first-fire log firing.
      const mod = await import('../../src/core/surface-guard.js');
      resetSurfaceGuardLogState = mod.__resetSurfaceGuardSkipLogStateForTests;
      resetSurfaceGuardLogState();
    });

    it('checkSurfaceGuard passes with current registry', async () => {
      const { checkSurfaceGuard } = await import('../../src/core/surface-guard.js');
      const result = checkSurfaceGuard();
      expect(result.passed).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('isSurfaceEnabled returns false for unknown surface with reason', async () => {
      const { isSurfaceEnabled } = await import('../../src/core/surface-guard.js');
      const result = isSurfaceEnabled('hook:unknown_new_hook');
      expect(result.enabled).toBe(false);
      expect(result.reason).toContain('not found in registry');
    });

    it('isSurfaceEnabled returns true for core surfaces', async () => {
      const { isSurfaceEnabled } = await import('../../src/core/surface-guard.js');
      const result = isSurfaceEnabled('hook:before_prompt_build');
      expect(result.enabled).toBe(true);
    });

    it('isSurfaceEnabled returns false for unknown surfaces even with override', async () => {
      const { isSurfaceEnabled } = await import('../../src/core/surface-guard.js');
      const result = isSurfaceEnabled('hook:nonexistent_gone', { 'hook:nonexistent_gone': true });
      expect(result.enabled).toBe(false);
      expect(result.reason).toContain('not found in registry');
    });

    it('isSurfaceEnabled returns true for core surfaces even with false override', async () => {
      const { isSurfaceEnabled } = await import('../../src/core/surface-guard.js');
      const result = isSurfaceEnabled('hook:before_prompt_build', { 'hook:before_prompt_build': false });
      expect(result.enabled).toBe(true);
      expect(result.reason).toContain('core');
    });

    it('isSurfaceEnabled returns false for quiet surfaces by default', async () => {
      const { isSurfaceEnabled } = await import('../../src/core/surface-guard.js');
      const result = isSurfaceEnabled('hook:subagent_spawning');
      expect(result.enabled).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('isSurfaceEnabled allows quiet surfaces with explicit override', async () => {
      const { isSurfaceEnabled } = await import('../../src/core/surface-guard.js');
      const result = isSurfaceEnabled('hook:subagent_spawning', { 'hook:subagent_spawning': true });
      expect(result.enabled).toBe(true);
    });

    it('guardHook returns original handler for core surfaces', async () => {
      const { guardHook } = await import('../../src/core/surface-guard.js');
      const handler = () => 'result';
      const guarded = guardHook('hook:before_prompt_build', undefined, handler);
      expect(guarded).toBe(handler);
    });

    it('guardHook returns no-op handler for quiet surfaces', async () => {
      const { guardHook } = await import('../../src/core/surface-guard.js');
      const handler = () => 'result';
      const guarded = guardHook('hook:after_tool_call.trajectory', undefined, handler);
      expect(guarded).not.toBe(handler);
      expect(guarded({} as never, {} as never)).toBeUndefined();
    });

    it('guardHook returns no-op handler for unregistered surfaces', async () => {
      const { guardHook } = await import('../../src/core/surface-guard.js');
      const handler = () => 'result';
      const guarded = guardHook('hook:nonexistent_hook', undefined, handler);
      expect(guarded).not.toBe(handler);
    });

    it('guardHook logs disabled reason via logger for quiet surfaces', async () => {
      const { guardHook } = await import('../../src/core/surface-guard.js');
      const logs: string[] = [];
      const logger = { info: (msg: string) => { logs.push(msg); } };
      const handler = () => 'result';
      const guarded = guardHook('hook:after_tool_call.trajectory', logger, handler);
      guarded({} as never, {} as never);
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('[PD:surface-guard] SKIP');
      expect(logs[0]).toContain('hook:after_tool_call.trajectory');
    });

    it('guardHook does not log for enabled surfaces', async () => {
      const { guardHook } = await import('../../src/core/surface-guard.js');
      const logs: string[] = [];
      const logger = { info: (msg: string) => { logs.push(msg); } };
      const handler = () => 'result';
      const guarded = guardHook('hook:before_prompt_build', logger, handler);
      guarded({} as never, {} as never);
      expect(logs.length).toBe(0);
    });

    it('guardService returns null for evolution-worker (quiet, default off)', async () => {
      const { guardService } = await import('../../src/core/surface-guard.js');
      const service = { api: null, start: () => {} };
      const guarded = guardService('service:evolution-worker', service);
      expect(guarded).toBeNull();
    });

    it('guardService returns the service for core surfaces (trajectory is now core)', async () => {
      const { guardService } = await import('../../src/core/surface-guard.js');
      const service = { api: null, start: () => {} };
      const guarded = guardService('service:trajectory', service);
      expect(guarded).toBe(service);
    });

    it('guardService returns null for unregistered surfaces', async () => {
      const { guardService } = await import('../../src/core/surface-guard.js');
      const service = { api: null, start: () => {} };
      const guarded = guardService('service:nonexistent_service', service);
      expect(guarded).toBeNull();
    });

    it('PRI-298 rate-limit: quiet surface logs once, not per invocation', async () => {
      const { guardHook } = await import('../../src/core/surface-guard.js');
      const logs: string[] = [];
      const logger = { info: (msg: string) => { logs.push(msg); } };
      const handler = () => 'result';
      const guarded = guardHook('hook:after_tool_call.trajectory', logger, handler);

      // First invocation must surface the disabled reason.
      guarded({} as never, {} as never);
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('[PD:surface-guard] SKIP');
      expect(logs[0]).toContain('hook:after_tool_call.trajectory');

      // Subsequent invocations on the same surfaceId stay silent.
      for (let i = 0; i < 10; i += 1) {
        guarded({} as never, {} as never);
      }
      expect(logs.length).toBe(1);
    });

    it('PRI-298 rate-limit: resetSurfaceGuardSkipLogStateForTests re-arms first-fire', async () => {
      const { guardHook } = await import('../../src/core/surface-guard.js');
      const logs: string[] = [];
      const logger = { info: (msg: string) => { logs.push(msg); } };
      const handler = () => 'result';
      const guarded = guardHook('hook:after_tool_call.trajectory', logger, handler);

      guarded({} as never, {} as never);
      expect(logs.length).toBe(1);

      // Additional fires on the same surface: still 1 log.
      guarded({} as never, {} as never);
      expect(logs.length).toBe(1);

      // Reset the per-process bookkeeping (simulating a fresh process / test
      // isolation). The next fire on a freshly-constructed guarded handler
      // should log again.
      resetSurfaceGuardLogState();
      const guarded2 = guardHook('hook:after_tool_call.trajectory', logger, handler);
      guarded2({} as never, {} as never);
      expect(logs.length).toBe(2);
    });

    it('PRI-298 / chatgpt P2: guardHook does NOT log at construction time', async () => {
      const { guardHook } = await import('../../src/core/surface-guard.js');
      const logs: string[] = [];
      const logger = { info: (msg: string) => { logs.push(msg); } };
      // The act of constructing the guard must not emit a SKIP line. Plugin
      // startup that registers 7 quiet hooks would otherwise log 7 SKIP
      // lines before any real traffic.
      guardHook('hook:after_tool_call.trajectory', logger, () => 'result');
      expect(logs.length).toBe(0);

      // The first INVOCATION is when the log fires (and only once).
      const guarded = guardHook('hook:llm_output.trajectory', logger, () => 'result');
      guarded({} as never, {} as never);
      expect(logs.length).toBe(1);
    });

    it('PRI-298 / coderabbit Major: guardHook logger undefined on first fire does not consume the one-shot slot', async () => {
      const { guardHook } = await import('../../src/core/surface-guard.js');

      // First call: no logger. The no-op suppresses the handler, but the
      // once-only slot is preserved (a missing logger must not eat the
      // chance to surface the disabled reason later).
      const handler1 = guardHook('hook:after_tool_call.trajectory', undefined, () => 'result');
      handler1({} as never, {} as never);

      // Second call: real logger. This is now the first log emission for
      // this surfaceId.
      const logs: string[] = [];
      const logger = { info: (msg: string) => { logs.push(msg); } };
      const handler2 = guardHook('hook:after_tool_call.trajectory', logger, () => 'result');
      handler2({} as never, {} as never);
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('[PD:surface-guard] SKIP');

      // Third call: slot is now consumed; the third call is silent.
      const handler3 = guardHook('hook:after_tool_call.trajectory', logger, () => 'result');
      handler3({} as never, {} as never);
      expect(logs.length).toBe(1);
    });
  });
});
