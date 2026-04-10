/**
 * Subagent Runtime Availability Probe
 *
 * OpenClaw has two runtime modes:
 * - Gateway mode: api.runtime.subagent methods are real async functions
 * - Embedded mode: api.runtime.subagent is a Proxy that throws synchronously
 *
 * This utility provides a reliable way to detect which mode we're in.
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
 * Check if the subagent runtime is actually functional.
 *
 * In gateway mode, subagent.run is an AsyncFunction (constructor.name === 'AsyncFunction').
 * In embedded mode, subagent.run is a regular Function that throws synchronously.
 *
 * We use constructor check first because it's fast and has no side effects.
 *
 * @param subagent - The subagent runtime object from api.runtime.subagent
 * @returns true if the runtime is functional (gateway mode), false otherwise
 */
export function isSubagentRuntimeAvailable(
  subagent: { run?: unknown } | undefined
): boolean {
  if (!subagent) return false;

  try {
    const runFn = subagent.run;
    if (typeof runFn !== 'function') return false;

    // Check 1: In gateway mode, methods are AsyncFunction instances
    const isAsync = runFn.constructor?.name === 'AsyncFunction';
    if (isAsync) return true;

    // Check 2: OpenClaw may provide subagent.run as a regular Function that
    // internally resolves to gateway context at call time. The function exists,
    // so we should trust it and let it fail at runtime if truly unavailable.
    // This is the case with the late-binding Proxy from OpenClaw's plugin runtime.
    // eslint-disable-next-line no-console -- debug logging for critical path
    console.warn('[PD:SubagentProbe] subagent.run exists but constructor is not AsyncFunction — assuming it is callable via late-binding proxy');
    return true;
  } catch {
    return false;
  }
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
