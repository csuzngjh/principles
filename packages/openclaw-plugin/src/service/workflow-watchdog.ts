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
 * BUG-03: Nocturnal workflow snapshot validation detects pain_context_fallback
 *         with zero stats (lines 184-198)
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
  /** Set when the watchdog scan itself failed (e.g., store errors). Undefined means scan succeeded. */
  scanError?: string;
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

      // Check 1: Stale active workflows (active > 2x TTL)
      const staleThreshold = WORKFLOW_TTL_MS * 2;
      const staleActive = allWorkflows.filter(
        (wf: WorkflowRow) => wf.state === 'active' && (now - wf.created_at) > staleThreshold,
      );
      if (staleActive.length > 0) {
        for (const wf of staleActive) {
          const ageMin = Math.round((now - wf.created_at) / 60000);
          details.push(`stale_active: ${wf.workflow_id} (${wf.workflow_type}, ${ageMin}min old)`);

          // #257: Check if the last recorded event reason indicates expected subagent unavailability.
          // If so, skip marking as terminal_error — the workflow is stale because the subagent
          // was expectedly unavailable (daemon mode, process isolation), not due to a hard failure.
          const events = store.getEvents(wf.workflow_id);
          const lastEventReason = events.length > 0 ? events[events.length - 1].reason : 'unknown';
          if (isExpectedSubagentError(lastEventReason)) {
            logger?.debug?.(`[PD:Watchdog] Skipping stale active workflow ${wf.workflow_id}: expected subagent error (${lastEventReason})`);
            continue;
          }

          store.updateWorkflowState(wf.workflow_id, 'terminal_error');
          store.recordEvent(wf.workflow_id, 'watchdog_timeout', 'active', 'terminal_error', `Stale active > ${staleThreshold / 60000}s`, { ageMs: now - wf.created_at });

          // Cleanup session if possible (#188: gateway-safe fallback)
          if (wf.child_session_key) {
            try {
              if (subagentRuntime) {
                await subagentRuntime.deleteSession({ sessionKey: wf.child_session_key, deleteTranscript: true });
                logger?.info?.(`[PD:Watchdog] Cleaned up stale session: ${wf.child_session_key}`);
              } else if (agentSession) {
                const storePath = agentSession.resolveStorePath();
                const sessionStore = agentSession.loadSessionStore(storePath, { skipCache: true });
                const normalizedKey = wf.child_session_key.toLowerCase();
                if (sessionStore[normalizedKey]) {
                  delete sessionStore[normalizedKey];
                  await agentSession.saveSessionStore(storePath, sessionStore);
                  logger?.info?.(`[PD:Watchdog] Cleaned up stale session via agentSession fallback: ${wf.child_session_key}`);
                }
              }
            } catch (cleanupErr) {
              const errMsg = String(cleanupErr);
              if (errMsg.includes('gateway request') && agentSession) {
                const storePath = agentSession.resolveStorePath();
                const sessionStore = agentSession.loadSessionStore(storePath, { skipCache: true });
                const normalizedKey = wf.child_session_key.toLowerCase();
                if (sessionStore[normalizedKey]) {
                  delete sessionStore[normalizedKey];
                  await agentSession.saveSessionStore(storePath, sessionStore);
                  logger?.info?.(`[PD:Watchdog] Cleaned up stale session via agentSession fallback after gateway error: ${wf.child_session_key}`);
                }
              } else {
                logger?.warn?.(`[PD:Watchdog] Failed to cleanup session ${wf.child_session_key}: ${errMsg}`);
              }
            }
          }
        }
      }

      // Check 2: Workflows in terminal_error/expired without cleanup
      const unclearedTerminal = allWorkflows.filter(
        (wf: WorkflowRow) => (wf.state === 'terminal_error' || wf.state === 'expired') && wf.cleanup_state === 'pending',
      );
      if (unclearedTerminal.length > 0) {
        details.push(`uncleared_terminal: ${unclearedTerminal.length} workflows (will be swept next cycle)`);
      }

      // Check 3: Nocturnal workflow result validation (#181 pattern)
      const nocturnalCompleted = allWorkflows.filter(
        (wf: WorkflowRow) => wf.workflow_type === 'nocturnal' && wf.state === 'completed',
      );
      for (const wf of nocturnalCompleted) {
        // Check if the metadata snapshot has all zeros (invalid data)
        try {
          const meta = JSON.parse(wf.metadata_json) as Record<string, unknown>;
          const snapshot = meta.snapshot as Record<string, unknown> | undefined;
          if (snapshot) {
            // #219: Check for fallback data source (partial stats from pain context)
            const dataSource = snapshot._dataSource as string | undefined;
            if (dataSource === 'pain_context_fallback') {
              details.push(`fallback_snapshot: nocturnal workflow ${wf.workflow_id} uses pain-context fallback (stats may be incomplete)`);
            }
            const stats = snapshot.stats as Record<string, number> | undefined;
            // #246: Stats are now always number (never null). Detect "empty" fallback:
            // fallback + all counts zero means no real data was available.
            // NOTE: totalAssistantTurns may be 0 even for valid sessions because
            // listRecentNocturnalCandidateSessions (used in fallback path) does not
            // populate assistantTurnCount (only getNocturnalSessionSnapshot does).
            // We use totalToolCalls=0 as the primary indicator instead.
            if (stats && dataSource === 'pain_context_fallback' &&
                stats.totalToolCalls === 0 && stats.totalGateBlocks === 0 &&
                stats.failureCount === 0) {
              details.push(`fallback_snapshot_stats: nocturnal workflow ${wf.workflow_id} has empty fallback stats (no trajectory data found)`);
            }
          }
        } catch (err) {
          details.push(`malformed_metadata: workflow ${wf.workflow_id} has unparseable metadata: ${String(err).slice(0, 100)}`);
        }
      }

      // Summary
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
