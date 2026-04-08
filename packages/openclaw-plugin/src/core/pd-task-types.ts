/**
 * PD Task Manager Types
 *
 * Type definitions for the PD Task Manager — a declarative cron task
 * management system that reconciles PD task declarations with OpenClaw's
 * cron/jobs.json using safe file operations (lock + atomic write).
 */

// =========================================================================
// PDTaskSpec — Declaration Schema
// =========================================================================

/** Cron schedule for PD tasks (only "every" kind supported for now) */
export interface PDTaskSchedule {
  kind: 'every';
  everyMs: number;
}

/** Execution configuration for a PD task */
export interface PDTaskExecution {
  /** Which prompt builder to use */
  promptTemplate: string;
  /** Execution timeout in seconds (default: 120) */
  timeoutSeconds?: number;
  /** Use lightweight context to save tokens */
  lightContext?: boolean;
  /** Restrict available tools */
  toolsAllow?: string[];
}

/** Delivery configuration for task results */
export interface PDTaskDelivery {
  mode: 'none' | 'announce';
  channel?: string;
  to?: string;
}

/** Metadata — not synced to cron, used for health tracking */
export interface PDTaskMeta {
  /** When this task was first declared */
  createdAtMs?: number;
  /** Last successful reconcile timestamp */
  lastSyncedAtMs?: number;
  /** The cron job ID from last sync */
  lastSyncedJobId?: string;
  /** Last sync status */
  lastSyncStatus?: 'ok' | 'error';
  /** Last sync error message */
  lastSyncError?: string;
  /** Consecutive failure count (from CronJobState.consecutiveErrors) */
  consecutiveFailCount?: number;
  /** Timestamp of last failure */
  lastFailedAtMs?: number;
  /** Whether this task was auto-disabled due to health issues */
  autoDisabled?: boolean;
  /** When the task was auto-disabled */
  autoDisabledAt?: number;
  /** Reason for auto-disable */
  autoDisabledReason?: string;
  /** Last manual trigger timestamp */
  lastTriggeredAtMs?: number;
  /** Last manual trigger status */
  lastTriggerStatus?: 'succeeded' | 'failed' | 'pending';
}

/**
 * PDTaskSpec — A declarative specification for a PD background task.
 *
 * This is the source of truth. The reconciler translates these into
 * CronJob entries in OpenClaw's cron/jobs.json.
 */
export interface PDTaskSpec {
  /** Stable unique ID — never changes across versions */
  id: string;
  /** Human-readable name — becomes the CronJob name (must start with "PD ") */
  name: string;
  /** Description shown to users */
  description: string;
  /** Whether this task should be active */
  enabled: boolean;
  /** Schema version — bumped when prompt/config changes require re-sync */
  version: string;
  /** Cron schedule (only "every" kind supported for now) */
  schedule: PDTaskSchedule;
  /** OpenClaw agent ID to run under (default: "main") */
  agentId?: string;
  /** Execution configuration */
  execution: PDTaskExecution;
  /** Delivery configuration */
  delivery: PDTaskDelivery;
  /** Metadata — not synced to cron */
  meta?: PDTaskMeta;
}

// =========================================================================
// Builtin PD Tasks
// =========================================================================

/**
 * Built-in PD tasks declared by the plugin.
 *
 * These are reconciled on plugin startup. Adding a new task here
 * automatically creates the corresponding cron job on next restart.
 */
export const BUILTIN_PD_TASKS: PDTaskSpec[] = [
  {
    id: 'empathy-optimizer',
    name: 'PD Empathy Optimizer',
    description:
      'Analyzes recent user messages to discover new frustration expressions and optimize keyword weights.',
    enabled: true,
    version: '1.0.1', // Bumped to force cron job settings update
    schedule: {
      kind: 'every',
      everyMs: 5 * 60 * 1000, // 5 minutes (testing); increase to 6h once stable
    },
    agentId: 'main',
    execution: {
      promptTemplate: 'empathy-optimizer',
      timeoutSeconds: 300, // 5 min — needs time to scan events.jsonl
      lightContext: true,
      toolsAllow: ['read_file', 'write_file', 'search_file_content'],
    },
    delivery: {
      mode: 'none',
    },
  },
];
