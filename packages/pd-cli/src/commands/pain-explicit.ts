/**
 * pd pain explicit — agent-assisted explicit Owner pain registration from the
 * LIVE Codex turn context (no `PD记录痛苦：` prefix).
 *
 * Usage:
 *   pd pain explicit --statement "<Owner 原文>" [--workspace <path>] [--json]
 *
 * The command takes NO lineage flags by design: the Codex hook wrote the
 * current turn's host-verified identity to `<workspace>/.state/`, and the
 * bridge (registerCurrentTurnOwnerStatement) re-validates it — transcript
 * existence, CODEX_HOME containment, workspace match — inside the SAME
 * admission chain the prefix entry uses (governance admission marker,
 * explicit rate-limit bucket, diagnostician task ensure). The model never
 * supplies session/rollout/turn ids, so it cannot guess or fabricate them.
 *
 * This is NOT `pd pain record`: that command is the unbound operator/recovery
 * entry (manual pain ids, no admission marker); this one is the bound
 * agent-assisted counterpart of the prefix entry.
 */
import { registerCurrentTurnOwnerStatement, type RegisterCurrentTurnResult } from '@principles/codex-adapter';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface ExplicitOptions {
  statement?: string;
  workspace?: string;
  json?: boolean;
}

const FAILURE_MESSAGES: Record<string, string> = {
  statement_empty: 'The Owner statement is empty; nothing was recorded.',
  statement_too_long: 'The Owner statement exceeds 500 characters; nothing was recorded (never truncated).',
  turn_context_missing: 'No live Codex turn context: the turn already completed, the session restarted, or the PD hook did not run.',
  turn_context_invalid: 'The Codex turn context file is malformed or unsupported; nothing was recorded.',
  turn_context_workspace_mismatch: 'The live turn context belongs to a different PD workspace; nothing was recorded.',
  transcript_unavailable: 'The Codex transcript for the live turn is unavailable; nothing was recorded.',
  lineage_invalid: 'The live turn context failed lineage validation; nothing was recorded.',
  rate_limited: 'The per-root-session explicit statement quota (5/hour) is exhausted; nothing was recorded.',
  continuation_failed: 'The governance admission or diagnostician-task continuation failed; nothing was recorded.',
  workspace_unresolvable: 'No PD workspace could be resolved for this invocation.',
};

function emitFailure(opts: ExplicitOptions, failure: { reason: string; message: string; nextAction: string }): never {
  if (opts.json) {
    console.log(JSON.stringify({ status: 'failed', reason: failure.reason, message: failure.message, nextAction: failure.nextAction }, null, 2));
  } else {
    console.error(`Error: ${failure.message}`);
    console.error(`Reason: ${failure.reason}`);
    console.error(`Next action: ${failure.nextAction}`);
  }
  process.exit(1);
}

export async function handlePainExplicit(opts: ExplicitOptions): Promise<void> {
  let workspaceDir: string;
  try {
    workspaceDir = resolveWorkspaceDir(opts.workspace);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emitFailure(opts, { reason: 'workspace_unresolvable', message: detail.slice(0, 400), nextAction: 'Pass --workspace explicitly or run from a directory inside a PD workspace.' });
  }
  const result: RegisterCurrentTurnResult = await registerCurrentTurnOwnerStatement({
    workspaceDir,
    statementText: opts.statement ?? '',
  });
  if (result.status !== 'received') {
    emitFailure(opts, {
      reason: result.reason,
      message: FAILURE_MESSAGES[result.reason] ?? 'The explicit registration was rejected; nothing was recorded.',
      nextAction: result.nextAction,
    });
  }
  if (opts.json) {
    console.log(JSON.stringify({
      status: 'received',
      disposition: result.disposition,
      painId: result.painId,
      taskId: result.taskId,
      logicalObservationKey: result.logicalObservationKey,
      ...(result.promotionDegraded !== undefined ? { promotionDegraded: result.promotionDegraded } : {}),
    }, null, 2));
  } else {
    const duplicateNote = result.disposition === 'already_admitted' ? ' (duplicate submission merged into the same signal)' : '';
    console.log(`Pain registered${duplicateNote}: painId=${result.painId} taskId=${result.taskId}`);
    if (result.promotionDegraded !== undefined) {
      console.error(`Warning: session-evidence promotion degraded: ${result.promotionDegraded}`);
    }
  }
}
