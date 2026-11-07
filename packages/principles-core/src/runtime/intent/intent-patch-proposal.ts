/**
 * IntentPatchProposal — read-only patch proposal generator (PRI-471, SPEC §10).
 *
 * When an Owner chooses `revise_intent`, the system generates a read-only
 * patch proposal that the Owner can review and manually apply. The proposal
 * is NEVER auto-applied to `.principles/INTENT.md`.
 *
 * SPEC §10 format:
 * ```md
 * ## Intent Patch Proposal
 * ### Reason
 * ### Evidence (max 3)
 * ### Proposed Diff
 * ### Risk
 * ```
 *
 * ERR checklist:
 * - EP-01: no untrusted input — operates on already-validated IntentDecisionRecord
 * - EP-09: pure function, independently testable
 */

import type { IntentDecisionRecord } from './intent-decision-record.js';
import type { IntentRelatedField } from '../diagnostician/diag-rootcause-output.js';

/**
 * A read-only Intent Patch Proposal generated from an Owner decision.
 * `id` is deterministic: `patch-<decisionId>` so it can be referenced without
 * a separate storage table. `markdown` is the SPEC §10 formatted text.
 */
export interface IntentPatchProposal {
  id: string;
  decisionId: string;
  markdown: string;
}

const FIELD_LABELS: Record<IntentRelatedField, string> = {
  why: 'Why',
  desired_outcome: 'Desired Outcome',
  non_negotiables: 'Non-negotiables',
  stop_escalation: 'Stop / Escalation',
  current_strategic_focus: 'Current Strategic Focus',
};

/**
 * Generate a read-only Intent Patch Proposal from an Owner decision.
 *
 * The proposal summarizes why INTENT may need revision, lists the evidence
 * (max 3 items from the decision's evidenceRefs), identifies the related
 * INTENT fields, and includes a placeholder diff for the Owner to fill in.
 *
 * The proposal is marked "Display only, cannot be auto-applied" per SPEC §22.1.4.
 */
export function generateIntentPatchProposal(decision: IntentDecisionRecord): IntentPatchProposal {
  const fieldNames = decision.relatedIntentFields
    .map((f) => FIELD_LABELS[f] ?? f)
    .join(', ');

  const evidenceList = decision.evidenceRefs
    .slice(0, 3)
    .map((ref, i) => `- Evidence ${i + 1}: ${ref}`)
    .join('\n');

  const reason = `Owner decision: ${decision.ownerAction}. Source: ${decision.source}, Evidence strength: ${decision.evidenceStrength}.`;

  const markdown = `## Intent Patch Proposal

> **Display only — cannot be auto-applied.**
> The Owner must manually edit \`.principles/INTENT.md\` if they accept this proposal.

### Reason

${reason}

### Related INTENT Fields

${fieldNames || 'No specific fields identified.'}

### Evidence

${evidenceList || 'No evidence recorded.'}

### Proposed Diff

\`\`\`diff
# Owner: fill in the desired INTENT.md changes here.
# This is a placeholder — PD does not auto-generate diff content.
\`\`\`

### Risk

- **If modified:** INTENT changes may affect future intentTension diagnosis. Review carefully.
- **If not modified:** The identified tension may recur in similar scenarios.
`;

  return {
    id: `patch-${decision.id}`,
    decisionId: decision.id,
    markdown,
  };
}
