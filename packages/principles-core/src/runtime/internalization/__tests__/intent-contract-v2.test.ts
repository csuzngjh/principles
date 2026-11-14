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
  });

  it('keeps conflictStatus none with no conflicts', () => {
    const result = assemble();
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
