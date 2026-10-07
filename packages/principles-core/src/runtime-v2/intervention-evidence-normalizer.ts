/**
 * Intervention Evidence Normalizer — deterministic validation and
 * canonicalization for the Phase 1 evidence ingress (ADR-0027 §2.2–2.4,
 * receipt-design SPEC §13.3–13.5).
 *
 * Trust boundary: a batch arrives as `unknown` runtime data (rc-1) and is
 * validated here — never `as`-cast past validation (rc-2), required facts
 * fail explicitly (rc-3), and unknown fields are rejected, not skipped.
 * Pure module: no I/O, no clocks, no randomness. Replaying the same source
 * batch yields the same normalized records, the same evidenceIds and the
 * same recordDigests — that determinism is what store-level idempotency and
 * source-conflict detection are built on.
 *
 * Cross-field rules deliberately encode the anti-forgery boundary:
 *   - `delivered` requires a confirmation ≥ host_accepted; prepared/submitted
 *     stay delivery-unknown attempts;
 *   - `runtime_verified` applications require a trusted activation reference
 *     AND an explicit enforcement boundary — an agent's self-report can never
 *     satisfy either;
 *   - effects require an exact episode reference; nothing is associated by
 *     session proximity or text similarity.
 */
import { createHash } from 'node:crypto';
import {
  DELIVERED_CONFIRMATIONS,
  INTERVENTION_CAPABILITIES,
  INTERVENTION_RECORD_KINDS,
  INTERVENTION_SOURCE_KINDS,
  INTERVENTION_TEXT_BOUNDS,
  type InterventionActivationOccurrenceRef,
  type InterventionApplicationAction,
  type InterventionApplicationPayload,
  type InterventionApplicationProof,
  type InterventionCapabilityDeclaration,
  type InterventionContentRef,
  type InterventionDeliveryOutcome,
  type InterventionDeliveryPayload,
  type InterventionEffectPayload,
  type InterventionEpisodePayload,
  type InterventionNativeRefs,
  type InterventionOutcomePayload,
  type InterventionPayload,
  type InterventionRecordKind,
  type InterventionSourceKind,
  type NormalizedInterventionRecord,
} from './types/intervention-evidence-contract.js';

export interface NormalizedInterventionBatch {
  evidenceScopeId: string;
  sourceKind: InterventionSourceKind;
  adapterVersion: string;
  recordedAt: string;
  records: NormalizedInterventionRecord[];
  capabilityDeclarations: InterventionCapabilityDeclaration[];
}

export type InterventionNormalization =
  | { ok: true; batch: NormalizedInterventionBatch }
  | { ok: false; reason: string };

const RECORD_KINDS = new Set<string>(INTERVENTION_RECORD_KINDS);
const SOURCE_KINDS = new Set<string>(INTERVENTION_SOURCE_KINDS);
const DELIVERED_CONFIRMATION_SET = new Set<string>(DELIVERED_CONFIRMATIONS);
const DELIVERY_OUTCOMES = new Set<string>(['attempted', 'delivered', 'failed', 'unsupported']);
const DELIVERY_TARGETS = new Set<string>(['agent_context', 'runtime_enforcement']);
const CONFIRMATIONS = new Set<string>(['prepared', 'submitted', 'host_accepted', 'context_present', 'runtime_loaded']);
const PROOF_METHODS = new Set<string>(['agent_claimed', 'runtime_verified']);
const RUNTIME_VERIFIED_ACTIONS = new Set<string>(['tool_blocked', 'auto_correct_applied']);
const EPISODE_STATUSES = new Set<string>(['open', 'closed', 'interrupted']);
const EFFECT_STATUSES = new Set<string>(['observed', 'disputed', 'invalidated']);
const OUTCOME_SOURCES = new Set<string>(['authorized_result_observation', 'owner_feedback']);
const CAPABILITY_STATUSES = new Set<string>(['supported', 'unsupported', 'unknown']);
const CAPABILITY_SET = new Set<string>(INTERVENTION_CAPABILITIES);
const HOST_KINDS = new Set<string>(['openclaw', 'codex']);

const BATCH_KEYS = new Set([
  'evidenceScopeId', 'sourceKind', 'adapterVersion', 'recordedAt',
  'observations', 'capabilityDeclarations',
]);
const OBSERVATION_KEYS = new Set([
  'observationKey', 'sourceLocator', 'kind', 'occurredAt', 'nativeRefs',
  'principleId', 'contentRef', 'activationRef', 'deliveryKey', 'episodeKey',
  'effectKey', 'correctionOf', 'correctionReason', 'payload',
]);
const NATIVE_REF_KEYS = new Set([
  'hostKind', 'sessionId', 'runId', 'turnId', 'toolCallId', 'toolName', 'rolloutIdentity',
]);
const CONTENT_REF_KEYS = new Set([
  'principleId', 'artifactId', 'version', 'payloadDigest', 'approvalRef', 'resolution',
]);
const ACTIVATION_REF_KEYS = new Set([
  'activationId', 'idempotencyKey', 'artifactId', 'channel', 'activatedAt', 'sourceSnapshotDigest',
]);
const PAYLOAD_KEYS_BY_KIND: Record<InterventionRecordKind, Set<string>> = {
  delivery: new Set(['targetKind', 'confirmation', 'outcome', 'failureReason', 'nonAttemptReason', 'unsupportedNote']),
  application: new Set(['proofMethod', 'action', 'claimText', 'enforcementBoundary']),
  behavior_episode: new Set(['status', 'actionSummary', 'inputPreview', 'resultSummary']),
  effect: new Set(['status', 'observationSummary', 'disputeReason']),
  outcome: new Set(['outcomeSource', 'observationSummary', 'feedbackText', 'actorId']),
};
const CAPABILITY_KEYS = new Set(['hostKind', 'capability', 'status', 'adapterVersion', 'channel', 'maxConfirmation', 'note']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(obj: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return `${context}_unknown_field:${key}`;
  }
  return null;
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value);
}

/**
 * Bounded-string field checks bound to one error-context prefix (produced by
 * stringChecks so each helper stays within the 3-parameter lint bound).
 * `read` treats absent fields as absent; `require` turns absence into an
 * error and returns a placeholder value the caller must not use on error.
 */
interface StringChecks {
  read(obj: Record<string, unknown>, key: string, bound: number): { value?: string; error?: string };
  require(obj: Record<string, unknown>, key: string, bound: number): { value: string; error?: string };
}

function stringChecks(context: string): StringChecks {
  const read = (obj: Record<string, unknown>, key: string, bound: number): { value?: string; error?: string } => {
    if (!Object.hasOwn(obj, key) || obj[key] === undefined) return {};
    const val = obj[key];
    if (typeof val !== 'string') return { error: `${context}_${key}_not_a_string` };
    if (val.length === 0) return { error: `${context}_${key}_empty` };
    if (val.length > bound) return { error: `${context}_${key}_too_long:${val.length}>${bound}` };
    return { value: val };
  };
  return {
    read,
    require(obj: Record<string, unknown>, key: string, bound: number) {
      const raw = read(obj, key, bound);
      if (raw.error || raw.value === undefined) {
        return { value: '', error: raw.error ?? `${context}_${key}_missing` };
      }
      return { value: raw.value };
    },
  };
}

/** Enum field checks bound to one error-context prefix. */
interface EnumChecks {
  read<T extends string>(obj: Record<string, unknown>, key: string, allowed: ReadonlySet<string>): { value?: T; error?: string };
  require<T extends string>(obj: Record<string, unknown>, key: string, allowed: ReadonlySet<string>): { value: T; error?: string };
}

function enumChecks(context: string): EnumChecks {
  const read = <T extends string>(obj: Record<string, unknown>, key: string, allowed: ReadonlySet<string>): { value?: T; error?: string } => {
    if (!Object.hasOwn(obj, key) || obj[key] === undefined) return {};
    const val = obj[key];
    if (typeof val !== 'string' || !allowed.has(val)) {
      return { error: `${context}_${key}_invalid:${String(val)}` };
    }
    return { value: val as T };
  };
  return {
    read,
    require<T extends string>(obj: Record<string, unknown>, key: string, allowed: ReadonlySet<string>) {
      const raw = read<T>(obj, key, allowed);
      if (raw.error || raw.value === undefined) {
        return { value: '' as T, error: raw.error ?? `${context}_${key}_missing` };
      }
      return { value: raw.value };
    },
  };
}

/** Deterministic key minting for producers: joins parts with '|', mapping absent parts to '-'. */
export function mintObservationKey(parts: readonly (string | undefined)[]): string {
  return parts.map((p) => (p === undefined || p === '' ? '-' : p)).join('|');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Canonical JSON: recursively key-sorted, no whitespace — stable across replays. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function computeEvidenceId(sourceKind: string, sourceLocator: string, observationKey: string): string {
  return `sha256:${sha256Hex(`${sourceKind}|${sourceLocator}|${observationKey}`)}`;
}

/**
 * Record content fingerprint. Deliberately EXCLUDES evidenceId (derived from
 * the identity triple), evidenceScopeId (rewritten by the ingress to the
 * workspace scope) and recordedAt (batch record time): two observations of
 * the SAME fact recorded at different times or through different producer
 * scope placeholders are the same content — only a change in the observed
 * fact itself is a source conflict.
 */
const DIGEST_EXCLUDED_KEYS: ReadonlySet<string> = new Set(['evidenceId', 'evidenceScopeId', 'recordedAt']);

export function computeRecordDigest(record: Omit<NormalizedInterventionRecord, 'recordDigest'>): string {
  const factView: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!DIGEST_EXCLUDED_KEYS.has(key)) factView[key] = value;
  }
  return `sha256:${sha256Hex(canonicalJson(factView))}`;
}

function normalizeNativeRefs(raw: unknown): { value?: InterventionNativeRefs; error?: string } {
  if (!isRecord(raw)) return { error: 'observation_nativeRefs_not_an_object' };
  const err = rejectUnknownFields(raw, NATIVE_REF_KEYS, 'observation_nativeRefs');
  if (err) return { error: err };
  const enums = enumChecks('observation_nativeRefs');
  const strings = stringChecks('observation_nativeRefs');
  const hostKind = enums.require<'openclaw' | 'codex'>(raw, 'hostKind', HOST_KINDS);
  if (hostKind.error) return { error: hostKind.error };
  const value: InterventionNativeRefs = { hostKind: hostKind.value };
  for (const key of ['sessionId', 'runId', 'turnId', 'toolCallId', 'toolName', 'rolloutIdentity'] as const) {
    const field = strings.read(raw, key, 256);
    if (field.error) return { error: field.error };
    if (field.value !== undefined) value[key] = field.value;
  }
  return { value };
}

function normalizeContentRef(raw: unknown): { value?: InterventionContentRef; error?: string } {
  if (!isRecord(raw)) return { error: 'observation_contentRef_not_an_object' };
  const err = rejectUnknownFields(raw, CONTENT_REF_KEYS, 'observation_contentRef');
  if (err) return { error: err };
  const strings = stringChecks('observation_contentRef');
  const enums = enumChecks('observation_contentRef');
  const principleId = strings.require(raw, 'principleId', 256);
  if (principleId.error) return { error: principleId.error };
  const payloadDigest = strings.require(raw, 'payloadDigest', 256);
  if (payloadDigest.error) return { error: payloadDigest.error };
  const resolution = enums.require<'resolved' | 'revision_reference_unresolved'>(
    raw, 'resolution', new Set(['resolved', 'revision_reference_unresolved']),
  );
  if (resolution.error) return { error: resolution.error };
  const value: InterventionContentRef = {
    principleId: principleId.value,
    payloadDigest: payloadDigest.value,
    resolution: resolution.value,
  };
  for (const key of ['artifactId', 'version', 'approvalRef'] as const) {
    const field = strings.read(raw, key, 256);
    if (field.error) return { error: field.error };
    if (field.value !== undefined) value[key] = field.value;
  }
  return { value };
}

function normalizeActivationRef(raw: unknown): { value?: InterventionActivationOccurrenceRef; error?: string } {
  if (!isRecord(raw)) return { error: 'observation_activationRef_not_an_object' };
  const err = rejectUnknownFields(raw, ACTIVATION_REF_KEYS, 'observation_activationRef');
  if (err) return { error: err };
  const strings = stringChecks('observation_activationRef');
  const activationId = strings.require(raw, 'activationId', 256);
  if (activationId.error) return { error: activationId.error };
  const sourceSnapshotDigest = strings.require(raw, 'sourceSnapshotDigest', 256);
  if (sourceSnapshotDigest.error) return { error: sourceSnapshotDigest.error };
  const value: InterventionActivationOccurrenceRef = {
    activationId: activationId.value,
    sourceSnapshotDigest: sourceSnapshotDigest.value,
  };
  for (const key of ['idempotencyKey', 'artifactId', 'channel'] as const) {
    const field = strings.read(raw, key, 256);
    if (field.error) return { error: field.error };
    if (field.value !== undefined) value[key] = field.value;
  }
  if (Object.hasOwn(raw, 'activatedAt') && raw.activatedAt !== undefined) {
    if (typeof raw.activatedAt !== 'string' || !isIsoTimestamp(raw.activatedAt)) {
      return { error: 'observation_activationRef_activatedAt_not_iso_utc' };
    }
    value.activatedAt = raw.activatedAt;
  }
  return { value };
}

function normalizePayload(
  kind: InterventionRecordKind,
  raw: unknown,
): { value?: InterventionPayload; error?: string } {
  if (!isRecord(raw)) return { error: `observation_payload_${kind}_not_an_object` };
  const err = rejectUnknownFields(raw, PAYLOAD_KEYS_BY_KIND[kind], `observation_payload_${kind}`);
  if (err) return { error: err };
  const strings = stringChecks(`observation_payload_${kind}`);
  const enums = enumChecks(`observation_payload_${kind}`);

  if (kind === 'delivery') {
    const targetKind = enums.require<'agent_context' | 'runtime_enforcement'>(raw, 'targetKind', DELIVERY_TARGETS);
    if (targetKind.error) return { error: targetKind.error };
    const confirmation = enums.require<'prepared' | 'submitted' | 'host_accepted' | 'context_present' | 'runtime_loaded'>(
      raw, 'confirmation', CONFIRMATIONS,
    );
    if (confirmation.error) return { error: confirmation.error };
    const outcome = enums.require<InterventionDeliveryOutcome>(raw, 'outcome', DELIVERY_OUTCOMES);
    if (outcome.error) return { error: outcome.error };
    if (outcome.value === 'delivered' && !DELIVERED_CONFIRMATION_SET.has(confirmation.value)) {
      return { error: 'delivery_delivered_requires_confirmed_boundary' };
    }
    const value: InterventionDeliveryPayload = {
      targetKind: targetKind.value,
      confirmation: confirmation.value,
      outcome: outcome.value,
    };
    for (const key of ['failureReason', 'nonAttemptReason', 'unsupportedNote'] as const) {
      const field = strings.read(raw, key, INTERVENTION_TEXT_BOUNDS.reason);
      if (field.error) return { error: field.error };
      if (field.value !== undefined) value[key] = field.value;
    }
    if (value.outcome === 'failed' && !value.failureReason) {
      return { error: 'delivery_failed_requires_failure_reason' };
    }
    if (value.outcome === 'unsupported' && !value.unsupportedNote) {
      return { error: 'delivery_unsupported_requires_boundary_note' };
    }
    return { value };
  }

  if (kind === 'application') {
    const proofMethod = enums.require<InterventionApplicationProof>(raw, 'proofMethod', PROOF_METHODS);
    if (proofMethod.error) return { error: proofMethod.error };
    const action = enums.require<InterventionApplicationAction>(
      raw, 'action', new Set(['self_reported', 'tool_blocked', 'auto_correct_applied']),
    );
    if (action.error) return { error: action.error };
    const value: InterventionApplicationPayload = { proofMethod: proofMethod.value, action: action.value };
    const claim = strings.read(raw, 'claimText', INTERVENTION_TEXT_BOUNDS.claimText);
    if (claim.error) return { error: claim.error };
    if (claim.value !== undefined) value.claimText = claim.value;
    const boundary = strings.read(raw, 'enforcementBoundary', 128);
    if (boundary.error) return { error: boundary.error };
    if (boundary.value !== undefined) value.enforcementBoundary = boundary.value;
    if (proofMethod.value === 'runtime_verified') {
      if (!RUNTIME_VERIFIED_ACTIONS.has(action.value)) {
        return { error: 'runtime_verified_requires_runtime_action' };
      }
      if (!value.enforcementBoundary) {
        return { error: 'runtime_verified_requires_enforcement_boundary' };
      }
    } else {
      if (action.value !== 'self_reported') return { error: 'agent_claimed_requires_self_reported_action' };
      if (!value.claimText) return { error: 'agent_claimed_requires_claim_text' };
      if (value.enforcementBoundary !== undefined) {
        return { error: 'agent_claimed_forbids_enforcement_boundary' };
      }
    }
    return { value };
  }

  if (kind === 'behavior_episode') {
    const status = enums.require<'open' | 'closed' | 'interrupted'>(raw, 'status', EPISODE_STATUSES);
    if (status.error) return { error: status.error };
    const actionSummary = strings.require(raw, 'actionSummary', INTERVENTION_TEXT_BOUNDS.summary);
    if (actionSummary.error) return { error: actionSummary.error };
    const value: InterventionEpisodePayload = { status: status.value, actionSummary: actionSummary.value };
    for (const key of ['inputPreview', 'resultSummary'] as const) {
      const field = strings.read(raw, key, INTERVENTION_TEXT_BOUNDS.summary);
      if (field.error) return { error: field.error };
      if (field.value !== undefined) value[key] = field.value;
    }
    return { value };
  }

  if (kind === 'effect') {
    const status = enums.require<'observed' | 'disputed' | 'invalidated'>(raw, 'status', EFFECT_STATUSES);
    if (status.error) return { error: status.error };
    const observationSummary = strings.require(raw, 'observationSummary', INTERVENTION_TEXT_BOUNDS.summary);
    if (observationSummary.error) return { error: observationSummary.error };
    const value: InterventionEffectPayload = { status: status.value, observationSummary: observationSummary.value };
    const dispute = strings.read(raw, 'disputeReason', INTERVENTION_TEXT_BOUNDS.reason);
    if (dispute.error) return { error: dispute.error };
    if (dispute.value !== undefined) value.disputeReason = dispute.value;
    if (status.value !== 'observed' && !value.disputeReason) {
      return { error: 'effect_disputed_or_invalidated_requires_dispute_reason' };
    }
    return { value };
  }

  // kind === 'outcome'
  const outcomeSource = enums.require<'authorized_result_observation' | 'owner_feedback'>(raw, 'outcomeSource', OUTCOME_SOURCES);
  if (outcomeSource.error) return { error: outcomeSource.error };
  const observationSummary = strings.require(raw, 'observationSummary', INTERVENTION_TEXT_BOUNDS.summary);
  if (observationSummary.error) return { error: observationSummary.error };
  const value: InterventionOutcomePayload = { outcomeSource: outcomeSource.value, observationSummary: observationSummary.value };
  const feedback = strings.read(raw, 'feedbackText', INTERVENTION_TEXT_BOUNDS.feedbackText);
  if (feedback.error) return { error: feedback.error };
  if (feedback.value !== undefined) value.feedbackText = feedback.value;
  const actor = strings.read(raw, 'actorId', 256);
  if (actor.error) return { error: actor.error };
  if (actor.value !== undefined) value.actorId = actor.value;
  if (outcomeSource.value === 'owner_feedback' && !value.actorId) {
    return { error: 'owner_feedback_requires_resolved_actor' };
  }
  return { value };
}

function normalizeObservation(
  raw: unknown,
  ctx: { sourceKind: InterventionSourceKind; evidenceScopeId: string; recordedAt: string },
): { value?: NormalizedInterventionRecord; error?: string } {
  if (!isRecord(raw)) return { error: 'observation_not_an_object' };
  const fieldErr = rejectUnknownFields(raw, OBSERVATION_KEYS, 'observation');
  if (fieldErr) return { error: fieldErr };
  const strings = stringChecks('observation');
  const enums = enumChecks('observation');

  const observationKey = strings.require(raw, 'observationKey', INTERVENTION_TEXT_BOUNDS.observationKey);
  if (observationKey.error) return { error: observationKey.error };
  const sourceLocator = strings.require(raw, 'sourceLocator', INTERVENTION_TEXT_BOUNDS.sourceLocator);
  if (sourceLocator.error) return { error: sourceLocator.error };
  const kind = enums.require<InterventionRecordKind>(raw, 'kind', RECORD_KINDS);
  if (kind.error) return { error: kind.error };

  const nativeRefs = normalizeNativeRefs(raw.nativeRefs);
  if (nativeRefs.error || !nativeRefs.value) return { error: nativeRefs.error ?? 'observation_nativeRefs_missing' };

  const payload = normalizePayload(kind.value, raw.payload);
  if (payload.error || !payload.value) return { error: payload.error ?? 'observation_payload_missing' };

  const record: Omit<NormalizedInterventionRecord, 'recordDigest'> = {
    evidenceId: computeEvidenceId(ctx.sourceKind, sourceLocator.value, observationKey.value),
    evidenceScopeId: ctx.evidenceScopeId,
    sourceKind: ctx.sourceKind,
    observationKey: observationKey.value,
    sourceLocator: sourceLocator.value,
    kind: kind.value,
    recordedAt: ctx.recordedAt,
    nativeRefs: nativeRefs.value,
    payload: payload.value,
  };

  if (Object.hasOwn(raw, 'occurredAt') && raw.occurredAt !== undefined) {
    if (typeof raw.occurredAt !== 'string' || !isIsoTimestamp(raw.occurredAt)) {
      return { error: 'observation_occurredAt_not_iso_utc' };
    }
    record.occurredAt = raw.occurredAt;
  }
  for (const key of ['principleId', 'deliveryKey', 'episodeKey', 'effectKey', 'correctionOf'] as const) {
    const field = strings.read(raw, key, INTERVENTION_TEXT_BOUNDS.observationKey);
    if (field.error) return { error: field.error };
    if (field.value !== undefined) (record as Record<string, unknown>)[key] = field.value;
  }
  const correctionReason = strings.read(raw, 'correctionReason', INTERVENTION_TEXT_BOUNDS.reason);
  if (correctionReason.error) return { error: correctionReason.error };
  if (correctionReason.value !== undefined) record.correctionReason = correctionReason.value;
  if ((record.correctionOf !== undefined) !== (record.correctionReason !== undefined)) {
    return { error: 'correction_requires_both_reference_and_reason' };
  }
  if (Object.hasOwn(raw, 'contentRef') && raw.contentRef !== undefined) {
    const contentRef = normalizeContentRef(raw.contentRef);
    if (contentRef.error || !contentRef.value) return { error: contentRef.error ?? 'observation_contentRef_invalid' };
    record.contentRef = contentRef.value;
  }
  if (Object.hasOwn(raw, 'activationRef') && raw.activationRef !== undefined) {
    const activationRef = normalizeActivationRef(raw.activationRef);
    if (activationRef.error || !activationRef.value) return { error: activationRef.error ?? 'observation_activationRef_invalid' };
    record.activationRef = activationRef.value;
  }

  // ── Cross-field relationship rules (SPEC §13.3) ──
  if (record.kind === 'delivery') {
    if (!record.contentRef || !record.activationRef) {
      return { error: 'delivery_requires_content_and_activation_reference' };
    }
  }
  if (record.kind === 'application') {
    const proof = (record.payload as InterventionApplicationPayload).proofMethod;
    if (proof === 'runtime_verified' && !record.activationRef) {
      return { error: 'runtime_verified_application_requires_activation_reference' };
    }
    if (!record.principleId) {
      return { error: 'application_requires_principle_reference' };
    }
  }
  if (record.kind === 'behavior_episode') {
    const refs = record.nativeRefs;
    const hasNativeEventKey = refs.toolCallId !== undefined
      || refs.turnId !== undefined
      || refs.runId !== undefined
      || refs.rolloutIdentity !== undefined;
    if (!hasNativeEventKey) {
      return { error: 'episode_requires_native_event_key' };
    }
  }
  if (record.kind === 'effect') {
    if (!record.episodeKey || !record.principleId || !record.contentRef) {
      return { error: 'effect_requires_episode_principle_and_content_reference' };
    }
    if (record.episodeKey === record.observationKey) {
      return { error: 'effect_cannot_reference_itself' };
    }
  }
  if (record.kind === 'outcome' && !record.episodeKey) {
    return { error: 'outcome_requires_episode_reference' };
  }

  return { value: { ...record, recordDigest: computeRecordDigest(record) } };
}

function normalizeCapabilityDeclaration(raw: unknown): { value?: InterventionCapabilityDeclaration; error?: string } {
  if (!isRecord(raw)) return { error: 'capability_not_an_object' };
  const err = rejectUnknownFields(raw, CAPABILITY_KEYS, 'capability');
  if (err) return { error: err };
  const strings = stringChecks('capability');
  const enums = enumChecks('capability');
  const hostKind = enums.require<'openclaw' | 'codex'>(raw, 'hostKind', HOST_KINDS);
  if (hostKind.error) return { error: hostKind.error };
  const capability = enums.require<InterventionCapabilityDeclaration['capability']>(raw, 'capability', CAPABILITY_SET);
  if (capability.error) return { error: capability.error };
  const status = enums.require<'supported' | 'unsupported' | 'unknown'>(raw, 'status', CAPABILITY_STATUSES);
  if (status.error) return { error: status.error };
  const adapterVersion = strings.require(raw, 'adapterVersion', INTERVENTION_TEXT_BOUNDS.adapterVersion);
  if (adapterVersion.error) return { error: adapterVersion.error };
  const channel = strings.require(raw, 'channel', 128);
  if (channel.error) return { error: channel.error };
  const value: InterventionCapabilityDeclaration = {
    hostKind: hostKind.value,
    capability: capability.value,
    status: status.value,
    adapterVersion: adapterVersion.value,
    channel: channel.value,
  };
  if (Object.hasOwn(raw, 'maxConfirmation') && raw.maxConfirmation !== undefined) {
    const confirmation = enums.require<'prepared' | 'submitted' | 'host_accepted' | 'context_present' | 'runtime_loaded'>(
      raw, 'maxConfirmation', CONFIRMATIONS,
    );
    if (confirmation.error) return { error: confirmation.error };
    value.maxConfirmation = confirmation.value;
  }
  const note = strings.read(raw, 'note', INTERVENTION_TEXT_BOUNDS.reason);
  if (note.error) return { error: note.error };
  if (note.value !== undefined) value.note = note.value;
  // SPEC §13.6: Supported requires a real proof reference — a bare "supported"
  // without an evidence citation is exactly the false capability this forbids.
  if (status.value === 'supported' && !value.note) {
    return { error: 'capability_supported_requires_proof_note' };
  }
  return { value };
}

/**
 * Validate and normalize one evidence batch. Never throws; the first
 * validation failure is returned as a stable reason string.
 */
export function normalizeInterventionEvidenceBatch(raw: unknown): InterventionNormalization {
  if (!isRecord(raw)) return { ok: false, reason: 'batch_is_not_an_object' };
  const fieldErr = rejectUnknownFields(raw, BATCH_KEYS, 'batch');
  if (fieldErr) return { ok: false, reason: fieldErr };

  const batchStrings = stringChecks('batch');
  const batchEnums = enumChecks('batch');
  const scopeId = batchStrings.require(raw, 'evidenceScopeId', INTERVENTION_TEXT_BOUNDS.evidenceScopeId);
  if (scopeId.error) return { ok: false, reason: scopeId.error };
  const sourceKind = batchEnums.require<InterventionSourceKind>(raw, 'sourceKind', SOURCE_KINDS);
  if (sourceKind.error) return { ok: false, reason: sourceKind.error };
  const adapterVersion = batchStrings.require(raw, 'adapterVersion', INTERVENTION_TEXT_BOUNDS.adapterVersion);
  if (adapterVersion.error) return { ok: false, reason: adapterVersion.error };
  if (!Object.hasOwn(raw, 'recordedAt') || typeof raw.recordedAt !== 'string' || !isIsoTimestamp(raw.recordedAt)) {
    return { ok: false, reason: 'batch_recordedAt_missing_or_not_iso_utc' };
  }

  if (!Array.isArray(raw.observations)) return { ok: false, reason: 'batch_observations_not_an_array' };
  if (raw.observations.length > 64) return { ok: false, reason: `batch_observations_too_large:${raw.observations.length}>64` };

  const ctx = { sourceKind: sourceKind.value, evidenceScopeId: scopeId.value, recordedAt: raw.recordedAt };
  const records: NormalizedInterventionRecord[] = [];
  const seenKeys = new Set<string>();
  for (const observationRaw of raw.observations) {
    const normalized = normalizeObservation(observationRaw, ctx);
    if (normalized.error || !normalized.value) {
      return { ok: false, reason: normalized.error ?? 'observation_invalid' };
    }
    const naturalKey = `${normalized.value.sourceKind}|${normalized.value.sourceLocator}|${normalized.value.observationKey}`;
    if (seenKeys.has(naturalKey)) {
      return { ok: false, reason: `batch_duplicate_observation_key:${normalized.value.observationKey}` };
    }
    seenKeys.add(naturalKey);
    records.push(normalized.value);
  }

  const capabilityDeclarations: InterventionCapabilityDeclaration[] = [];
  if (Object.hasOwn(raw, 'capabilityDeclarations') && raw.capabilityDeclarations !== undefined) {
    if (!Array.isArray(raw.capabilityDeclarations)) {
      return { ok: false, reason: 'batch_capabilityDeclarations_not_an_array' };
    }
    const seenCapabilities = new Set<string>();
    for (const capRaw of raw.capabilityDeclarations) {
      const cap = normalizeCapabilityDeclaration(capRaw);
      if (cap.error || !cap.value) return { ok: false, reason: cap.error ?? 'capability_invalid' };
      const capKey = `${cap.value.hostKind}|${cap.value.capability}`;
      if (seenCapabilities.has(capKey)) {
        return { ok: false, reason: `batch_duplicate_capability:${capKey}` };
      }
      seenCapabilities.add(capKey);
      capabilityDeclarations.push(cap.value);
    }
  }

  return {
    ok: true,
    batch: {
      evidenceScopeId: scopeId.value,
      sourceKind: sourceKind.value,
      adapterVersion: adapterVersion.value,
      recordedAt: ctx.recordedAt,
      records,
      capabilityDeclarations,
    },
  };
}
