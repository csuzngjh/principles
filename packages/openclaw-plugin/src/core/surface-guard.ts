import {
  PLUGIN_SURFACE_REGISTRY,
  validateSurfaceRegistry,
  getSurfacesByCategory,
  type PluginSurfaceEntry,
  type MvpCategory,
} from '@principles/core/runtime-v2';
import type { OpenClawPluginService } from '../openclaw-sdk.js';

export interface SurfaceGuardResult {
  passed: boolean;
  enabledCoreSurfaces: string[];
  disabledNonCoreSurfaces: string[];
  violations: string[];
  warnings: string[];
}

export function checkSurfaceGuard(): SurfaceGuardResult {
  const validation = validateSurfaceRegistry(PLUGIN_SURFACE_REGISTRY);
  const violations: string[] = [];
  const warnings: string[] = [...validation.warnings];

  const coreSurfaces = getSurfacesByCategory(PLUGIN_SURFACE_REGISTRY, 'core');
  const enabledCore = coreSurfaces.filter(s => s.enabledByDefault);
  const nonCoreEnabled = PLUGIN_SURFACE_REGISTRY.filter(
    s => s.category !== 'core' && s.enabledByDefault,
  );

  if (nonCoreEnabled.length > 0) {
    for (const surface of nonCoreEnabled) {
      violations.push(
        `non-core surface '${surface.id}' (${surface.category}) is enabledByDefault=true — must be false per ADR-0014`,
      );
    }
  }

  if (!validation.valid) {
    violations.push(...validation.errors);
  }

  return {
    passed: violations.length === 0,
    enabledCoreSurfaces: enabledCore.map(s => s.id),
    disabledNonCoreSurfaces: PLUGIN_SURFACE_REGISTRY
      .filter(s => s.category !== 'core' && !s.enabledByDefault)
      .map(s => s.id),
    violations,
    warnings,
  };
}

export function getSurfaceIdForHook(hookEvent: string, label?: string): string {
  if (label) {
    return `hook:${hookEvent}.${label}`;
  }
  return `hook:${hookEvent}`;
}

export function getSurfaceIdForService(serviceName: string): string {
  return `service:${serviceName}`;
}

export function isSurfaceEnabled(
  surfaceId: string,
  overrides: Record<string, boolean> = {},
): { enabled: boolean; reason?: string } {
  const entry = PLUGIN_SURFACE_REGISTRY.find(s => s.id === surfaceId);

  if (!entry) {
    return {
      enabled: false,
      reason: `surface '${surfaceId}' not found in registry — classify before enabling (PRI-289)`,
    };
  }

  if (Object.hasOwn(overrides, surfaceId)) {
    const override = overrides[surfaceId];
    if (typeof override !== 'boolean') {
      return { enabled: entry.enabledByDefault, reason: `override for '${surfaceId}' is not boolean, using default` };
    }
    if (entry.category === 'gone') {
      return { enabled: false, reason: `surface '${surfaceId}' is gone and cannot be re-enabled` };
    }
    if (entry.category === 'core' && !override) {
      return { enabled: true, reason: `surface '${surfaceId}' is core and cannot be disabled` };
    }
    return { enabled: override };
  }

  if (!entry.enabledByDefault && entry.disabledReason) {
    return { enabled: false, reason: entry.disabledReason };
  }

  return { enabled: entry.enabledByDefault };
}

export type HookHandler<E, C, R> = (event: E, ctx: C) => R | Promise<R>;

export function guardHook<E, C, R>(
  surfaceId: string,
  handler: HookHandler<E, C, R>,
  logger?: { info?: (msg: string) => void; debug?: (msg: string) => void },
): HookHandler<E, C, R> {
  const check = isSurfaceEnabled(surfaceId);
  if (check.enabled) {
    return handler;
  }
  const reason = check.reason ?? 'surface not enabled';
  return (_event: E, _ctx: C): R | Promise<R> => {
    logger?.debug?.(`[PD:surface-guard] SKIP ${surfaceId}: ${reason}`);
    return undefined as R;
  };
}

export function guardService<T extends OpenClawPluginService>(
  surfaceId: string,
  service: T,
  logger?: { info?: (msg: string) => void; debug?: (msg: string) => void },
): T | null {
  const check = isSurfaceEnabled(surfaceId);
  if (check.enabled) {
    return service;
  }
  const reason = check.reason ?? 'surface not enabled';
  logger?.info?.(`[PD:surface-guard] SKIP service ${surfaceId}: ${reason}`);
  return null;
}

export { PLUGIN_SURFACE_REGISTRY, validateSurfaceRegistry, getSurfacesByCategory };
export type { PluginSurfaceEntry, MvpCategory };
