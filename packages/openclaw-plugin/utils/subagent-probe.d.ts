/**
 * Subagent Runtime Availability Probe
 *
 * OpenClaw has two runtime modes:
 * - Gateway mode: api.runtime.subagent methods are real async functions
 * - Embedded mode: api.runtime.subagent is a Proxy that throws synchronously
 *
 * This utility provides a reliable way to detect which mode we're in.
 */
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
export declare function isSubagentRuntimeAvailable(subagent: {
    run?: unknown;
} | undefined): boolean;
