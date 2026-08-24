import type { SqliteConnection } from '../sqlite-connection.js';
import { PDRuntimeError } from '../../error-categories.js';
import type {
  PainDiagnosisEvidence,
  PainDiagnosisRecord,
  PainDiagnosisStore,
  PainDiagnosisWriteInput,
} from './pain-diagnosis-store.js';
import { buildPainDiagnosisId, isRootCauseCategory } from './pain-diagnosis-store.js';

interface PainDiagnosisRow {
  id: string;
  pain_id: string;
  task_id: string;
  diagnosis_id: string;
  category: string;
  root_cause: string;
  evidence_json: string | null;
  confidence: number | null;
  artifact_id: string | null;
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Row-level type guard (rc-1/rc-2): sqlite rows are untrusted until every
 * column is shape-checked — no `as` casts on query results.
 */
function isPainDiagnosisRow(value: unknown): value is PainDiagnosisRow {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.pain_id === 'string'
    && typeof value.task_id === 'string'
    && typeof value.diagnosis_id === 'string'
    && typeof value.category === 'string'
    && typeof value.root_cause === 'string'
    && (value.evidence_json === null || typeof value.evidence_json === 'string')
    && (value.confidence === null || typeof value.confidence === 'number')
    && (value.artifact_id === null || typeof value.artifact_id === 'string')
    && typeof value.created_at === 'string';
}

/**
 * Parse and validate evidence_json back into typed entries (rc-1/rc-4: DB
 * payloads are unknown until shape-checked; malformed entries are dropped,
 * a malformed root value yields no entries).
 */
function parseEvidence(json: string | null): PainDiagnosisEvidence[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is PainDiagnosisEvidence =>
    isRecord(entry)
    && typeof entry.sourceRef === 'string' && entry.sourceRef.length > 0
    && typeof entry.note === 'string' && entry.note.length > 0);
}

function mapRow(row: PainDiagnosisRow): PainDiagnosisRecord {
  // The CHECK constraint on the table restricts category to the four
  // literals, so an invalid value means row corruption — fail loud
  // instead of silently recasting (rc-2/rc-9).
  if (!isRootCauseCategory(row.category)) {
    throw new PDRuntimeError('storage_unavailable', `pain diagnosis row ${row.id} has invalid category "${row.category}"`, {
      nextAction: 'Inspect state.db pain_diagnoses — the CHECK constraint should have prevented this row.',
    });
  }
  return {
    id: row.id,
    painId: row.pain_id,
    taskId: row.task_id,
    diagnosisId: row.diagnosis_id,
    category: row.category,
    rootCause: row.root_cause,
    evidence: parseEvidence(row.evidence_json),
    confidence: row.confidence,
    artifactId: row.artifact_id,
    createdAt: row.created_at,
  };
}

export class SqlitePainDiagnosisStore implements PainDiagnosisStore {  constructor(private readonly connection: SqliteConnection) {}

  async recordPainDiagnosis(input: PainDiagnosisWriteInput): Promise<PainDiagnosisRecord> {
    // rc-3: fail loud on malformed input before any write.
    for (const [name, value] of [['painId', input.painId], ['taskId', input.taskId], ['diagnosisId', input.diagnosisId], ['rootCause', input.rootCause]] as const) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new PDRuntimeError('input_invalid', `pain diagnosis ${name} must be a non-empty string`, {
          nextAction: 'Fix the caller to pass the diagnostician output fields verbatim.',
        });
      }
    }
    if (!isRootCauseCategory(input.category)) {
      throw new PDRuntimeError('input_invalid', `pain diagnosis category must be People|Design|Assumption|Tooling, got ${String(input.category)}`);
    }
    if (input.confidence !== null && (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
      throw new PDRuntimeError('input_invalid', `pain diagnosis confidence must be null or a number in [0,1], got ${String(input.confidence)}`);
    }

    const id = buildPainDiagnosisId(input.taskId, input.diagnosisId);
    const db = this.connection.getDb();
    const createdAt = new Date().toISOString();
    const evidenceJson = JSON.stringify(input.evidence);
    // Parameter binding only — no string assembly of SQL values (Mimosa gate).
    db.prepare(
      'INSERT OR IGNORE INTO pain_diagnoses (id, pain_id, task_id, diagnosis_id, category, root_cause, evidence_json, confidence, artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, input.painId, input.taskId, input.diagnosisId, input.category, input.rootCause, evidenceJson, input.confidence, input.artifactId ?? null, createdAt);

    // EP-07: return the canonical persisted row, not the in-memory input —
    // a replayed write must report the originally persisted createdAt.
    const raw: unknown = db.prepare('SELECT id, pain_id, task_id, diagnosis_id, category, root_cause, evidence_json, confidence, artifact_id, created_at FROM pain_diagnoses WHERE id = ?').get(id);
    if (!isPainDiagnosisRow(raw)) {
      throw new PDRuntimeError('storage_unavailable', `pain diagnosis row ${id} missing or malformed after insert`, {
        nextAction: 'Check state.db integrity (pain_diagnoses table) and retry the diagnosis completion.',
      });
    }
    return mapRow(raw);
  }

  async getDiagnosesByPainId(painId: string): Promise<PainDiagnosisRecord[]> {
    const db = this.connection.getDb();
    const rawRows: unknown[] = db.prepare('SELECT id, pain_id, task_id, diagnosis_id, category, root_cause, evidence_json, confidence, artifact_id, created_at FROM pain_diagnoses WHERE pain_id = ? ORDER BY created_at ASC, id ASC').all(painId);
    const rows = rawRows.filter(isPainDiagnosisRow);
    // Rows in this table are only ever written by this store (shape-validated
    // writes) — a filtered-out row means external corruption, so fail loud
    // instead of silently shrinking the pain's diagnosis history (rc-3/rc-9).
    if (rows.length !== rawRows.length) {
      throw new PDRuntimeError('storage_unavailable', `pain ${painId} has malformed diagnosis row(s)`, {
        nextAction: 'Inspect state.db pain_diagnoses for externally modified rows.',
      });
    }
    return rows.map(mapRow);
  }
}
