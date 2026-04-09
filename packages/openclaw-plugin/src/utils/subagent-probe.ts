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
    const globalState = (globalThis as Record<string, unknown>)[symbol as unknown as string];
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

    // In gateway mode, methods are AsyncFunction instances
    // In embedded mode, methods are regular Function instances that throw
    const isAsync = runFn.constructor?.name === 'AsyncFunction';
    
    if (isAsync) return true;

    // Fallback: Check if it's a Proxy that might late-bind to the gateway subagent
    // This handles the case where the plugin was loaded with allowGatewaySubagentBinding
    // but the proxy hasn't resolved yet
    const globalGateway = getGlobalGatewaySubagent();
    if (globalGateway && typeof globalGateway.run === 'function') {
      return globalGateway.run.constructor?.name === 'AsyncFunction';
    }

    return false;
  } catch {
    // Any error means unavailable
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
