/**
 * Centralized Runtime Defaults
 *
 * All runtime-related constants that were previously scattered across modules.
 * Centralizing these makes it easier to tune behavior and understand limits.
 */

// ── Time Constants ──────────────────────────────────────────────────────────────

/** Milliseconds per second */
export const MS_PER_SECOND = 1000;

/** Seconds per minute */
export const SECONDS_PER_MINUTE = 60;

/** Minutes per hour */
export const MINUTES_PER_HOUR = 60;

/** Hours per day */
export const HOURS_PER_DAY = 24;

/** Days per week */
export const DAYS_PER_WEEK = 7;

/** One minute in milliseconds */
export const ONE_MINUTE_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;

/** One hour in milliseconds */
export const ONE_HOUR_MS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** One day in milliseconds */
export const ONE_DAY_MS = HOURS_PER_DAY * ONE_HOUR_MS;

/** One week in milliseconds */
export const ONE_WEEK_MS = DAYS_PER_WEEK * ONE_DAY_MS;

// ── Workflow TTL & Timeouts ────────────────────────────────────────────────────

/** Default TTL for helper workflows (5 minutes) */
export const WORKFLOW_TTL_MS = 5 * ONE_MINUTE_MS;

/** Default workflow timeout (15 minutes) */
export const WORKFLOW_TIMEOUT_MS = 15 * ONE_MINUTE_MS;

/** Default workflow sweep interval (30 minutes) */
export const WORKFLOW_SWEEP_MS = 30 * ONE_MINUTE_MS;

// ── Trajectory Gate Block Retry Settings ──────────────────────────────────────

/**
 * Trajectory gate block retry settings
 * Used when trajectory recording fails and needs to retry
 */
export const TRAJECTORY_GATE_BLOCK_RETRY_DELAY_MS = 250;
export const TRAJECTORY_GATE_BLOCK_MAX_RETRIES = 3;

// ── Thinking Checkpoint Defaults (P-10) ───────────────────────────────────────

export const THINKING_CHECKPOINT_WINDOW_MS = 5 * ONE_MINUTE_MS;
export const THINKING_CHECKPOINT_DEFAULT_HIGH_RISK_TOOLS = [
  'run_shell_command',
  'delete_file',
  'move_file',
] as const;

// ── GFI Gate Thresholds ───────────────────────────────────────────────────────

/** Large change threshold for GFI gate adjustments */
export const GFI_LARGE_CHANGE_LINES = 50;

/** Agent spawn GFI threshold (critically high = no spawn) */
export const AGENT_SPAWN_GFI_THRESHOLD = 90;

// ── Evolution Worker Settings ───────────────────────────────────────────────────

/** Evolution worker polling interval (15 minutes) */
export const EVOLUTION_WORKER_POLL_INTERVAL_MS = 15 * ONE_MINUTE_MS;

/** Evolution queue batch size */
export const EVOLUTION_QUEUE_BATCH_SIZE = 10;

/** Pain queue dedup window (30 minutes) */
export const PAIN_QUEUE_DEDUP_WINDOW_MS = 30 * ONE_MINUTE_MS;

// ── Session Tracker Settings ───────────────────────────────────────────────────

export const SESSION_TOKEN_WARNING_THRESHOLD = 8000;
export const SESSION_MAX_IDLE_MS = 30 * ONE_MINUTE_MS;

// ── Event Log Buffer Settings ───────────────────────────────────────────────────

export const EVENT_LOG_BUFFER_SIZE = 20;
export const EVENT_LOG_FLUSH_INTERVAL_MS = 30 * ONE_MINUTE_MS;

// ── Default Busy Timeout ───────────────────────────────────────────────────────

/** Default busy timeout for SQLite operations (5 seconds) */
export const DEFAULT_BUSY_TIMEOUT_MS = 5 * MS_PER_SECOND;

// ── Nocturnal Runtime Settings ─────────────────────────────────────────────────

/** Idle threshold (30 minutes) */
export const DEFAULT_IDLE_THRESHOLD_MS = 30 * ONE_MINUTE_MS;

/** Quota window (24 hours) */
export const DEFAULT_QUOTA_WINDOW_MS = ONE_DAY_MS;

/** Cool down period (30 minutes) */
export const DEFAULT_COOLDOWN_MS = 30 * ONE_MINUTE_MS;

// ── String & Size Limits ────────────────────────────────────────────────────────

/** Max string length for trajectory/event logs */
export const MAX_STRING_LENGTH = 1000;

/** Default max file size (10MB) */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

// ── Workflow TTL Settings ───────────────────────────────────────────────────────

/** Deep-reflect workflow TTL (10 minutes) */
export const DEEP_REFLECT_TTL_MS = 10 * ONE_MINUTE_MS;
