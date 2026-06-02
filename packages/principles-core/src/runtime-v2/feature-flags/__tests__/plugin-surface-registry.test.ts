import { describe, expect, it } from 'vitest';
import {
  PLUGIN_SURFACE_REGISTRY,
  validateSurfaceRegistry,
  getEnabledSurfaces,
  getSurfacesByCategory,
  getSurfacesByKind,
  findUnclassifiedSurfaces,
  VALID_SURFACE_KINDS,
  VALID_MVP_CATEGORIES,
  type PluginSurfaceEntry,
} from '../plugin-surface-registry.js';

describe('plugin-surface-registry', () => {
  describe('validateSurfaceRegistry', () => {
    it('validates the default registry without errors', () => {
      const result = validateSurfaceRegistry(PLUGIN_SURFACE_REGISTRY);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects duplicate ids', () => {
      const registry: PluginSurfaceEntry[] = [
        { id: 'hook:test', kind: 'hook', category: 'core', enabledByDefault: true, since: '2026-01-01', description: 'test' },
        { id: 'hook:test', kind: 'hook', category: 'core', enabledByDefault: true, since: '2026-01-01', description: 'test2' },
      ];
      const result = validateSurfaceRegistry(registry);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("duplicate surface id: 'hook:test'");
    });

    it('rejects core surface with enabledByDefault=false', () => {
      const registry: PluginSurfaceEntry[] = [
        { id: 'hook:test', kind: 'hook', category: 'core', enabledByDefault: false, since: '2026-01-01', description: 'test' },
      ];
      const result = validateSurfaceRegistry(registry);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('core surface must be enabledByDefault=true'))).toBe(true);
    });

    it('rejects non-core surface with enabledByDefault=true', () => {
      const registry: PluginSurfaceEntry[] = [
        { id: 'hook:test', kind: 'hook', category: 'quiet', enabledByDefault: true, since: '2026-01-01', description: 'test' },
      ];
      const result = validateSurfaceRegistry(registry);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('non-core surface') && e.includes('must not be enabledByDefault=true'))).toBe(true);
    });

    it('rejects invalid kind', () => {
      const registry = [
        { id: 'test', kind: 'invalid', category: 'core', enabledByDefault: true, since: '2026-01-01', description: 'test' },
      ] as unknown as PluginSurfaceEntry[];
      const result = validateSurfaceRegistry(registry);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("invalid kind 'invalid'"))).toBe(true);
    });

    it('rejects invalid category', () => {
      const registry = [
        { id: 'test', kind: 'hook', category: 'invalid', enabledByDefault: true, since: '2026-01-01', description: 'test' },
      ] as unknown as PluginSurfaceEntry[];
      const result = validateSurfaceRegistry(registry);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("invalid category 'invalid'"))).toBe(true);
    });

    it('warns when quiet/gone/legacy_retire surface has no disabledReason', () => {
      const registry: PluginSurfaceEntry[] = [
        { id: 'hook:test', kind: 'hook', category: 'quiet', enabledByDefault: false, since: '2026-01-01', description: 'test' },
      ];
      const result = validateSurfaceRegistry(registry);
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('no disabledReason'))).toBe(true);
    });
  });

  describe('getEnabledSurfaces', () => {
    it('returns only core surfaces by default', () => {
      const enabled = getEnabledSurfaces(PLUGIN_SURFACE_REGISTRY);
      for (const surface of enabled) {
        expect(surface.category).toBe('core');
        expect(surface.enabledByDefault).toBe(true);
      }
    });

    it('allows quiet surface override', () => {
      const enabled = getEnabledSurfaces(PLUGIN_SURFACE_REGISTRY, {
        'hook:after_tool_call.trajectory': true,
      });
      const trajectoryHook = enabled.find(s => s.id === 'hook:after_tool_call.trajectory');
      expect(trajectoryHook).toBeDefined();
    });

    it('ignores gone surface override', () => {
      const goneEntry: PluginSurfaceEntry = {
        id: 'hook:gone_test', kind: 'hook', category: 'gone', enabledByDefault: false,
        since: '2026-01-01', description: 'test gone', disabledReason: 'test',
      };
      const enabled = getEnabledSurfaces([...PLUGIN_SURFACE_REGISTRY, goneEntry], {
        'hook:gone_test': true,
      });
      const gone = enabled.find(s => s.id === 'hook:gone_test');
      expect(gone).toBeUndefined();
    });

    it('ignores core surface disable override', () => {
      const enabled = getEnabledSurfaces(PLUGIN_SURFACE_REGISTRY, {
        'hook:before_prompt_build': false,
      });
      const promptHook = enabled.find(s => s.id === 'hook:before_prompt_build');
      expect(promptHook).toBeDefined();
    });
  });

  describe('getSurfacesByCategory', () => {
    it('returns only core surfaces', () => {
      const core = getSurfacesByCategory(PLUGIN_SURFACE_REGISTRY, 'core');
      expect(core.length).toBeGreaterThan(0);
      for (const s of core) {
        expect(s.category).toBe('core');
      }
    });

    it('returns only quiet surfaces', () => {
      const quiet = getSurfacesByCategory(PLUGIN_SURFACE_REGISTRY, 'quiet');
      expect(quiet.length).toBeGreaterThan(0);
      for (const s of quiet) {
        expect(s.category).toBe('quiet');
      }
    });
  });

  describe('getSurfacesByKind', () => {
    it('returns only hook surfaces', () => {
      const hooks = getSurfacesByKind(PLUGIN_SURFACE_REGISTRY, 'hook');
      expect(hooks.length).toBeGreaterThan(0);
      for (const s of hooks) {
        expect(s.kind).toBe('hook');
      }
    });
  });

  describe('findUnclassifiedSurfaces', () => {
    it('returns empty when all actual surfaces are registered', () => {
      const registryIds = PLUGIN_SURFACE_REGISTRY.map(s => s.id);
      const result = findUnclassifiedSurfaces(registryIds, registryIds);
      expect(result).toEqual([]);
    });

    it('returns unregistered surface ids', () => {
      const registryIds = PLUGIN_SURFACE_REGISTRY.map(s => s.id);
      const actualIds = [...registryIds, 'hook:brand_new_hook'];
      const result = findUnclassifiedSurfaces(registryIds, actualIds);
      expect(result).toEqual(['hook:brand_new_hook']);
    });
  });

  describe('constant integrity', () => {
    it('VALID_SURFACE_KINDS contains expected kinds', () => {
      expect(VALID_SURFACE_KINDS).toEqual(['hook', 'service', 'startup']);
    });

    it('VALID_MVP_CATEGORIES contains expected categories', () => {
      expect(VALID_MVP_CATEGORIES).toEqual(['core', 'quiet', 'gone', 'legacy_retire']);
    });
  });
});
