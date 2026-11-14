/**
 * Execution timing contract — SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.1.
 *
 * The pipeline used to keep three unrelated budgets:
 *   - `BasePeerRunner` stage timeout (300 s default, never fed by the factory),
 *   - the split-pipeline parent budget (`3 × perStageTimeoutMs`),
 *   - the database lease TTL (300 s default, never renewed).
 *
 * A stage can therefore run exactly as long as its own lease and be reclaimed
 * by the per-cycle recovery sweep while still executing. This module makes the
 * three budgets explicit and derived from ONE input, so callers cannot drift:
 *
 *   stageTimeoutMs        max wall clock for one stage execution
 *   parentBudgetMs        max wall clock for A→B→C (>= stageTimeoutMs)
 *   leaseTtlMs            lease validity window, sustained by the heartbeat
 *   heartbeatIntervalMs   renewal cadence, strictly below leaseTtlMs
 *
 * The lease TTL is deliberately NOT the task's maximum duration: a long stage
 * is kept alive by renewals, which is the only way recovery can distinguish a
 * slow worker from a dead one.
 */

export interface ExecutionTimingInput {
  /** Max wall clock for one stage execution. */
  readonly stageTimeoutMs?: number;
  /** Max wall clock for the whole A→B→C pipeline. */
  readonly parentBudgetMs?: number;
  /** Lease validity window. */
  readonly leaseTtlMs?: number;
  /** Renewal cadence. Must stay strictly below `leaseTtlMs`. */
  readonly heartbeatIntervalMs?: number;
}

export interface ExecutionTiming {
  readonly stageTimeoutMs: number;
  readonly parentBudgetMs: number;
  /** How long the pipeline may hold one lease between conference calls. */
  readonly leaseTtlMs: number;
  readonly heartbeatIntervalMs: number;
}

/** First renewal happens after one interval; lease is 3× that by default. */
const DEFAULT_STAGE_TIMEOUT_MS = 300_000;
const DEFAULT_PARENT_BUDGET_MS = 900_000;
const DEFAULT_LEASE_TTL_MS = 120_000;
const MIN_HEARTBEAT_INTERVAL_MS = 10;
const MAX_HEARTBEAT_INTERVAL_MS = 60_000;

export const DEFAULT_EXECUTION_TIMING: ExecutionTiming = Object.freeze({
  stageTimeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
  parentBudgetMs: DEFAULT_PARENT_BUDGET_MS,
  leaseTtlMs: DEFAULT_LEASE_TTL_MS,
  heartbeatIntervalMs: Math.floor(DEFAULT_LEASE_TTL_MS / 3),
});

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Derive the renewal cadence from a lease TTL.
 *
 * A third of the TTL gives two failed renewals of slack before expiry, while the
 * 60 s ceiling keeps a very long lease from being renewed only rarely.
 */
export function deriveHeartbeatIntervalMs(leaseTtlMs: number): number {
  const raw = Math.floor(leaseTtlMs / 3);
  return Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.min(MAX_HEARTBEAT_INTERVAL_MS, raw));
}

/**
 * Resolve the timing contract from optional input.
 *
 * Missing/invalid values use the documented defaults (never `Infinity`). A
 * heartbeat interval configured at or above the lease TTL is clamped to half
 * the TTL: a renewal cadence that cannot beat expiry is not a valid contract,
 * and silently accepting it would recreate the very bug this module removes.
 */
export function resolveExecutionTiming(input: ExecutionTimingInput = {}): ExecutionTiming {
  const stageTimeoutMs = isPositiveFinite(input.stageTimeoutMs)
    ? input.stageTimeoutMs
    : DEFAULT_STAGE_TIMEOUT_MS;

  // Parent budget must cover at least one stage. An explicit value below the
  // stage timeout would make the pipeline budget expire mid-stage.
  const parentBudgetMs = isPositiveFinite(input.parentBudgetMs)
    ? Math.max(input.parentBudgetMs, stageTimeoutMs)
    : Math.max(DEFAULT_PARENT_BUDGET_MS, stageTimeoutMs);

  const leaseTtlMs = isPositiveFinite(input.leaseTtlMs)
    ? input.leaseTtlMs
    : DEFAULT_LEASE_TTL_MS;

  const derivedInterval = deriveHeartbeatIntervalMs(leaseTtlMs);
  const requestedInterval = isPositiveFinite(input.heartbeatIntervalMs)
    ? Math.floor(input.heartbeatIntervalMs)
    : derivedInterval;
  // Strictly below the TTL; half the TTL is the largest safe cadence.
  const maxSafeInterval = Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(leaseTtlMs / 2));
  const heartbeatIntervalMs = Math.max(
    MIN_HEARTBEAT_INTERVAL_MS,
    Math.min(requestedInterval, maxSafeInterval),
  );

  return { stageTimeoutMs, parentBudgetMs, leaseTtlMs, heartbeatIntervalMs };
}

/**
 * Stable, log-safe description of the effective contract. Used in the
 * `execution_timing_resolved` telemetry payload so an operator can see which
 * values actually applied instead of inferring them from defaults.
 */
export function describeExecutionTiming(timing: ExecutionTiming): ExecutionTiming {
  return { ...timing };
}
