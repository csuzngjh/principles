/**
 * Shared utility for detecting expected subagent unavailability errors.
 * These occur during cron jobs, boot sessions, daemon mode, or isolated sessions
 * where the gateway request context is not available.
 *
 * Callers should suppress warnings for these errors — they are not real failures.
 */
export function isExpectedSubagentError(err: unknown): boolean {
    const msg = String(err);
    return (
        msg.includes('Plugin runtime subagent methods are only available during a gateway request') ||
        msg.includes('cannot start workflow for boot session') ||
        msg.includes('subagent runtime unavailable') ||
        // #208/#209: Daemon mode — subagent process not connected
        msg.includes('subagent is not available') ||
        // NocturnalWorkflowManager explicit throw when subagent unavailable
        (msg.includes('NocturnalWorkflowManager') && msg.includes('subagent runtime unavailable')) ||
        // Gateway not running (daemon/cron context)
        msg.includes('gateway is not running') ||
        // Process isolation in cron jobs
        msg.includes('process isolation') ||
        // Connection dropped in daemon mode
        (msg.toLowerCase().includes('connection') && (msg.includes('refused') || msg.includes('reset') || msg.includes('econnrefused')))
    );
}
