/**
 * PITaskMetadata — Persistence & Hydration (PRI-65)
 *
 * Provides the core-owned serialization/hydration contract for PITaskRecord metadata.
 *
 * Problem: PITaskRecord extends TaskRecord with internalization fields
 * (dependencyTaskIds, channel, timeoutMs, inputArtifactRefs, outputArtifactRefs),
 * but SqliteTaskStore only persists base TaskRecord fields + diagnostic_json.
 * There is no second task store — PI metadata must travel inside diagnosticJson.
 *
 * Solution: Store PI metadata in diagnosticJson using a namespaced JSON envelope.
 * This module provides:
 *   - serializePITaskMetadata  (PITaskMetadata → JSON string for diagnosticJson)
 *   - parsePITaskMetadata      (JSON string → PITaskMetadata | null, fail closed)
 *   - hydratePITaskRecord      (TaskRecord from store → PITaskRecord | null, fail closed)
 *   - createPITaskDiagnosticJson (alias for serialize, explicit name for adapter use)
 *
 * Design principles:
 *   - All functions are pure / total — no exceptions thrown
 *   - Fail closed: invalid/missing data → null, not error
 *   - Optional fields (parentTaskId, correlationId) must be non-empty string if present
 *   - Namespaced key avoids collision with other diagnosticJson uses
 *
 * @see ADR-0003 Section 3.4
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */

import type { TaskRecord } from '../task-status.js';
import type {
  PITaskRecord,
  InternalizationChannel,
  ArtifactRef,
} from './peer-runner-contracts.js';
import { isInternalizationChannel, isRunnerKind } from './peer-runner-contracts.js';

/** Namespace key used inside diagnosticJson to isolate PI metadata. */
export const PI_METADATA_KEY = 'pi_metadata' as const;

/**
 * Evaluator repair payload (PRI-509).
 *
 * Carries the evaluator's structured feedback when decision === 'needs_revision'
 * so the seeded artificer repair task can address each required change instead
 * of regenerating blind. The metadata layer treats this as opaque; the
 * ArtificerRunner.buildContext reads it and constructs a pre-formatted
 * repairFeedback string for the prompt builder.
 *
 * Lineage (rc-6):
 *   - sourceArtificerArtifactId: the prior artificer artifact that was rejected
 *   - sourceEvaluatorTaskId: the evaluator task that returned needs_revision
 *
 * Loop state freshness (rc-7, EP-05, ERR-015/018/019):
 *   - repairIteration is written at task creation time, never inferred at read.
 *   - Round 1 = first repair (after initial evaluator needs_revision).
 *   - Round 2 = second repair (after first repair's evaluator needs_revision).
 *   - Max 2 rounds; a 3rd needs_revision fails loud via needs_human_review (EP-03).
 */
export interface RepairPayload {
  readonly requiredChanges: readonly string[];
  readonly concerns: readonly string[];
  readonly previousScore: number;
  readonly repairIteration: number;
  readonly sourceArtificerArtifactId: string;
  readonly sourceEvaluatorTaskId: string;
}

/**
 * PI-specific metadata stored inside TaskRecord.diagnosticJson.
 * All fields must be present except parentTaskId and correlationId (optional).
 */
export interface PITaskMetadata {
  dependencyTaskIds: string[];
  channel: InternalizationChannel;
  timeoutMs: number;
  inputArtifactRefs: ArtifactRef[];
  outputArtifactRefs: ArtifactRef[];
  parentTaskId?: string;
  correlationId?: string;
  rejectionCount?: number;
  /**
   * Prior adversarial replay failures to inject into a Round-2+ Artificer
   * prompt (RuleHost MVP, PRI-428). Set by runAdversarialLoop when a prior
   * Evaluator round returned needs_revision. Treated as opaque text by the
   * metadata layer; the ArtificerRunner forwards it to the prompt builder.
   */
  adversarialFeedback?: string;
  /**
   * Evaluator repair payload (PRI-509). Present only on artificer tasks seeded
   * by evaluator needs_revision. Carries the structured feedback
   * (requiredChanges/concerns/previousScore/repairIteration) so the artificer
   * can address each required change. Undefined on Round-1 artificer tasks.
   */
  repairPayload?: RepairPayload;
}

// ── Serialization ──────────────────────────────────────────────────────────────

/**
 * Serialize PITaskMetadata into a JSON string suitable for TaskRecord.diagnosticJson.
 * Uses a namespaced envelope: { "pi_metadata": { ... } }
 */
export function serializePITaskMetadata(metadata: PITaskMetadata): string {
  return JSON.stringify({
    [PI_METADATA_KEY]: {
      dependencyTaskIds: metadata.dependencyTaskIds,
      channel: metadata.channel,
      timeoutMs: metadata.timeoutMs,
      inputArtifactRefs: metadata.inputArtifactRefs,
      outputArtifactRefs: metadata.outputArtifactRefs,
      parentTaskId: metadata.parentTaskId,
      correlationId: metadata.correlationId,
      rejectionCount: metadata.rejectionCount,
      adversarialFeedback: metadata.adversarialFeedback,
      repairPayload: metadata.repairPayload,
    },
  });
}

/** Alias for serializePITaskMetadata — explicit name for adapter/consumer use. */
export const createPITaskDiagnosticJson = serializePITaskMetadata;

// ── ArtifactRef validation ─────────────────────────────────────────────────────

/**
 * Validates a value is a valid ArtifactRef { artifactType: string, ref: string }.
 * artifactType is accepted as any string — runtime validation of PIArtifactKind
 * is the caller's responsibility when creating the record.
 */
function isValidArtifactRef(value: unknown): value is ArtifactRef {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.artifactType === 'string' && r.artifactType.trim() !== '' &&
    typeof r.ref === 'string' && r.ref.trim() !== '';
}

/**
 * Validates a value is a valid RepairPayload (PRI-509).
 *
 * Trust boundary (rc-1, rc-2): repairPayload originates from evaluator LLM
 * output persisted into diagnosticJson. Treat as unknown and validate every
 * field before returning. No `as` casts that bypass validation.
 *
 * Validation rules:
 *   - requiredChanges: non-empty array of non-empty strings (rc-4)
 *   - concerns: array of non-empty strings (can be empty)
 *   - previousScore: finite number
 *   - repairIteration: positive integer (1 or 2)
 *   - sourceArtificerArtifactId: non-empty string
 *   - sourceEvaluatorTaskId: non-empty string
 */
function isValidRepairPayload(value: unknown): value is RepairPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  // rc-4: validate array elements are non-empty strings.
  if (!Array.isArray(p.requiredChanges) || p.requiredChanges.length === 0) return false;
  for (const c of p.requiredChanges) {
    if (typeof c !== 'string' || c.trim() === '') return false;
  }
  if (!Array.isArray(p.concerns)) return false;
  for (const c of p.concerns) {
    if (typeof c !== 'string' || c.trim() === '') return false;
  }
  if (typeof p.previousScore !== 'number' || !Number.isFinite(p.previousScore)) return false;
  if (typeof p.repairIteration !== 'number' || !Number.isInteger(p.repairIteration) || p.repairIteration < 1) return false;
  if (typeof p.sourceArtificerArtifactId !== 'string' || p.sourceArtificerArtifactId.trim() === '') return false;
  if (typeof p.sourceEvaluatorTaskId !== 'string' || p.sourceEvaluatorTaskId.trim() === '') return false;
  return true;
}

// ── Parsing ─────────────────────────────────────────────────────────────────────

/**
 * Parse a diagnosticJson string into PITaskMetadata.
 * Returns null on any parse/validation failure (fail closed).
 *
 * Validation rules:
 *   - Must be valid JSON
 *   - Must contain pi_metadata key with all required fields
 *   - channel must be a valid InternalizationChannel
 *   - parentTaskId / correlationId if present must be non-empty strings
 */
export function parsePITaskMetadata(diagnosticJson: string): PITaskMetadata | null {
  // Guard: must be non-empty string after trim
  const trimmed = diagnosticJson.trim();
  if (!trimmed) return null;

  let parsed: Record<string, unknown>;  
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rawMeta = parsed[PI_METADATA_KEY];
  if (!rawMeta || typeof rawMeta !== 'object' || rawMeta === null || Array.isArray(rawMeta)) return null;

  const m = rawMeta as Record<string, unknown>;

  // Required fields
  if (!Array.isArray(m.dependencyTaskIds)) return null;
  for (const id of m.dependencyTaskIds) {
    if (typeof id !== 'string') return null;
  }
  if (typeof m.channel !== 'string') return null;
  if (!isInternalizationChannel(m.channel)) return null;
  if (typeof m.timeoutMs !== 'number') return null;
  if (!Number.isFinite(m.timeoutMs) || m.timeoutMs <= 0) return null;
  if (!Array.isArray(m.inputArtifactRefs)) return null;
  if (!Array.isArray(m.outputArtifactRefs)) return null;

  // Validate each ArtifactRef element
  for (const ref of m.inputArtifactRefs) {
    if (!isValidArtifactRef(ref)) return null;
  }
  for (const ref of m.outputArtifactRefs) {
    if (!isValidArtifactRef(ref)) return null;
  }

  // Optional fields: if present, must be non-empty strings (null is not accepted)
  if (Object.hasOwn(m, 'parentTaskId') && m.parentTaskId !== undefined) {
    if (typeof m.parentTaskId !== 'string') return null;
    if (m.parentTaskId.trim() === '') return null;
  }
  if (Object.hasOwn(m, 'correlationId') && m.correlationId !== undefined) {
    if (typeof m.correlationId !== 'string') return null;
    if (m.correlationId.trim() === '') return null;
  }

  let rejectionCount = 0;
  if (Object.hasOwn(m, 'rejectionCount') && m.rejectionCount !== undefined) {
    if (typeof m.rejectionCount !== 'number' || !Number.isFinite(m.rejectionCount) || m.rejectionCount < 0) return null;
    rejectionCount = Math.floor(m.rejectionCount);
  }

  // adversarialFeedback (PRI-428): optional, non-empty string if present.
  if (Object.hasOwn(m, 'adversarialFeedback') && m.adversarialFeedback !== undefined) {
    if (typeof m.adversarialFeedback !== 'string') return null;
    if (m.adversarialFeedback.trim() === '') return null;
  }

  // repairPayload (PRI-509): optional, must pass full validation if present.
  // rc-3: if the key is present but the value is malformed, fail loud (return null)
  // rather than silently dropping the field — the caller will see a null metadata
  // and treat the task as non-PI, which surfaces the corruption.
  let repairPayload: RepairPayload | undefined;
  if (Object.hasOwn(m, 'repairPayload') && m.repairPayload !== undefined) {
    if (!isValidRepairPayload(m.repairPayload)) return null;
    ({ repairPayload } = m);
  }

  return {
    dependencyTaskIds: m.dependencyTaskIds as string[],
    channel: m.channel,
    timeoutMs: m.timeoutMs,
    inputArtifactRefs: m.inputArtifactRefs as ArtifactRef[],
    outputArtifactRefs: m.outputArtifactRefs as ArtifactRef[],
    parentTaskId: typeof m.parentTaskId === 'string' ? m.parentTaskId : undefined,
    correlationId: typeof m.correlationId === 'string' ? m.correlationId : undefined,
    rejectionCount,
    adversarialFeedback: typeof m.adversarialFeedback === 'string' ? m.adversarialFeedback : undefined,
    repairPayload,
  };
}

// ── Hydration ───────────────────────────────────────────────────────────────────

/**
 * Hydrate a raw TaskRecord (as returned by SqliteTaskStore.getTask or listTasks)
 * into a PITaskRecord by reading and parsing its diagnosticJson.
 *
 * Fail-closed: returns null for any non-RunnerKind taskKind
 * even if diagnosticJson contains valid pi_metadata. This prevents the
 * InternalizationOrchestrator from treating a non-PI task as a PITaskRecord.
 *
 * Returns null if:
 *   - taskKind is not a valid RunnerKind (PeerRunnerKind or DiagnosticianStageKind)
 *   - diagnosticJson is missing or whitespace
 *   - diagnosticJson is not valid JSON
 *   - pi_metadata key is missing or invalid
 *   - Any required PI field fails validation
 *   - Optional field present but not a non-empty string
 */
export function hydratePITaskRecord(task: TaskRecord): PITaskRecord | null {
  // Guard: reject non-runner task kinds — lineage/kind invariant
  // Accept both PeerRunnerKind and DiagnosticianStageKind
  if (!isRunnerKind(task.taskKind)) return null;

  // Read diagnosticJson from the runtime object (not typed on TaskRecord)
  const raw = task as Record<string, unknown>;
  const {diagnosticJson} = raw;
  if (!diagnosticJson || typeof diagnosticJson !== 'string') return null;

  const meta = parsePITaskMetadata(diagnosticJson);
  if (!meta) return null;

  // Merge base TaskRecord with PI metadata → PITaskRecord
  // Cast through unknown to satisfy TypeScript's spread-overlap rules
  return {
    ...task,
    dependencyTaskIds: meta.dependencyTaskIds,
    channel: meta.channel,
    timeoutMs: meta.timeoutMs,
    inputArtifactRefs: meta.inputArtifactRefs,
    outputArtifactRefs: meta.outputArtifactRefs,
    parentTaskId: meta.parentTaskId,
    correlationId: meta.correlationId,
    rejectionCount: meta.rejectionCount ?? 0,
    adversarialFeedback: meta.adversarialFeedback,
    repairPayload: meta.repairPayload,
  } as unknown as PITaskRecord;
}
