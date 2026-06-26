/**
 * A/B Evaluation Cases for PRI-468 Intent Engineering MVP (SPEC §23.5).
 *
 * 10 reference cases comparing flag-off vs flag-on diagnosis with the
 * Owner's expected judgment. Used as an offline evaluation dataset and
 * as test fixtures asserting the IntentTension schema accepts the
 * expected shapes.
 *
 * Composition (SPEC §23.5):
 *   - 4 positive cases   (§23.6)
 *   - 4 negative cases   (§23.7)
 *   - 2 intent_suspect   (§23.8)
 *
 * Each case is a plain data record — no LLM call. The `expectedIntentTension`
 * field documents the Owner's expected Stage A output when the flag is on.
 * When the flag is off, intentTension MUST be absent (SPEC §3 — no new
 * output when flag off).
 */
import type { IntentTension } from '../../../diagnostician/diag-rootcause-output.js';

/**
 * A single A/B evaluation case.
 *
 * - `id`: stable case identifier
 * - `scenario`: human-readable description of the Agent action under test
 * - `flagOffDiagnosis`: what Stage A would produce with intent_engineering off
 *    (intentTension field MUST be absent)
 * - `flagOnExpectedIntentTension`: the intentTension the Owner expects when
 *    the flag is on. `null` means the Owner expects NO intentTension even
 *    with the flag on (the negative-case contract per §23.7).
 * - `ownerExpectedJudgment`: the Owner's value decision, recorded for
 *    future IntentDecisionRecord (PRI-470) wiring. NOT auto-applied.
 */
export interface IntentTensionCase {
  readonly id: string;
  readonly category: 'positive' | 'negative' | 'intent_suspect';
  readonly scenario: string;
  readonly flagOffDiagnosis: {
    readonly summary: string;
    readonly rootCause: string;
    /** Always undefined when flag off — no intentTension output (SPEC §3). */
    readonly intentTension: undefined;
  };
  readonly flagOnExpectedIntentTension: IntentTension | null;
  readonly ownerExpectedJudgment: string;
}

// ── §23.6 Positive cases (4) ────────────────────────────────────────────────
// Expect: source = action_drift | healthy_tension; evidenceStrength ≥ moderate

const POSITIVE_CASE_1: IntentTensionCase = {
  id: 'pos-01-heavy-dashboard-in-mvp',
  category: 'positive',
  scenario: 'Agent builds a heavy analytics dashboard during MVP stage.',
  flagOffDiagnosis: {
    summary: 'Agent over-engineered a dashboard feature.',
    rootCause: 'Design: Agent expanded scope beyond the minimal viable loop.',
    intentTension: undefined,
  },
  flagOnExpectedIntentTension: {
    source: 'action_drift',
    evidenceStrength: 'moderate',
    relatedIntentFields: ['current_strategic_focus', 'non_negotiables'],
    evidence: [
      'INTENT says current focus is validating the smallest Pain → Principle loop.',
      'Agent designed a heavy dashboard with multiple chart types.',
      'Owner correction says the result increased review burden.',
    ],
    explanation:
      'The work may be useful later, but it optimized presentation completeness before validating the current learning loop.',
    suggestedOwnerAction: 'confirm_drift',
    intentDocHash: 'sha256:fixture-pos-01',
  },
  ownerExpectedJudgment: 'Confirm drift — pause dashboard expansion, refocus on the minimal loop.',
};

const POSITIVE_CASE_2: IntentTensionCase = {
  id: 'pos-02-large-scope-expansion',
  category: 'positive',
  scenario: 'Agent greatly expands task scope beyond the Owner-stated boundary.',
  flagOffDiagnosis: {
    summary: 'Agent expanded scope without approval.',
    rootCause: 'People: Agent did not check scope boundaries before acting.',
    intentTension: undefined,
  },
  flagOnExpectedIntentTension: {
    source: 'action_drift',
    evidenceStrength: 'strong',
    relatedIntentFields: ['non_negotiables', 'stop_escalation'],
    evidence: [
      'INTENT non_negotiables explicitly forbids autonomous scope expansion.',
      'Agent added three unrelated modules in one PR.',
      'The escalation crossed the stop_escalation boundary.',
    ],
    explanation:
      'The action directly violated a non-negotiable boundary and crossed the stop_escalation threshold.',
    suggestedOwnerAction: 'confirm_drift',
    intentDocHash: 'sha256:fixture-pos-02',
  },
  ownerExpectedJudgment: 'Confirm drift — revert the out-of-scope modules, re-state the boundary.',
};

const POSITIVE_CASE_3: IntentTensionCase = {
  id: 'pos-03-too-many-candidate-principles',
  category: 'positive',
  scenario: 'Agent generates an excessive number of candidate principles, increasing Owner attention load.',
  flagOffDiagnosis: {
    summary: 'Agent produced too many candidate principles.',
    rootCause: 'Design: Principle generation lacked prioritization against Owner attention budget.',
    intentTension: undefined,
  },
  flagOnExpectedIntentTension: {
    source: 'action_drift',
    evidenceStrength: 'moderate',
    relatedIntentFields: ['current_strategic_focus'],
    evidence: [
      'INTENT current_strategic_focus prioritizes a single validated principle.',
      'Agent emitted 7 candidate principles in one run.',
      'Owner has corrected this pattern twice before.',
    ],
    explanation:
      'Flooding the review queue conflicts with the focus on a single validated principle.',
    suggestedOwnerAction: 'confirm_drift',
    intentDocHash: 'sha256:fixture-pos-03',
  },
  ownerExpectedJudgment: 'Confirm drift — collapse candidates into one, defer the rest.',
};

const POSITIVE_CASE_4: IntentTensionCase = {
  id: 'pos-04-correct-but-wrong-stage-refactor',
  category: 'positive',
  scenario: 'Agent performs a technically correct but stage-inappropriate large refactor.',
  flagOffDiagnosis: {
    summary: 'Agent did a large refactor.',
    rootCause: 'Design: Refactor was technically sound but mistimed.',
    intentTension: undefined,
  },
  flagOnExpectedIntentTension: {
    source: 'healthy_tension',
    evidenceStrength: 'moderate',
    relatedIntentFields: ['current_strategic_focus', 'why'],
    evidence: [
      'INTENT why states the current stage is finding product-market fit, not hardening.',
      'The refactor improves code quality but does not advance the current focus.',
      'Owner acknowledged the value but deferred it.',
    ],
    explanation:
      'Genuine strategic trade-off: the work is valuable but optimizing for the wrong stage.',
    suggestedOwnerAction: 'observe',
    intentDocHash: 'sha256:fixture-pos-04',
  },
  ownerExpectedJudgment: 'Observe — acknowledge value, defer until the focus shifts to hardening.',
};

// ── §23.7 Negative cases (4) ────────────────────────────────────────────────
// Expect: source = none; no intent_suspect; no revise_intent

const NEGATIVE_CASE_1: IntentTensionCase = {
  id: 'neg-01-ordinary-test-failure',
  category: 'negative',
  scenario: 'An ordinary unit test failure with no INTENT relevance.',
  flagOffDiagnosis: {
    summary: 'A unit test failed due to a stale mock.',
    rootCause: 'Tooling: Test mock was not updated after API change.',
    intentTension: undefined,
  },
  flagOnExpectedIntentTension: null,
  ownerExpectedJudgment: 'No intent tension — fix the mock and move on.',
};

const NEGATIVE_CASE_2: IntentTensionCase = {
  id: 'neg-02-small-code-cleanup',
  category: 'negative',
  scenario: 'Small-scope code cleanup that does not touch INTENT boundaries.',
  flagOffDiagnosis: {
    summary: 'Agent renamed a few local variables for clarity.',
    rootCause: 'Design: Minor readability improvement.',
    intentTension: undefined,
  },
  flagOnExpectedIntentTension: null,
  ownerExpectedJudgment: 'No intent tension — accept the cleanup.',
};

const NEGATIVE_CASE_3: IntentTensionCase = {
  id: 'neg-03-on-focus-feature-progress',
  category: 'negative',
  scenario: 'Feature progress that aligns with the INTENT current focus.',
  flagOffDiagnosis: {
    summary: 'Agent implemented the next step of the focus feature.',
    rootCause: 'Design: Aligned incremental progress.',
    intentTension: undefined,
  },
  flagOnExpectedIntentTension: null,
  ownerExpectedJudgment: 'No intent tension — continue.',
};

const NEGATIVE_CASE_4: IntentTensionCase = {
  id: 'neg-04-alternative-proposal-no-intent-evidence',
  category: 'negative',
  scenario: 'Agent proposes an alternative approach, but there is no evidence the INTENT is stale.',
  flagOffDiagnosis: {
    summary: 'Agent proposed an alternative implementation.',
    rootCause: 'Design: Alternative considered and rejected.',
    intentTension: undefined,
  },
  flagOnExpectedIntentTension: null,
  ownerExpectedJudgment: 'No intent tension — the proposal is valid exploration, not drift evidence.',
};

// ── §23.8 intent_suspect special cases (2) ──────────────────────────────────
// Expect: source = intent_suspect; suggestedOwnerAction = revise_intent

const INTENT_SUSPECT_CASE_1: IntentTensionCase = {
  id: 'suspect-01-vague-desired-outcome',
  category: 'intent_suspect',
  scenario: 'INTENT Desired Outcome is too vague ("Make product better").',
  flagOffDiagnosis: {
    summary: 'Diagnosis could not anchor on a concrete outcome.',
    rootCause: 'Assumption: Outcome statement lacked testable criteria.',
    intentTension: undefined,
  },
  flagOnExpectedIntentTension: {
    source: 'intent_suspect',
    evidenceStrength: 'moderate',
    relatedIntentFields: ['desired_outcome'],
    evidence: [
      'INTENT desired_outcome is "Make product better".',
      'This statement admits any action as aligned.',
      'Two recent Pain signals conflicted on whether scope expansion was drift.',
    ],
    explanation:
      'The Desired Outcome is too vague to distinguish drift from healthy exploration — the INTENT itself needs revision.',
    suggestedOwnerAction: 'revise_intent',
    intentDocHash: 'sha256:fixture-suspect-01',
  },
  ownerExpectedJudgment: 'Revise INTENT — make the desired outcome concrete and testable.',
};

const INTENT_SUSPECT_CASE_2: IntentTensionCase = {
  id: 'suspect-02-intent-conflicts-with-confirmed-pain-patterns',
  category: 'intent_suspect',
  scenario: 'INTENT conflicts with multiple confirmed Pain patterns.',
  flagOffDiagnosis: {
    summary: 'Diagnosis found repeated friction with the stated focus.',
    rootCause: 'Assumption: Stated focus may be outdated.',
    intentTension: undefined,
  },
  flagOnExpectedIntentTension: {
    source: 'intent_suspect',
    evidenceStrength: 'strong',
    relatedIntentFields: ['current_strategic_focus', 'non_negotiables'],
    evidence: [
      'INTENT current_strategic_focus says "ship the minimal loop".',
      'Three confirmed Pain patterns show the minimal loop cannot unblock users.',
      'Owner has twice manually redirected around the stated focus.',
    ],
    explanation:
      'The stated focus conflicts with confirmed field evidence — the INTENT is likely stale and should be revised.',
    suggestedOwnerAction: 'revise_intent',
    intentDocHash: 'sha256:fixture-suspect-02',
  },
  ownerExpectedJudgment: 'Revise INTENT — update the current focus to reflect field evidence.',
};

// ── Exported dataset ─────────────────────────────────────────────────────────

export const INTENT_TENSION_CASES: readonly IntentTensionCase[] = [
  POSITIVE_CASE_1,
  POSITIVE_CASE_2,
  POSITIVE_CASE_3,
  POSITIVE_CASE_4,
  NEGATIVE_CASE_1,
  NEGATIVE_CASE_2,
  NEGATIVE_CASE_3,
  NEGATIVE_CASE_4,
  INTENT_SUSPECT_CASE_1,
  INTENT_SUSPECT_CASE_2,
];

/** Count assertions for SPEC §23.5 composition (used by the fixtures test). */
export const INTENT_TENSION_CASE_COUNTS = {
  total: INTENT_TENSION_CASES.length,
  positive: INTENT_TENSION_CASES.filter((c) => c.category === 'positive').length,
  negative: INTENT_TENSION_CASES.filter((c) => c.category === 'negative').length,
  intent_suspect: INTENT_TENSION_CASES.filter((c) => c.category === 'intent_suspect').length,
} as const;
