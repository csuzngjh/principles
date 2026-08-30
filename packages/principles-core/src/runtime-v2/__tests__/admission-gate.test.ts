import { describe, it, expect } from 'vitest';
import {
  evaluateAdmission,
  evaluateCandidateAdmissions,
  evaluateCandidateAdmissionFromRecord,
  ADMISSION_CONFIDENCE_THRESHOLD,
} from '../admission-gate.js';
import type { AdmissionGateInput } from '../admission-gate.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';

const makeInput = (overrides: Partial<AdmissionGateInput> = {}): AdmissionGateInput => ({
  recommendationKind: 'principle',
  confidence: 0.8,
  evidenceCount: 2,
  inputEvidenceCount: 2,
  provenance: 'host_context_bound',
  ...overrides,
});

const makeDiagnosticianOutput = (overrides: Partial<DiagnosticianOutputV1> = {}): DiagnosticianOutputV1 => ({
  valid: true,
  diagnosisId: 'diag-001',
  summary: 'Test diagnosis',
  rootCause: 'Test root cause',
  violatedPrinciples: [],
  evidence: [{ sourceRef: 'src-1', note: 'evidence note' }],
  recommendations: [{ kind: 'principle', description: 'Test recommendation' }],
  confidence: 0.8,
  ...overrides,
});

describe('evaluateAdmission', () => {
  it('admits when evidence is sufficient', () => {
    const result = evaluateAdmission(makeInput());
    expect(result.decision).toBe('admitted');
    expect(result.reason).toBe('evidence_sufficient');
    expect(result.nextAction).toBe('none');
  });

  it('defers when recommendationKind is defer', () => {
    const result = evaluateAdmission(makeInput({ recommendationKind: 'defer' }));
    expect(result.decision).toBe('deferred');
    expect(result.reason).toBe('recommendation_kind_defer_not_actionable');
    expect(result.nextAction).toBe('review_defer_disposition_manually');
  });

  it('admits owner_reported_no_host_trace when confidence and evidence sufficient', () => {
    const result = evaluateAdmission(
      makeInput({ provenance: 'owner_reported_no_host_trace', confidence: 0.9, evidenceCount: 5 }),
    );
    expect(result.decision).toBe('admitted');
    expect(result.reason).toBe('evidence_sufficient');
    expect(result.evidenceStatus).toBe('owner_reported_no_host_trace');
  });

  it('gates when confidence is below threshold', () => {
    const result = evaluateAdmission(makeInput({ confidence: 0.35 }));
    expect(result.decision).toBe('needs_evidence');
    expect(result.reason).toContain('confidence_below_threshold');
    expect(result.reason).toContain('0.35');
    expect(result.nextAction).toBe('provide_additional_evidence_or_manual_review');
  });

  it('gates when evidence array is empty', () => {
    const result = evaluateAdmission(makeInput({ evidenceCount: 0 }));
    expect(result.decision).toBe('needs_evidence');
    expect(result.reason).toBe('evidence_array_empty');
    expect(result.nextAction).toBe('provide_source_evidence_for_diagnosis');
  });

  it('admits at exactly the confidence threshold', () => {
    const result = evaluateAdmission(makeInput({ confidence: ADMISSION_CONFIDENCE_THRESHOLD }));
    expect(result.decision).toBe('admitted');
  });

  it('gates just below the confidence threshold', () => {
    const result = evaluateAdmission(makeInput({ confidence: ADMISSION_CONFIDENCE_THRESHOLD - 0.01 }));
    expect(result.decision).toBe('needs_evidence');
  });

  it('gates when provenance is undefined (fail-closed)', () => {
    const result = evaluateAdmission(makeInput({ provenance: undefined, confidence: 0.35 }));
    expect(result.decision).toBe('needs_evidence');
    expect(result.evidenceStatus).toBe('unknown');
  });

  it('defer takes priority over provenance check', () => {
    const result = evaluateAdmission(
      makeInput({ recommendationKind: 'defer', provenance: 'owner_reported_no_host_trace' }),
    );
    expect(result.decision).toBe('deferred');
  });

  it('produces stable string literals for reason and nextAction', () => {
    const gated = evaluateAdmission(makeInput({ provenance: 'owner_reported_no_host_trace' }));
    expect(gated.reason).not.toMatch(/[\u4e00-\u9fff]/);
    expect(gated.nextAction).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe('evaluateCandidateAdmissions', () => {
  it('evaluates each candidate independently', () => {
    const candidates = [
      { candidateId: 'c-1', recommendationKind: 'principle' as const },
      { candidateId: 'c-2', recommendationKind: 'defer' as const },
      { candidateId: 'c-3', recommendationKind: 'rule' as const },
    ];
    const output = makeDiagnosticianOutput({ confidence: 0.8 });
    const results = evaluateCandidateAdmissions(candidates, output, { provenance: 'host_context_bound', inputEvidenceCount: 2 });

    expect(results).toHaveLength(3);
    const admitted = results.find((r) => r.candidateId === 'c-1');
    const deferred = results.find((r) => r.candidateId === 'c-2');
    const ruleAdmitted = results.find((r) => r.candidateId === 'c-3');
    expect(admitted?.admission.decision).toBe('admitted');
    expect(deferred?.admission.decision).toBe('deferred');
    expect(ruleAdmitted?.admission.decision).toBe('admitted');
  });

  it('admits owner_reported candidates when confidence and evidence sufficient', () => {
    const candidates = [
      { candidateId: 'c-1', recommendationKind: 'principle' as const },
      { candidateId: 'c-2', recommendationKind: 'rule' as const },
    ];
    const output = makeDiagnosticianOutput({ confidence: 0.8 });
    const results = evaluateCandidateAdmissions(candidates, output, { provenance: 'owner_reported_no_host_trace', inputEvidenceCount: 1 });

    const first = results.find((r) => r.candidateId === 'c-1');
    const second = results.find((r) => r.candidateId === 'c-2');
    expect(first?.admission.decision).toBe('admitted');
    expect(second?.admission.decision).toBe('admitted');
  });

  it('reproduces the live sample: confidence 0.35 + owner_reported_no_host_trace', () => {
    const candidates = [
      { candidateId: 'c-1', recommendationKind: 'principle' as const },
      { candidateId: 'c-2', recommendationKind: 'rule' as const },
      { candidateId: 'c-3', recommendationKind: 'implementation' as const },
      { candidateId: 'c-4', recommendationKind: 'prompt' as const },
      { candidateId: 'c-5', recommendationKind: 'defer' as const },
    ];
    const output = makeDiagnosticianOutput({
      confidence: 0.35,
      evidence: [],
    });
    const results = evaluateCandidateAdmissions(candidates, output, { provenance: 'owner_reported_no_host_trace', inputEvidenceCount: 1 });

    const actionable = results.filter((r) => r.admission.decision === 'admitted');
    const deferred = results.filter((r) => r.admission.decision === 'deferred');
    const gated = results.filter((r) => r.admission.decision === 'needs_evidence');

    expect(actionable).toHaveLength(0);
    expect(deferred).toHaveLength(1);
    expect(gated).toHaveLength(4);
  });

  // ── Additional edge cases for provenance handling ──────────────────────────────

  it('gates owner_reported_no_host_trace when confidence below threshold regardless of evidence', () => {
    // Regression test: owner_reported should use normal confidence+evidence checks
    const result = evaluateAdmission(
      makeInput({ provenance: 'owner_reported_no_host_trace', confidence: 0.4, evidenceCount: 10 }),
    );
    expect(result.decision).toBe('needs_evidence');
    expect(result.reason).toContain('confidence_below_threshold');
  });

  it('gates owner_reported_no_host_trace when evidence count is zero', () => {
    // Regression test: evidence array empty should gate even for owner_reported
    const result = evaluateAdmission(
      makeInput({ provenance: 'owner_reported_no_host_trace', confidence: 0.9, evidenceCount: 0 }),
    );
    expect(result.decision).toBe('needs_evidence');
    expect(result.reason).toBe('evidence_array_empty');
  });

  it('admits automatic_hook provenance when confidence and evidence sufficient', () => {
    const result = evaluateAdmission(
      makeInput({ provenance: 'automatic_hook', confidence: 0.8, evidenceCount: 3 }),
    );
    expect(result.decision).toBe('admitted');
    expect(result.evidenceStatus).toBe('automatic_hook');
  });

  it('gates automatic_hook provenance when confidence below threshold', () => {
    const result = evaluateAdmission(
      makeInput({ provenance: 'automatic_hook', confidence: 0.4, evidenceCount: 5 }),
    );
    expect(result.decision).toBe('needs_evidence');
    expect(result.evidenceStatus).toBe('automatic_hook');
  });

  it('admits at confidence boundary exactly 0.50', () => {
    // Boundary test: exactly at threshold should admit
    const result = evaluateAdmission(
      makeInput({ confidence: 0.50, evidenceCount: 1 }),
    );
    expect(result.decision).toBe('admitted');
  });

  it('gates at confidence boundary 0.49', () => {
    // Boundary test: just below threshold should gate
    const result = evaluateAdmission(
      makeInput({ confidence: 0.49, evidenceCount: 1 }),
    );
    expect(result.decision).toBe('needs_evidence');
  });

  it('admits at confidence boundary 0.51', () => {
    // Boundary test: just above threshold should admit
    const result = evaluateAdmission(
      makeInput({ confidence: 0.51, evidenceCount: 1 }),
    );
    expect(result.decision).toBe('admitted');
  });

  it('defer priority over low confidence + owner_reported', () => {
    // Priority test: defer should win even when owner_reported + low confidence
    const result = evaluateAdmission(
      makeInput({ recommendationKind: 'defer', provenance: 'owner_reported_no_host_trace', confidence: 0.2 }),
    );
    expect(result.decision).toBe('deferred');
    expect(result.reason).toBe('recommendation_kind_defer_not_actionable');
  });

  it('defer priority over empty evidence', () => {
    // Priority test: defer should win even when evidence is empty
    const result = evaluateAdmission(
      makeInput({ recommendationKind: 'defer', evidenceCount: 0 }),
    );
    expect(result.decision).toBe('deferred');
  });
});

// ── PRI-345: input-evidence hard gate + owner manual exemption ────────────────

describe('PRI-345: input-evidence hard gate', () => {
  // 用例 A（核心）: inputEvidenceCount=0, model fabricates evidence → gated
  it('gates when inputEvidenceCount=0 even if model fabricates high confidence + output evidence', () => {
    const candidates = [
      { candidateId: 'c-fab', recommendationKind: 'principle' as const },
    ];
    const output = makeDiagnosticianOutput({
      confidence: 0.85,
      evidence: [
        { sourceRef: 'fabricated-1', note: 'model made this up' },
        { sourceRef: 'fabricated-2', note: 'also fabricated' },
        { sourceRef: 'fabricated-3', note: 'not real evidence' },
      ],
    });
    const results = evaluateCandidateAdmissions(candidates, output, { provenance: 'host_context_bound', inputEvidenceCount: 0 });

    expect(results).toHaveLength(1);
    expect(results[0]?.admission.decision).toBe('needs_evidence');
    expect(results[0]?.admission.reason).toBe('input_evidence_empty');
    expect(results[0]?.admission.nextAction).toBe('collect_evidence_before_diagnosis');
  });

  // 用例 B（回归保护）: inputEvidenceCount=2, normal → admitted
  it('admits when inputEvidenceCount=2 with sufficient confidence and output evidence', () => {
    const result = evaluateAdmission(
      makeInput({ inputEvidenceCount: 2, confidence: 0.7, evidenceCount: 2 }),
    );
    expect(result.decision).toBe('admitted');
    expect(result.reason).toBe('evidence_sufficient');
  });

  // 用例 C（owner 手动豁免 — 非 owner provenance 被拦）
  it('gates openclaw_context_bound when inputEvidenceCount=0', () => {
    const result = evaluateAdmission(
      makeInput({ inputEvidenceCount: 0, provenance: 'host_context_bound', confidence: 0.9, evidenceCount: 3 }),
    );
    expect(result.decision).toBe('needs_evidence');
    expect(result.reason).toBe('input_evidence_empty');
  });

  // 用例 C（owner 手动豁免 — owner_reported_no_host_trace 不被误杀）
  it('does NOT gate owner_reported_no_host_trace when inputEvidenceCount=0 (PRI-311 regression guard)', () => {
    const result = evaluateAdmission(
      makeInput({ inputEvidenceCount: 0, provenance: 'owner_reported_no_host_trace', confidence: 0.9, evidenceCount: 3 }),
    );
    expect(result.decision).toBe('admitted');
    expect(result.reason).toBe('evidence_sufficient');
  });

  // Defer still takes priority over input evidence gate
  it('defer priority over input_evidence_empty', () => {
    const result = evaluateAdmission(
      makeInput({ recommendationKind: 'defer', inputEvidenceCount: 0, provenance: 'host_context_bound' }),
    );
    expect(result.decision).toBe('deferred');
    expect(result.reason).toBe('recommendation_kind_defer_not_actionable');
  });

  // inputEvidenceCount=0 gates automatic_hook too
  it('gates automatic_hook when inputEvidenceCount=0', () => {
    const result = evaluateAdmission(
      makeInput({ inputEvidenceCount: 0, provenance: 'automatic_hook', confidence: 0.9, evidenceCount: 5 }),
    );
    expect(result.decision).toBe('needs_evidence');
    expect(result.reason).toBe('input_evidence_empty');
  });
});

describe('evaluateCandidateAdmissionFromRecord (CLI partial check)', () => {
  it('admits when recommendationKind is actionable and confidence >= threshold', () => {
    const result = evaluateCandidateAdmissionFromRecord({
      recommendationKind: 'principle',
      confidence: 0.8,
    });
    expect(result.decision).toBe('admitted');
    expect(result.reason).toBe('cli_partial_check_passed_confidence_and_kind');
    expect(result.nextAction).toBe('none');
  });

  it('admits at exactly the threshold (boundary)', () => {
    const result = evaluateCandidateAdmissionFromRecord({
      recommendationKind: 'principle',
      confidence: ADMISSION_CONFIDENCE_THRESHOLD,
    });
    expect(result.decision).toBe('admitted');
  });

  it('defers when recommendationKind is defer', () => {
    const result = evaluateCandidateAdmissionFromRecord({
      recommendationKind: 'defer',
      confidence: 0.9,
    });
    expect(result.decision).toBe('deferred');
    expect(result.reason).toBe('recommendation_kind_defer_not_actionable');
    expect(result.nextAction).toBe('review_defer_disposition_manually');
  });

  it('needs_evidence when confidence is below threshold', () => {
    const result = evaluateCandidateAdmissionFromRecord({
      recommendationKind: 'principle',
      confidence: 0.35,
    });
    expect(result.decision).toBe('needs_evidence');
    expect(result.reason).toContain('confidence_below_threshold');
    expect(result.reason).toContain('0.35');
    expect(result.nextAction).toBe('provide_additional_evidence_or_manual_review');
  });

  it('needs_evidence when confidence is null (rc-3 fail loud)', () => {
    const result = evaluateCandidateAdmissionFromRecord({
      recommendationKind: 'principle',
      confidence: null,
    });
    expect(result.decision).toBe('needs_evidence');
    expect(result.reason).toBe('confidence_missing_on_candidate_record');
    expect(result.nextAction).toContain('re_run_diagnosis');
  });

  it('defers even when confidence is null (defer takes precedence)', () => {
    const result = evaluateCandidateAdmissionFromRecord({
      recommendationKind: 'defer',
      confidence: null,
    });
    expect(result.decision).toBe('deferred');
    expect(result.reason).toBe('recommendation_kind_defer_not_actionable');
  });

  it('needs_evidence at confidence = 0 (below threshold)', () => {
    const result = evaluateCandidateAdmissionFromRecord({
      recommendationKind: 'principle',
      confidence: 0,
    });
    expect(result.decision).toBe('needs_evidence');
    expect(result.reason).toContain('confidence_below_threshold');
  });
});
