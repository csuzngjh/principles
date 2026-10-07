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
 * Scope identity (SPEC §13.3): evidence_scope_id is derived once per
 * governance workspace and cached per process — it identifies the local
 * ledger's scope, never a Principle entity.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'path';
import {
  normalizeInterventionEvidenceBatch,
  SqliteConnection,
  SqliteInterventionEvidenceStore,
  type InterventionActivationOccurrenceRef,
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

export interface InterventionEvidenceIngress {
  /** Best-effort normalized append. Never throws. */
  appendObservationBatch(input: {
    workspaceDir: string;
    batch: InterventionEvidenceBatchInput;
  }): InterventionIngressAppendResult;
  /** Evidence scope id for a governance workspace (stable per workspace). */
  evidenceScopeIdFor(workspaceDir: string): string;
  /**
   * Resolve the observed activation occurrence snapshot (activations row +
   * governed artifact digest) for evidence references. Returns null when the
   * activation or artifact cannot be resolved — the caller records an honest
   * gap, never a guessed reference.
   */
  resolveActivationOccurrenceRef(
    workspaceDir: string,
    activationId: string,
  ): InterventionActivationOccurrenceRef | null;
}

const scopeIdCache = new Map<string, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createInterventionEvidenceIngress(): InterventionEvidenceIngress {
  function evidenceScopeIdFor(workspaceDir: string): string {
    const resolved = isAbsolute(workspaceDir) ? resolve(workspaceDir) : resolve(process.cwd(), workspaceDir);
    const cached = scopeIdCache.get(resolved);
    if (cached) return cached;
    const scopeId = `pd-evidence-scope:sha256:${createHash('sha256').update(resolved, 'utf8').digest('hex').slice(0, 32)}`;
    scopeIdCache.set(resolved, scopeId);
    return scopeId;
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
    const scopeId = evidenceScopeIdFor(input.workspaceDir);
    let connection: SqliteConnection | null = null;
    try {
      connection = new SqliteConnection({ workspaceDir: input.workspaceDir, busyTimeoutMs: 0 });
      const store = new SqliteInterventionEvidenceStore(connection);
      const result = store.appendObservationBatch({
        ...normalization.batch,
        evidenceScopeId: scopeId,
      });
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
      const activationRow = db.prepare(`
        SELECT activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at
        FROM activations
        WHERE activation_id = ? AND deactivated_at IS NULL
        ORDER BY activated_at DESC
        LIMIT 1
      `).get(activationId);
      if (!isRecord(activationRow)) return null;
      const artifactId = typeof activationRow.artifact_id === 'string' ? activationRow.artifact_id : null;
      let artifactDigest: string | null = null;
      if (artifactId) {
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

  return { appendObservationBatch, evidenceScopeIdFor, resolveActivationOccurrenceRef };
}

/** Process-wide default ingress (stateless apart from the scope-id cache). */
let defaultIngress: InterventionEvidenceIngress | null = null;

export function getInterventionEvidenceIngress(): InterventionEvidenceIngress {
  if (!defaultIngress) defaultIngress = createInterventionEvidenceIngress();
  return defaultIngress;
}
