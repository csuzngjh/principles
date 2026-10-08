/**
 * Intervention Evidence Ingress — the single normalized entry point every
 * runtime source uses to append intervention evidence (PD v2 Phase 1,
 * ADR-0027 §2.3; SPEC §13.7 "统一入口").
 *
 * Host adapters build observation batches; ONLY this module validates,
 * normalizes and persists them. No adapter writes evidence tables directly.
 *
 * Failure contract (SPEC §13.7): evidence persistence failure must NEVER
 * change an already computed tool allow/deny. The ingress never throws —
 * every failure returns a structured result with reason + nextAction, and
 * the durable raw source (event log / receipt ledger rows) stays available
 * for bounded replay. The writer connection uses busyTimeoutMs: 0, so a
 * contended state.db lock surfaces immediately as storage_unavailable
 * instead of delaying a hook.
 *
 * Scope identity (SPEC §13.3): evidence_scope_id is persisted in the local
 * evidence ledger and reused after workspace relocation. A canonical path
 * only provides a deterministic candidate when a ledger has no scope yet.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import {
  normalizeInterventionEvidenceBatch,
  SqliteConnection,
  SqliteInterventionEvidenceStore,
  type InterventionActivationOccurrenceRef,
  type InterventionContentRef,
  type InterventionEvidenceBatchInput,
} from '@principles/core/runtime-v2';

export interface InterventionIngressAppendResult {
  ok: boolean;
  insertedCount?: number;
  duplicateCount?: number;
  conflictCount?: number;
  reason?: string;
  nextAction?: string;
}

export interface ExistingInterventionObservationSource {
  sourceKind: 'openclaw_plugin_event_log' | 'codex_pd_hook_event_log';
  sourceLocator: string;
  observationKey: string;
  principleId: string;
  activationId: string;
  artifactId?: string;
}

export interface InterventionEvidenceIngress {
  /** Best-effort normalized append. Never throws. */
  appendObservationBatch(input: {
    workspaceDir: string;
    batch: InterventionEvidenceBatchInput;
  }): InterventionIngressAppendResult;
  /** Evidence scope id for a governance workspace (stable per workspace). */
  evidenceScopeIdFor(workspaceDir: string): string;
  /** Digest the actual governed artifact content, not activation metadata. */
  resolveInterventionContentRef(
    workspaceDir: string,
    activationRef: InterventionActivationOccurrenceRef,
    principleId: string,
  ): InterventionContentRef | null;
  /**
   * Resolve the activation occurrence metadata snapshot. The snapshot digest
   * is not a Principle content digest; use resolveInterventionContentRef for
   * the artifact's actual bytes.
   */
  resolveActivationOccurrenceRef(
    workspaceDir: string,
    activationId: string,
  ): InterventionActivationOccurrenceRef | null;
  /** Reuse the exact references already persisted for an idempotent source key. */
  existingObservationRefs(
    workspaceDir: string,
    source: ExistingInterventionObservationSource,
  ): { activationRef: InterventionActivationOccurrenceRef; contentRef: InterventionContentRef } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createInterventionEvidenceIngress(): InterventionEvidenceIngress {
  function scopeIdCandidateFor(workspaceDir: string): string {
    const absolute = isAbsolute(workspaceDir) ? resolve(workspaceDir) : resolve(process.cwd(), workspaceDir);
    // Resolve aliases before using the path as a first-append candidate. Once
    // persisted, the database scope remains authoritative across relocations.
    let resolved = absolute;
    try { resolved = realpathSync(absolute); } catch { /* keep absolute */ }
    return `pd-evidence-scope:sha256:${createHash('sha256').update(resolved, 'utf8').digest('hex').slice(0, 32)}`;
  }

  function evidenceScopeIdFor(workspaceDir: string): string {
    const candidate = scopeIdCandidateFor(workspaceDir);
    let connection: SqliteConnection | null = null;
    try {
      connection = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false });
      const established = new SqliteInterventionEvidenceStore(connection).getEvidenceScope();
      if (established) return established.scopeId;
    } catch {
      // A missing or unreadable read-only database cannot confirm a persisted
      // scope; return an uncached candidate and let the writer recheck.
    } finally {
      try { connection?.close(); } catch { /* best-effort */ }
    }
    return candidate;
  }

  function resolveInterventionContentRef(
    workspaceDir: string,
    activationRef: InterventionActivationOccurrenceRef,
    principleId: string,
  ): InterventionContentRef | null {
    if (!activationRef.artifactId) return null;
    let connection: SqliteConnection | null = null;
    try {
      connection = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false });
      const db = connection.getDb();
      // A replay may refer to a deactivated occurrence. Its current artifact
      // bytes cannot prove what was injected at the historical event time.
      // Resolve content only while the exact activation occurrence is live.
      const occurrence = db.prepare(`
        SELECT 1 FROM activations
        WHERE activation_id = ? AND idempotency_key = ? AND deactivated_at IS NULL
      `).get(activationRef.activationId, activationRef.idempotencyKey ?? '');
      if (!occurrence) return null;
      const row = db.prepare(
        'SELECT content_json, source_principle_id FROM pi_artifacts WHERE artifact_id = ?',
      ).get(activationRef.artifactId);
      if (!isRecord(row)
        || typeof row.content_json !== 'string'
        || row.source_principle_id !== principleId) return null;
      return {
        principleId,
        artifactId: activationRef.artifactId,
        payloadDigest: `sha256:${createHash('sha256').update(row.content_json, 'utf8').digest('hex')}`,
        resolution: 'resolved',
      };
    } catch {
      return null;
    } finally {
      try { connection?.close(); } catch { /* best-effort */ }
    }
  }

  function appendObservationBatch(input: {
    workspaceDir: string;
    batch: InterventionEvidenceBatchInput;
  }): InterventionIngressAppendResult {
    const normalization = normalizeInterventionEvidenceBatch(input.batch);
    if (!normalization.ok) {
      return {
        ok: false,
        reason: `evidence_batch_rejected:${normalization.reason}`,
        nextAction: 'Fix the producer payload; nothing was written. The raw source remains durable.',
      };
    }
    let connection: SqliteConnection | null = null;
    try {
      connection = new SqliteConnection({ workspaceDir: input.workspaceDir, busyTimeoutMs: 0 });
      const store = new SqliteInterventionEvidenceStore(connection);
      const expectedScope = store.getEvidenceScope()?.scopeId ?? scopeIdCandidateFor(input.workspaceDir);
      if (input.batch.evidenceScopeId !== expectedScope) {
        return {
          ok: false,
          reason: `evidence_scope_mismatch:${input.batch.evidenceScopeId}`,
          nextAction: 'Resolve the evidence scope for this workspace and rebuild the batch before replay; no records were written.',
        };
      }
      const result = store.appendObservationBatch(normalization.batch);
      return {
        ok: result.ok,
        insertedCount: result.insertedCount,
        duplicateCount: result.duplicates.length,
        conflictCount: result.conflicts.length,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.nextAction !== undefined ? { nextAction: result.nextAction } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: `evidence_storage_failed:${message}`,
        nextAction: 'The raw source remains durable; replay the same observation batch later — idempotency makes replay safe.',
      };
    } finally {
      try { connection?.close(); } catch { /* best-effort */ }
    }
  }

  function resolveActivationOccurrenceRef(
    workspaceDir: string,
    activationId: string,
  ): InterventionActivationOccurrenceRef | null {
    let connection: SqliteConnection | null = null;
    try {
      connection = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false });
      const db = connection.getDb();
      const activationRows: unknown[] = db.prepare(`
        SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at
        FROM activations
        WHERE activation_id = ?
        ORDER BY activated_at DESC
      `).all(activationId);
      // Without the source's activation-time snapshot, reused ids cannot be
      // matched to one historical row safely. Keep this as an explicit gap.
      if (activationRows.length !== 1) return null;
      const activationRow: unknown = activationRows[0];
      if (!isRecord(activationRow)) return null;
      const artifactId = typeof activationRow.artifact_id === 'string' ? activationRow.artifact_id : null;
      let artifactDigest: string | null = null;
      // A deactivated activation row proves occurrence metadata, but the
      // artifact table only exposes current content, not an as-activated copy.
      if (artifactId && activationRow.deactivated_at == null) {
        const artifactRow = db.prepare(`
          SELECT artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id,
                 lineage_artifact_ids, validation_status, content_json, created_at, updated_at
          FROM pi_artifacts WHERE artifact_id = ?
        `).get(artifactId);
        if (isRecord(artifactRow) && typeof artifactRow.content_json === 'string') {
          // Digest the governed artifact bytes exactly as captured — this is
          // the content the approval/activation authority owns (SPEC §13.3).
          artifactDigest = `sha256:${createHash('sha256').update(artifactRow.content_json, 'utf8').digest('hex')}`;
        }
      }
      const snapshotBody = {
        activationId,
        idempotencyKey: activationRow.idempotency_key ?? null,
        artifactId,
        channel: activationRow.channel ?? null,
        action: activationRow.action ?? null,
        activatedAt: activationRow.activated_at ?? null,
        artifactDigest,
      };
      // An activation row can survive after its artifact has been removed.
      // Its metadata snapshot remains useful, but it is not a content digest.
      return {
        activationId,
        ...(typeof activationRow.idempotency_key === 'string' ? { idempotencyKey: activationRow.idempotency_key } : {}),
        ...(artifactId !== null ? { artifactId } : {}),
        ...(typeof activationRow.channel === 'string' ? { channel: activationRow.channel } : {}),
        ...(typeof activationRow.activated_at === 'string' ? { activatedAt: activationRow.activated_at } : {}),
        sourceSnapshotDigest: `sha256:${createHash('sha256').update(JSON.stringify(snapshotBody), 'utf8').digest('hex')}`,
      };
    } catch {
      // Resolution is best-effort metadata for the evidence reference; an
      // unreadable store leaves the caller to record the honest gap.
      return null;
    } finally {
      try { connection?.close(); } catch { /* best-effort */ }
    }
  }

  function existingObservationRefs(
    workspaceDir: string,
    source: ExistingInterventionObservationSource,
  ): { activationRef: InterventionActivationOccurrenceRef; contentRef: InterventionContentRef } | null {
    let connection: SqliteConnection | null = null;
    try {
      connection = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false });
      const row = connection.getDb().prepare(`
        SELECT activation_ref_json, content_ref_json
        FROM intervention_evidence_records WHERE source_kind = ? AND source_locator = ? AND observation_key = ?
      `).get(source.sourceKind, source.sourceLocator, source.observationKey);
      if (!isRecord(row) || typeof row.activation_ref_json !== 'string' || typeof row.content_ref_json !== 'string') return null;
      const activationRaw: unknown = JSON.parse(row.activation_ref_json);
      const contentRaw: unknown = JSON.parse(row.content_ref_json);
      const validDigest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
      if (!isRecord(activationRaw) || typeof activationRaw.activationId !== 'string'
        || !validDigest(activationRaw.sourceSnapshotDigest)
        || !isRecord(contentRaw) || typeof contentRaw.principleId !== 'string'
        || (contentRaw.resolution !== 'resolved' && contentRaw.resolution !== 'revision_reference_unresolved')
        || (contentRaw.resolution === 'resolved' && !validDigest(contentRaw.payloadDigest))
        || (contentRaw.resolution === 'revision_reference_unresolved' && contentRaw.payloadDigest !== undefined)) return null;
      if (activationRaw.activationId !== source.activationId || contentRaw.principleId !== source.principleId
        || (typeof activationRaw.artifactId === 'string' && contentRaw.artifactId !== activationRaw.artifactId)
        || (source.artifactId !== undefined && (activationRaw.artifactId !== source.artifactId
          || contentRaw.artifactId !== source.artifactId))) return null;
      const activationRef: InterventionActivationOccurrenceRef = {
        activationId: activationRaw.activationId,
        sourceSnapshotDigest: activationRaw.sourceSnapshotDigest,
        ...(typeof activationRaw.idempotencyKey === 'string' ? { idempotencyKey: activationRaw.idempotencyKey } : {}),
        ...(typeof activationRaw.artifactId === 'string' ? { artifactId: activationRaw.artifactId } : {}),
        ...(typeof activationRaw.channel === 'string' ? { channel: activationRaw.channel } : {}),
        ...(typeof activationRaw.activatedAt === 'string' ? { activatedAt: activationRaw.activatedAt } : {}),
      };
      const contentRef: InterventionContentRef = {
        principleId: contentRaw.principleId,
        resolution: contentRaw.resolution,
        ...(typeof contentRaw.artifactId === 'string' ? { artifactId: contentRaw.artifactId } : {}),
        ...(typeof contentRaw.version === 'string' ? { version: contentRaw.version } : {}),
        ...(typeof contentRaw.payloadDigest === 'string' ? { payloadDigest: contentRaw.payloadDigest } : {}),
        ...(typeof contentRaw.approvalRef === 'string' ? { approvalRef: contentRaw.approvalRef } : {}),
      };
      return { activationRef, contentRef };
    } catch {
      return null;
    } finally {
      try { connection?.close(); } catch { /* best-effort */ }
    }
  }

  return { appendObservationBatch, evidenceScopeIdFor, resolveInterventionContentRef, resolveActivationOccurrenceRef, existingObservationRefs };
}

/** Process-wide default ingress. */
let defaultIngress: InterventionEvidenceIngress | null = null;

export function getInterventionEvidenceIngress(): InterventionEvidenceIngress {
  if (!defaultIngress) defaultIngress = createInterventionEvidenceIngress();
  return defaultIngress;
}
