/**
 * Canonical task and run status types for PD Runtime v2.
 *
 * Source: PD Runtime Protocol SPEC v1, Section 12
 * Source: Diagnostician v2 Detailed Design, Section 7
 *
 * MIGRATION NOTE:
 *   - openclaw-plugin's QueueStatus ('in_progress', 'completed', 'canceled')
 *     is the LEGACY status model. New code uses PDTaskStatus.
 *   - principles-core's EvolutionTaskRecord.status (free-form string)
 *     will be migrated to PDTaskStatus in M2.
 *   - The new status model introduces 'leased' and 'retry_wait' which
 *     do not exist in the legacy model.
 */
import { Type, type Static } from '@sinclair/typebox';

import { PDErrorCategorySchema } from './error-categories.js';

// ── Task Status ──

/**
 * The canonical task status model for PD Runtime v2 (PRI-612 authority).
 *
 * State transitions:
 *   pending → leased → succeeded
 *                     → retry_wait → pending (via lease expiry recovery)
 *                     → failed
 *                     → needs_human_review (owner-attention terminal until recovered)
 */
export const PD_TASK_STATUSES = [
  'pending',
  'leased',
  'succeeded',
  'retry_wait',
  'failed',
  'needs_human_review',
] as const;

export type PDTaskStatus = (typeof PD_TASK_STATUSES)[number];

export const PDTaskStatusSchema = Type.Union([
  ...PD_TASK_STATUSES.map((status) => Type.Literal(status)),
]);

/** Runtime guard for untrusted status strings (DB rows, API payloads). */
export function isPDTaskStatus(value: unknown): value is PDTaskStatus {
  return typeof value === 'string' && (PD_TASK_STATUSES as readonly string[]).includes(value);
}

// ── Task Record ──

export const TaskRecordSchema = Type.Object({
  /** Unique task identifier. */
  taskId: Type.String({ minLength: 1 }),
  /** Kind of task (e.g., "diagnostician", "principle_candidate_intake"). */
  taskKind: Type.String({ minLength: 1 }),
  /** Current task status. */
  status: PDTaskStatusSchema,
  /** ISO timestamp of task creation. */
  createdAt: Type.String(),
  /** ISO timestamp of last status update. */
  updatedAt: Type.String(),
  /** Current lease owner identifier. */
  leaseOwner: Type.Optional(Type.String()),
  /** ISO timestamp when the current lease expires. */
  leaseExpiresAt: Type.Optional(Type.String()),
  /** Number of execution attempts made so far. */
  attemptCount: Type.Integer({ minimum: 0 }),
  /** Maximum number of attempts before forced failure. */
  maxAttempts: Type.Integer({ minimum: 1 }),
  /** Last error category, if the task is in a failure-related state. null when cleared (e.g. after successful retry). */
  lastError: Type.Optional(Type.Union([PDErrorCategorySchema, Type.Null()])),
  /** Reference to the task's input data. */
  inputRef: Type.Optional(Type.String()),
  /** Reference to the task's result data. */
  resultRef: Type.Optional(Type.String()),
  /** Diagnostic JSON payload (PI metadata, session hints, etc.). */
  diagnosticJson: Type.Optional(Type.String()),
});
export type TaskRecord = Static<typeof TaskRecordSchema>;

// ── Diagnostician-specific task record ──
// (extends TaskRecord with diagnosis-specific fields)

export const DiagnosticianTaskRecordSchema = Type.Intersect([
  TaskRecordSchema,
  Type.Object({
    taskKind: Type.Literal('diagnostician'),
    sourcePainId: Type.Optional(Type.String()),
    workspaceDir: Type.String(),
    severity: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
    sessionIdHint: Type.Optional(Type.String()),
    agentIdHint: Type.Optional(Type.String()),
    reasonSummary: Type.String(),
    provenance: Type.Optional(Type.Union([
      Type.Literal('host_context_bound'),
      Type.Literal('owner_reported_no_host_trace'),
      Type.Literal('automatic_hook'),
      // Legacy spelling persisted before Codex Governance Closure Slice B —
      // valid on read (normalized via normalizePainProvenance), never written.
      Type.Literal('openclaw_context_bound'),
    ])),
    hostKind: Type.Optional(Type.Union([Type.Literal('openclaw'), Type.Literal('codex')])),
    provenanceReason: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.Array(Type.Object({
      sourceRef: Type.String({ minLength: 1 }),
      note: Type.String({ minLength: 1, maxLength: 200 }),
    }))),
  }),
]);
export type DiagnosticianTaskRecord = Static<typeof DiagnosticianTaskRecordSchema>;
