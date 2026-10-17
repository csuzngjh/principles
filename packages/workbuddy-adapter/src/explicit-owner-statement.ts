import { admitGovernanceSignals, ensureGovernanceDiagnosticianTask, parseOwnerStatementPrefix } from '@principles/host-runtime';
import type { HostEvent } from '@principles/core/host';

/** Only this native current-user hook can assert Owner authorship. No transcript is read. */
export async function recordWorkbuddyOwnerStatement(event: HostEvent, workspaceDir: string): Promise<string | undefined> {
  if (event.kind !== 'before_prompt_build') return undefined;
  const parsed = parseOwnerStatementPrefix(event.context.promptContent);
  if (!parsed.matched) return undefined;
  const rejected = (reason: string, nextAction: string): string =>
    `[PD] host=workbuddy status=rejected reason=owner_statement_${reason} nextAction=${nextAction}`;
  if (parsed.text === null) return rejected(parsed.reason ?? 'statement_empty', 'Resubmit PD记录痛苦：<Owner statement of 1–500 characters>; nothing was recorded.');
  const raw = event.rawPayload;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || Object.getOwnPropertyDescriptor(raw, 'is_internal_continuation')?.value !== false) {
    return rejected('owner_source_unverified', 'Submit a new current-user message; native is_internal_continuation=false is required. Nothing was recorded.');
  }
  const { sessionId, turnId } = event.context;
  if (sessionId.trim().length === 0 || turnId === undefined || turnId.trim().length === 0) {
    return rejected('lineage_invalid', 'Native session_id and generation_id are required; nothing was recorded. Submit a new message.');
  }
  // A tuple avoids delimiter collisions; the occurrence namespace prevents
  // collisions with Codex without changing its established canonical IDs.
  const nativeIdentity = JSON.stringify(['workbuddy', sessionId, turnId]);
  const logicalObservationKey = `${nativeIdentity}|user`;
  try {
    const admitted = admitGovernanceSignals({ workspaceDir, candidates: [{
      kind: 'user_correction', hostKind: 'workbuddy', logicalObservationKey,
      rolloutIdentity: JSON.stringify(['workbuddy', sessionId]), rootSessionId: sessionId,
      hostTurnId: nativeIdentity, text: parsed.text, observedAt: new Date().toISOString(), explicitOwnerStatement: true,
    }] });
    if (!admitted.ok) return rejected('continuation_failed', `${admitted.reason}: ${admitted.nextAction}`);
    const [outcome] = admitted.outcomes;
    if (outcome === undefined) return rejected('continuation_failed', 'Admission returned no outcome; inspect PD status and retry the same event.');
    // Admission outcomes are a trusted discriminated union from the shared runtime.
    // eslint-disable-next-line no-restricted-syntax
    if (!('disposition' in outcome)) return rejected('continuation_failed', `${outcome.reason}: ${outcome.nextAction}`);
    if (outcome.disposition === 'rate_limited') return rejected('rate_limited', 'The existing per-session quota is exhausted; resubmit later. Nothing was recorded.');
    if (outcome.disposition !== 'admitted' && outcome.disposition !== 'already_admitted') return rejected('continuation_failed', 'The signal was not admitted; inspect PD status.');
    const ensured = await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey, canonicalPainId: outcome.canonicalPainId });
    if (!ensured.ok) return rejected('continuation_failed', `painId=${outcome.canonicalPainId}; ${ensured.reason}: ${ensured.nextAction}. The pain may already be durable; retry the same event.`);
    return `[PD] host=workbuddy status=received painId=${outcome.canonicalPainId} taskId=${ensured.taskId} disposition=${outcome.disposition}. Owner statement recorded as unverified owner_statement; diagnosis, candidate admission, approval and activation are not complete.`;
  } catch {
    return rejected('continuation_failed', 'Inspect PD workspace storage and retry the same event; a durable pain may exist. No completed receipt is available.');
  }
}
