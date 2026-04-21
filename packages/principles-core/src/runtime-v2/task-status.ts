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
import type { PDErrorCategory } from './error-categories.js';

// ── Task Status ──

/**
 * The canonical task status model for PD Runtime v2.
 *
 * State transitions:
 *   pending → leased → succeeded
 *                     → retry_wait → pending (via lease expiry recovery)
 *                     → failed
 */
export const PDTaskStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('leased'),
  Type.Literal('succeeded'),
  Type.Literal('retry_wait'),
  Type.Literal('failed'),
]);
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type PDTaskStatus = Static<typeof PDTaskStatusSchema>;

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
  /** Last error category, if the task is in a failure-related state. */
  lastError: Type.Optional(PDErrorCategorySchema),
  /** Reference to the task's input data. */
  inputRef: Type.Optional(Type.String()),
  /** Reference to the task's result data. */
  resultRef: Type.Optional(Type.String()),
});
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type TaskRecord = Static<typeof TaskRecordSchema>;

// ── Diagnostician-specific task record ──
// (extends TaskRecord with diagnosis-specific fields)

export const DiagnosticianTaskRecordSchema = Type.Intersect([
  TaskRecordSchema,
  Type.Object({
    taskKind: Type.Literal('diagnostician'),
    /** Pain signal that triggered this diagnosis. */
    sourcePainId: Type.Optional(Type.String()),
    /** Workspace directory for the diagnosis. */
    workspaceDir: Type.String(),
    /** Severity hint from the pain signal. */
    severity: Type.Optional(Type.String()),
    /** Source hint from the pain signal. */
    source: Type.Optional(Type.String()),
    /** Session ID hint for context assembly. */
    sessionIdHint: Type.Optional(Type.String()),
    /** Agent ID hint for context assembly. */
    agentIdHint: Type.Optional(Type.String()),
    /** Human-readable summary of why this task was created. */
    reasonSummary: Type.String(),
  }),
]);
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type DiagnosticianTaskRecord = Static<typeof DiagnosticianTaskRecordSchema>;
