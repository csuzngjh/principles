import type { ActivationStatusRecord, PIArtifactSnapshot } from './activation-types.js';
import { isArtifactRevisionOf } from './activation-types.js';

/**
 * SPEC-RULECODE-APPROVED-REVISION-001 §B: detect the live shadow a revised
 * RuleCode artifact replaces.
 *
 * A bounded revision reuses the SAME evaluator task and produces a NEW
 * immutable artifact, so the artifact lineage — not the principle alone — is
 * the authoritative "this is a later version of that rule" signal. The match is
 * deliberately narrow:
 *
 * - same `sourceTaskId` (the evaluator chain that produced both versions), AND
 * - `isArtifactRevisionOf(new, old)` (the existing lineage/identity relation);
 *
 * a live (promoted) activation is NEVER silently replaced with a shadow — that
 * would be an invisible downgrade of an enforcing rule, so it refuses and asks
 * the Owner to use the formal lifecycle instead.
 *
 * Ambiguity fails closed: with more than one live candidate the caller must
 * deactivate the stale versions manually rather than guess.
 */
export interface RuleReplacementTarget {
  supersededActivationId: string;
  supersededArtifactId: string;
}

export type RuleReplacementDetection =
  | { ok: true; target: RuleReplacementTarget | null }
  | { ok: false; error: string; nextAction: string };

export async function detectRuleReplacementTarget(input: {
  approvalArtifactId: string;
  getArtifactById: (artifactId: string) => Promise<PIArtifactSnapshot | null>;
  listRuleActivations: () => Promise<ActivationStatusRecord[]>;
}): Promise<RuleReplacementDetection> {
  const approvalArtifact = await input.getArtifactById(input.approvalArtifactId);
  if (approvalArtifact === null) {
    return {
      ok: false,
      error: `rule_replacement_artifact_unreadable: ${input.approvalArtifactId}`,
      nextAction: 'check_pi_artifacts_table',
    };
  }
  const matches: RuleReplacementTarget[] = [];
  for (const activation of await input.listRuleActivations()) {
    if (activation.deactivatedAt !== null) continue;
    if (activation.artifactId === input.approvalArtifactId) continue;
    const previous = await input.getArtifactById(activation.artifactId);
    if (previous === null) continue;
    if (previous.sourceTaskId !== approvalArtifact.sourceTaskId) continue;
    if (!isArtifactRevisionOf(approvalArtifact, previous)) continue;
    if (activation.action === 'code_tool_hook_live_activate') {
      return {
        ok: false,
        error: `rule_replacement_target_is_live: ${activation.activationId}`,
        nextAction: 'demote the live rule through the formal lifecycle before approving its revised version',
      };
    }
    if (activation.action !== 'code_tool_hook_shadow_activate') continue;
    matches.push({ supersededActivationId: activation.activationId, supersededArtifactId: activation.artifactId });
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `ambiguous_rule_replacement: ${matches.length} live shadow activations match this revision (${matches.map((match) => match.supersededActivationId).join(', ')})`,
      nextAction: 'deactivate the stale versions manually, then retry the approval — replacement never migrates history in bulk',
    };
  }
  return { ok: true, target: matches[0] ?? null };
}
