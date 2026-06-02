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

// Surface-level once-only log state (PRI-298).
// The first time a quiet/non-core surface guard fires in this process, the
// disabled reason is emitted once. Subsequent fires for the same surfaceId
// are still observable (the no-op handler preserves behaviour) but no longer
// flood the log on every hook call. Fresh processes start with an empty set,
// so each plugin load gets one observable skip per surface.
const loggedSkipSurfaces = new Set<string>();

/**
 * Reset the per-process surface-guard skip log bookkeeping. Intended for tests
 * that need to assert on the first-fire log without cross-test pollution.
 * Not part of the production API surface; do not call from runtime code.
 */
export function __resetSurfaceGuardSkipLogStateForTests(): void {
  loggedSkipSurfaces.clear();
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
  logger: { info?: (msg: string) => void; debug?: (msg: string) => void } | undefined,
  handler: HookHandler<E, C, R>,
): HookHandler<E, C, R> {
  const check = isSurfaceEnabled(surfaceId);
  if (check.enabled) {
    return handler;
  }
  const reason = check.reason ?? 'surface not enabled';
  // First-fire-per-surfaceId observability: emit the reason once so operators
  // can still see why the guard fired; subsequent fires stay silent to avoid
  // log noise on every hook call (PRI-298 / ERR-002).
  if (!loggedSkipSurfaces.has(surfaceId)) {
    loggedSkipSurfaces.add(surfaceId);
    logger?.info?.(`[PD:surface-guard] SKIP ${surfaceId}: ${reason}`);
  }
  return (_event: E, _ctx: C): R | Promise<R> => {
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
  // First-fire-per-surfaceId observability (PRI-298). guardService is called
  // once per service during plugin registration, so the once-only check is
  // defensive — it keeps the behaviour consistent with guardHook.
  if (!loggedSkipSurfaces.has(surfaceId)) {
    loggedSkipSurfaces.add(surfaceId);
    logger?.info?.(`[PD:surface-guard] SKIP service ${surfaceId}: ${reason}`);
  }
  return null;
}

export { PLUGIN_SURFACE_REGISTRY, validateSurfaceRegistry, getSurfacesByCategory };
export type { PluginSurfaceEntry, MvpCategory };
