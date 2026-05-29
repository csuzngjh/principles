import { describe, it, expect } from 'vitest';
import {
  evaluateAdmission,
  evaluateCandidateAdmissions,
  ADMISSION_CONFIDENCE_THRESHOLD,
} from '../admission-gate.js';
import type { AdmissionGateInput } from '../admission-gate.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';

const makeInput = (overrides: Partial<AdmissionGateInput> = {}): AdmissionGateInput => ({
  recommendationKind: 'principle',
  confidence: 0.8,
  evidenceCount: 2,
  provenance: 'openclaw_context_bound',
  ...overrides,
});

const makeDiagnosticianOutput = (overrides: Partial<DiagnosticianOutputV1> = {}): DiagnosticianOutputV1 => ({
  valid: true,
  diagnosisId: 'diag-001',
  taskId: 'task-001',
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

  it('gates when provenance is owner_reported_no_host_trace', () => {
    const result = evaluateAdmission(
      makeInput({ provenance: 'owner_reported_no_host_trace', confidence: 0.9, evidenceCount: 5 }),
    );
    expect(result.decision).toBe('needs_evidence');
    expect(result.reason).toBe('provenance_owner_reported_no_host_trace');
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
    const results = evaluateCandidateAdmissions(candidates, output, 'openclaw_context_bound');

    expect(results).toHaveLength(3);
    const admitted = results.find((r) => r.candidateId === 'c-1');
    const deferred = results.find((r) => r.candidateId === 'c-2');
    const ruleAdmitted = results.find((r) => r.candidateId === 'c-3');
    expect(admitted?.admission.decision).toBe('admitted');
    expect(deferred?.admission.decision).toBe('deferred');
    expect(ruleAdmitted?.admission.decision).toBe('admitted');
  });

  it('gates all candidates when provenance is owner_reported_no_host_trace', () => {
    const candidates = [
      { candidateId: 'c-1', recommendationKind: 'principle' as const },
      { candidateId: 'c-2', recommendationKind: 'rule' as const },
    ];
    const output = makeDiagnosticianOutput({ confidence: 0.8 });
    const results = evaluateCandidateAdmissions(candidates, output, 'owner_reported_no_host_trace');

    const first = results.find((r) => r.candidateId === 'c-1');
    const second = results.find((r) => r.candidateId === 'c-2');
    expect(first?.admission.decision).toBe('needs_evidence');
    expect(second?.admission.decision).toBe('needs_evidence');
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
    const results = evaluateCandidateAdmissions(candidates, output, 'owner_reported_no_host_trace');

    const actionable = results.filter((r) => r.admission.decision === 'admitted');
    const deferred = results.filter((r) => r.admission.decision === 'deferred');
    const gated = results.filter((r) => r.admission.decision === 'needs_evidence');

    expect(actionable).toHaveLength(0);
    expect(deferred).toHaveLength(1);
    expect(gated).toHaveLength(4);
  });
});
