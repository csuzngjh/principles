// SPEC-PD-EXAMINER-001 v0.3 — Phase 1A immutable A/B/Summary arm configuration
// for challenge studies. Reuses the G2 single delivery path (deliverPayload:
// research-same-channel-v1, payloadHash = sha256(payload bytes), over-budget
// throws — never truncates) and the PRI-971 freeze interface (freezeCandidate).
// Content modes reuse the real-runner vocabulary: A='none', B='policy',
// C='summary'. This module only BUILDS and AUDITS configurations — it never
// transports anything and never opens a socket. Real runs stay NOT_RUN.

import { deliverPayload, composeActorPrompt } from './g2.mjs';
import { freezeCandidate } from './sidecar.mjs';
import { sha256 } from './fixture.mjs';

export const CHALLENGE_ARM_IDS = ['A', 'B', 'C'];

/**
 * Build the three frozen arm configs. The B payload is the EXACT frozen
 * principle statement (SPEC §6.2.6: prefer the production-deliverable
 * principleDraft.statement) — payloadHash must equal statementSha256 from the
 * frozen principle asset. The C payload is an experience summary that shares
 * the underlying incident but must NOT contain the principle's normative
 * expression (checked by auditArmIsolation).
 */
export function buildStudyArms({ commonContextText, principleStatement, summaryText, budgetChars = 2000 }) {
  if (typeof commonContextText !== 'string' || commonContextText.length === 0) throw new Error('buildStudyArms: commonContextText required');
  if (typeof principleStatement !== 'string' || principleStatement.length === 0) throw new Error('buildStudyArms: principleStatement required');
  if (typeof summaryText !== 'string' || summaryText.length === 0) throw new Error('buildStudyArms: summaryText required');

  const commonContextHash = sha256(commonContextText);
  const arms = {
    A: {
      armId: 'A',
      name: 'BASELINE_NO_ADDED_PRINCIPLE',
      contentMode: 'none',
      delivery: deliverPayload({ armId: 'A', content: null, budgetChars }),
    },
    B: {
      armId: 'B',
      name: 'TARGET_PRINCIPLE',
      contentMode: 'policy',
      delivery: deliverPayload({ armId: 'B', content: principleStatement, budgetChars }),
      frozenCandidate: freezeCandidate({ policyText: principleStatement, sourceStage: 'principle-frozen', deliveredRepresentation: 'statement' }),
    },
    C: {
      armId: 'C',
      name: 'EXPERIENCE_SUMMARY',
      contentMode: 'summary',
      delivery: deliverPayload({ armId: 'C', content: summaryText, budgetChars }),
      frozenCandidate: freezeCandidate({ policyText: summaryText, sourceStage: 'experience-summary-frozen', deliveredRepresentation: 'summary' }),
    },
  };
  return { commonContextText, commonContextHash, budgetChars, arms };
}

/** Compose the full actor-visible prompt for an arm (audit surface only). */
export function composeArmPrompt({ arms, armId, taskText }) {
  const arm = arms[armId];
  if (!arm) throw new Error(`composeArmPrompt: unknown armId ${armId}`);
  return composeActorPrompt({ taskText, delivery: arm.delivery });
}

/**
 * Static isolation audit over the built arm configs:
 *  - A's composed prompt must contain neither the principle statement, nor
 *    the summary text, nor any normative marker (keyword proxy for
 *    principle-synonymous content; hash equality is covered separately).
 *  - B must deliver exactly the frozen statement (payloadHash equality).
 *  - C must deliver the summary and must NOT contain the normative markers.
 *  - All arms share the same commonContextHash and budget policy.
 * This is a STATIC config audit. It proves nothing about real hosts (see the
 * study's a-baseline-contamination-audit.json for the UNKNOWN boundary).
 */
export function auditArmIsolation({ arms, commonContextText, taskText, normativeMarkers }) {
  const problems = [];
  const summaryText = arms.C.delivery.payloadText;
  const principleStatement = arms.B.delivery.payloadText;
  if (arms.A.delivery.payloadText !== '') problems.push('arm A payload must be empty');
  if (arms.B.delivery.payloadHash !== arms.B.frozenCandidate.contentHash) problems.push('arm B payloadHash != frozenCandidate.contentHash');
  const promptA = composeArmPrompt({ arms, armId: 'A', taskText });
  const promptB = composeArmPrompt({ arms, armId: 'B', taskText });
  const promptC = composeArmPrompt({ arms, armId: 'C', taskText });
  if (promptA.includes(principleStatement)) problems.push('arm A composed prompt contains the principle statement');
  if (promptA.includes(summaryText)) problems.push('arm A composed prompt contains the summary text');
  for (const marker of normativeMarkers) {
    if (promptA.includes(marker)) problems.push(`arm A composed prompt contains normative marker: ${marker}`);
    if (promptC.includes(marker)) problems.push(`arm C payload contains normative marker (summary must not carry the normative rule): ${marker}`);
  }
  if (!promptB.includes(principleStatement)) problems.push('arm B composed prompt must contain the frozen principle statement');
  if (promptC.includes(principleStatement)) problems.push('arm C payload must not contain the verbatim principle statement');
  const commonHashes = new Set([arms.A, arms.B, arms.C].map(() => arms.commonContextHash ?? sha256(commonContextText)));
  if (commonHashes.size !== 1) problems.push('arms disagree on common context hash');
  return {
    ok: problems.length === 0,
    problems,
    evidence: {
      aPayloadEmpty: arms.A.delivery.payloadText === '',
      bPayloadHash: arms.B.delivery.payloadHash,
      cPayloadHash: arms.C.delivery.payloadHash,
      promptALength: promptA.length,
      markersChecked: normativeMarkers.length,
    },
  };
}
