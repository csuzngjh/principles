import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  PLUGIN_SURFACE_REGISTRY,
  validateSurfaceRegistry,
  findUnclassifiedSurfaces,
  getSurfacesByCategory,
  getSurfacesByKind,
  type PluginSurfaceEntry,
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

function extractHookRegistrations(source: string): string[] {
  const hooks: string[] = [];
  const hookPattern = /api\.on\s*\(\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = hookPattern.exec(source)) !== null) {
    hooks.push(match[1]);
  }
  return hooks;
}

function extractServiceRegistrations(source: string): string[] {
  const services: string[] = [];
  const servicePattern = /api\.registerService\s*\(\s*(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = servicePattern.exec(source)) !== null) {
    services.push(match[1]);
  }
  return services;
}

const SERVICE_NAME_MAP: Record<string, string> = {
  EvolutionWorkerService: 'service:evolution-worker',
  TrajectoryService: 'service:trajectory',
  PDTaskService: 'service:pd-task',
  CentralSyncService: 'service:central-sync',
};

const HOOK_LABEL_MAP: Record<string, string[]> = {
  before_prompt_build: ['hook:before_prompt_build'],
  before_tool_call: ['hook:before_tool_call'],
  after_tool_call: ['hook:after_tool_call', 'hook:after_tool_call.trajectory'],
  llm_output: ['hook:llm_output', 'hook:llm_output.trajectory'],
  subagent_spawning: ['hook:subagent_spawning'],
  subagent_ended: ['hook:subagent_ended'],
  before_reset: ['hook:before_reset'],
  before_compaction: ['hook:before_compaction'],
  after_compaction: ['hook:after_compaction'],
};

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

  describe('hook registration coverage', () => {
    it('every api.on() hook event in index.ts is classified in the registry', () => {
      const source = read('packages/openclaw-plugin/src/index.ts');
      const hookEvents = extractHookRegistrations(source);
      const uniqueHookEvents = [...new Set(hookEvents)];

      const registeredHookIds = new Set(
        PLUGIN_SURFACE_REGISTRY.filter(s => s.kind === 'hook').map(s => s.id),
      );

      const unclassified: string[] = [];
      for (const event of uniqueHookEvents) {
        const expectedIds = HOOK_LABEL_MAP[event];
        if (!expectedIds) {
          unclassified.push(event);
          continue;
        }
        for (const expectedId of expectedIds) {
          if (!registeredHookIds.has(expectedId)) {
            unclassified.push(expectedId);
          }
        }
      }

      expect(unclassified).toEqual([]);
    });

    it('every api.registerService() in index.ts is classified in the registry', () => {
      const source = read('packages/openclaw-plugin/src/index.ts');
      const serviceNames = extractServiceRegistrations(source);

      const registeredServiceIds = new Set(
        PLUGIN_SURFACE_REGISTRY.filter(s => s.kind === 'service').map(s => s.id),
      );

      const unclassified: string[] = [];
      for (const name of serviceNames) {
        const expectedId = SERVICE_NAME_MAP[name];
        if (!expectedId) {
          unclassified.push(name);
          continue;
        }
        if (!registeredServiceIds.has(expectedId)) {
          unclassified.push(expectedId);
        }
      }

      expect(unclassified).toEqual([]);
    });

    it('findUnclassifiedSurfaces detects new unregistered surfaces', () => {
      const registeredIds = PLUGIN_SURFACE_REGISTRY.map(s => s.id);
      const actualIds = ['hook:before_prompt_build', 'hook:new_unregistered_hook'];
      const unclassified = findUnclassifiedSurfaces(registeredIds, actualIds);
      expect(unclassified).toEqual(['hook:new_unregistered_hook']);
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
  });
});
