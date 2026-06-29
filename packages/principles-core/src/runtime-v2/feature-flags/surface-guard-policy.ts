/**
 * Surface Guard Policy — pure logic migrated from openclaw-plugin.
 *
 * No I/O, no fs, no network. Operates on PLUGIN_SURFACE_REGISTRY (same
 * directory) and in-memory module-level Set for once-only log state.
 *
 * The guardService<T> generic constraint was relaxed from
 * <T extends OpenClawPluginService> (a plugin type) to <T> because the
 * function body only passes the service through — it never accesses
 * OpenClawPluginService properties. Callers pass concrete service types,
 * so TypeScript infers T correctly without the constraint.
 */

import {
  PLUGIN_SURFACE_REGISTRY,
  validateSurfaceRegistry,
  getSurfacesByCategory,
} from './plugin-surface-registry.js';

export interface SurfaceGuardResult {
  passed: boolean;
  enabledCoreSurfaces: string[];
  disabledNonCoreSurfaces: string[];
  violations: string[];
  warnings: string[];
}

// Surface-level once-only log state (PRI-298).
// The first time a quiet/non-core surface guard actually fires in this
// process, the disabled reason is emitted once. Subsequent fires for the
// same surfaceId are still observable (the no-op handler preserves
// behaviour) but no longer flood the log. Fresh processes start with an
// empty set, so each plugin load gets one observable skip per surface.
//
// The Set is only updated when the log was actually emitted, so passing
// `undefined` for the logger on a quiet first fire does NOT consume the
// one-shot slot — a later registration that supplies a logger still gets
// the first-fire reason (PRI-298 / ERR-002).
const loggedSkipSurfaces = new Set<string>();

type LoggerLike = { info?: (msg: string) => void; debug?: (msg: string) => void };

/**
 * Emit the disabled-reason log line for `surfaceId` at most once per
 * process. Returns true if the log was emitted, false if it was suppressed
 * (already logged, or no logger available). Only marks the surface as
 * logged when the log was actually written, so a missing logger on first
 * call does not consume the one-shot slot.
 */
function logSkipOnce(
  surfaceId: string,
  logger: LoggerLike | undefined,
  message: string,
): boolean {
  if (loggedSkipSurfaces.has(surfaceId)) {
    return false;
  }
  if (!logger?.info) {
    return false;
  }
  loggedSkipSurfaces.add(surfaceId);
  logger.info(message);
  return true;
}

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
  logger: LoggerLike | undefined,
  handler: HookHandler<E, C, R>,
): HookHandler<E, C, R> {
  const check = isSurfaceEnabled(surfaceId);
  if (check.enabled) {
    return handler;
  }
  const reason = check.reason ?? 'surface not enabled';
  // Log on the first ACTUAL no-op invocation, not at construction time
  // (PRI-298). Construction-time logging would emit a `SKIP` line at
  // plugin startup for every registered quiet hook, regardless of
  // whether the hook ever fires — which is exactly the startup log
  // noise this change is meant to prevent. The one-shot is consumed only
  // when the log was actually written, so `undefined` logger on first
  // call does not eat the slot.
  return (_event: E, _ctx: C): R | Promise<R> => {
    logSkipOnce(surfaceId, logger, `[PD:surface-guard] SKIP ${surfaceId}: ${reason}`);
    return undefined as R;
  };
}

export function guardService<T>(
  surfaceId: string,
  service: T,
  logger?: LoggerLike,
): T | null {
  const check = isSurfaceEnabled(surfaceId);
  if (check.enabled) {
    return service;
  }
  const reason = check.reason ?? 'surface not enabled';
  // guardService is called once per service during plugin registration,
  // so the once-only check fires on the registration call itself. The
  // shared helper makes the consumption rule identical to guardHook:
  // a missing logger on first call does not consume the one-shot.
  logSkipOnce(surfaceId, logger, `[PD:surface-guard] SKIP service ${surfaceId}: ${reason}`);
  return null;
}
