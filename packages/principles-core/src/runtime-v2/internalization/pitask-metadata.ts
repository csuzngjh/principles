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
  if (m.parentTaskId !== undefined) {
    if (typeof m.parentTaskId !== 'string') return null;
    if (m.parentTaskId.trim() === '') return null;
  }
  if (m.correlationId !== undefined) {
    if (typeof m.correlationId !== 'string') return null;
    if (m.correlationId.trim() === '') return null;
  }

  let rejectionCount = 0;
  if (m.rejectionCount !== undefined) {
    if (typeof m.rejectionCount !== 'number' || !Number.isFinite(m.rejectionCount) || m.rejectionCount < 0) return null;
    rejectionCount = Math.floor(m.rejectionCount);
  }

  return {
    dependencyTaskIds: m.dependencyTaskIds as string[],
    channel: m.channel,
    timeoutMs: m.timeoutMs,
    inputArtifactRefs: m.inputArtifactRefs as ArtifactRef[],
    outputArtifactRefs: m.outputArtifactRefs as ArtifactRef[],
    parentTaskId: m.parentTaskId,
    correlationId: m.correlationId,
    rejectionCount,
  };
}

// ── Hydration ───────────────────────────────────────────────────────────────────

/**
 * Hydrate a raw TaskRecord (as returned by SqliteTaskStore.getTask or listTasks)
 * into a PITaskRecord by reading and parsing its diagnosticJson.
 *
 * Fail-closed: returns null for any non-peer-runner taskKind (e.g. diagnostician)
 * even if diagnosticJson contains valid pi_metadata. This prevents the
 * InternalizationOrchestrator from treating a non-PI task as a PITaskRecord.
 *
 * Returns null if:
 *   - taskKind is not a PeerRunnerKind (e.g. diagnostician)
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
  } as unknown as PITaskRecord;
}
