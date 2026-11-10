/**
 * Read-only source-declared-relation resolution tests (PRI-1146 / SPEC v0.6 §6).
 *
 * Matrix E of the PRI-1146 acceptance plan, focused on the envelope-driven
 * resolver `resolveSourceDeclaredRelations`:
 *  - rule → same-artifact principle candidate → canonical identity (proposed,
 *    basis source_declared_relation, authorizesGeneration:false);
 *  - rule → canonical principle exposed this run (eligibility via ledger port);
 *  - tampered persisted recommendation → source_relation_stale;
 *  - duplicate candidate rows / foreign artifact rows → candidate_material_invalid;
 *  - target principle candidate without identity → related_candidate_unresolved;
 *  - identity source throws → identity_source_unavailable;
 *  - unavailable receipt context → context_invalid;
 *  - governance invariants: every result is mode 'shadow', never an owner
 *    receipt; semanticCorrectness stays 'not_evaluated'.
 */
import { describe, it, expect } from 'vitest';
import { resolveSourceDeclaredRelations, type SourceRelationCandidateRow } from '../diagnostician-association-shadow.js';
import { computeTrustedPrincipleDigest } from '../internalization/router-context-evidence.js';
import type { DiagnosticianOutputV2, DiagnosticianRecommendationV2 } from '../diagnostician-output.js';

const PRINCIPLE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = 'diag_router-001';
const RUN_ID = 'run-router-001';
const ARTIFACT_ID = 'art-001';
const EVIDENCE_REF = 'trace:1';

const principleRec: DiagnosticianRecommendationV2 = {
  kind: 'principle',
  description: 'Principle',
  recommendationRef: 'principle-1',
  abstractedPrinciple: 'Limit blast radius',
};

const ruleRec: DiagnosticianRecommendationV2 = {
  kind: 'rule',
  description: 'Rule',
  recommendationRef: 'rule-1',
  triggerPattern: 'deploy',
  action: 'run checks',
  principleAssociation: {
    status: 'linked',
    relation: 'implements',
    target: { type: 'recommendation_ref', recommendationRef: 'principle-1' },
    rationale: 'operationalizes the principle',
    evidenceRefs: [EVIDENCE_REF],
  },
};

function makeOutput(recommendations: DiagnosticianRecommendationV2[] = [principleRec, ruleRec]): DiagnosticianOutputV2 {
  return {
    schemaVersion: 'diagnostician-output-v2',
    valid: true,
    diagnosisId: 'd',
    summary: 's',
    rootCause: 'Design: r',
    violatedPrinciples: [{ principleId: PRINCIPLE_ID, rationale: 'r' }],
    evidence: [{ sourceRef: EVIDENCE_REF, note: 'n' }],
    recommendations,
    confidence: 0.9,
  };
}

function makeEnvelope(output: DiagnosticianOutputV2, canonicalPrinciples: unknown = {
  status: 'available',
  principles: [{
    principleId: PRINCIPLE_ID,
    status: 'active',
    version: 1,
    text: 'Limit blast radius',
    contentDigest: computeTrustedPrincipleDigest({ principleId: PRINCIPLE_ID, status: 'active', version: 1, text: 'Limit blast radius' }),
  }],
}): Record<string, unknown> {
  return {
    ...output,
    trustedContextReceipt: {
      schemaVersion: 'router-context-v2',
      taskId: TASK_ID,
      runId: RUN_ID,
      outputSchemaRef: 'diagnostician-output',
      contextHash: 'hash',
      messageDigest: 'a'.repeat(64),
      systemPromptDigest: 'b'.repeat(64),
      predecessorDigests: [
        { artifactId: 'pi-art-rc-001', contentDigest: 'c'.repeat(64) },
        { artifactId: 'pi-art-dist-001', contentDigest: 'd'.repeat(64) },
      ],
      evidenceRefs: [EVIDENCE_REF],
      canonicalPrinciples,
    },
    associationValidation: { ok: true },
  };
}

function makeRows(recs: DiagnosticianRecommendationV2[], kinds: string[]): SourceRelationCandidateRow[] {
  return recs.map((sourceRecommendation, i) => ({
    candidateId: `candidate-${i}`,
    artifactId: ARTIFACT_ID,
    recommendationKind: kinds[i] ?? sourceRecommendation.kind,
    sourceRecommendation,
  }));
}

const resolvePrincipleCandidateResolved = (candidateId: string) => ({
  status: 'resolved' as const,
  candidateId,
  principleId: PRINCIPLE_ID,
});

function resolve(input: {
  envelope?: unknown;
  runOutput?: unknown;
  runLineage?: { taskId: string; runId: string };
  candidates?: readonly SourceRelationCandidateRow[];
  resolvePrincipleCandidate?: (id: string) => unknown;
  resolveCanonicalEligibility?: (id: string) => { eligible: true } | { eligible: false; reason: 'missing' | 'ineligible' | 'ledger_unavailable' | 'ledger_corrupt' };
}) {
  return resolveSourceDeclaredRelations({
    envelope: input.envelope ?? makeEnvelope(makeOutput()),
    runOutput: 'runOutput' in input ? input.runOutput : makeOutput(),
    // P2-02: the resolver now requires the persisted run lineage it loaded the
    // output from, and verifies the artifact + run output are the same source.
    runLineage: input.runLineage ?? { taskId: TASK_ID, runId: RUN_ID },
    candidates: input.candidates ?? makeRows([principleRec, ruleRec], ['principle', 'rule']),
    taskId: TASK_ID,
    runId: RUN_ID,
    artifactId: ARTIFACT_ID,
    resolvePrincipleCandidate: input.resolvePrincipleCandidate ?? resolvePrincipleCandidateResolved,
    resolveCanonicalEligibility: input.resolveCanonicalEligibility ?? (() => ({ eligible: true })),
  });
}

describe('resolveSourceDeclaredRelations (read-only shadow, SPEC v0.6 §6)', () => {
  it('proposes a canonical identity for rule → same-artifact principle candidate', () => {
    const result = resolve({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolutions).toHaveLength(1);
    expect(result.resolutions[0]).toMatchObject({
      mode: 'shadow',
      candidateId: 'candidate-1',
      recommendationRef: 'rule-1',
      status: 'proposed',
      basis: 'source_declared_relation',
      principleId: PRINCIPLE_ID,
      targetCandidateId: 'candidate-0',
      semanticCorrectness: 'not_evaluated',
      authorizesGeneration: false,
    });
  });

  it('proposes a canonical identity for rule → canonical principle exposed this run', () => {
    const canonicalRule: DiagnosticianRecommendationV2 = {
      ...ruleRec,
      principleAssociation: {
        status: 'linked',
        relation: 'implements',
        target: { type: 'canonical_principle', principleId: PRINCIPLE_ID },
        rationale: 'implements the ledger principle',
        evidenceRefs: [EVIDENCE_REF],
      },
    };
    const result = resolve({
      envelope: makeEnvelope(makeOutput([principleRec, canonicalRule])),
      runOutput: makeOutput([principleRec, canonicalRule]),
      candidates: makeRows([principleRec, canonicalRule], ['principle', 'rule']),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolutions[0]).toMatchObject({
      status: 'proposed',
      basis: 'source_declared_relation',
      principleId: PRINCIPLE_ID,
      semanticCorrectness: 'not_evaluated',
      authorizesGeneration: false,
    });
  });

  it('unresolved: canonical target missing from the ledger', () => {
    const canonicalRule: DiagnosticianRecommendationV2 = {
      ...ruleRec,
      principleAssociation: {
        status: 'linked',
        relation: 'implements',
        target: { type: 'canonical_principle', principleId: PRINCIPLE_ID },
        rationale: 'x',
        evidenceRefs: [EVIDENCE_REF],
      },
    };
    const result = resolve({
      envelope: makeEnvelope(makeOutput([principleRec, canonicalRule])),
      runOutput: makeOutput([principleRec, canonicalRule]),
      candidates: makeRows([principleRec, canonicalRule], ['principle', 'rule']),
      resolveCanonicalEligibility: () => ({ eligible: false, reason: 'missing' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolutions[0]).toMatchObject({ status: 'unresolved', reason: 'target_missing', authorizesGeneration: false });
  });

  it('unresolved: canonical target eligibility unprovable propagates ledger_unavailable (not target_missing)', () => {
    const canonicalRule: DiagnosticianRecommendationV2 = {
      ...ruleRec,
      principleAssociation: {
        status: 'linked', relation: 'implements',
        target: { type: 'canonical_principle', principleId: PRINCIPLE_ID },
        rationale: 'x', evidenceRefs: [EVIDENCE_REF],
      },
    };
    const result = resolve({
      envelope: makeEnvelope(makeOutput([principleRec, canonicalRule])),
      runOutput: makeOutput([principleRec, canonicalRule]),
      candidates: makeRows([principleRec, canonicalRule], ['principle', 'rule']),
      resolveCanonicalEligibility: () => ({ eligible: false, reason: 'ledger_unavailable' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolutions[0]).toMatchObject({ status: 'unresolved', reason: 'ledger_unavailable', authorizesGeneration: false });
  });

  it('unresolved: canonical target eligibility unprovable propagates ledger_corrupt (not target_ineligible)', () => {
    const canonicalRule: DiagnosticianRecommendationV2 = {
      ...ruleRec,
      principleAssociation: {
        status: 'linked', relation: 'implements',
        target: { type: 'canonical_principle', principleId: PRINCIPLE_ID },
        rationale: 'x', evidenceRefs: [EVIDENCE_REF],
      },
    };
    const result = resolve({
      envelope: makeEnvelope(makeOutput([principleRec, canonicalRule])),
      runOutput: makeOutput([principleRec, canonicalRule]),
      candidates: makeRows([principleRec, canonicalRule], ['principle', 'rule']),
      resolveCanonicalEligibility: () => ({ eligible: false, reason: 'ledger_corrupt' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolutions[0]).toMatchObject({ status: 'unresolved', reason: 'ledger_corrupt', authorizesGeneration: false });
  });

  it('unresolved: persisted recommendation no longer matches the artifact (stale)', () => {
    const tampered = makeRows(
      [principleRec, { ...ruleRec, description: 'tampered' }],
      ['principle', 'rule'],
    );
    const result = resolve({ candidates: tampered });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolutions[0]).toMatchObject({ status: 'unresolved', reason: 'source_relation_stale' });
  });

  it('rejects duplicate candidate rows for one recommendationRef (never first-match)', () => {
    const rows = [...makeRows([principleRec, ruleRec], ['principle', 'rule']), {
      candidateId: 'candidate-dup',
      artifactId: ARTIFACT_ID,
      recommendationKind: 'rule',
      sourceRecommendation: ruleRec,
    }];
    const result = resolve({ candidates: rows });
    expect(result).toMatchObject({ ok: false, reason: 'candidate_material_invalid' });
  });

  it('unresolved: target principle candidate has no canonical identity yet', () => {
    const result = resolve({
      resolvePrincipleCandidate: () => ({ status: 'unresolved', reason: 'missing', nextAction: 'await reuse/create decision' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolutions[0]).toMatchObject({ status: 'unresolved', reason: 'missing' });
  });

  it('unresolved: identity source throws (ledger unavailable, fail loud)', () => {
    const result = resolve({ resolvePrincipleCandidate: () => { throw new Error('unreadable'); } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolutions[0]).toMatchObject({ status: 'unresolved', reason: 'identity_source_unavailable' });
  });

  it('unresolved: rule declared unresolved by the model stays unresolved with its reason', () => {
    const unresolvedRule: DiagnosticianRecommendationV2 = {
      ...ruleRec,
      principleAssociation: { status: 'unresolved', reason: 'principle_not_in_context' },
    };
    const result = resolve({
      envelope: makeEnvelope(makeOutput([unresolvedRule])),
      runOutput: makeOutput([unresolvedRule]),
      candidates: makeRows([unresolvedRule], ['rule']),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolutions[0]).toMatchObject({ status: 'unresolved', reason: 'principle_not_in_context' });
  });

  it('refuses when the receipt lineage does not match', () => {
    const foreignEnvelope = makeEnvelope(makeOutput());
    (foreignEnvelope.trustedContextReceipt as Record<string, unknown>).taskId = 'foreign';
    const result = resolve({ envelope: foreignEnvelope });
    expect(result).toMatchObject({ ok: false, reason: 'context_receipt_lineage_mismatch' });
  });

  it('refuses when the receipt records an unavailable context (exposure not provable)', () => {
    const envelope = makeEnvelope(makeOutput(), { status: 'unavailable', reason: 'ledger_unavailable', nextAction: 'repair' });
    const result = resolve({ envelope });
    expect(result).toMatchObject({ ok: false, reason: 'context_invalid' });
  });

  it('refuses a V1-shaped artifact envelope (Clean Break)', () => {
    // The envelope owns the trusted-context proof; a V1 payload (no
    // schemaVersion) has no receipt and no V2 output — refused outright.
    const v1Output = { ...makeOutput() } as Record<string, unknown>;
    delete v1Output.schemaVersion;
    expect(resolve({ envelope: v1Output, runOutput: v1Output })).toMatchObject({ ok: false, reason: 'context_receipt_missing' });
    // A V1 run payload cannot rescue a receipt-less V1 envelope either.
    expect(resolve({ envelope: v1Output, runOutput: makeOutput() })).toMatchObject({ ok: false, reason: 'context_receipt_missing' });
  });

  it('governance: no result ever authorizes generation or claims semantic correctness', () => {
    const result = resolve({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const resolution of result.resolutions) {
      expect(resolution.mode).toBe('shadow');
      expect(resolution.authorizesGeneration).toBe(false);
      if (resolution.status === 'proposed') {
        expect(resolution.semanticCorrectness).toBe('not_evaluated');
        expect(resolution.basis).toBe('source_declared_relation');
      }
    }
  });

  // ── PRI-1146 P2-02: dual-source (artifact + run output) consistency ───────

  it('A. accepts when artifact and run output are identical V2 (positive control)', () => {
    const output = makeOutput();
    const result = resolve({ envelope: makeEnvelope(output), runOutput: structuredClone(output) });
    expect(result.ok).toBe(true);
  });

  it('B. rejects when the run output is V1 while the artifact is V2', () => {
    const v1RunOutput = { ...makeOutput() } as Record<string, unknown>;
    delete v1RunOutput.schemaVersion;
    expect(resolve({ runOutput: v1RunOutput })).toMatchObject({ ok: false, reason: 'run_output_invalid' });
  });

  it('C. rejects two legal-but-different V2 outputs', () => {
    const otherOutput = makeOutput([
      principleRec,
      { ...ruleRec, recommendationRef: 'rule-other' },
    ] as DiagnosticianRecommendationV2[]);
    expect(resolve({ runOutput: otherOutput })).toMatchObject({ ok: false, reason: 'run_output_recommendation_ref_mismatch' });
    // Same refs, different content is still not the same source.
    const driftedOutput = { ...makeOutput(), confidence: 0.5 };
    expect(resolve({ runOutput: driftedOutput })).toMatchObject({ ok: false, reason: 'run_output_content_mismatch' });
  });

  it('D. rejects when the run output is missing', () => {
    expect(resolve({ runOutput: undefined })).toMatchObject({ ok: false, reason: 'run_output_invalid' });
    expect(resolve({ runOutput: null })).toMatchObject({ ok: false, reason: 'run_output_invalid' });
  });

  it('E. rejects when the artifact envelope is missing or corrupted', () => {
    expect(resolve({ envelope: {} })).toMatchObject({ ok: false, reason: 'context_receipt_missing' });
    const corrupted = makeEnvelope(makeOutput());
    delete (corrupted).schemaVersion;
    expect(resolve({ envelope: corrupted })).toMatchObject({ ok: false, reason: 'artifact_output_invalid' });
  });

  it('F. rejects when recommendationRefs differ (explicit set check)', () => {
    const sameLengthDifferentRefs = makeOutput([
      principleRec,
      { ...ruleRec, recommendationRef: 'rule-renamed' },
    ] as DiagnosticianRecommendationV2[]);
    expect(resolve({ runOutput: sameLengthDifferentRefs })).toMatchObject({ ok: false, reason: 'run_output_recommendation_ref_mismatch' });
  });

  it('G. rejects when the run lineage does not match the artifact receipt', () => {
    expect(resolve({ runLineage: { taskId: TASK_ID, runId: 'foreign-run' } })).toMatchObject({ ok: false, reason: 'run_lineage_mismatch' });
    expect(resolve({ runLineage: { taskId: 'foreign-task', runId: RUN_ID } })).toMatchObject({ ok: false, reason: 'run_lineage_mismatch' });
  });

  it('all negative cases are side-effect free: no resolutions, no binding, no generation', () => {
    const negativeInputs = [
      { runOutput: null },
      { runOutput: makeOutput([principleRec, { ...ruleRec, recommendationRef: 'rule-other' }] as DiagnosticianRecommendationV2[]) },
      { runLineage: { taskId: 'foreign', runId: RUN_ID } },
    ];
    for (const input of negativeInputs) {
      const result = resolve(input);
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('resolutions');
      expect(result).not.toHaveProperty('authorizesGeneration');
    }
  });
});
