/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-02/CR-03 — explicit Owner statement +
 * persisted admission disposition tests.
 *
 * Negative controls (fail on the pre-fix code):
 *  - an explicit owner statement must satisfy ONLY the empty-input-evidence
 *    admission condition (pre-fix: needs_evidence/input_evidence_empty
 *    regardless of the statement — the exact PRI-958/PRI-959 incident);
 *  - the admission disposition must be persisted on the candidate row
 *    (pre-fix: emitted as dormant telemetry only).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateAdmission } from '../admission-gate.js';
import { isOwnerStatementEvidence } from '../evidence-guards.js';
import {
  appendAdmissionEvaluation,
  currentEvaluation,
  parseAdmissionDocument,
  type AdmissionEvaluationRecord,
} from '../store/candidate/admission-document.js';
import { SqliteCandidateStore } from '../store/candidate/sqlite-candidate-store.js';
import { SqliteConnection } from '../store/sqlite-connection.js';

const tmpDirs: string[] = [];

function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cr02-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});

function makeEvaluation(overrides: Partial<AdmissionEvaluationRecord> = {}): AdmissionEvaluationRecord {
  return {
    evaluationId: 'ae_test_1',
    decision: 'admitted',
    reason: 'evidence_sufficient',
    nextAction: 'none',
    evaluatedAt: '2026-10-14T00:00:00.000Z',
    policyVersion: 'admission-gate@cr-03',
    provenance: 'host_context_bound',
    inputEvidenceCount: 0,
    ownerStatementPresent: true,
    recommendationKind: 'principle',
    confidence: 0.85,
    materialFingerprint: 'fp-1',
    materialSummary: { inputEvidenceCount: 0, outputEvidenceCount: 2, ownerStatementPresent: true, statementFingerprint: 'st-1' },
    ...overrides,
  };
}

describe('CR-02 admission gate: explicit owner statement', () => {
  const base = {
    recommendationKind: 'principle' as const,
    confidence: 0.85,
    evidenceCount: 2,
    provenance: 'host_context_bound' as const,
  };

  it('negative control: without a statement, empty input evidence still blocks', () => {
    expect(evaluateAdmission({ ...base, inputEvidenceCount: 0 })).toEqual(
      expect.objectContaining({ decision: 'needs_evidence', reason: 'input_evidence_empty' }),
    );
  });

  it('an explicit owner statement satisfies ONLY the input-evidence condition', () => {
    expect(evaluateAdmission({ ...base, inputEvidenceCount: 0, ownerStatementPresent: true })).toEqual(
      expect.objectContaining({ decision: 'admitted', reason: 'evidence_sufficient' }),
    );
  });

  it('the statement does NOT lower the confidence gate', () => {
    expect(evaluateAdmission({ ...base, confidence: 0.3, inputEvidenceCount: 0, ownerStatementPresent: true })).toEqual(
      expect.objectContaining({ decision: 'needs_evidence', reason: expect.stringContaining('confidence_below_threshold') }),
    );
  });

  it('the statement does NOT satisfy empty diagnostician output evidence', () => {
    expect(evaluateAdmission({ ...base, evidenceCount: 0, inputEvidenceCount: 0, ownerStatementPresent: true })).toEqual(
      expect.objectContaining({ decision: 'needs_evidence', reason: 'evidence_array_empty' }),
    );
  });

  it('classification guard: only owner_statement-classified correction evidence counts', () => {
    expect(isOwnerStatementEvidence({ text: 'owner words' })).toBe(false);
    expect(isOwnerStatementEvidence({ text: 'owner words', classification: 'behavior_trace' })).toBe(false);
    expect(isOwnerStatementEvidence({ text: 'owner words', classification: 'owner_statement' })).toBe(true);
    expect(isOwnerStatementEvidence(null)).toBe(false);
  });
});

describe('CR-03 admission document: append-only history', () => {
  it('appends a new evaluation and moves the current pointer', () => {
    const first = appendAdmissionEvaluation(null, makeEvaluation());
    expect(first.status).toBe('appended');
    if (first.status === 'refused') throw new Error(`append refused: ${first.reason}`);
    const second = appendAdmissionEvaluation(first.document, makeEvaluation({
      evaluationId: 'ae_test_2',
      decision: 'needs_evidence',
      reason: 'input_evidence_empty',
      materialFingerprint: 'fp-2',
    }));
    expect(second.status).toBe('appended');
    if (second.status === 'refused') throw new Error(`append refused: ${second.reason}`);
    expect(second.document.evaluations).toHaveLength(2);
    expect(second.document.currentEvaluationId).toBe('ae_test_2');
    // A15: the old version stays intact and queryable.
    expect(second.document.evaluations[0]?.decision).toBe('admitted');
    expect(currentEvaluation(second.document)?.decision).toBe('needs_evidence');
  });

  it('is idempotent for the same material fingerprint + policy version (no duplicate, no overwrite)', () => {
    const first = appendAdmissionEvaluation(null, makeEvaluation());
    expect(first.status).toBe('appended');
    if (first.status === 'refused') throw new Error(`first append refused: ${first.reason}`);
    const again = appendAdmissionEvaluation(first.document, makeEvaluation({ evaluationId: 'different-id-same-material' }));
    expect(again.status).toBe('reused');
    if (again.status === 'refused') throw new Error(`re-append refused: ${again.reason}`);
    expect(again.document.evaluations).toHaveLength(1);
    expect(again.evaluation.evaluationId).toBe('ae_test_1');
  });

  it('processing domain updates never touch evaluation history', () => {
    const first = appendAdmissionEvaluation(null, makeEvaluation());
    if (first.status === 'refused') throw new Error(`append refused: ${first.reason}`);
    const withProcessing = { ...first.document, processing: { state: 'in_progress' as const, attempts: 2 } };
    expect(withProcessing.evaluations).toEqual(first.document.evaluations);
    expect(parseAdmissionDocument(JSON.stringify(withProcessing)).document?.processing?.attempts).toBe(2);
  });

  it('malformed persisted JSON fails loud, never reads as absent', () => {
    const bad = parseAdmissionDocument('{"schemaVersion":1,"evaluations":"nope"}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('admission_json');
    expect(parseAdmissionDocument(null).document).toBeNull();
  });
});

describe('CR-03 sqlite candidate store: admission_json round-trip + migration', () => {
  function legacyDb(): { connection: SqliteConnection; dir: string } {
    const dir = tmpWorkspace();
    fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
    const db = new Database(path.join(dir, '.pd', 'state.db'));
    // Pre-CR-03 principle_candidates WITHOUT admission_json (legacy shape).
    db.exec('CREATE TABLE principle_candidates (candidate_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, task_id TEXT NOT NULL, source_run_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, confidence REAL, source_recommendation_json TEXT, idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT \'pending\', created_at TEXT NOT NULL, consumed_at TEXT, recommendation_kind TEXT NOT NULL DEFAULT \'principle\', trigger_pattern TEXT, action TEXT, abstracted_principle TEXT)');
    db.prepare("INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence, source_recommendation_json, idempotency_key, status, created_at, recommendation_kind) VALUES ('c-1','a-1','t-1','r-1','T','D',0.9,'{}','k-1','pending','2026-10-14T00:00:00Z','principle')").run();
    db.close();
    const connection = new SqliteConnection(dir);
    return { connection, dir };
  }

  it('migrates a legacy database (admission_json column added) and round-trips a document', async () => {
    const { connection, dir } = legacyDb();
    try {
      const store = new SqliteCandidateStore(connection);
      const before = await store.getAdmissionDocument('c-1');
      expect(before).toEqual({ ok: true, document: null });
      const appended = await store.appendAdmissionEvaluation('c-1', makeEvaluation());
      expect(appended.status).toBe('appended');
      if (appended.status === 'refused') throw new Error(`append refused: ${appended.reason}`);
      expect(appended.document.currentEvaluationId).toBe('ae_test_1');
      const read = await store.getAdmissionDocument('c-1');
      expect(read).toEqual({ ok: true, document: expect.objectContaining({ currentEvaluationId: 'ae_test_1' }) });
      // A08: the column physically exists after migration (raw row check).
      const raw = new Database(path.join(dir, '.pd', 'state.db'), { readonly: true });
      expect(raw.prepare('SELECT admission_json IS NOT NULL AS has FROM principle_candidates WHERE candidate_id = ?').get('c-1'))
        .toEqual({ has: 1 });
      raw.close();
    } finally {
      connection.close();
    }
  });

  it('updateAdmissionProcessing only touches the processing domain', async () => {
    const { connection } = legacyDb();
    try {
      const store = new SqliteCandidateStore(connection);
      await store.appendAdmissionEvaluation('c-1', makeEvaluation());
      const ok = await store.updateAdmissionProcessing('c-1', { state: 'exhausted', attempts: 3, blockedReason: 'post_processing_attempts_exhausted:x' });
      expect(ok).toBe(true);
      const read = await store.getAdmissionDocument('c-1');
      expect(read.ok && read.document?.processing).toEqual(expect.objectContaining({ state: 'exhausted', attempts: 3 }));
      expect(read.ok && read.document?.evaluations).toHaveLength(1);
    } finally {
      connection.close();
    }
  });

  it('refuses unknown candidates loudly', async () => {
    const { connection } = legacyDb();
    try {
      const store = new SqliteCandidateStore(connection);
      const result = await store.appendAdmissionEvaluation('missing', makeEvaluation());
      expect(result).toEqual({ status: 'refused', reason: 'candidate_not_found' });
    } finally {
      connection.close();
    }
  });
});
