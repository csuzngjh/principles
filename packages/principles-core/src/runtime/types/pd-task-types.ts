/**
 * PD Task Manager Types
 *
 * Type definitions for the PD Task Manager — a declarative cron task
 * management system that reconciles PD task declarations with OpenClaw's
 * cron/jobs.json using safe file operations (lock + atomic write).
 */

import { Type, type Static } from '@sinclair/typebox';

// =========================================================================
// PDTaskSpec — Declaration Schema
// =========================================================================

/** Cron schedule for PD tasks (only "every" kind supported for now) */
export const PDTaskScheduleSchema = Type.Object({
  kind: Type.Literal('every'),
  everyMs: Type.Number({ minimum: 1000 }),
});
export type PDTaskSchedule = Static<typeof PDTaskScheduleSchema>;

/** Execution configuration for a PD task */
export const PDTaskExecutionSchema = Type.Object({
  /** Which prompt builder to use */
  promptTemplate: Type.String({ minLength: 1 }),
  /** Execution timeout in seconds (default: 120) */
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
  /** Use lightweight context to save tokens */
  lightContext: Type.Optional(Type.Boolean()),
  /** Restrict available tools */
  toolsAllow: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});
export type PDTaskExecution = Static<typeof PDTaskExecutionSchema>;

/** Delivery configuration for task results */
export const PDTaskDeliverySchema = Type.Object({
  mode: Type.Union([Type.Literal('none'), Type.Literal('announce')]),
  channel: Type.Optional(Type.String({ minLength: 1 })),
  to: Type.Optional(Type.String({ minLength: 1 })),
});
export type PDTaskDelivery = Static<typeof PDTaskDeliverySchema>;

/** Metadata — not synced to cron, used for health tracking */
export const PDTaskMetaSchema = Type.Object({
  /** When this task was first declared */
  createdAtMs: Type.Optional(Type.Number({ minimum: 0 })),
  /** Last successful reconcile timestamp */
  lastSyncedAtMs: Type.Optional(Type.Number({ minimum: 0 })),
  /** The cron job ID from last sync */
  lastSyncedJobId: Type.Optional(Type.String({ minLength: 1 })),
  /** Last sync status */
  lastSyncStatus: Type.Optional(Type.Union([Type.Literal('ok'), Type.Literal('error')])),
  /** Last sync error message */
  lastSyncError: Type.Optional(Type.String({ minLength: 1 })),
  /** Consecutive failure count (from CronJobState.consecutiveErrors) */
  consecutiveFailCount: Type.Optional(Type.Number({ minimum: 0 })),
  /** Timestamp of last failure */
  lastFailedAtMs: Type.Optional(Type.Number({ minimum: 0 })),
  /** Whether this task was auto-disabled due to health issues */
  autoDisabled: Type.Optional(Type.Boolean()),
  /** When the task was auto-disabled */
  autoDisabledAt: Type.Optional(Type.Number({ minimum: 0 })),
  /** Reason for auto-disable */
  autoDisabledReason: Type.Optional(Type.String({ minLength: 1 })),
  /** Last manual trigger timestamp */
  lastTriggeredAtMs: Type.Optional(Type.Number({ minimum: 0 })),
  /** Last manual trigger status */
  lastTriggerStatus: Type.Optional(Type.Union([Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('pending')])),
});
export type PDTaskMeta = Static<typeof PDTaskMetaSchema>;

/**
 * PDTaskSpec — A declarative specification for a PD background task.
 *
 * This is the source of truth. The reconciler translates these into
 * CronJob entries in OpenClaw's cron/jobs.json.
 */
export const PDTaskSpecSchema = Type.Object({
  /** Stable unique ID — never changes across versions */
  id: Type.String({ minLength: 1 }),
  /** Human-readable name — becomes the CronJob name (must start with "PD ") */
  name: Type.String({ minLength: 1 }),
  /** Description shown to users */
  description: Type.String({ minLength: 1 }),
  /** Whether this task should be active */
  enabled: Type.Boolean(),
  /** Schema version — bumped when prompt/config changes require re-sync */
  version: Type.String({ minLength: 1 }),
  /** Cron schedule (only "every" kind supported for now) */
  schedule: PDTaskScheduleSchema,
  /** OpenClaw agent ID to run under (default: "main") */
  agentId: Type.Optional(Type.String({ minLength: 1 })),
  /** Execution configuration */
  execution: PDTaskExecutionSchema,
  /** Delivery configuration */
  delivery: PDTaskDeliverySchema,
  /** Metadata — not synced to cron */
  meta: Type.Optional(PDTaskMetaSchema),
});
export type PDTaskSpec = Static<typeof PDTaskSpecSchema>;

// =========================================================================
// Builtin PD Tasks
// =========================================================================

/**
 * Built-in PD tasks declared by the plugin.
 *
 * These are reconciled on plugin startup. Adding a new task here
 * automatically creates the corresponding cron job on next restart.
 */
export const BUILTIN_PD_TASKS: PDTaskSpec[] = [];
