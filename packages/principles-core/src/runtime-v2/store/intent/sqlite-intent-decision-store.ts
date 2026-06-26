/**
 * SqliteIntentDecisionStore — SQLite implementation of IntentDecisionStore.
 *
 * PRI-470 / SPEC §21.7 durable persistence for Owner decisions on
 * intentTension. Records are written to the `intent_decisions` table
 * (schema created by SqliteConnection.initSchema).
 *
 * Idempotency (SPEC §21.7 req 4):
 * - When `painId` is non-null: dedupe on (pain_id, intent_doc_hash, owner_action).
 * - When `painId` is null: dedupe on (task_id, intent_doc_hash, owner_action)
 *   using the NULL-safe `IS` operator so a null intentDocHash compares equal.
 *
 * Snapshots (SPEC §21.7 audit boundary):
 * - source / evidenceStrength / relatedIntentFields / evidenceRefs are stored
 *   twice: once in the live columns and once in the `_snapshot` columns. The
 *   snapshot is the immutable audit copy; the live columns mirror it at write
 *   time. This keeps the audit trail accurate even if a future migration or
 *   artifact change alters the live columns.
 *
 * ERR checklist:
 * - EP-01 / ERR-001, ERR-005: DB rows treated as unknown, mapped via guards
 * - EP-03 / ERR-002: write failures throw (fail loud)
 * - EP-07 / ERR-015, ERR-018: idempotency SELECT reads fresh state each call
 */

import type { SqliteConnection } from '../sqlite-connection.js';
import type {
  IntentDecisionInput,
  IntentDecisionRecord,
  IntentDecisionRecordResult,
  IntentDecisionSummary,
  IntentDecisionStore,
} from '../../intent/intent-decision-record.js';
import type {
  IntentTensionSource,
  EvidenceStrength,
  IntentRelatedField,
  SuggestedOwnerAction,
} from '../../diagnostician/diag-rootcause-output.js';
import {
  isIntentTensionSource,
  isEvidenceStrength,
  isIntentRelatedField,
  isSuggestedOwnerAction,
} from '../../diagnostician/diag-rootcause-output.js';

const MAX_EVIDENCE_REFS = 3;

interface IntentDecisionRow {
  id: string;
  pain_id: string | null;
  task_id: string;
  run_id: string | null;
  intent_doc_hash: string | null;
  source: string;
  evidence_strength: string;
  related_intent_fields: string;
  owner_action: string;
  evidence_refs: string;
  source_snapshot: string;
  evidence_strength_snapshot: string;
  related_intent_fields_snapshot: string;
  evidence_refs_snapshot: string;
  resulting_candidate_id: string | null;
  resulting_rule_candidate_id: string | null;
  patch_proposal_id: string | null;
  created_at: string;
}

function parseStringArray(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((v): v is string => typeof v === 'string');
}

// ── Row type guards (Runtime Contract Rule 2: no `as` bypass) ────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIntentDecisionRow(v: unknown): v is IntentDecisionRow {
  if (!isRecord(v)) return false;
  if (typeof v.id !== 'string') return false;
  if (v.pain_id !== null && typeof v.pain_id !== 'string') return false;
  if (typeof v.task_id !== 'string') return false;
  if (v.run_id !== null && typeof v.run_id !== 'string') return false;
  if (v.intent_doc_hash !== null && typeof v.intent_doc_hash !== 'string') return false;
  if (typeof v.source !== 'string') return false;
  if (typeof v.evidence_strength !== 'string') return false;
  if (typeof v.related_intent_fields !== 'string') return false;
  if (typeof v.owner_action !== 'string') return false;
  if (typeof v.evidence_refs !== 'string') return false;
  if (typeof v.source_snapshot !== 'string') return false;
  if (typeof v.evidence_strength_snapshot !== 'string') return false;
  if (typeof v.related_intent_fields_snapshot !== 'string') return false;
  if (typeof v.evidence_refs_snapshot !== 'string') return false;
  if (v.resulting_candidate_id !== null && typeof v.resulting_candidate_id !== 'string') return false;
  if (v.resulting_rule_candidate_id !== null && typeof v.resulting_rule_candidate_id !== 'string') return false;
  if (v.patch_proposal_id !== null && typeof v.patch_proposal_id !== 'string') return false;
  if (typeof v.created_at !== 'string') return false;
  return true;
}

interface SummaryRow {
  owner_action: string;
  cnt: number;
  last_at: string | null;
}

function isSummaryRow(v: unknown): v is SummaryRow {
  if (!isRecord(v)) return false;
  if (typeof v.owner_action !== 'string') return false;
  if (typeof v.cnt !== 'number' || !Number.isFinite(v.cnt)) return false;
  if (v.last_at !== null && typeof v.last_at !== 'string') return false;
  return true;
}

function zeroCounts(): Record<SuggestedOwnerAction, number> {
  return {
    confirm_drift: 0,
    revise_intent: 0,
    observe: 0,
    dismiss: 0,
    promote_to_principle: 0,
    promote_to_rulehost: 0,
  };
}

function mapRow(r: IntentDecisionRow): IntentDecisionRecord {
  // Validate enum fields read from the DB (ERR-001). Snapshot columns are the
  // auditable source of truth, so we read from them; the live column is a
  // secondary fallback. Both are written by this store, so they should always
  // be valid — the defaults below are defensive against DB corruption.
  const source: IntentTensionSource = isIntentTensionSource(r.source_snapshot)
    ? r.source_snapshot
    : isIntentTensionSource(r.source)
      ? r.source
      : 'none';
  const evidenceStrength: EvidenceStrength = isEvidenceStrength(r.evidence_strength_snapshot)
    ? r.evidence_strength_snapshot
    : isEvidenceStrength(r.evidence_strength)
      ? r.evidence_strength
      : 'weak';
  const ownerAction: SuggestedOwnerAction = isSuggestedOwnerAction(r.owner_action)
    ? r.owner_action
    : 'observe';

  const fieldsRaw = parseStringArray(r.related_intent_fields_snapshot);
  const relatedIntentFields: IntentRelatedField[] = fieldsRaw.length > 0
    ? fieldsRaw.filter(isIntentRelatedField)
    : parseStringArray(r.related_intent_fields).filter(isIntentRelatedField);

  const evidenceRefs = parseStringArray(r.evidence_refs_snapshot);

  const record: IntentDecisionRecord = {
    id: r.id,
    source,
    evidenceStrength,
    relatedIntentFields,
    ownerAction,
    evidenceRefs,
    createdAt: r.created_at,
  };
  if (r.pain_id !== null) record.painId = r.pain_id;
  if (r.run_id !== null) record.runId = r.run_id;
  if (r.intent_doc_hash !== null) record.intentDocHash = r.intent_doc_hash;
  // task_id is NOT NULL in the schema, but the type marks it optional — only
  // surface it when it is non-empty so an empty string does not masquerade as
  // a real lineage id.
  if (r.task_id !== '') record.taskId = r.task_id;
  if (r.resulting_candidate_id !== null) record.resultingCandidateId = r.resulting_candidate_id;
  if (r.resulting_rule_candidate_id !== null) record.resultingRuleCandidateId = r.resulting_rule_candidate_id;
  if (r.patch_proposal_id !== null) record.patchProposalId = r.patch_proposal_id;
  return record;
}

export class SqliteIntentDecisionStore implements IntentDecisionStore {
  constructor(private readonly connection: SqliteConnection) {}

  async record(input: IntentDecisionInput): Promise<IntentDecisionRecordResult> {
    const db = this.connection.getDb();

    // Truncate evidence to the SPEC §22.1.2 maximum of 3 items.
    const truncatedEvidence = input.evidenceRefs.slice(0, MAX_EVIDENCE_REFS);
    const relatedFieldsJson = JSON.stringify(input.relatedIntentFields);
    const evidenceRefsJson = JSON.stringify(truncatedEvidence);
    const createdAt = new Date().toISOString();

    // ── Idempotency check ──────────────────────────────────────────────────
    // SPEC §21.7 req 4: same painId + intentDocHash + ownerAction must be
    // idempotent. When painId is null, fall back to taskId-based dedupe.
    let existing: IntentDecisionRow | undefined;
    if (input.painId !== undefined) {
      const row = db.prepare(
        'SELECT * FROM intent_decisions WHERE pain_id = ? AND intent_doc_hash IS ? AND owner_action = ? LIMIT 1',
      ).get(input.painId, input.intentDocHash ?? null, input.ownerAction);
      if (isIntentDecisionRow(row)) existing = row;
    } else {
      const taskId = input.taskId ?? '';
      const row = db.prepare(
        'SELECT * FROM intent_decisions WHERE pain_id IS NULL AND task_id = ? AND intent_doc_hash IS ? AND owner_action = ? LIMIT 1',
      ).get(taskId, input.intentDocHash ?? null, input.ownerAction);
      if (isIntentDecisionRow(row)) existing = row;
    }

    if (existing) {
      return { record: mapRow(existing), created: false };
    }

    // ── Insert ─────────────────────────────────────────────────────────────
    db.prepare(`
      INSERT INTO intent_decisions (
        id, pain_id, task_id, run_id, intent_doc_hash,
        source, evidence_strength, related_intent_fields, owner_action, evidence_refs,
        note,
        source_snapshot, evidence_strength_snapshot,
        related_intent_fields_snapshot, evidence_refs_snapshot,
        resulting_candidate_id, resulting_rule_candidate_id, patch_proposal_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.painId ?? null,
      input.taskId ?? '',
      input.runId ?? null,
      input.intentDocHash ?? null,
      input.source,
      input.evidenceStrength,
      relatedFieldsJson,
      input.ownerAction,
      evidenceRefsJson,
      input.note ?? null,
      // Snapshots — immutable audit copies (identical to live values at write time).
      input.source,
      input.evidenceStrength,
      relatedFieldsJson,
      evidenceRefsJson,
      null,
      null,
      null,
      createdAt,
    );

    const record: IntentDecisionRecord = {
      id: input.id,
      source: input.source,
      evidenceStrength: input.evidenceStrength,
      relatedIntentFields: [...input.relatedIntentFields],
      ownerAction: input.ownerAction,
      evidenceRefs: [...truncatedEvidence],
      createdAt,
    };
    if (input.painId !== undefined) record.painId = input.painId;
    if (input.taskId !== undefined) record.taskId = input.taskId;
    if (input.runId !== undefined) record.runId = input.runId;
    if (input.intentDocHash !== undefined) record.intentDocHash = input.intentDocHash;

    return { record, created: true };
  }

  async getById(id: string): Promise<IntentDecisionRecord | null> {
    const db = this.connection.getDb();
    const row = db.prepare('SELECT * FROM intent_decisions WHERE id = ?').get(id);
    if (!isIntentDecisionRow(row)) return null;
    return mapRow(row);
  }

  async listByPainId(painId: string): Promise<IntentDecisionRecord[]> {
    const db = this.connection.getDb();
    const rawRows = db.prepare(
      'SELECT * FROM intent_decisions WHERE pain_id = ? ORDER BY created_at DESC',
    ).all(painId);
    if (!Array.isArray(rawRows)) return [];
    return rawRows.filter(isIntentDecisionRow).map(mapRow);
  }

  async listByTaskId(taskId: string): Promise<IntentDecisionRecord[]> {
    const db = this.connection.getDb();
    const rawRows = db.prepare(
      'SELECT * FROM intent_decisions WHERE task_id = ? ORDER BY created_at DESC',
    ).all(taskId);
    if (!Array.isArray(rawRows)) return [];
    return rawRows.filter(isIntentDecisionRow).map(mapRow);
  }

  async getSummary(): Promise<IntentDecisionSummary> {
    const db = this.connection.getDb();
    const rawRows = db.prepare(
      'SELECT owner_action, COUNT(*) AS cnt, MAX(created_at) AS last_at FROM intent_decisions GROUP BY owner_action',
    ).all();
    if (!Array.isArray(rawRows)) return { counts: zeroCounts(), lastDecisionAt: null };
    const rows: SummaryRow[] = rawRows.filter(isSummaryRow);

    const counts = zeroCounts();
    let lastDecisionAt: string | null = null;

    for (const row of rows) {
      if (isSuggestedOwnerAction(row.owner_action)) {
        counts[row.owner_action] = row.cnt;
      }
      if (row.last_at && (lastDecisionAt === null || row.last_at > lastDecisionAt)) {
        lastDecisionAt = row.last_at;
      }
    }

    return { counts, lastDecisionAt };
  }
}
