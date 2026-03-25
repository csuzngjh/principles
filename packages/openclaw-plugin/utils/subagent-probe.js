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
export function isSubagentRuntimeAvailable(subagent) {
    // DEBUG: Log detection details
    console.log(`[PD:SubagentProbe:DEBUG] isSubagentRuntimeAvailable called`);
    console.log(`[PD:SubagentProbe:DEBUG] - subagent exists: ${!!subagent}`);
    if (!subagent) {
        console.log(`[PD:SubagentProbe:DEBUG] - Result: FALSE (subagent is null/undefined)`);
        return false;
    }
    try {
        const runFn = subagent.run;
        console.log(`[PD:SubagentProbe:DEBUG] - run exists: ${!!runFn}`);
        console.log(`[PD:SubagentProbe:DEBUG] - run type: ${typeof runFn}`);
        if (typeof runFn !== 'function') {
            console.log(`[PD:SubagentProbe:DEBUG] - Result: FALSE (run is not a function)`);
            return false;
        }
        // In gateway mode, methods are AsyncFunction instances
        // In embedded mode, methods are regular Function instances that throw
        const constructorName = runFn.constructor?.name;
        console.log(`[PD:SubagentProbe:DEBUG] - run.constructor.name: ${constructorName}`);
        const isAvailable = constructorName === 'AsyncFunction';
        console.log(`[PD:SubagentProbe:DEBUG] - Result: ${isAvailable}`);
        return isAvailable;
    }
    catch (err) {
        // Any error means unavailable
        console.log(`[PD:SubagentProbe:DEBUG] - Result: FALSE (caught error: ${err})`);
        return false;
    }
}
