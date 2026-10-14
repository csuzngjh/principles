import type { SqliteConnection } from '../sqlite-connection.js';
import type { CandidateRecord, CandidateStore } from './candidate-store.js';
import { resolveRecommendationKind } from './recommendation-kind-resolver.js';
import {
  appendAdmissionEvaluation,
  parseAdmissionDocument,
  serializeAdmissionDocument,
  withProcessing,
  type AdmissionEvaluationRecord,
  type AdmissionProcessingRecord,
  type CandidateAdmissionDocument,
} from './admission-document.js';

interface CandidateRow {
  candidate_id: string;
  artifact_id: string;
  task_id: string;
  source_run_id: string;
  title: string;
  description: string;
  confidence: number | null;
  source_recommendation_json: string;
  recommendation_kind: string;
  status: string;
  created_at: string;
}

function mapRow(r: CandidateRow): CandidateRecord {
  return {
    candidateId: r.candidate_id,
    artifactId: r.artifact_id,
    taskId: r.task_id,
    sourceRunId: r.source_run_id,
    title: r.title,
    description: r.description,
    confidence: r.confidence,
    sourceRecommendationJson: r.source_recommendation_json,
    recommendationKind: resolveRecommendationKind(r.recommendation_kind),
    // Phase 1 / PR1: preserve the persisted column value verbatim so the
    // Principle Ledger write boundary can validate provenance instead of the
    // fail-open normalized view above.
    rawRecommendationKind: r.recommendation_kind,
    status: r.status as CandidateRecord['status'],
    createdAt: r.created_at,
  };
}

export class SqliteCandidateStore implements CandidateStore {
  constructor(private readonly connection: SqliteConnection) {}

  async getCandidatesByTaskId(taskId: string): Promise<CandidateRecord[]> {
    const db = this.connection.getDb();
    const rows = db.prepare(`
      SELECT pc.candidate_id, pc.artifact_id, pc.task_id, pc.source_run_id,
             pc.title, pc.description, pc.confidence, pc.status, pc.created_at,
             pc.source_recommendation_json, pc.recommendation_kind
      FROM principle_candidates pc
      JOIN commits c ON c.artifact_id = pc.artifact_id
      JOIN runs r ON r.run_id = c.run_id
      JOIN tasks t ON t.task_id = r.task_id
      WHERE t.task_id = ? OR t.input_ref = ?
      ORDER BY pc.created_at DESC
    `).all(taskId, taskId) as CandidateRow[];
    return rows.map(mapRow);
  }

  async getCandidate(candidateId: string): Promise<CandidateRecord | null> {
    const db = this.connection.getDb();
    const row = db.prepare(`
      SELECT candidate_id, artifact_id, task_id, source_run_id, title, description,
             confidence, source_recommendation_json, recommendation_kind, status, created_at
      FROM principle_candidates WHERE candidate_id = ?
    `).get(candidateId) as CandidateRow | undefined;
    if (!row) return null;
    return mapRow(row);
  }

  async updateCandidateStatus(candidateId: string, patch: { status: CandidateRecord['status'] }): Promise<boolean> {
    const db = this.connection.getDb();
    // F13 (PRI-442): when transitioning to 'consumed', set consumed_at in
    // the same statement so the row satisfies the schema CHECK constraint
    // (status='consumed' → consumed_at IS NOT NULL). Previously this method
    // left consumed_at NULL and a separate ensureConsumedAt() patch fixed it
    // post-hoc — but that left a window where the row violated the invariant.
    if (patch.status === 'consumed') {
      const now = new Date().toISOString();
      const info = db.prepare('UPDATE principle_candidates SET status = ?, consumed_at = COALESCE(consumed_at, ?) WHERE candidate_id = ?')
        .run(patch.status, now, candidateId);
      return info.changes > 0;
    }
    const info = db.prepare('UPDATE principle_candidates SET status = ? WHERE candidate_id = ?')
      .run(patch.status, candidateId);
    return info.changes > 0;
  }

  async transitionCandidateStatus(candidateId: string, expectedStatus: CandidateRecord['status'], newStatus: CandidateRecord['status']): Promise<boolean> {
    const db = this.connection.getDb();
    // F13 (PRI-442): same CHECK-constraint fix as updateCandidateStatus —
    // set consumed_at atomically when the new status is 'consumed'.
    if (newStatus === 'consumed') {
      const now = new Date().toISOString();
      const info = db.prepare('UPDATE principle_candidates SET status = ?, consumed_at = COALESCE(consumed_at, ?) WHERE candidate_id = ? AND status = ?')
        .run(newStatus, now, candidateId, expectedStatus);
      return info.changes > 0;
    }
    const info = db.prepare('UPDATE principle_candidates SET status = ? WHERE candidate_id = ? AND status = ?')
      .run(newStatus, candidateId, expectedStatus);
    return info.changes > 0;
  }

  /**
   * SPEC §9.1 (review P1): the diagnosis post-processing backlog. Candidates
   * of SUCCEEDED diagnostician tasks whose admission/intake/seeding never
   * completed — INCLUDING candidates committed by the diag_router SUBTASK
   * (resolved to the diagnostician parent through subtask.inputRef) and
   * legacy consumed-but-unseeded orphans (admission_json NULL + consumed).
   * Terminal processing states are excluded. `taskId` is always the PARENT
   * diagnostician task (the resume entry reads the original pain input from
   * the parent and the router output from the subtask run).
   */
  listDiagnosisPostProcessingBacklog(options: { limit: number; nowIso?: string }): {
    eligible: { candidateId: string; taskId: string; status: string; createdAt: string; processingState: string | null }[];
    corrupt: { candidateId: string; taskId: string; status: string; createdAt: string }[];
  } {
    const db = this.connection.getDb();
    const nowIso = options.nowIso ?? new Date().toISOString();
    // SPEC review round-4 P1: json_extract throws on malformed admission_json
    // and would fail the WHOLE backlog scan. json_valid() filters without
    // throwing: eligible rows need a parseable (or absent) document; corrupt
    // rows are surfaced SEPARATELY as a candidate-level queryable blocker —
    // never deleted, never treated as unrecorded, and never eligible for
    // governance writes (the shared write gate independently refuses them).
    const eligible = db.prepare(`
      SELECT pc.candidate_id AS candidateId,
             COALESCE(parent.task_id, ct.task_id) AS taskId,
             pc.status AS status,
             pc.created_at AS createdAt,
             json_extract(pc.admission_json, '$.processing.state') AS processingState
      FROM principle_candidates pc
      JOIN tasks ct ON ct.task_id = pc.task_id
      LEFT JOIN tasks parent
        ON parent.task_id = ct.input_ref AND parent.task_kind = 'diagnostician'
      WHERE COALESCE(parent.task_kind, ct.task_kind) = 'diagnostician'
        AND COALESCE(parent.status, ct.status) = 'succeeded'
        AND (pc.admission_json IS NULL OR json_valid(pc.admission_json) = 1)
        AND (
          (pc.admission_json IS NULL AND pc.status IN ('pending', 'consumed'))
          OR (
            pc.admission_json IS NOT NULL
            AND COALESCE(json_extract(pc.admission_json, '$.processing.state'), 'not_started') IN ('not_started', 'in_progress')
            AND (
              json_extract(pc.admission_json, '$.processing.nextRetryAt') IS NULL
              OR json_extract(pc.admission_json, '$.processing.nextRetryAt') <= ?
            )
          )
        )
      ORDER BY pc.created_at ASC
      LIMIT ?
    `).all(nowIso, options.limit) as { candidateId: string; taskId: string; status: string; createdAt: string; processingState: string | null }[];
    const corrupt = db.prepare(`
      SELECT pc.candidate_id AS candidateId,
             COALESCE(parent.task_id, ct.task_id) AS taskId,
             pc.status AS status,
             pc.created_at AS createdAt
      FROM principle_candidates pc
      JOIN tasks ct ON ct.task_id = pc.task_id
      LEFT JOIN tasks parent
        ON parent.task_id = ct.input_ref AND parent.task_kind = 'diagnostician'
      WHERE COALESCE(parent.task_kind, ct.task_kind) = 'diagnostician'
        AND COALESCE(parent.status, ct.status) = 'succeeded'
        AND pc.admission_json IS NOT NULL AND json_valid(pc.admission_json) = 0
      ORDER BY pc.created_at ASC
    
    `).all() as { candidateId: string; taskId: string; status: string; createdAt: string }[];
    return { eligible, corrupt };
  }

  async getAdmissionDocument(candidateId: string): Promise<
    { ok: true; document: CandidateAdmissionDocument | null } | { ok: false; reason: string }
  > {
    const db = this.connection.getDb();
    const row = db.prepare('SELECT admission_json FROM principle_candidates WHERE candidate_id = ?').get(candidateId) as { admission_json: string | null } | undefined;
    if (row === undefined) return { ok: false, reason: 'candidate_not_found' };
    return parseAdmissionDocument(row.admission_json);
  }

  async appendAdmissionEvaluation(candidateId: string, evaluation: AdmissionEvaluationRecord): Promise<
    { status: 'appended' | 'reused'; document: CandidateAdmissionDocument } | { status: 'refused'; reason: string }
  > {
    const db = this.connection.getDb();
    // SPEC review S3: read-modify-write under BEGIN IMMEDIATE so two
    // processes (worker + CLI) can never interleave read→read→write→write
    // and drop an evaluation or clobber the processing domain. The single
    // write authority stays this store; the idempotency contract is
    // unchanged (same fingerprint+policy reuses).
    let outcome: { status: 'appended' | 'reused'; document: CandidateAdmissionDocument } | { status: 'refused'; reason: string } = { status: 'refused', reason: 'admission_append_not_executed' };
    const applyAppend = db.transaction((): void => {
      const read = db.prepare('SELECT admission_json FROM principle_candidates WHERE candidate_id = ?').get(candidateId) as { admission_json: string | null } | undefined;
      if (read === undefined) {
        outcome = { status: 'refused', reason: 'candidate_not_found' };
        return;
      }
      const parsed = parseAdmissionDocument(read.admission_json);
      if (!parsed.ok) {
        outcome = { status: 'refused', reason: parsed.reason ?? 'admission_json_invalid' };
        return;
      }
      const result = appendAdmissionEvaluation(parsed.document, evaluation);
      if (result.status === 'refused') {
        outcome = result;
        return;
      }
      const serialized = serializeAdmissionDocument(result.document);
      if (!serialized.ok) {
        outcome = { status: 'refused', reason: serialized.reason };
        return;
      }
      const info = db.prepare('UPDATE principle_candidates SET admission_json = ? WHERE candidate_id = ?')
        .run(serialized.json, candidateId);
      if (info.changes === 0) {
        outcome = { status: 'refused', reason: 'candidate_not_found' };
        return;
      }
      outcome = { status: result.status, document: result.document };
    });
    applyAppend.immediate();
    return outcome;
  }

  async updateAdmissionProcessing(candidateId: string, processing: AdmissionProcessingRecord): Promise<boolean> {
    const db = this.connection.getDb();
    // SPEC review S3: same BEGIN IMMEDIATE read-modify-write as
    // appendAdmissionEvaluation — processing updates and evaluation appends
    // from different processes serialize here instead of overwriting each
    // other (evaluation history is never lost, processing state never reset).
    let updated = false;
    const applyProcessing = db.transaction((): void => {
      const read = db.prepare('SELECT admission_json FROM principle_candidates WHERE candidate_id = ?').get(candidateId) as { admission_json: string | null } | undefined;
      if (read === undefined) return;
      const parsed = parseAdmissionDocument(read.admission_json);
      if (!parsed.ok) return;
      const document = withProcessing(parsed.document, processing);
      const serialized = serializeAdmissionDocument(document);
      if (!serialized.ok) return;
      const info = db.prepare('UPDATE principle_candidates SET admission_json = ? WHERE candidate_id = ?')
        .run(serialized.json, candidateId);
      updated = info.changes > 0;
    });
    applyProcessing.immediate();
    return updated;
  }
}
