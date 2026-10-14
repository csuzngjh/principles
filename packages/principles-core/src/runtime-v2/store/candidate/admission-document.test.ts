/**
 * SPEC-CODEX-PAIN-CLOSURE-001: the admission-document codec is the single
 * parse/serialize/append authority shared by BOTH candidate stores. Its
 * failure branches are what make a corrupt or hostile `admission_json` column
 * surface as a refusal instead of a crash — and none of them were covered.
 *
 * Every rejection reason asserted here is a real, reachable state: a truncated
 * or hand-edited column, a row written by a newer schema, an oversized blob,
 * and a hostile evaluation entry.
 */
import { describe, it, expect } from 'vitest';
import {
  ADMISSION_POLICY_VERSION,
  CANDIDATE_ADMISSION_SCHEMA_VERSION,
  MAX_ADMISSION_EVALUATIONS,
  MAX_ADMISSION_JSON_CHARS,
  appendAdmissionEvaluation,
  currentEvaluation,
  fingerprintMaterial,
  fingerprintStatement,
  parseAdmissionDocument,
  serializeAdmissionDocument,
  withProcessing,
  type AdmissionEvaluationRecord,
  type CandidateAdmissionDocument,
} from './admission-document.js';

const NOW = '2026-10-14T12:00:00.000Z';

function evaluation(overrides: Partial<AdmissionEvaluationRecord> = {}): AdmissionEvaluationRecord {
  return {
    evaluationId: 'eval-1',
    decision: 'admitted',
    reason: 'evidence_sufficient',
    nextAction: 'none',
    evaluatedAt: NOW,
    policyVersion: ADMISSION_POLICY_VERSION,
    provenance: 'owner_reported_no_host_trace',
    inputEvidenceCount: 1,
    ownerStatementPresent: false,
    recommendationKind: 'principle',
    confidence: 0.9,
    materialFingerprint: 'fp-1',
    materialSummary: { inputEvidenceCount: 1, outputEvidenceCount: 1, ownerStatementPresent: false },
    ...overrides,
  };
}

function validDocumentJson(): string {
  return JSON.stringify({
    schemaVersion: CANDIDATE_ADMISSION_SCHEMA_VERSION,
    evaluations: [evaluation()],
    currentEvaluationId: 'eval-1',
  });
}

describe('parseAdmissionDocument', () => {
  it('treats null / undefined / empty / non-string as "no document", not corruption', () => {
    expect(parseAdmissionDocument(null)).toEqual({ ok: true, document: null });
    expect(parseAdmissionDocument(undefined)).toEqual({ ok: true, document: null });
    expect(parseAdmissionDocument('')).toEqual({ ok: true, document: null });
    // Non-strings that are neither null nor undefined are NOT documents either.
    expect(parseAdmissionDocument(42)).toEqual({ ok: true, document: null });
    expect(parseAdmissionDocument({})).toEqual({ ok: true, document: null });
    expect(parseAdmissionDocument({ schemaVersion: 1 })).toEqual({ ok: true, document: null });
  });

  it('rejects unparseable JSON', () => {
    const result = parseAdmissionDocument('{');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('admission_json_unparseable');
  });

  it('rejects a JSON value that is not an object (including arrays)', () => {
    for (const raw of ['"just-a-string"', '[]', 'null', '3']) {
      const result = parseAdmissionDocument(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('admission_json_not_an_object');
    }
  });

  it('rejects an unsupported schema version, naming the version it saw', () => {
    const result = parseAdmissionDocument(JSON.stringify({ schemaVersion: 99, evaluations: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('admission_json_unsupported_schema_version:99');
  });

  it('rejects a non-array evaluations field and an over-long history', () => {
    const notArray = parseAdmissionDocument(JSON.stringify({ schemaVersion: 1, evaluations: {} }));
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) expect(notArray.reason).toBe('admission_json_evaluations_invalid');

    const tooMany = parseAdmissionDocument(JSON.stringify({
      schemaVersion: 1,
      evaluations: Array.from({ length: MAX_ADMISSION_EVALUATIONS + 1 }, () => evaluation()),
    }));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.reason).toBe('admission_json_evaluations_invalid');
  });

  it('rejects a malformed evaluation entry (non-object, then missing fields)', () => {
    const nonObject = parseAdmissionDocument(JSON.stringify({ schemaVersion: 1, evaluations: [null] }));
    expect(nonObject.ok).toBe(false);
    if (!nonObject.ok) expect(nonObject.reason).toBe('admission_json_evaluation_invalid');

    const missingField = parseAdmissionDocument(JSON.stringify({
      schemaVersion: 1,
      evaluations: [{ evaluationId: 'e', decision: 'admitted' }],
    }));
    expect(missingField.ok).toBe(false);
    if (!missingField.ok) expect(missingField.reason).toBe('admission_json_evaluation_invalid');

    const badDecision = parseAdmissionDocument(JSON.stringify({
      schemaVersion: 1,
      evaluations: [{ ...evaluation(), decision: 'maybe' }],
    }));
    expect(badDecision.ok).toBe(false);
    if (!badDecision.ok) expect(badDecision.reason).toBe('admission_json_evaluation_invalid');
  });

  it('rejects an invalid currentEvaluationId and an invalid processing block', () => {
    const badCurrent = parseAdmissionDocument(JSON.stringify({
      schemaVersion: 1, evaluations: [evaluation()], currentEvaluationId: 7,
    }));
    expect(badCurrent.ok).toBe(false);
    if (!badCurrent.ok) expect(badCurrent.reason).toBe('admission_json_current_evaluation_id_invalid');

    // A missing pointer is corruption too: the serializer always writes the key.
    const missingCurrent = parseAdmissionDocument(JSON.stringify({
      schemaVersion: 1, evaluations: [evaluation()],
    }));
    expect(missingCurrent.ok).toBe(false);
    if (!missingCurrent.ok) expect(missingCurrent.reason).toBe('admission_json_current_evaluation_id_invalid');

    const badProcessing = parseAdmissionDocument(JSON.stringify({
      schemaVersion: 1, evaluations: [evaluation()], currentEvaluationId: null, processing: { attempts: 1 },
    }));
    expect(badProcessing.ok).toBe(false);
    if (!badProcessing.ok) expect(badProcessing.reason).toBe('admission_json_processing_invalid');
  });

  it('round-trips a valid document, defaulting currentEvaluationId to null', () => {
    const result = parseAdmissionDocument(validDocumentJson());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document?.currentEvaluationId).toBe('eval-1');
      expect(result.document?.evaluations).toHaveLength(1);
    }

    const noCurrent = parseAdmissionDocument(JSON.stringify({ schemaVersion: 1, evaluations: [], currentEvaluationId: null }));
    expect(noCurrent.ok).toBe(true);
    if (noCurrent.ok) expect(noCurrent.document?.currentEvaluationId).toBeNull();
  });
});

describe('serializeAdmissionDocument', () => {
  it('serializes a normal document', () => {
    const result = serializeAdmissionDocument({
      schemaVersion: CANDIDATE_ADMISSION_SCHEMA_VERSION,
      evaluations: [evaluation()],
      currentEvaluationId: 'eval-1',
    } as CandidateAdmissionDocument);
    expect(result.ok).toBe(true);
  });

  it('refuses an oversized document rather than writing an unbounded column', () => {
    const huge = evaluation({ reason: 'x'.repeat(MAX_ADMISSION_JSON_CHARS + 1000) });
    const result = serializeAdmissionDocument({
      schemaVersion: CANDIDATE_ADMISSION_SCHEMA_VERSION,
      evaluations: [huge],
      currentEvaluationId: 'eval-1',
    } as CandidateAdmissionDocument);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('admission_json_size_exceeded');
  });
});

describe('fingerprints', () => {
  it('fingerprintStatement is a stable sha256 of the statement text', () => {
    const a = fingerprintStatement('owner said X');
    expect(a).toBe(fingerprintStatement('owner said X'));
    expect(a).not.toBe(fingerprintStatement('owner said Y'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fingerprintMaterial is order-sensitive', () => {
    expect(fingerprintMaterial(['a', 'b'])).not.toBe(fingerprintMaterial(['b', 'a']));
    expect(fingerprintMaterial(['a'])).toBe(fingerprintMaterial(['a']));
  });
});

describe('appendAdmissionEvaluation', () => {
  it('appends the first evaluation and reuses an identical material fingerprint', () => {
    const first = appendAdmissionEvaluation(null, evaluation({ evaluationId: 'e1' }));
    expect(first.status).toBe('appended');

    const reused = appendAdmissionEvaluation(first.status !== 'refused' ? first.document : null, evaluation({ evaluationId: 'e2' }));
    expect(reused.status).toBe('reused');

    const changed = appendAdmissionEvaluation(first.status !== 'refused' ? first.document : null, evaluation({ evaluationId: 'e3', materialFingerprint: 'fp-new' }));
    expect(changed.status).toBe('appended');
    if (changed.status !== 'refused') expect(changed.document.evaluations).toHaveLength(2);
  });

  it('refuses once the evaluation history is at capacity', () => {
    // Build a full history.
    let current = appendAdmissionEvaluation(null, evaluation({ evaluationId: 'e0', materialFingerprint: 'fp-0' }));
    expect(current.status).toBe('appended');
    let doc = current.status !== 'refused' ? current.document : null;
    for (let i = 1; i < MAX_ADMISSION_EVALUATIONS; i += 1) {
      const next = appendAdmissionEvaluation(doc, evaluation({ evaluationId: `e${i}`, materialFingerprint: `fp-${i}` }));
      expect(next.status).toBe('appended');
      doc = next.status !== 'refused' ? next.document : null;
    }
    const overflow = appendAdmissionEvaluation(doc, evaluation({ evaluationId: 'overflow', materialFingerprint: 'fp-overflow' }));
    expect(overflow.status).toBe('refused');
    if (overflow.status === 'refused') expect(overflow.reason).toBe('admission_history_exceeded');
  });
});

describe('currentEvaluation / withProcessing', () => {
  it('returns null when there is no document or no current pointer', () => {
    expect(currentEvaluation(null)).toBeNull();
    expect(currentEvaluation({ schemaVersion: 1, evaluations: [evaluation()], currentEvaluationId: null })).toBeNull();
  });

  it('resolves the pointed-at evaluation, and withProcessing attaches a processing block', () => {
    const document: CandidateAdmissionDocument = {
      schemaVersion: CANDIDATE_ADMISSION_SCHEMA_VERSION,
      evaluations: [evaluation({ evaluationId: 'e1' })],
      currentEvaluationId: 'e1',
    };
    expect(currentEvaluation(document)?.evaluationId).toBe('e1');

    const withProc = withProcessing(document, { state: 'in_progress', attempts: 1 });
    expect(withProc.processing?.state).toBe('in_progress');
    // A null document still yields a schema-correct shell.
    expect(withProcessing(null, { state: 'not_started', attempts: 0 }).evaluations).toEqual([]);
  });
});
