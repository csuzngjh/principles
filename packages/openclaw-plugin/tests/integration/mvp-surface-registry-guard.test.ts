import { describe, expect, it } from 'vitest';
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

interface HookRegistration {
  event: string;
  surfaceId: string;
  index: number;
}

function extractHookRegistrations(source: string): HookRegistration[] {
  const registrations: HookRegistration[] = [];
  const hookPattern = /guardHook\s*\(\s*['"]([^'"]+)['"]\s*,/g;
  let match: RegExpExecArray | null;
  let hookIndex = 0;
  while ((match = hookPattern.exec(source)) !== null) {
    registrations.push({
      surfaceId: match[1],
      event: match[1].replace(/^hook:/, '').replace(/\..+$/, ''),
      index: hookIndex++,
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
  });

  describe('hook registration coverage — per-registration, not deduplicated', () => {
    it('every guardHook() call in index.ts has a classified surface id', () => {
      const source = read('packages/openclaw-plugin/src/index.ts');
      const registrations = extractHookRegistrations(source);

      expect(registrations.length).toBeGreaterThan(0);

      const registeredIds = new Set(
        PLUGIN_SURFACE_REGISTRY.filter(s => s.kind === 'hook').map(s => s.id),
      );

      const unclassified: string[] = [];
      for (const reg of registrations) {
        if (!registeredIds.has(reg.surfaceId)) {
          unclassified.push(reg.surfaceId);
        }
      }

      expect(unclassified).toEqual([]);
    });

    it('each individual hook registration is covered (no dedup by event name)', () => {
      const source = read('packages/openclaw-plugin/src/index.ts');
      const registrations = extractHookRegistrations(source);

      const registeredIds = new Set(
        PLUGIN_SURFACE_REGISTRY.filter(s => s.kind === 'hook').map(s => s.id),
      );

      for (const reg of registrations) {
        expect(registeredIds.has(reg.surfaceId)).toBe(true);
      }
    });

    it('after_tool_call has two registrations: core + trajectory', () => {
      const source = read('packages/openclaw-plugin/src/index.ts');
      const registrations = extractHookRegistrations(source);

      const afterToolCallRegs = registrations.filter(r => r.surfaceId.startsWith('hook:after_tool_call'));
      expect(afterToolCallRegs.length).toBe(2);
      expect(afterToolCallRegs[0].surfaceId).toBe('hook:after_tool_call');
      expect(afterToolCallRegs[1].surfaceId).toBe('hook:after_tool_call.trajectory');
    });

    it('llm_output has two registrations: core + trajectory', () => {
      const source = read('packages/openclaw-plugin/src/index.ts');
      const registrations = extractHookRegistrations(source);

      const llmOutputRegs = registrations.filter(r => r.surfaceId.startsWith('hook:llm_output'));
      expect(llmOutputRegs.length).toBe(2);
      expect(llmOutputRegs[0].surfaceId).toBe('hook:llm_output');
      expect(llmOutputRegs[1].surfaceId).toBe('hook:llm_output.trajectory');
    });

    it('total hook registrations match expected count', () => {
      const source = read('packages/openclaw-plugin/src/index.ts');
      const registrations = extractHookRegistrations(source);

      const registryHookCount = PLUGIN_SURFACE_REGISTRY.filter(s => s.kind === 'hook').length;
      expect(registrations.length).toBe(registryHookCount);
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

    it('total service registrations match expected count', () => {
      const source = read('packages/openclaw-plugin/src/index.ts');
      const registrations = extractServiceRegistrations(source);

      const registryServiceCount = PLUGIN_SURFACE_REGISTRY.filter(s => s.kind === 'service').length;
      expect(registrations.length).toBe(registryServiceCount);
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

    it('message_sanitize is MVP-Gone (ADR-0014 §2.5: COMPONENTS.md self-tagged)', () => {
      const sanitize = PLUGIN_SURFACE_REGISTRY.find(s => s.id === 'prompt_section:message_sanitize');
      expect(sanitize).toBeDefined();
      expect(sanitize!.category).toBe('gone');
      expect(sanitize!.enabledByDefault).toBe(false);
    });
  });

  describe('surface guard runtime', () => {
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

    it('isSurfaceEnabled returns false for gone surfaces even with override', async () => {
      const { isSurfaceEnabled } = await import('../../src/core/surface-guard.js');
      const result = isSurfaceEnabled('prompt_section:message_sanitize', { 'prompt_section:message_sanitize': true });
      expect(result.enabled).toBe(false);
      expect(result.reason).toContain('gone');
    });

    it('isSurfaceEnabled returns true for core surfaces even with false override', async () => {
      const { isSurfaceEnabled } = await import('../../src/core/surface-guard.js');
      const result = isSurfaceEnabled('hook:before_prompt_build', { 'hook:before_prompt_build': false });
      expect(result.enabled).toBe(true);
      expect(result.reason).toContain('core');
    });

    it('isSurfaceEnabled returns false for quiet surfaces by default', async () => {
      const { isSurfaceEnabled } = await import('../../src/core/surface-guard.js');
      const result = isSurfaceEnabled('hook:after_tool_call.trajectory');
      expect(result.enabled).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('isSurfaceEnabled allows quiet surfaces with explicit override', async () => {
      const { isSurfaceEnabled } = await import('../../src/core/surface-guard.js');
      const result = isSurfaceEnabled('hook:after_tool_call.trajectory', { 'hook:after_tool_call.trajectory': true });
      expect(result.enabled).toBe(true);
    });

    it('guardHook returns original handler for core surfaces', async () => {
      const { guardHook } = await import('../../src/core/surface-guard.js');
      const handler = () => 'result';
      const guarded = guardHook('hook:before_prompt_build', handler);
      expect(guarded).toBe(handler);
    });

    it('guardHook returns no-op handler for quiet surfaces', async () => {
      const { guardHook } = await import('../../src/core/surface-guard.js');
      const handler = () => 'result';
      const guarded = guardHook('hook:after_tool_call.trajectory', handler);
      expect(guarded).not.toBe(handler);
      expect(guarded({} as never, {} as never)).toBeUndefined();
    });

    it('guardHook returns no-op handler for gone surfaces', async () => {
      const { guardHook } = await import('../../src/core/surface-guard.js');
      const handler = () => 'result';
      const guarded = guardHook('prompt_section:message_sanitize', handler);
      expect(guarded).not.toBe(handler);
    });

    it('guardService returns null for evolution-worker (quiet, default off)', async () => {
      const { guardService } = await import('../../src/core/surface-guard.js');
      const service = { api: null, start: () => {} };
      const guarded = guardService('service:evolution-worker', service);
      expect(guarded).toBeNull();
    });

    it('guardService returns null for quiet surfaces', async () => {
      const { guardService } = await import('../../src/core/surface-guard.js');
      const service = { api: null, start: () => {} };
      const guarded = guardService('service:trajectory', service);
      expect(guarded).toBeNull();
    });

    it('guardService returns null for gone surfaces even with override', async () => {
      const { guardService } = await import('../../src/core/surface-guard.js');
      const service = { api: null, start: () => {} };
      const guarded = guardService('prompt_section:message_sanitize', service);
      expect(guarded).toBeNull();
    });
  });
});
