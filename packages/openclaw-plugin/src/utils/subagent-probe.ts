/**
 * Subagent Runtime Availability Probe
 *
 * This utility intentionally avoids inferring runtime availability from
 * JavaScript implementation details like constructor names. The only contract
 * we trust here is whether a callable `run` entrypoint exists.
 */

import type { OpenClawPluginApi } from '../openclaw-sdk.js';

type SubagentRuntime = NonNullable<OpenClawPluginApi['runtime']>['subagent'];

/**
 * Try to access the global gateway subagent runtime.
 * This is a fallback for cases where the plugin was loaded with
 * allowGatewaySubagentBinding but the late-binding proxy isn't working.
 */
function getGlobalGatewaySubagent(): SubagentRuntime | null {
  try {
    // Access the global symbol that OpenClaw uses for gateway subagent
    const symbol = Symbol.for('openclaw.plugin.gatewaySubagentRuntime');
    const globalState = (globalThis as Record<string, unknown>)[symbol as unknown as string] as { subagent?: SubagentRuntime } | null;
    return globalState?.subagent ?? null;
  } catch {
    return null;
  }
}

/**
 * Return a small, explicit availability assessment for the subagent runtime.
 * This is a shape check only. Actual invocation failures are classified by the
 * caller as runtime-unavailable vs downstream task failures.
 *
 * @param subagent - The subagent runtime object from api.runtime.subagent
 * @returns availability status and reason
 */
export function getSubagentRuntimeAvailability(
  subagent: { run?: unknown } | undefined
): { available: boolean; reason: 'missing_runtime' | 'missing_run' | 'callable' } {
  if (!subagent) return { available: false, reason: 'missing_runtime' };

  try {
    const runFn = subagent.run;
    if (typeof runFn !== 'function') {
      return { available: false, reason: 'missing_run' };
    }
    return { available: true, reason: 'callable' };
  } catch {
    return { available: false, reason: 'missing_run' };
  }
}

export function isSubagentRuntimeAvailable(
  subagent: { run?: unknown } | undefined
): boolean {
  return getSubagentRuntimeAvailability(subagent).available;
}

/**
 * Get the actual subagent runtime, preferring the global gateway subagent
 * if the passed one is not available.
 * 
 * This is useful for cases where the plugin was loaded with allowGatewaySubagentBinding
 * but the late-binding proxy isn't resolving correctly.
 */
export function getAvailableSubagentRuntime(
  subagent: SubagentRuntime | undefined
): SubagentRuntime | undefined {
  // First check if the passed subagent is available
  if (isSubagentRuntimeAvailable(subagent)) {
    return subagent;
  }

  // Fallback to global gateway subagent
  const globalGateway = getGlobalGatewaySubagent();
  if (globalGateway && isSubagentRuntimeAvailable(globalGateway)) {
    return globalGateway;
  }

  return undefined;
}
