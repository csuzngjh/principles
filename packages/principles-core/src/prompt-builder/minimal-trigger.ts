/**
 * Minimal trigger detection — determines if prompt should skip heavy context injection.
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 1
 */

export function isMinimalTrigger(trigger: string | undefined, sessionId?: string): boolean {
  return (
    trigger === 'heartbeat' ||
    trigger === 'cron' ||
    sessionId?.includes(':subagent:') === true
  );
}