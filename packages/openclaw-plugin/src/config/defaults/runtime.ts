/**
 * Centralized Runtime Defaults
 * 
 * All runtime-related constants that were previously scattered across modules.
 * Centralizing these makes it easier to tune behavior and understand limits.
 */

/**
 * Trajectory gate block retry settings
 * Used when trajectory recording fails and needs to retry
 */
export const TRAJECTORY_GATE_BLOCK_RETRY_DELAY_MS = 250;
export const TRAJECTORY_GATE_BLOCK_MAX_RETRIES = 3;

/**
 * Thinking checkpoint defaults (P-10)
 */
export const THINKING_CHECKPOINT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
export const THINKING_CHECKPOINT_DEFAULT_HIGH_RISK_TOOLS = [
  'run_shell_command',
  'delete_file', 
  'move_file',
] as const;

/**
 * Large change threshold for GFI gate adjustments
 */
export const GFI_LARGE_CHANGE_LINES = 50;

/**
 * Agent spawn GFI threshold (critically high = no spawn)
 */
export const AGENT_SPAWN_GFI_THRESHOLD = 90;

/**
 * Evolution worker polling intervals
 */
export const EVOLUTION_WORKER_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
export const EVOLUTION_QUEUE_BATCH_SIZE = 10;

/**
 * Session tracker settings
 */
export const SESSION_TOKEN_WARNING_THRESHOLD = 8000;
export const SESSION_MAX_IDLE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Event log buffer settings
 */
export const EVENT_LOG_BUFFER_SIZE = 20;
export const EVENT_LOG_FLUSH_INTERVAL_MS = 30 * 1000; // 30 seconds
