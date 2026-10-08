/**
 * SqliteInterventionEvidenceStore — normalized intervention evidence ledger
 * inside the existing workspace state.db (PD v2 Phase 1, ADR-0027 §2.2).
 *
 * One authority for the NEW fact kinds only: Principle/Approval/Activation
 * keep their existing stores untouched; raw host sources keep theirs. This
 * store owns evidence identity, association and the capability matrix —
 * appended atomically per batch, immutable per record.
 *
 * Idempotency & conflicts (SPEC §13.3): the natural key is
 * (source_kind, source_locator, observation_key). Replaying the same source
 * yields the same record_digest → duplicate no-op. The same key with a
 * different digest is a REPORTED source conflict; the original record is
 * never overwritten.
 *
 * The evidence writer is expected to use a dedicated SqliteConnection with
 * busyTimeoutMs: 0 — a busy lock surfaces as storage_unavailable
 * (nextAction: bounded replay) instead of delaying a hook. Evidence failure
 * must never change an already computed tool decision (ADR-0027 §2.4).
 */
import type Database from 'better-sqlite3';
import { PDRuntimeError } from '../error-categories.js';
import type { SqliteConnection } from './sqlite-connection.js';
import {
  INTERVENTION_EVIDENCE_TABLES,
} from './intervention-evidence-schema.js';
import { INTERVENTION_RECORD_KINDS, INTERVENTION_SOURCE_KINDS } from '../types/intervention-evidence-contract.js';
import type { NormalizedInterventionBatch } from '../intervention-evidence-normalizer.js';
import type {
  InterventionActivationOccurrenceRef,
  InterventionAuditRecordSummary,
  InterventionContentRef,
  InterventionNativeRefs,
  InterventionAuditRelations,
  InterventionAuditSelector,
  InterventionCapabilityDeclaration,
  InterventionRecordKind,
} from '../types/intervention-evidence-contract.js';
import {
  INTERVENTION_SHORT_RETENTION_SOURCE_KINDS,
  INTERVENTION_SHORT_SOURCE_RETENTION_DAYS,
  RECEIPT_RETENTION_POLICY_DAYS,
  interventionEvidenceSourcePolicy,
} from '../receipt-coverage.js';

export interface InterventionSourceConflict {
  observationKey: string;
  existingDigest: string;
  incomingDigest: string;
}

export interface AppendObservationBatchResult {
  /** false only when source conflicts were reported (inserted rows stay committed). */
  ok: boolean;
  insertedCount: number;
  duplicates: string[];
  conflicts: InterventionSourceConflict[];
  reason?: string;
  nextAction?: string;
}

export interface InterventionAuditReadOptions {
  /** Max records per kind section. Default 50, clamped to [1, 200]. */
  limit?: number;
  /** Resume one kind from the cursor returned in relations.pages. */
  cursor?: { kind: InterventionRecordKind; after: { recordedAt: string; evidenceId: string } };
}

export type InterventionAuditRead =
  | { available: true; relations: InterventionAuditRelations }
  | { available: false; reason: string; nextAction?: string };

const AUDIT_DEFAULT_LIMIT = 50;
const AUDIT_MAX_LIMIT = 200;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
function isValidAuditTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  return match !== null && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonColumn(column: string, rowId: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(column);
  } catch {
    throw new PDRuntimeError(
      'storage_unavailable',
      `Malformed intervention evidence row ${rowId}: JSON column is not parseable`,
      { nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.' },
    );
  }
  if (!isRecord(parsed)) {
    throw new PDRuntimeError(
      'storage_unavailable',
      `Malformed intervention evidence row ${rowId}: JSON column is not an object`,
      { nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.' },
    );
  }
  return parsed;
}

function requirePayloadField(payload: Record<string, unknown>, field: string, rowId: string): unknown {
  if (!Object.hasOwn(payload, field)) {
    throw new PDRuntimeError(
      'storage_unavailable',
      `Malformed intervention evidence row ${rowId}: payload is missing ${field}`,
      { nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.' },
    );
  }
  return payload[field];
}

const RECORD_KIND_SET: ReadonlySet<string> = new Set(INTERVENTION_RECORD_KINDS);
const SOURCE_KIND_SET: ReadonlySet<string> = new Set(INTERVENTION_SOURCE_KINDS);

/** rc-2: narrow a stored enum column through a real guard, never a cast. */
function narrowEnumColumn<T extends string>(spec: { value: unknown; allowed: ReadonlySet<string>; column: string; rowId: string }): T {
  const { value, allowed, column, rowId } = spec;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new PDRuntimeError(
      'storage_unavailable',
      `Malformed intervention evidence row ${rowId}: ${column} is outside the closed vocabulary (${String(value)})`,
      { nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.' },
    );
  }
  return value as T;
}

function strColumn(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new PDRuntimeError(
      'storage_unavailable',
      `Malformed intervention evidence row ${column}: expected a string column`,
      { nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.' },
    );
  }
  return value;
}

function strOrNullColumn(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseOptionalJsonColumn(column: unknown, rowId: string): Record<string, unknown> | undefined {
  if (column === null || column === undefined) return undefined;
  if (typeof column !== 'string') {
    throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${rowId}: JSON reference is not text`, {
      nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
    });
  }
  return parseJsonColumn(column, rowId);
}

function parseNativeRefs(column: unknown, rowId: string): InterventionNativeRefs {
  const raw = parseJsonColumn(typeof column === 'string' ? column : '', rowId);
  if (raw.hostKind !== 'openclaw' && raw.hostKind !== 'codex') {
    throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${rowId}: native host is invalid`, {
      nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
    });
  }
  const refs: InterventionNativeRefs = { hostKind: raw.hostKind };
  for (const key of ['sessionId', 'runId', 'turnId', 'toolCallId', 'toolName', 'rolloutIdentity'] as const) {
    const value = raw[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
        throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${rowId}: native ${key} is invalid`, {
          nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
        });
      }
      refs[key] = value;
    }
  }
  return refs;
}

function parseContentRef(column: unknown, rowId: string): InterventionContentRef | undefined {
  const raw = parseOptionalJsonColumn(column, rowId);
  if (!raw) return undefined;
  if (typeof raw.principleId !== 'string' || raw.principleId.length === 0 || raw.principleId.length > 256
    || (raw.resolution !== 'resolved' && raw.resolution !== 'revision_reference_unresolved')
    || (raw.payloadDigest !== undefined && (typeof raw.payloadDigest !== 'string' || !SHA256_RE.test(raw.payloadDigest)))
    || (raw.resolution === 'resolved' && (typeof raw.payloadDigest !== 'string' || !SHA256_RE.test(raw.payloadDigest)))) {
    throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${rowId}: content reference is invalid`, {
      nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
    });
  }
  const ref: InterventionContentRef = { principleId: raw.principleId, resolution: raw.resolution };
  if (typeof raw.payloadDigest === 'string') ref.payloadDigest = raw.payloadDigest;
  for (const key of ['artifactId', 'version', 'approvalRef'] as const) {
    const value = raw[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
        throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${rowId}: content ${key} is invalid`, {
          nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
        });
      }
      ref[key] = value;
    }
  }
  return ref;
}

function parseActivationRef(column: unknown, rowId: string): InterventionActivationOccurrenceRef | undefined {
  const raw = parseOptionalJsonColumn(column, rowId);
  if (!raw) return undefined;
  if (typeof raw.activationId !== 'string' || raw.activationId.length === 0 || raw.activationId.length > 256
    || typeof raw.sourceSnapshotDigest !== 'string' || !SHA256_RE.test(raw.sourceSnapshotDigest)
    || (raw.activatedAt !== undefined && !isValidAuditTimestamp(raw.activatedAt))) {
    throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${rowId}: activation reference is invalid`, {
      nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
    });
  }
  const ref: InterventionActivationOccurrenceRef = { activationId: raw.activationId, sourceSnapshotDigest: raw.sourceSnapshotDigest };
  for (const key of ['idempotencyKey', 'artifactId', 'channel', 'activatedAt'] as const) {
    const value = raw[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
        throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${rowId}: activation ${key} is invalid`, {
          nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
        });
      }
      ref[key] = value;
    }
  }
  return ref;
}

function redactPayloadText(recordKind: unknown, rawPayload: unknown, evidenceId: string): string | null {
  if (typeof recordKind !== 'string') return null;
  const payload = parseJsonColumn(typeof rawPayload === 'string' ? rawPayload : '', evidenceId);
  let changed = false;
  const remove = (key: string): void => {
    if (Object.hasOwn(payload, key)) {
      delete payload[key];
      changed = true;
    }
  };
  const replace = (key: string): void => {
    if (Object.hasOwn(payload, key) && payload[key] !== '[expired]') {
      payload[key] = '[expired]';
      changed = true;
    }
  };
  switch (recordKind) {
    case 'delivery':
      remove('failureReason'); remove('nonAttemptReason'); remove('unsupportedNote');
      break;
    case 'application':
      remove('claimText');
      break;
    case 'behavior_episode':
      remove('inputPreview'); remove('resultSummary'); replace('actionSummary');
      break;
    case 'effect':
      remove('disputeReason'); replace('observationSummary');
      break;
    case 'outcome':
      remove('feedbackText'); remove('actorId'); replace('observationSummary');
      break;
    default:
      throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${evidenceId}: record kind is invalid during retention`, {
        nextAction: 'Inspect the evidence ledger schema and preserve its raw source before retrying retention.',
      });
  }
  return changed ? JSON.stringify(payload) : null;
}

function redactCorrectionReason(value: unknown): string | null {
  return value !== null && value !== undefined && value !== '[expired]' ? '[expired]' : null;
}

function redactExpiredSensitivePayloads(db: Database.Database, asOf: Date): number {
  const receiptCutoff = new Date(asOf.getTime() - RECEIPT_RETENTION_POLICY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const shortSourceCutoff = new Date(asOf.getTime() - INTERVENTION_SHORT_SOURCE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`SELECT evidence_id, record_kind, payload_json, correction_reason
    FROM intervention_evidence_records
    WHERE ((source_kind IN (?, ?, ?) AND
            (recorded_at < ? OR (occurred_at < ? AND occurred_at < recorded_at))) OR
           (source_kind NOT IN (?, ?, ?) AND
            (recorded_at < ? OR (occurred_at < ? AND occurred_at < recorded_at))))
      AND (
        (content_redacted_at IS NULL AND (
          (record_kind = 'delivery' AND (json_type(payload_json, '$.failureReason') IS NOT NULL OR json_type(payload_json, '$.nonAttemptReason') IS NOT NULL OR json_type(payload_json, '$.unsupportedNote') IS NOT NULL)) OR
          (record_kind = 'application' AND json_type(payload_json, '$.claimText') IS NOT NULL) OR
          (record_kind = 'behavior_episode' AND (json_type(payload_json, '$.inputPreview') IS NOT NULL OR json_type(payload_json, '$.resultSummary') IS NOT NULL OR (json_type(payload_json, '$.actionSummary') IS NOT NULL AND json_extract(payload_json, '$.actionSummary') <> '[expired]'))) OR
          (record_kind = 'effect' AND (json_type(payload_json, '$.disputeReason') IS NOT NULL OR (json_type(payload_json, '$.observationSummary') IS NOT NULL AND json_extract(payload_json, '$.observationSummary') <> '[expired]'))) OR
          (record_kind = 'outcome' AND (json_type(payload_json, '$.feedbackText') IS NOT NULL OR json_type(payload_json, '$.actorId') IS NOT NULL OR (json_type(payload_json, '$.observationSummary') IS NOT NULL AND json_extract(payload_json, '$.observationSummary') <> '[expired]')))
        )) OR (correction_reason IS NOT NULL AND correction_reason <> '[expired]')
      )
    ORDER BY recorded_at ASC, evidence_id ASC LIMIT 200`).all(
      ...INTERVENTION_SHORT_RETENTION_SOURCE_KINDS,
      shortSourceCutoff,
      shortSourceCutoff,
      ...INTERVENTION_SHORT_RETENTION_SOURCE_KINDS,
      receiptCutoff,
      receiptCutoff,
    );
  const redact = db.prepare(`UPDATE intervention_evidence_records
    SET payload_json = ?, correction_reason = ?, content_redacted_at = COALESCE(content_redacted_at, ?)
    WHERE evidence_id = ? AND (content_redacted_at IS NULL OR (correction_reason IS NOT NULL AND correction_reason <> '[expired]'))`);
  let count = 0;
  const redactedAt = asOf.toISOString();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.evidence_id !== 'string') {
      throw new PDRuntimeError('storage_unavailable', 'Malformed intervention evidence row during retention sweep', {
        nextAction: 'Inspect the evidence ledger schema and preserve its raw source before retrying retention.',
      });
    }
    const payload = redactPayloadText(row.record_kind, row.payload_json, row.evidence_id);
    const correctionReason = redactCorrectionReason(row.correction_reason);
    if (payload !== null || correctionReason !== null) {
      count += redact.run(payload ?? String(row.payload_json), correctionReason ?? row.correction_reason ?? null, redactedAt, row.evidence_id).changes;
    }
  }
  return count;
}

function mapRowToSummary(row: unknown, existingKeys: ReadonlySet<string>): InterventionAuditRecordSummary & { pendingFields: { field: string; missingKey: string }[] } {
  // rc-1: SELECT rows arrive as unknown; every column is narrowed through a
  // guard before use, and out-of-vocabulary values fail loud as corruption.
  if (!isRecord(row)) {
    throw new PDRuntimeError(
      'storage_unavailable',
      'Malformed intervention evidence row: not an object',
      { nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.' },
    );
  }
  const evidenceId = strColumn(row, 'evidence_id');
  const recordKind = narrowEnumColumn<InterventionRecordKind>({ value: row.record_kind, allowed: RECORD_KIND_SET, column: 'record_kind', rowId: evidenceId });
  const sourceKind = narrowEnumColumn<InterventionAuditRecordSummary['sourceKind']>({ value: row.source_kind, allowed: SOURCE_KIND_SET, column: 'source_kind', rowId: evidenceId });
  let payload = parseJsonColumn(strColumn(row, 'payload_json'), evidenceId);
  const nativeRefs = parseNativeRefs(row.native_refs_json, evidenceId);
  const contentRef = parseContentRef(row.content_ref_json, evidenceId);
  const activationRef = parseActivationRef(row.activation_ref_json, evidenceId);
  let contentRedactedAt = strOrNullColumn(row, 'content_redacted_at') ?? undefined;
  const recordedAt = strColumn(row, 'recorded_at');
  const occurredAt = strOrNullColumn(row, 'occurred_at') ?? undefined;
  if (!isValidAuditTimestamp(recordedAt) || (occurredAt !== undefined && !isValidAuditTimestamp(occurredAt))) {
    throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${evidenceId}: source timestamp is invalid`, {
      nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
    });
  }
  if (Date.parse(recordedAt) > Date.now() + 5 * 60 * 1000 || (occurredAt !== undefined && Date.parse(occurredAt) > Date.parse(recordedAt) + 5 * 60 * 1000)) {
    throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${evidenceId}: future source timestamp cannot extend retention`, {
      nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
    });
  }
  const sourceTime = occurredAt && Date.parse(occurredAt) < Date.parse(recordedAt) ? occurredAt : recordedAt;
  const { retentionDays, sourceStatus } = interventionEvidenceSourcePolicy(sourceKind);
  const expiresAt = Date.parse(sourceTime) + retentionDays * 24 * 60 * 60 * 1000;
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    const redactedPayload = redactPayloadText(recordKind, JSON.stringify(payload), evidenceId);
    const redactedCorrectionReason = redactCorrectionReason(row.correction_reason);
    if (redactedPayload !== null) {
      payload = parseJsonColumn(redactedPayload, evidenceId);
    }
    if (redactedPayload !== null || redactedCorrectionReason !== null) contentRedactedAt ??= new Date(expiresAt).toISOString();
  }
  if (contentRedactedAt !== undefined) {
    if (!isValidAuditTimestamp(contentRedactedAt) || Date.parse(contentRedactedAt) > Date.now() + 5 * 60 * 1000) {
      throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${evidenceId}: redaction timestamp is invalid`, {
        nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
      });
    }
    const stillSensitive = redactPayloadText(recordKind, JSON.stringify(payload), evidenceId);
    if (stillSensitive !== null) {
      throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${evidenceId}: redacted row still contains sensitive text`, {
        nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
      });
    }
  }
  const principleId = strOrNullColumn(row, 'principle_id') ?? undefined;
  const activationId = strOrNullColumn(row, 'activation_id') ?? undefined;
  if (contentRef && principleId !== undefined && contentRef.principleId !== principleId) {
    throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${evidenceId}: content reference principle does not match record`, {
      nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
    });
  }
  if (activationRef && activationRef.activationId !== activationId) {
    throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${evidenceId}: activation occurrence does not match record`, {
      nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
    });
  }
  if (activationRef?.activatedAt && occurredAt !== undefined && Date.parse(activationRef.activatedAt) > Date.parse(occurredAt)) {
    throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${evidenceId}: activation occurs after referenced evidence`, {
      nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
    });
  }
  if (contentRef?.artifactId && activationRef?.artifactId && contentRef.artifactId !== activationRef.artifactId) {
    throw new PDRuntimeError('storage_unavailable', `Malformed intervention evidence row ${evidenceId}: content and activation artifacts differ`, {
      nextAction: 'The ledger row is corrupted; preserve the raw source, then quarantine and re-record from the durable source batch.',
    });
  }
  // Minimal per-kind structural check before the typed read: full validation
  // happened at ingress time; this only fails loud on ledger corruption
  // instead of trusting stored JSON blind (rc-2).
  if (recordKind === 'delivery') {
    requirePayloadField(payload, 'targetKind', evidenceId);
    requirePayloadField(payload, 'confirmation', evidenceId);
    requirePayloadField(payload, 'outcome', evidenceId);
  } else if (recordKind === 'application') {
    requirePayloadField(payload, 'proofMethod', evidenceId);
    requirePayloadField(payload, 'action', evidenceId);
  } else if (recordKind === 'behavior_episode') {
    requirePayloadField(payload, 'status', evidenceId);
    requirePayloadField(payload, 'actionSummary', evidenceId);
  } else if (recordKind === 'effect') {
    requirePayloadField(payload, 'status', evidenceId);
    requirePayloadField(payload, 'observationSummary', evidenceId);
  } else if (recordKind === 'outcome') {
    requirePayloadField(payload, 'outcomeSource', evidenceId);
    requirePayloadField(payload, 'observationSummary', evidenceId);
  }
  // Every payload member was presence-checked per kind above; this narrows VALIDATED data (the union type has no guard form).
  // runtime-contract-exempt: ERR-001 payload-union narrowing after per-kind field validation — see the checks immediately above
  const typedPayload = payload as unknown as InterventionAuditRecordSummary['payload'];

  const deliveryKey = strOrNullColumn(row, 'delivery_key');
  const episodeKey = strOrNullColumn(row, 'episode_key');
  const effectKey = strOrNullColumn(row, 'effect_key');
  const correctionOf = strOrNullColumn(row, 'correction_of');
  const pendingFields: { field: string; missingKey: string }[] = [];
  if (contentRef?.resolution === 'revision_reference_unresolved') {
    pendingFields.push({ field: 'contentRef', missingKey: `revision:${contentRef.principleId}` });
  }
  for (const [field, key] of [
    ['deliveryKey', deliveryKey],
    ['episodeKey', episodeKey],
    ['effectKey', effectKey],
    ['correctionOf', correctionOf],
  ] as const) {
    if (key !== null && !existingKeys.has(key)) {
      pendingFields.push({ field, missingKey: key });
    }
  }
  if (activationId !== undefined && activationRef === undefined) {
    pendingFields.push({ field: 'activationRef', missingKey: activationId });
  }

  return {
    evidenceId,
    kind: recordKind,
    observationKey: strColumn(row, 'observation_key'),
    sourceKind,
    sourceLocator: strColumn(row, 'source_locator'),
    recordedAt,
    occurredAt,
    principleId,
    activationId,
    deliveryKey: deliveryKey ?? undefined,
    episodeKey: episodeKey ?? undefined,
    effectKey: effectKey ?? undefined,
    correctionOf: correctionOf ?? undefined,
    nativeRefs,
    ...(contentRef ? { contentRef } : {}),
    ...(activationRef ? { activationRef } : {}),
    ...(contentRedactedAt ? { contentRedactedAt } : {}),
    ...(sourceStatus ? { sourceStatus } : {}),
    payload: typedPayload,
    recordDigest: strColumn(row, 'record_digest'),
    associationStatus: pendingFields.length === 0 ? 'linked' : 'pending_association',
    pendingFields,
  };
}

function readCapabilityDeclarations(db: Database.Database): InterventionCapabilityDeclaration[] {
  const rows = db.prepare(
    'SELECT host_kind, capability, status, adapter_version, channel, max_confirmation, note FROM intervention_capability_declarations',
  ).all();
  const declarations: InterventionCapabilityDeclaration[] = [];
  for (const rawRow of rows) {
    if (!isRecord(rawRow)) continue;
    const declaration: InterventionCapabilityDeclaration = {
      hostKind: rawRow.host_kind as 'openclaw' | 'codex',
      capability: rawRow.capability as InterventionCapabilityDeclaration['capability'],
      status: rawRow.status as InterventionCapabilityDeclaration['status'],
      adapterVersion: typeof rawRow.adapter_version === 'string' ? rawRow.adapter_version : '',
      channel: typeof rawRow.channel === 'string' ? rawRow.channel : '',
    };
    if (typeof rawRow.max_confirmation === 'string') {
      declaration.maxConfirmation = rawRow.max_confirmation as InterventionCapabilityDeclaration['maxConfirmation'];
    }
    if (typeof rawRow.note === 'string') declaration.note = rawRow.note;
    declarations.push(declaration);
  }
  return declarations;
}

function interventionEvidenceTablesExist(db: Database.Database): boolean {
  const check = db.prepare(
    "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  for (const table of INTERVENTION_EVIDENCE_TABLES) {
    const row = check.get(table);
    if (!isRecord(row) || row.cnt !== 1) return false;
  }
  return true;
}

export class SqliteInterventionEvidenceStore {
  constructor(private readonly connection: SqliteConnection) {}

  /** Returns the workspace evidence scope, or null when not yet established. */
  getEvidenceScope(): { scopeId: string; establishedAt: string } | null {
    const db = this.connection.getDb();
    if (!interventionEvidenceTablesExist(db)) return null;
    const row = db.prepare('SELECT scope_id, established_at FROM intervention_evidence_scope LIMIT 1').get();
    if (!isRecord(row)) return null;
    const scopeId = typeof row.scope_id === 'string' ? row.scope_id : null;
    const establishedAt = typeof row.established_at === 'string' ? row.established_at : null;
    if (!scopeId || !establishedAt) return null;
    return { scopeId, establishedAt };
  }

  /**
   * Resolve the host that owns a behavior episode: the episode row's own
   * native_refs hostKind (an episode IS observed by exactly one host).
   * Returns null when the episode is absent or its stored refs are corrupt —
   * callers fall back to an explicit Unknown/derived marker, never a guess.
   */
  findEpisodeHostKind(episodeKey: string): 'openclaw' | 'codex' | null {
    const db = this.connection.getDb();
    if (!interventionEvidenceTablesExist(db)) return null;
    const row = db.prepare(
      `SELECT native_refs_json FROM intervention_evidence_records
       WHERE record_kind = 'behavior_episode' AND observation_key = ?
       ORDER BY recorded_at DESC, evidence_id DESC LIMIT 1`,
    ).get(episodeKey);
    if (!isRecord(row) || typeof row.native_refs_json !== 'string') return null;
    let refs: unknown;
    try {
      refs = JSON.parse(row.native_refs_json);
    } catch {
      return null;
    }
    if (!isRecord(refs)) return null;
    return refs.hostKind === 'openclaw' || refs.hostKind === 'codex' ? refs.hostKind : null;
  }

  /**
   * Append one normalized batch atomically. Scope is established on first
   * append; a batch from a different scope is rejected without writes.
   * Conflicting payloads under an existing natural key are reported — the
   * original stays intact and other records in the batch still commit.
   */
  appendObservationBatch(batch: NormalizedInterventionBatch): AppendObservationBatchResult {
    const db = this.connection.getDb();
    const insertRecord = db.prepare(`
      INSERT INTO intervention_evidence_records (
        evidence_id, scope_id, source_kind, observation_key, source_locator, record_kind,
        principle_id, activation_id, delivery_key, episode_key, effect_key,
        correction_of, correction_reason, occurred_at, recorded_at,
        native_refs_json, content_ref_json, activation_ref_json, payload_json, record_digest, content_redacted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const findExisting = db.prepare(`
      SELECT evidence_id, record_digest FROM intervention_evidence_records
      WHERE source_kind = ? AND source_locator = ? AND observation_key = ?
    `);
    const upsertCapability = db.prepare(`
      INSERT INTO intervention_capability_declarations (
        host_kind, capability, status, adapter_version, channel, max_confirmation, note, declared_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_kind, capability) DO UPDATE SET
        status = excluded.status,
        adapter_version = excluded.adapter_version,
        channel = excluded.channel,
        max_confirmation = excluded.max_confirmation,
        note = excluded.note,
        declared_at = excluded.declared_at
    `);

    let insertedCount = 0;
    const duplicates: string[] = [];
    const conflicts: InterventionSourceConflict[] = [];

    db.exec('BEGIN IMMEDIATE');
    try {
      const scopeRow = db.prepare('SELECT scope_id FROM intervention_evidence_scope LIMIT 1').get();
      if (isRecord(scopeRow) && typeof scopeRow.scope_id === 'string') {
        if (scopeRow.scope_id !== batch.evidenceScopeId) {
          db.exec('ROLLBACK');
          return {
            ok: false,
            insertedCount: 0,
            duplicates,
            conflicts,
            reason: `evidence_scope_mismatch:${scopeRow.scope_id}`,
            nextAction: `This state.db evidence ledger belongs to scope ${scopeRow.scope_id}; re-resolve the workspace to its canonical path (check symlinks, renames or bind mounts — evidenceScopeIdFor uses realpath) and replay the same batch, or inspect .pd/state.db ownership when two workspaces share one db file.`,
          };
        }
      } else {
        db.prepare('INSERT INTO intervention_evidence_scope (scope_id, established_at) VALUES (?, ?)')
          .run(batch.evidenceScopeId, batch.recordedAt);
      }

      // Reuse the existing receipt horizon at the evidence writer boundary.
      // Redaction is bounded and preserves the immutable identity/provenance
      // columns; there is no background process or caller-controlled bypass.
      redactExpiredSensitivePayloads(db, new Date());

      for (const record of batch.records) {
        const existing = findExisting.get(record.sourceKind, record.sourceLocator, record.observationKey);
        if (isRecord(existing)) {
          const existingDigest = typeof existing.record_digest === 'string' ? existing.record_digest : '';
          if (existingDigest === record.recordDigest) {
            duplicates.push(record.observationKey);
          } else {
            conflicts.push({
              observationKey: record.observationKey,
              existingDigest,
              incomingDigest: record.recordDigest,
            });
          }
          continue;
        }
        const recordTime = record.occurredAt && Date.parse(record.occurredAt) < Date.parse(record.recordedAt)
          ? record.occurredAt
          : record.recordedAt;
        const { retentionDays } = interventionEvidenceSourcePolicy(record.sourceKind);
        const expiresAt = Date.parse(recordTime) + retentionDays * 24 * 60 * 60 * 1000;
        let payloadJson = JSON.stringify(record.payload);
        let correctionReason: string | null = record.correctionReason ?? null;
        let contentRedactedAt: string | null = null;
        const insertedAt = new Date();
        if (Number.isFinite(expiresAt) && expiresAt <= insertedAt.getTime()) {
          const redactedPayload = redactPayloadText(record.kind, payloadJson, record.evidenceId);
          const redactedCorrectionReason = redactCorrectionReason(correctionReason);
          if (redactedPayload !== null || redactedCorrectionReason !== null) {
            payloadJson = redactedPayload ?? payloadJson;
            correctionReason = redactedCorrectionReason ?? correctionReason;
            contentRedactedAt = insertedAt.toISOString();
          }
        }
        insertRecord.run(
          record.evidenceId,
          record.evidenceScopeId,
          record.sourceKind,
          record.observationKey,
          record.sourceLocator,
          record.kind,
          record.principleId ?? null,
          record.activationRef?.activationId ?? record.activationId ?? null,
          record.deliveryKey ?? null,
          record.episodeKey ?? null,
          record.effectKey ?? null,
          record.correctionOf ?? null,
          correctionReason,
          record.occurredAt ?? null,
          record.recordedAt,
          JSON.stringify(record.nativeRefs),
          record.contentRef ? JSON.stringify(record.contentRef) : null,
          record.activationRef ? JSON.stringify(record.activationRef) : null,
          payloadJson,
          record.recordDigest,
          contentRedactedAt,
        );
        insertedCount += 1;
      }

      for (const declaration of batch.capabilityDeclarations) {
        upsertCapability.run(
          declaration.hostKind,
          declaration.capability,
          declaration.status,
          declaration.adapterVersion,
          declaration.channel,
          declaration.maxConfirmation ?? null,
          declaration.note ?? null,
          batch.recordedAt,
        );
      }

      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* best-effort: tx may already be rolled back */ }
      const busy = typeof error === 'object' && error !== null
        && (error as { code?: unknown }).code === 'SQLITE_BUSY';
      throw new PDRuntimeError(
        'storage_unavailable',
        busy
          ? 'Intervention evidence append hit a busy state.db lock (evidence writers never wait on locks).'
          : `Intervention evidence append failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          nextAction: busy
            ? 'The raw source remains durable; replay the same observation batch later — idempotency makes replay safe.'
            : 'The transaction rolled back atomically; the raw source remains durable. Retry the same batch after resolving the storage error.',
        },
      );
    }

    return {
      ok: conflicts.length === 0,
      insertedCount,
      duplicates,
      conflicts,
      ...(conflicts.length > 0
        ? {
            reason: `source_conflict:${conflicts.length}`,
            nextAction: 'A different payload arrived under an existing source key. The original record is preserved; inspect both digests from the durable sources before recording a correction.',
          }
        : {}),
    };
  }

  /**
   * Read-side for the four audit queries (SPEC §13.8). Read-only friendly:
   * on a state.db that predates the evidence tables this reports
   * unavailable instead of creating anything.
   */
  readAuditRelations(
    selector: InterventionAuditSelector,
    options: InterventionAuditReadOptions = {},
  ): InterventionAuditRead {
    const db = this.connection.getDb();
    if (!interventionEvidenceTablesExist(db)) {
      return {
        available: false,
        reason: 'evidence_schema_not_initialized',
        nextAction: 'Evidence tables are created on the first evidence write; run a host with evidence collection enabled, or verify the workspace has any intervention evidence yet.',
      };
    }
    const limit = Math.min(Math.max(options.limit ?? AUDIT_DEFAULT_LIMIT, 1), AUDIT_MAX_LIMIT);
    const evidenceColumns = db.prepare('PRAGMA table_info(intervention_evidence_records)').all();
    const hasRedactionColumn = evidenceColumns.some((column) => isRecord(column) && column.name === 'content_redacted_at');
    const redactedAtSelect = hasRedactionColumn ? 'content_redacted_at' : 'NULL AS content_redacted_at';
    const baseSelect = `
      SELECT evidence_id, scope_id, source_kind, observation_key, source_locator, record_kind,
             principle_id, activation_id, delivery_key, episode_key, effect_key,
             correction_of, correction_reason, occurred_at, recorded_at,
             native_refs_json, content_ref_json, activation_ref_json, payload_json, record_digest,
             ${redactedAtSelect}
      FROM intervention_evidence_records`;
    let selectorWhere: string;
    let selectorArgs: (string | number)[];
    switch (selector.type) {
      case 'principle':
        selectorWhere = 'principle_id = ?';
        selectorArgs = [selector.principleId];
        break;
      case 'activation':
        selectorWhere = 'activation_id = ?';
        selectorArgs = [selector.activationId];
        break;
      case 'episode':
        selectorWhere = '(observation_key = ? OR episode_key = ?)';
        selectorArgs = [selector.observationKey, selector.observationKey];
        break;
      case 'effect':
        selectorWhere = '(observation_key = ? OR effect_key = ?)';
        selectorArgs = [selector.observationKey, selector.observationKey];
        break;
    }
    const kinds: InterventionRecordKind[] = ['delivery', 'application', 'behavior_episode', 'effect', 'outcome'];
    const kindRows = new Map<InterventionRecordKind, unknown[]>();
    const pages: InterventionAuditRelations['pages'] = {
      delivery: { hasMore: false, nextCursor: null },
      application: { hasMore: false, nextCursor: null },
      behavior_episode: { hasMore: false, nextCursor: null },
      effect: { hasMore: false, nextCursor: null },
      outcome: { hasMore: false, nextCursor: null },
    };
    const selectorKind = (kind: InterventionRecordKind): string => {
      if (selector.type !== 'principle' && selector.type !== 'effect') return selectorWhere;
      if (kind !== 'outcome') return selectorWhere;
      // Outcome rows commonly have no principle/effect id of their own. Reach
      // them through exact episode references selected by the same query.
      return `(${selectorWhere} OR (record_kind = 'outcome' AND episode_key IN (
        SELECT episode_key FROM intervention_evidence_records WHERE ${selectorWhere} AND episode_key IS NOT NULL
      )))`;
    };
    for (const kind of kinds) {
      const cursor = options.cursor?.kind === kind ? options.cursor.after : undefined;
      const where = `record_kind = ? AND ${selectorKind(kind)}`;
      const cursorClause = cursor ? ' AND (recorded_at < ? OR (recorded_at = ? AND evidence_id < ?))' : '';
      const args: (string | number)[] = [kind, ...selectorArgs];
      if (kind === 'outcome' && (selector.type === 'principle' || selector.type === 'effect')) {
        args.push(...selectorArgs);
      }
      if (cursor) args.push(cursor.recordedAt, cursor.recordedAt, cursor.evidenceId);
      args.push(limit + 1);
      const fetched = db.prepare(`${baseSelect} WHERE ${where}${cursorClause} ORDER BY recorded_at DESC, evidence_id DESC LIMIT ?`).all(...args);
      const hasMore = fetched.length > limit;
      const pageRows = fetched.slice(0, limit);
      const last = pageRows.at(-1);
      pages[kind] = {
        hasMore,
        nextCursor: hasMore && isRecord(last)
          && typeof last.recorded_at === 'string' && typeof last.evidence_id === 'string'
          ? { recordedAt: last.recorded_at, evidenceId: last.evidence_id }
          : null,
      };
      kindRows.set(kind, pageRows);
    }
    const rows = kinds.flatMap((kind) => kindRows.get(kind) ?? []);

    const keyExists = db.prepare('SELECT 1 FROM intervention_evidence_records WHERE observation_key = ? LIMIT 1');
    // correctionOf cites an evidenceId, not an observation_key (contract
    // §correctionOf) — it needs its own existence probe.
    const evidenceExists = db.prepare('SELECT 1 FROM intervention_evidence_records WHERE evidence_id = ? LIMIT 1');
    const existingKeys = new Set<string>();
    const summaries: (InterventionAuditRecordSummary & { pendingFields: { field: string; missingKey: string }[] })[] = [];
    for (const rawRow of rows) {
      if (!isRecord(rawRow)) continue;
      for (const column of ['delivery_key', 'episode_key', 'effect_key', 'correction_of'] as const) {
        const key = rawRow[column];
        if (typeof key === 'string' && key.length > 0 && !existingKeys.has(key)) {
          const hit = column === 'correction_of' ? evidenceExists.get(key) : keyExists.get(key);
          if (isRecord(hit)) existingKeys.add(key);
        }
      }
      summaries.push(mapRowToSummary(rawRow, existingKeys));
    }

    const deliveries: InterventionAuditRecordSummary[] = [];
    const applications: InterventionAuditRecordSummary[] = [];
    const episodes: InterventionAuditRecordSummary[] = [];
    const effects: InterventionAuditRecordSummary[] = [];
    const outcomes: InterventionAuditRecordSummary[] = [];
    const unresolvedReferences: InterventionAuditRelations['unresolvedReferences'] = [];
    for (const summary of summaries) {
      const { pendingFields, ...plain } = summary;
      for (const pending of pendingFields) {
        unresolvedReferences.push({ evidenceId: summary.evidenceId, missingKey: pending.missingKey, field: pending.field });
      }
      switch (summary.kind) {
        case 'delivery': deliveries.push(plain); break;
        case 'application': applications.push(plain); break;
        case 'behavior_episode': episodes.push(plain); break;
        case 'effect': effects.push(plain); break;
        case 'outcome': outcomes.push(plain); break;
      }
    }

    return {
      available: true,
      relations: {
        selector,
        deliveries,
        applications,
        episodes,
        effects,
        outcomes,
        pages,
        unresolvedReferences,
        capabilityDeclarations: readCapabilityDeclarations(db),
        asOf: new Date().toISOString(),
      },
    };
  }
}
