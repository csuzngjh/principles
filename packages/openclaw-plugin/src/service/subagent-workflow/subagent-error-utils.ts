/**
 * Shared utility for detecting expected subagent unavailability errors.
 * These occur during cron jobs, boot sessions, or isolated sessions
 * where the gateway request context is not available.
 *
 * Callers should suppress warnings for these errors — they are not real failures.
 */
export function isExpectedSubagentError(err: unknown): boolean {
    const msg = String(err);
    return (
        msg.includes('Plugin runtime subagent methods are only available during a gateway request') ||
        msg.includes('cannot start workflow for boot session') ||
        msg.includes('subagent runtime unavailable')
    );
}
