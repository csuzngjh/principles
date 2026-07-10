/**
 * Workflow Watchdog - Extracted from evolution-worker.ts (lines 79-223)
 *
 * Detects stale/orphaned workflows, invalid results, and cleanup failures.
 * Runs every heartbeat cycle, catching bugs like:
 *   #185 — orphaned active workflows
 *   #181 — structurally invalid results (all zeros)
 *   #180/#183 — expired workflows not swept
 *   #182 — unhandled rejections leaving workflows in limbo
 *
 * BUG-01: isExpectedSubagentError guard prevents marking daemon-mode stale
 *         workflows as terminal_error (line 122)
 * BUG-02: Gateway fallback cleans up child sessions via agentSession when
 *         subagentRuntime unavailable (lines 148-156)
 */

import type { WorkspaceContext } from '../core/workspace-context.js';
import type { OpenClawPluginApi, PluginLogger } from '../openclaw-sdk.js';
import type { WorkflowRow } from './subagent-workflow/types.js';
import { WorkflowStore } from './subagent-workflow/workflow-store.js';
import { isExpectedSubagentError } from './subagent-workflow/subagent-error-utils.js';
import { WORKFLOW_TTL_MS } from '../config/defaults/runtime.js';

export interface WatchdogResult {
  anomalies: number;
  details: string[];
  scanError?: string;
}

type AgentSessionApi = NonNullable<
  NonNullable<NonNullable<OpenClawPluginApi['runtime']>['agent']>['session']
>;

/**
 * Clean up a stale session entry via the row-scoped session API.
 *
 * Uses `patchSessionEntry` with `replaceEntry: true` and `update: () => null`
 * to delete the row. If the host does not expose the row-scoped helpers
 * (older OpenClaw builds), logs a warning and lets OpenClaw's session GC
 * sweep the stale entry instead of falling back to the deprecated
 * whole-store `loadSessionStore`/`saveSessionStore` helpers (which trigger
 * ClawHub `sdk-load-session-store` / `sdk-session-store-write` warnings).
 */
async function cleanupStaleSessionEntry(
  session: AgentSessionApi,
  sessionKey: string,
  logger?: PluginLogger,
  phase?: string,
): Promise<void> {
  const tag = phase ? ` (${phase})` : '';

  if (
    typeof session.patchSessionEntry !== 'function' ||
    typeof session.getSessionEntry !== 'function'
  ) {
    logger?.warn?.(
      `[PD:Watchdog] Cannot clean up session ${sessionKey}${tag}: host does not expose row-scoped session helpers. The stale entry will be swept by OpenClaw's session GC.`,
    );
    return;
  }

  const existing = session.getSessionEntry({ sessionKey });
  if (!existing) {
    logger?.debug?.(
      `[PD:Watchdog] Session ${sessionKey} already absent${tag}; nothing to clean.`,
    );
    return;
  }

  await session.patchSessionEntry({
    sessionKey,
    replaceEntry: true,
    preserveActivity: false,
    update: () => null,
  });
  logger?.info?.(
    `[PD:Watchdog] Cleaned up stale session via row-scoped API${tag}: ${sessionKey}`,
  );
}

 
export async function runWorkflowWatchdog(
  wctx: WorkspaceContext,
  api: OpenClawPluginApi | null,
  logger?: PluginLogger,
): Promise<WatchdogResult> {
  const details: string[] = [];
  const now = Date.now();
  const subagentRuntime = api?.runtime?.subagent;
  const agentSession = api?.runtime?.agent?.session;

  try {
    const store = new WorkflowStore({ workspaceDir: wctx.workspaceDir });
    try {
      const allWorkflows: WorkflowRow[] = store.listWorkflows();

      const staleThreshold = WORKFLOW_TTL_MS * 2;
      const staleActive = allWorkflows.filter(
        (wf: WorkflowRow) => wf.state === 'active' && (now - wf.created_at) > staleThreshold,
      );
      if (staleActive.length > 0) {
        for (const wf of staleActive) {
          const ageMin = Math.round((now - wf.created_at) / 60000);
          details.push(`stale_active: ${wf.workflow_id} (${wf.workflow_type}, ${ageMin}min old)`);

          const events = store.getEvents(wf.workflow_id);
          const lastEvent = events[events.length - 1];
          const lastEventReason = lastEvent ? lastEvent.reason : 'unknown';
          if (isExpectedSubagentError(lastEventReason)) {
            logger?.debug?.(`[PD:Watchdog] Skipping stale active workflow ${wf.workflow_id}: expected subagent error (${lastEventReason})`);
            continue;
          }

          store.updateWorkflowState(wf.workflow_id, 'terminal_error');
          store.recordEvent(wf.workflow_id, 'watchdog_timeout', 'active', 'terminal_error', `Stale active > ${staleThreshold / 60000}s`, { ageMs: now - wf.created_at });

          if (wf.child_session_key) {
            try {
              if (subagentRuntime) {
                await subagentRuntime.deleteSession({ sessionKey: wf.child_session_key, deleteTranscript: true });
                logger?.info?.(`[PD:Watchdog] Cleaned up stale session: ${wf.child_session_key}`);
              } else if (agentSession) {
                await cleanupStaleSessionEntry(agentSession, wf.child_session_key, logger);
              }
            } catch (cleanupErr) {
              const errMsg = String(cleanupErr);
              if (errMsg.includes('gateway request') && agentSession) {
                try {
                  await cleanupStaleSessionEntry(
                    agentSession,
                    wf.child_session_key,
                    logger,
                    'after gateway error',
                  );
                } catch (fallbackErr) {
                  logger?.warn?.(
                    `[PD:Watchdog] Fallback cleanup also failed for ${wf.child_session_key}: ${String(fallbackErr)}`,
                  );
                }
              } else {
                logger?.warn?.(`[PD:Watchdog] Failed to cleanup session ${wf.child_session_key}: ${errMsg}`);
              }
            }
          }
        }
      }

      const unclearedTerminal = allWorkflows.filter(
        (wf: WorkflowRow) => (wf.state === 'terminal_error' || wf.state === 'expired') && wf.cleanup_state === 'pending',
      );
      if (unclearedTerminal.length > 0) {
        details.push(`uncleared_terminal: ${unclearedTerminal.length} workflows (will be swept next cycle)`);
      }

      const stateCounts: Record<string, number> = {};
      for (const wf of allWorkflows) {
        stateCounts[wf.state] = (stateCounts[wf.state] || 0) + 1;
      }
      const stateSummary = Object.entries(stateCounts).map(([s, c]) => `${s}=${c}`).join(', ');
      if (details.length === 0) {
        logger?.debug?.(`[PD:Watchdog] OK — ${allWorkflows.length} workflows (${stateSummary})`);
      } else {
        logger?.info?.(`[PD:Watchdog] ${details.length} anomalies — ${allWorkflows.length} workflows (${stateSummary})`);
      }
    } finally {
      store.dispose();
    }
  } catch (err) {
    logger?.warn?.(`[PD:Watchdog] Failed to scan workflows: ${String(err)}`);
    return { anomalies: -1, details: [], scanError: String(err) };
  }

  return { anomalies: details.length, details };
}
