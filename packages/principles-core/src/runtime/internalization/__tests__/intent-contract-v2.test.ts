/**
 * SIA v1.2 · PRI-1216 — IntentContract V2 completeness, V1 compatibility and
 * the server-side assembly boundary (SPEC §7.1 / §8.2 / §8.3, TECH §7.2 / §7.3).
 *
 * The invariants proven here:
 * 1. V2 completeness is a HARD rule — missing strategicAssessment / relevance /
 *    conflictStatus is never read as "no strategic information".
 * 2. Historical V1 contracts stay valid and are never forced to grow V2 fields.
 * 3. relevance is derived from Stage A's artifact ONLY, and is NOT a rename of
 *    `intentTension.source` (the two enums must not collapse into each other).
 * 4. The server — not the model — authors strategicIntent / relevance /
 *    conflictStatus; a model-supplied value is overridden and recorded.
 * 5. `corePrincipleRefs` is never populated from `violatedPrinciples`.
 */
import { describe, expect, it } from 'vitest';
import {
  assembleIntentContractV2,
  deriveStrategicRelevance,
  extractIntentContract,
  extractIntentContractV2,
  isValidIntentContractV1,
  isValidIntentContractV2,
  validateIntentContractV2,
  type IntentContractV1,
} from '../intent-contract.js';
import { CORE_PRINCIPLE_IDS } from '../../core-principles/core-principle-registry.js';

const BASE: IntentContractV1 = {
  ownerIntent: 'protect the authoritative state before merging',
  targetBehavior: 'verify the authoritative source before any state merge',
  forbiddenBehavior: 'merging stale entries without verification',
  evidenceSource: 'manual_evidence_001',
  validationExpectation: 'block merge-shaped writes with no prior verification',
};

const REF = { contentHash: 'sha256:stage-a-hash', capturedAt: '2026-11-14T00:00:00.000Z' };
const TENSION = { relatedIntentFields: ['why', 'non_negotiables'], explanation: 'the pain drifts from the stated owner intent' };

/** A real registered Core Principle id (used to prove resolvability is enforced). */
const [PRINCIPLE_ID] = CORE_PRINCIPLE_IDS;
if (PRINCIPLE_ID === undefined) throw new Error('the Core Principle registry is empty in this build');

function assemble(overrides: Partial<Parameters<typeof assembleIntentContractV2>[0]> = {}) {
  return assembleIntentContractV2({
    base: BASE,
    diagnosisAvailable: true,
    strategicIntentRef: REF,
    intentTension: TENSION,
    modelContract: BASE,
    ...overrides,
  });
}

describe('isValidIntentContractV2 — completeness is hard', () => {
  it('accepts a complete V2 assembled by the server', () => {
    const result = assemble();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isValidIntentContractV2(result.contract)).toBe(true);
    expect(result.contract.schemaVersion).toBe(2);
    expect(result.contract.strategicAssessment.relevance).toBe('relevant');
  });

  it('rejects a V1 contract as V2 (missing schemaVersion + assessment)', () => {
    expect(isValidIntentContractV1(BASE)).toBe(true);
    expect(isValidIntentContractV2(BASE)).toBe(false);
    expect(extractIntentContractV2({ intentContract: BASE })).toBeNull();
  });

  it.each([
    ['missing strategicAssessment', { schemaVersion: 2 }],
    ['missing relevance', { schemaVersion: 2, strategicAssessment: { rationale: 'r', conflictStatus: 'none' } }],
    ['missing conflictStatus', { schemaVersion: 2, strategicAssessment: { relevance: 'relevant', rationale: 'r' } }],
    ['empty rationale', { schemaVersion: 2, strategicAssessment: { relevance: 'relevant', rationale: '  ', conflictStatus: 'none' } }],
    ['illegal relevance', { schemaVersion: 2, strategicAssessment: { relevance: 'maybe', rationale: 'r', conflictStatus: 'none' } }],
    ['illegal conflictStatus', { schemaVersion: 2, strategicAssessment: { relevance: 'relevant', rationale: 'r', conflictStatus: 'open' } }],
    [
      'conflict without evidenceRefs',
      { schemaVersion: 2, strategicAssessment: { relevance: 'relevant', rationale: 'r', conflictStatus: 'potential', conflicts: [{ against: 'owner_intent', ref: 'why', status: 'potential', evidenceRefs: [] }] } },
    ],
    [
      'conflict with illegal against',
      { schemaVersion: 2, strategicAssessment: { relevance: 'relevant', rationale: 'r', conflictStatus: 'potential', conflicts: [{ against: 'pain', ref: 'why', status: 'potential', evidenceRefs: ['e1'] }] } },
    ],
    ['illegal schemaVersion', { schemaVersion: 3, strategicAssessment: { relevance: 'relevant', rationale: 'r', conflictStatus: 'none' } }],
    ['non-string corePrincipleRefs entry', { schemaVersion: 2, strategicAssessment: { relevance: 'relevant', rationale: 'r', conflictStatus: 'none' }, corePrincipleRefs: [1] }],
    ['illegal section key in strategicIntent', { schemaVersion: 2, strategicAssessment: { relevance: 'relevant', rationale: 'r', conflictStatus: 'none' }, strategicIntent: { contentHash: 'h', capturedAt: 'c', relevantSections: ['notes'] } }],
  ])('rejects V2 with %s', (_label, overrides) => {
    expect(isValidIntentContractV2({ ...BASE, ...overrides })).toBe(false);
  });

  it('keeps historical V1 contracts usable through the V1 extractor', () => {
    expect(extractIntentContract({ intentContract: BASE })).toEqual(BASE);
    expect(extractIntentContract({ intentContract: { ...BASE, schemaVersion: 2 } })).toEqual({ ...BASE, schemaVersion: 2 });
  });
});

// ── P1 (PR #2663 final): overall status MUST equal the conflict aggregate ────
//
// `maxConflictStatus(conflicts)` is the single aggregation authority, so a
// persisted V2 whose declared `conflictStatus` disagrees with its own list makes
// its status untrustworthy. Decision resolution is a SEPARATE layer: an already
// resolved conflict keeps its raw `status` and the overall status is unchanged.
function withAssessment(
  conflictStatus: 'none' | 'potential' | 'confirmed',
  conflicts?: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    ...BASE,
    schemaVersion: 2,
    strategicIntent: { contentHash: 'sha256:stage-a-hash', capturedAt: '2026-11-14T00:00:00.000Z' },
    strategicAssessment: {
      relevance: 'relevant',
      rationale: 'Stage A grounded this formation in INTENT.md',
      conflictStatus,
      ...(conflicts === undefined ? {} : { conflicts }),
    },
  };
}

const POTENTIAL_WHY = { against: 'owner_intent', ref: 'why', status: 'potential', evidenceRefs: ['why'] };
const CONFIRMED_WHY = { against: 'owner_intent', ref: 'why', status: 'confirmed', evidenceRefs: ['why'] };

const STATUS_MATRIX = [
  { label: '1. none + empty list is legal', status: 'none', conflicts: [], expected: true },
  { label: '2. none + potential is illegal', status: 'none', conflicts: [POTENTIAL_WHY], expected: false },
  { label: '3. none + confirmed is illegal', status: 'none', conflicts: [CONFIRMED_WHY], expected: false },
  { label: '4. potential + one potential is legal', status: 'potential', conflicts: [POTENTIAL_WHY], expected: true },
  { label: '5. potential + several potential is legal', status: 'potential', conflicts: [POTENTIAL_WHY, { ...POTENTIAL_WHY, ref: 'desired_outcome' }], expected: true },
  { label: '6. potential + empty list is illegal', status: 'potential', conflicts: [], expected: false },
  { label: '7. potential + confirmed is illegal', status: 'potential', conflicts: [CONFIRMED_WHY], expected: false },
  { label: '8. confirmed + one locatable confirmed is legal', status: 'confirmed', conflicts: [CONFIRMED_WHY], expected: true },
  { label: '9. confirmed + empty list is illegal', status: 'confirmed', conflicts: [], expected: false },
  { label: '10. confirmed + only potential is illegal', status: 'confirmed', conflicts: [POTENTIAL_WHY], expected: false },
  { label: '11. confirmed + confirmed and potential together is legal', status: 'confirmed', conflicts: [CONFIRMED_WHY, POTENTIAL_WHY], expected: true },
] as const;

describe('validateIntentContractV2 — status/conflicts consistency matrix', () => {
  it.each(STATUS_MATRIX)('$label', ({ status, conflicts, expected }) => {
    const result = validateIntentContractV2(withAssessment(status, conflicts));
    expect(result.ok).toBe(expected);
    if (expected) return;
    if (result.ok) return;
    expect(result.defect).toBe('conflict_status_mismatch');
  });

  it('missing conflicts[] is the same as an empty list (never "unknown")', () => {
    const missing = validateIntentContractV2(withAssessment('potential'));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.defect).toBe('conflict_status_mismatch');
    expect(missing.errors[0]).toContain('no conflicts');
  });

  it('keeps every raw conflict status untouched when the contract is legal (resolution is a later layer)', () => {
    const result = validateIntentContractV2(withAssessment('confirmed', [CONFIRMED_WHY, POTENTIAL_WHY]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.strategicAssessment.conflicts?.map((conflict) => conflict.status))
      .toEqual(['confirmed', 'potential']);
    expect(result.contract.strategicAssessment.conflictStatus).toBe('confirmed');
  });

  it('the type guard and the extractor share this verdict (no second rule set)', () => {
    const illegal = withAssessment('none', [CONFIRMED_WHY]);
    expect(isValidIntentContractV2(illegal)).toBe(false);
    expect(extractIntentContractV2({ intentContract: illegal })).toBeNull();
  });
});

describe('validateIntentContractV2 — conflict target locatability', () => {
  const target = (against: 'owner_intent' | 'core_principle', ref: string, status: 'potential' | 'confirmed' = 'confirmed') => ({
    against,
    ref,
    status,
    evidenceRefs: ['evidence-1'],
  });

  it.each([
    ['1. owner_intent:why', target('owner_intent', 'why'), true],
    ['2. owner_intent:desired_outcome', target('owner_intent', 'desired_outcome'), true],
    ['3. owner_intent:non_negotiables', target('owner_intent', 'non_negotiables'), true],
    ['4. owner_intent:current_strategic_focus', target('owner_intent', 'current_strategic_focus'), true],
    ['5. a registered core principle id', target('core_principle', PRINCIPLE_ID), true],
    ['6. an unknown core principle id', target('core_principle', 'CP-NOT-REGISTERED'), false],
    ['7. a section key masquerading as a core principle', target('core_principle', 'why'), false],
    ['8. an arbitrary non-empty owner_intent target', target('owner_intent', 'a-good-idea'), false],
  ] as const)('%s', (_label, conflict, expected) => {
    const result = validateIntentContractV2(withAssessment('confirmed', [conflict]));
    expect(result.ok).toBe(expected);
    if (expected) return;
    if (result.ok) return;
    expect(result.defect).toBe('unlocatable_conflict');
    expect(result.errors[0]).toContain('conflicts[0]');
  });

  it('treats evidenceRefs as structure: an empty string entry is malformed, not unlocatable', () => {
    const result = validateIntentContractV2(withAssessment('confirmed', [
      { against: 'owner_intent', ref: 'why', status: 'confirmed', evidenceRefs: [''] },
    ]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.defect).toBe('malformed_strategic_contract');
  });

  it('checks locatability for potential conflicts too', () => {
    const result = validateIntentContractV2(withAssessment('potential', [target('owner_intent', 'not-a-section', 'potential')]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.defect).toBe('unlocatable_conflict');
  });
});

describe('deriveStrategicRelevance — Stage A is the only authority', () => {
  it('no diagnosis artifact → insufficient_evidence (never fabricated)', () => {
    expect(deriveStrategicRelevance({ diagnosisAvailable: false, hasStrategicIntentRef: true })).toBe('insufficient_evidence');
  });

  it('Stage A ran without a snapshot → not_configured', () => {
    expect(deriveStrategicRelevance({ diagnosisAvailable: true, hasStrategicIntentRef: false })).toBe('not_configured');
  });

  it('snapshot present but no Stage A tension → insufficient_evidence', () => {
    expect(deriveStrategicRelevance({ diagnosisAvailable: true, hasStrategicIntentRef: true })).toBe('insufficient_evidence');
  });

  it('tension grounded in sections → relevant; ungrounded → not_applicable', () => {
    expect(deriveStrategicRelevance({
      diagnosisAvailable: true,
      hasStrategicIntentRef: true,
      intentTension: { relatedIntentFields: ['why'] },
    })).toBe('relevant');
    expect(deriveStrategicRelevance({
      diagnosisAvailable: true,
      hasStrategicIntentRef: true,
      intentTension: { relatedIntentFields: [] },
    })).toBe('not_applicable');
  });

  it('does NOT map intentTension.source to relevance (the enums stay distinct)', () => {
    // An "action_drift" tension whose evidence is not grounded in any INTENT
    // section is NOT automatically "relevant"...
    expect(deriveStrategicRelevance({
      diagnosisAvailable: true,
      hasStrategicIntentRef: true,
      intentTension: { relatedIntentFields: [] },
    })).toBe('not_applicable');
    // ...and a "none" tension that cites real sections is NOT "not_applicable".
    expect(deriveStrategicRelevance({
      diagnosisAvailable: true,
      hasStrategicIntentRef: true,
      intentTension: { relatedIntentFields: ['desired_outcome'] },
    })).toBe('relevant');
  });
});

describe('assembleIntentContractV2 — server assembly boundary', () => {
  it('stamps the server-captured reference and never the model-supplied hash', () => {
    const result = assemble({
      modelContract: {
        ...BASE,
        schemaVersion: 2,
        strategicIntent: { contentHash: 'model-forged', capturedAt: 'model-forged' },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.strategicIntent).toEqual({
      contentHash: REF.contentHash,
      capturedAt: REF.capturedAt,
      relevantSections: ['why', 'non_negotiables'],
    });
  });

  it('drops a model-authored strategicIntent when Stage A produced no snapshot (P0-6)', () => {
    const forged = {
      ...BASE,
      schemaVersion: 2,
      strategicIntent: { contentHash: 'model-forged', capturedAt: 'model-forged' },
      strategicAssessment: { relevance: 'relevant', conflictStatus: 'none' },
      corePrincipleRefs: [PRINCIPLE_ID],
    };
    const result = assemble({
      base: forged,
      modelContract: forged,
      diagnosisAvailable: true,
      strategicIntentRef: undefined,
      intentTension: undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // V1 fields survive; every V2 field is server-derived (or absent).
    expect(result.contract.ownerIntent).toBe(BASE.ownerIntent);
    expect(result.contract.strategicIntent).toBeUndefined();
    expect(result.contract.strategicAssessment.relevance).toBe('not_configured');
  });

  it('overrides a model-authored relevance and records the override', () => {
    const result = assemble({
      modelContract: { ...BASE, strategicAssessment: { relevance: 'not_configured', conflictStatus: 'none' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.strategicAssessment.relevance).toBe('relevant');
    expect(result.overrides).toEqual(['strategicAssessment.relevance', 'strategicAssessment.conflictStatus']);
  });

  it('derives conflictStatus from the model-authored conflicts (max severity)', () => {
    const conflicts = [
      { against: 'core_principle' as const, ref: PRINCIPLE_ID, status: 'potential' as const, evidenceRefs: ['diag#ev1'] },
      { against: 'owner_intent' as const, ref: 'why', status: 'confirmed' as const, evidenceRefs: ['why'] },
    ];
    const result = assemble({ modelContract: { ...BASE, strategicAssessment: { conflicts } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.strategicAssessment.conflicts).toEqual(conflicts);
    expect(result.contract.strategicAssessment.conflictStatus).toBe('confirmed');
    // P1: the assembly output must satisfy its own integrity validator.
    expect(validateIntentContractV2(result.contract).ok).toBe(true);
  });

  // P1-3 (PR #2652): a Scribe may propose conflicts but may not grant
  // `confirmed`; only server-verifiable evidence keeps that status.
  describe('confirmed conflicts require server verification', () => {
    const conflict = (overrides: Record<string, unknown> = {}) => ({
      against: 'core_principle' as const,
      ref: PRINCIPLE_ID,
      status: 'confirmed' as const,
      evidenceRefs: ['diag#ev1'],
      ...overrides,
    });

    it('keeps a verified confirmed conflict (registered ref + diagnosis evidence)', () => {
      const result = assemble({
        modelContract: { ...BASE, strategicAssessment: { conflicts: [conflict()] } },
        diagnosisEvidenceRefs: ['diag#ev1'],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.contract.strategicAssessment.conflicts?.[0]?.status).toBe('confirmed');
      expect(result.contract.strategicAssessment.conflictStatus).toBe('confirmed');
      expect(result.overrides).not.toContain('strategicAssessment.conflicts[0].status');
    });

    it('downgrades a confirmed conflict whose evidenceRef does not resolve', () => {
      const result = assemble({
        modelContract: { ...BASE, strategicAssessment: { conflicts: [conflict({ evidenceRefs: ['diag#never-happened'] })] } },
        diagnosisEvidenceRefs: ['diag#ev1'],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.contract.strategicAssessment.conflicts?.[0]?.status).toBe('potential');
      expect(result.contract.strategicAssessment.conflictStatus).toBe('potential');
      expect(result.overrides).toContain('strategicAssessment.conflicts[0].status');
    });

    it('downgrades when no verification material exists (reviewer unavailable)', () => {
      const result = assemble({
        modelContract: { ...BASE, strategicAssessment: { conflicts: [conflict()] } },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.contract.strategicAssessment.conflicts?.[0]?.status).toBe('potential');
      expect(result.overrides).toContain('strategicAssessment.conflicts[0].status');
    });

    it('requires Stage A to link the section before an owner_intent conflict is confirmed', () => {
      const linked = conflict({ against: 'owner_intent', ref: 'why', evidenceRefs: ['why'] });
      const kept = assemble({ modelContract: { ...BASE, strategicAssessment: { conflicts: [linked] } } });
      expect(kept.ok).toBe(true);
      if (!kept.ok) return;
      expect(kept.contract.strategicAssessment.conflicts?.[0]?.status).toBe('confirmed');

      const unlinked = conflict({ against: 'owner_intent', ref: 'stop_escalation', evidenceRefs: ['stop_escalation'] });
      const downgraded = assemble({ modelContract: { ...BASE, strategicAssessment: { conflicts: [unlinked] } } });
      expect(downgraded.ok).toBe(true);
      if (!downgraded.ok) return;
      expect(downgraded.contract.strategicAssessment.conflicts?.[0]?.status).toBe('potential');
    });

    it('rejects a conflict whose core principle ref is not resolvable', () => {
      const result = assemble({
        modelContract: { ...BASE, strategicAssessment: { conflicts: [conflict({ ref: 'CP-DOES-NOT-EXIST' })] } },
        diagnosisEvidenceRefs: ['diag#ev1'],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.join(' ')).toContain('CP-DOES-NOT-EXIST');
    });

    it('rejects a conflict whose owner_intent ref is not an INTENT section key', () => {
      const result = assemble({
        modelContract: { ...BASE, strategicAssessment: { conflicts: [conflict({ against: 'owner_intent', ref: 'some_free_text' })] } },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.join(' ')).toContain('some_free_text');
    });
  });

  it('keeps conflictStatus none with no conflicts', () => {    const result = assemble();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.strategicAssessment.conflictStatus).toBe('none');
    expect(result.contract.strategicAssessment.conflicts).toBeUndefined();
  });

  it('rejects an unresolvable core principle ref instead of storing an untraceable contract', () => {
    const result = assemble({ modelContract: { ...BASE, corePrincipleRefs: ['T-01', 'T-99-NOT-A-PRINCIPLE'] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('T-99-NOT-A-PRINCIPLE');
  });

  it('accepts resolvable refs and never copies the diagnosis violatedPrinciples', () => {
    const result = assemble({ modelContract: { ...BASE, corePrincipleRefs: [PRINCIPLE_ID] } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.corePrincipleRefs).toEqual([PRINCIPLE_ID]);
  });

  it('produces an explicit state instead of an incomplete V2 when the basis is missing', () => {
    const noDiagnosis = assemble({ diagnosisAvailable: false, strategicIntentRef: undefined, intentTension: undefined });
    expect(noDiagnosis.ok).toBe(true);
    if (!noDiagnosis.ok) return;
    expect(noDiagnosis.contract.strategicAssessment.relevance).toBe('insufficient_evidence');
    expect(isValidIntentContractV2(noDiagnosis.contract)).toBe(true);

    const notConfigured = assemble({ strategicIntentRef: undefined });
    expect(notConfigured.ok).toBe(true);
    if (!notConfigured.ok) return;
    expect(notConfigured.contract.strategicAssessment.relevance).toBe('not_configured');
    expect(notConfigured.contract.strategicIntent).toBeUndefined();
  });

  it('fails loud on a malformed model conflict element', () => {
    const result = assemble({ modelContract: { ...BASE, strategicAssessment: { conflicts: [{ against: 'owner_intent' }] } } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('conflicts[0]');
  });
});

describe('assembleIntentContractV2 — authored-section trust boundary (P0-1)', () => {
  it('narrows relevantSections to the server-authored set', () => {
    const result = assemble({ authoredSectionKeys: ['why'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.strategicIntent?.relevantSections).toEqual(['why']);
  });

  it('downgrades a fully-evidenced confirmed conflict that cites a non-authored section', () => {
    const linked = {
      against: 'owner_intent' as const,
      ref: 'non_negotiables',
      status: 'confirmed' as const,
      evidenceRefs: ['non_negotiables'],
    };
    const result = assemble({
      authoredSectionKeys: ['why'],
      modelContract: { ...BASE, strategicAssessment: { conflicts: [linked] } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Stage A linked the field, but the server knows the section is a template.
    expect(result.contract.strategicAssessment.conflicts?.[0]?.status).toBe('potential');
    expect(result.overrides.join(' ')).toContain('conflicts[0].status');
  });

  it('degrades to insufficient_evidence when every cited section was rejected', () => {
    const result = assemble({ authoredSectionKeys: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.strategicAssessment.relevance).toBe('insufficient_evidence');
    expect(result.contract.strategicAssessment.conflictStatus).toBe('none');
    expect(result.contract.strategicIntent?.relevantSections ?? []).toEqual([]);
  });
});
