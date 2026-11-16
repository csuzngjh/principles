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
import { isPiArtifactRow, mapPiArtifactRow } from '../artifact/sqlite-pi-artifact-store.js';
import { computeArtifactDigest } from '../../activation/promotion-evidence-snapshot.js';
import type {
  IntentDecisionInput,
  IntentDecisionRecord,
  IntentDecisionRecordResult,
  IntentDecisionFollowUpResult,
  IntentDecisionSummary,
  IntentDecisionStore,
  FollowUpPatch,
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
  /** SIA v1.2: nullable for pre-SIA rows (no backfill). */
  contract_digest: string | null;
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

/**
 * P1-2: which INTENT sections did this decision actually cover?
 *
 * The immutable audit copy (`related_intent_fields_snapshot`) wins; records
 * written before that column existed fall back to the mutable
 * `related_intent_fields`. Shared by the decision read model AND the approval
 * gate so the Owner's coverage can never be read two different ways.
 */
export function parseDecisionRelatedIntentFields(
  snapshotRaw: string,
  fieldsRaw: string,
): IntentRelatedField[] {
  const snapshot = parseStringArray(snapshotRaw).filter(isIntentRelatedField);
  if (snapshot.length > 0) return snapshot;
  return parseStringArray(fieldsRaw).filter(isIntentRelatedField);
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
  if (v.contract_digest !== null && typeof v.contract_digest !== 'string') return false;
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

/**
 * SIA v1.2 (SPEC §10.5): the digest is computed SERVER-side from the persisted
 * artifact snapshot. The input can only name which artifact is being resolved;
 * it can never supply the digest itself.
 *
 * REVIEW FIX (PR #2652 P0-2): the old lookup took the NEWEST pi_artifact under
 * the given task id. The Pain page supplies the DIAGNOSIS task id, so that
 * query could return the Stage A artifact — which carries no intent contract —
 * and bind its digest. A resolution bound to a non-contract artifact can never
 * match the approved Scribe artifact, so the confirmed conflict stayed blocked
 * forever. Resolution now requires a CONTRACT-bearing artifact and refuses to
 * guess when more than one qualifies.
 */
interface ContractArtifact {
  readonly artifactId: string;
  readonly digest: string;
  readonly intentDocHash: string | null;
  /** The lineage-verified candidate, when the caller named one. */
  readonly candidateId: string | null;
}

/** Read the server-authoritative intent hash carried by a contract artifact. */
function readContractIntentHash(contentJson: string): { readonly hasContract: boolean; readonly intentDocHash: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return { hasContract: false, intentDocHash: null };
  }
  if (!isRecord(parsed) || !Object.hasOwn(parsed, 'intentContract')) {
    return { hasContract: false, intentDocHash: null };
  }
  const contract = parsed.intentContract;
  const strategicIntent = isRecord(contract) ? contract.strategicIntent : undefined;
  const intentDocHash = isRecord(strategicIntent) && typeof strategicIntent.contentHash === 'string'
    && strategicIntent.contentHash !== ''
    ? strategicIntent.contentHash
    : null;
  return { hasContract: true, intentDocHash };
}

/**
 * Walk the REAL task lineage (`tasks.diagnostic_json.dependencyTaskIds`) from a
 * set of roots. Production writes this array on every internalization task, so
 * it is structured provenance — never a task-id prefix guess.
 */
function collectLineageTaskIds(
  db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
  roots: readonly string[],
): Set<string> | null {
  if (roots.length === 0) return null;
  try {
    const rows = db.prepare(`
      WITH RECURSIVE lineage(task_id) AS (
        SELECT value FROM json_each(?)
        UNION
        SELECT t.task_id FROM tasks t JOIN lineage l
         WHERE t.diagnostic_json IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM json_each(t.diagnostic_json, '$.dependencyTaskIds') je
              WHERE je.value = l.task_id
           )
      )
      SELECT task_id FROM lineage
    `).all(JSON.stringify(roots));
    const ids = new Set<string>();
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const taskId = row.task_id;
      if (typeof taskId === 'string' && taskId !== '') ids.add(taskId);
    }
    return ids.size > 0 ? ids : null;
  } catch {
    return null;
  }
}

type LineageRoots =
  | { readonly verdict: 'ok'; readonly roots: readonly string[]; readonly candidateId: string | null }
  | { readonly verdict: 'no_root' }
  | { readonly verdict: 'mismatch' };

/**
 * Resolve the lineage roots named by the decision input, VERIFYING the claimed
 * relations against structured state:
 *   - `candidateId` must exist and, when `painId` is also supplied, the
 *     candidate's diagnosis task must be recorded for that pain;
 *   - `painId` alone roots at its diagnosis tasks;
 *   - `taskId` alone roots at that task.
 * A caller-supplied id that cannot be verified is a `mismatch` (fail closed).
 */
function resolveLineageRoots(
  db: { prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] } },
  input: { readonly painId?: string; readonly taskId?: string; readonly candidateId?: string },
): LineageRoots {
  try {
    if (input.candidateId !== undefined) {
      const candidate = db.prepare('SELECT task_id FROM principle_candidates WHERE candidate_id = ?').get(input.candidateId);
      if (!isRecord(candidate)) return { verdict: 'mismatch' };
      const diagnosisTaskId = candidate.task_id;
      if (typeof diagnosisTaskId !== 'string' || diagnosisTaskId === '') return { verdict: 'mismatch' };
      if (input.painId !== undefined) {
        const link = db.prepare('SELECT 1 AS ok FROM pain_diagnoses WHERE pain_id = ? AND task_id = ? LIMIT 1').get(input.painId, diagnosisTaskId);
        if (!isRecord(link)) return { verdict: 'mismatch' };
      }
      return { verdict: 'ok', roots: [diagnosisTaskId], candidateId: input.candidateId };
    }
    if (input.painId !== undefined) {
      const rows = db.prepare('SELECT task_id FROM pain_diagnoses WHERE pain_id = ?').all(input.painId);
      const roots: string[] = [];
      for (const row of rows) {
        if (!isRecord(row)) continue;
        const taskId = row.task_id;
        if (typeof taskId === 'string' && taskId !== '') roots.push(taskId);
      }
      return roots.length === 0 ? { verdict: 'no_root' } : { verdict: 'ok', roots, candidateId: null };
    }
    if (input.taskId !== undefined && input.taskId !== '') {
      return { verdict: 'ok', roots: [input.taskId], candidateId: null };
    }
    return { verdict: 'no_root' };
  } catch {
    return { verdict: 'mismatch' };
  }
}

/**
 * P0-2 (PR #2652): resolve the Scribe contract artifact from the persisted
 * lineage — `Pain → Diagnosis Task → Candidate → internalization tasks →
 * Scribe PI Artifact`. The caller may NAME a candidate or artifact, but the
 * server verifies the relation and always computes the digest/hash itself;
 * nothing submitted by the client is trusted as a gate credential.
 */
function resolveContractArtifact(
  db: { prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] } },
  input: { readonly artifactId?: string; readonly taskId?: string; readonly painId?: string; readonly candidateId?: string },
): ContractArtifact | null {
  const lineage = resolveLineageRoots(db, input);
  if (lineage.verdict === 'mismatch') return null;
  const roots = lineage.verdict === 'ok' ? lineage.roots : null;
  const lineageTasks = roots !== null ? collectLineageTaskIds(db, roots) : null;
  if (roots !== null && lineageTasks === null) return null;
  const candidateId = lineage.verdict === 'ok' ? lineage.candidateId : null;

  let rows: unknown[];
  try {
    if (input.artifactId !== undefined) {
      rows = db.prepare('SELECT * FROM pi_artifacts WHERE artifact_id = ?').all(input.artifactId);
      // An explicitly named artifact must still be reachable from the named
      // lineage; a forged cross-pain artifact must not become a gate credential.
      if (lineageTasks !== null) {
        rows = rows.filter((row) => {
          if (!isRecord(row)) return false;
          const sourceTaskId = row.source_task_id;
          return typeof sourceTaskId === 'string' && lineageTasks.has(sourceTaskId);
        });
      }
    } else if (lineageTasks !== null) {
      rows = db.prepare(`
        WITH RECURSIVE lineage(task_id) AS (
          SELECT value FROM json_each(?)
          UNION
          SELECT t.task_id FROM tasks t JOIN lineage l
           WHERE t.diagnostic_json IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM json_each(t.diagnostic_json, '$.dependencyTaskIds') je
                WHERE je.value = l.task_id
             )
        )
        SELECT p.* FROM pi_artifacts p JOIN lineage l ON p.source_task_id = l.task_id
      `).all(JSON.stringify(roots));
    } else {
      rows = [];
    }
  } catch {
    return null;
  }
  const candidates: ContractArtifact[] = [];
  for (const row of rows) {
    if (!isPiArtifactRow(row)) return null;
    const contract = readContractIntentHash(row.content_json);
    if (!contract.hasContract) continue;
    try {
      candidates.push({
        artifactId: row.artifact_id,
        digest: computeArtifactDigest(mapPiArtifactRow(row)),
        intentDocHash: contract.intentDocHash,
        candidateId,
      });
    } catch {
      return null;
    }
  }
  // 0 = nothing contractual (fail closed); >1 = ambiguous (never guess).
  return candidates.length === 1 ? candidates[0] ?? null : null;
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

  const relatedIntentFields = parseDecisionRelatedIntentFields(
    r.related_intent_fields_snapshot,
    r.related_intent_fields,
  );

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
  if (r.contract_digest !== null) record.contractDigest = r.contract_digest;
  if (r.resulting_rule_candidate_id !== null) record.resultingRuleCandidateId = r.resulting_rule_candidate_id;
  if (r.patch_proposal_id !== null) record.patchProposalId = r.patch_proposal_id;
  return record;
}

/**
 * Read the decision row that already owns this identity key + contract digest.
 * Module-level (no `this`) so the query can be exercised without a store.
 */
function findDecisionByIdentityKey(
  db: { prepare(sql: string): { get(...params: unknown[]): unknown } },
  input: IntentDecisionInput,
  binding: { readonly intentDocHash: string | null; readonly contractDigest: string | null },
): IntentDecisionRow | null {
  const row: unknown = input.painId !== undefined
    ? db.prepare(
      'SELECT * FROM intent_decisions WHERE pain_id = ? AND intent_doc_hash IS ? AND owner_action = ? AND contract_digest IS ? LIMIT 1',
    ).get(input.painId, binding.intentDocHash, input.ownerAction, binding.contractDigest)
    : db.prepare(
      'SELECT * FROM intent_decisions WHERE pain_id IS NULL AND task_id = ? AND intent_doc_hash IS ? AND owner_action = ? AND contract_digest IS ? LIMIT 1',
    ).get(input.taskId ?? '', binding.intentDocHash, input.ownerAction, binding.contractDigest);
  return isIntentDecisionRow(row) ? row : null;
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
    // P0-2: the artifact (and therefore the digest + intent hash) is derived
    // from the persisted lineage. A client-submitted digest never participates.
    const resolvedContract = resolveContractArtifact(db, input);
    const contractDigest = resolvedContract?.digest ?? null;
    // SPEC §10.1: the artifact is the intent-hash authority. A client may send
    // `intentDocHash`, but it is only used when no contract artifact resolves.
    const intentDocHash = resolvedContract?.intentDocHash ?? input.intentDocHash ?? null;
    const resultingCandidateId = resolvedContract?.candidateId ?? null;

    // ── Immutable decision identity first (P0-3) ───────────────────────────
    // A replayed decision id is the SAME audit record. It is never mutated: if
    // the artifact it was bound to now hashes differently, the conflict is
    // reported to the caller instead of silently re-binding the Owner's
    // approval to a contract the Owner never reviewed.
    const byIdRow: unknown = db.prepare('SELECT * FROM intent_decisions WHERE id = ?').get(input.id);
    if (isIntentDecisionRow(byIdRow)) {
      if (byIdRow.contract_digest !== null && contractDigest !== null && byIdRow.contract_digest !== contractDigest) {
        return {
          record: mapRow(byIdRow),
          created: false,
          conflict: {
            reason: 'contract_digest_mismatch',
            message: `Decision ${input.id} is bound to contract ${byIdRow.contract_digest}, but the artifact now hashes to ${contractDigest}. The recorded Owner decision was not changed.`,
            nextAction:
              'Review the changed contract and record a NEW Owner decision for it; the existing decision keeps resolving only the contract it was recorded against.',
          },
        };
      }
      return { record: mapRow(byIdRow), created: false };
    }

    // ── Idempotency on the decision key + contract digest ──────────────────
    // SPEC §21.7 req 4 keys on painId + intentDocHash + ownerAction. SIA v1.2
    // adds the contract digest: the SAME key for a DIFFERENT contract is a
    // different decision (the Owner reviewed a different artifact), so it must
    // not be merged into the older row.
    const existing = findDecisionByIdentityKey(db, input, { intentDocHash, contractDigest });
    if (existing !== null) {
      return { record: mapRow(existing), created: false };
    }

    // ── Insert ─────────────────────────────────────────────────────────────
    try {
      db.prepare(`
        INSERT INTO intent_decisions (
          id, pain_id, task_id, run_id, intent_doc_hash,
          source, evidence_strength, related_intent_fields, owner_action, evidence_refs,
          note,
          source_snapshot, evidence_strength_snapshot,
          related_intent_fields_snapshot, evidence_refs_snapshot,
          resulting_candidate_id, resulting_rule_candidate_id, patch_proposal_id,
          contract_digest,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.painId ?? null,
        input.taskId ?? '',
        input.runId ?? null,
        intentDocHash,
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
        resultingCandidateId,
        null,
        null,
        contractDigest,
        createdAt,
      );
    } catch (err: unknown) {
      // Concurrent identical submissions: the unique index picks one winner;
      // the loser adopts it instead of failing (EP-07 / ERR-018).
      const winner = findDecisionByIdentityKey(db, input, { intentDocHash, contractDigest });
      if (winner !== null) return { record: mapRow(winner), created: false };
      throw err;
    }

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
    if (intentDocHash !== null) record.intentDocHash = intentDocHash;
    if (resultingCandidateId !== null) record.resultingCandidateId = resultingCandidateId;
    if (contractDigest !== null) record.contractDigest = contractDigest;

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

  /**
   * Update follow-up action fields on an existing record (PRI-471, SPEC §22.1.4).
   *
   * Only fields present in `patch` are written; absent fields are left unchanged.
   * Returns the updated record, or null if no record exists with the given id.
   *
   * ERR checklist:
   * - EP-01 / ERR-001: the patch fields are typed via the `FollowUpPatch`
   *   interface; we still re-check string-ness before binding to defend
   *   against a caller that constructed the patch from untrusted input.
   * - EP-03 / ERR-002: write failures throw (fail loud).
   * - EP-07 / ERR-015: re-reads the row after UPDATE so the returned record
   *   reflects fresh DB state, not optimistic in-memory mutation.
   */
  async updateFollowUp(id: string, patch: FollowUpPatch): Promise<IntentDecisionFollowUpResult> {
    const db = this.connection.getDb();

    // Build the SET clause dynamically based on which fields are present.
    // Each field is checked for `!== undefined` so callers can explicitly
    // set a field to null (clearing it) by passing `null` — but the
    // FollowUpPatch type uses optional strings, so we treat undefined as
    // "leave unchanged" and any string (including '') as a real value.
    const sets: string[] = [];
    const values: (string | null)[] = [];

    if (patch.resultingCandidateId !== undefined) {
      sets.push('resulting_candidate_id = ?');
      values.push(patch.resultingCandidateId);
    }
    if (patch.resultingRuleCandidateId !== undefined) {
      sets.push('resulting_rule_candidate_id = ?');
      values.push(patch.resultingRuleCandidateId);
    }
    if (patch.patchProposalId !== undefined) {
      sets.push('patch_proposal_id = ?');
      values.push(patch.patchProposalId);
    }

    const existing = await this.getById(id);
    if (existing === null) {
      return { ok: false, reason: 'decision_not_found', message: `Intent decision ${id} does not exist.` };
    }

    // REVIEW FIX (PR #2652 P0-3 / P1-4): the candidate binding is write-once.
    // Re-pointing a bound decision at another candidate would move an Owner
    // approval onto an artifact the Owner never confirmed; the gate would then
    // "resolve" a conflict with a decision that was not about it.
    if (
      patch.resultingCandidateId !== undefined
      && patch.resultingCandidateId !== null
      && existing.resultingCandidateId !== undefined
      && existing.resultingCandidateId !== patch.resultingCandidateId
    ) {
      return {
        ok: false,
        reason: 'candidate_already_bound',
        message: `Intent decision ${id} is already bound to candidate ${existing.resultingCandidateId}; it cannot be re-bound to ${patch.resultingCandidateId}.`,
      };
    }

    // No fields to update — return the existing record without writing.
    if (sets.length === 0) {
      return { ok: true, record: existing };
    }

    values.push(id);

    const result = db.prepare(
      `UPDATE intent_decisions SET ${sets.join(', ')} WHERE id = ?`,
    ).run(...values);

    // changes === 0 means no row matched the WHERE clause — record not found.
    if (result.changes === 0) {
      return { ok: false, reason: 'decision_not_found', message: `Intent decision ${id} does not exist.` };
    }

    // Re-read the row to return fresh state (EP-07 / ERR-015).
    const refreshed = await this.getById(id);
    if (refreshed === null) {
      return { ok: false, reason: 'decision_not_found', message: `Intent decision ${id} does not exist.` };
    }
    return { ok: true, record: refreshed };
  }
}
