/**
 * Shadow Observation Registry — Runtime Shadow Evidence for Promotion Gate
 * =======================================================================
 *
 * PURPOSE: Track real-world runtime evidence from shadow deployments to inform
 * promotion gate decisions. Real evidence replaces eval verdict proxies.
 *
 * ARCHITECTURE:
 *   - Shadow observations are recorded by the routing system when a checkpoint
 *     is routed in shadow mode
 *   - Each observation captures whether the routing decision was accepted,
 *     rejected, or escalated by the runtime
 *   - The promotion gate queries this registry to get real arbiter/executability
 *     reject rates instead of using eval verdict as a proxy
 *
 * SHADOW OBSERVATION LIFECYCLE:
 *   1. Routing system routes task to shadow checkpoint (shadow_ready state)
 *   2. Observation recorded: { checkpointId, taskFingerprint, routedAt }
 *   3. Task completes or times out
 *   4. Observation updated: { completedAt, accepted/rejected/escalated, failureSignals }
 *   5. After sufficient observations, promotion gate can query real reject rates
 *
 * DATA RETENTION:
 *   - Observations are kept for 7 days by default
 *   - Can be queried by checkpointId, time window, or outcome
 *
 * DESIGN CONSTRAINTS:
 *   - Fail-closed: if no shadow evidence exists, fall back to eval proxies
 *   - Shadow evidence must be statistically significant (min sample size)
 *   - Observations are retained until cleanup removes expired entries
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { withLock } from '../utils/file-lock.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Registry file for shadow observations.
 */
const SHADOW_REGISTRY_FILE = 'shadow-registry.json';

/**
 * Default observation retention period in milliseconds.
 * 7 days
 */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimum number of shadow observations required before trusting the evidence.
 * Below this, we fall back to eval proxies.
 */
export const MIN_OBSERVATIONS_FOR_TRUST = 5;

/**
 * Time window for computing recent reject rates.
 * Only observations within this window are considered.
 * 24 hours
 */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Outcome of a shadow routing observation.
 */
export type ShadowOutcome = 'accepted' | 'rejected' | 'escalated';

/**
 * Runtime failure signals captured during shadow routing.
 */
export interface RuntimeFailureSignals {
  /** Whether the task timed out */
  timedOut: boolean;

  /** Whether an exception was thrown */
  threwException: boolean;

  /** Whether the output was empty or invalid */
  invalidOutput: boolean;

  /** Whether the worker profile rejected the routing */
  profileRejected: boolean;

  /** Additional failure signals (free-form for extensibility) */
  extra: Record<string, boolean>;
}

/**
 * A shadow observation — records a single shadow routing event.
 */
export interface ShadowObservation {
  /** Unique identifier for this observation */
  observationId: string;

  /** Checkpoint being routed to in shadow mode */
  checkpointId: string;

  /** Worker profile this observation is for */
  workerProfile: string;

  /** Task fingerprint (hash of task input for deduplication) */
  taskFingerprint: string;

  /** ISO-8601 timestamp when routing decision was made */
  routedAt: string;

  /** ISO-8601 timestamp when task completed (null if still pending) */
  completedAt?: string;

  /** Outcome of the shadow routing */
  outcome?: ShadowOutcome;

  /** Runtime failure signals (null if still pending) */
  failureSignals?: RuntimeFailureSignals;

  /** Whether this observation was used in a promotion gate evaluation */
  usedInGate?: boolean;
}

/**
 * Computed statistics from shadow observations.
 */
export interface ShadowStats {
  /** Checkpoint ID these stats are for */
  checkpointId: string;

  /** Total observations in the time window */
  totalCount: number;

  /** Count by outcome */
  acceptedCount: number;
  rejectedCount: number;
  escalatedCount: number;

  /** Computed rates */
  rejectRate: number;      // rejected / totalCount
  escalationRate: number;  // escalated / totalCount
  acceptanceRate: number;  // accepted / totalCount

  /** Failure signal frequencies */
  timedOutRate: number;
  threwExceptionRate: number;
  invalidOutputRate: number;
  profileRejectedRate: number;

  /** Whether this has enough data to trust */
  isStatisticallySignificant: boolean;

  /** Time window used for computation */
  windowStart: string;
  windowEnd: string;
}

/**
 * The complete shadow registry.
 */
export interface ShadowRegistry {
  observations: ShadowObservation[];

  /** Schema version for migration support */
  version: number;
}

// ---------------------------------------------------------------------------
// Registry Path
// ---------------------------------------------------------------------------

function getRegistryPath(stateDir: string): string {
  return path.join(stateDir, SHADOW_REGISTRY_FILE);
}

/**
 * Ensure the registry directory exists.
 */
function ensureRegistryDir(stateDir: string): void {
  const registryPath = getRegistryPath(stateDir);
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// File Operations
// ---------------------------------------------------------------------------

/**
 * Read the registry from disk. Returns empty registry if missing.
 */
function readRegistry(stateDir: string): ShadowRegistry {
  const registryPath = getRegistryPath(stateDir);
  if (!fs.existsSync(registryPath)) {
    return { observations: [], version: 1 };
  }
  try {
    const content = fs.readFileSync(registryPath, 'utf-8');
    return JSON.parse(content) as ShadowRegistry;
  } catch (err) {
    console.warn(`[shadow-observation-registry] Registry corrupted at ${registryPath}, recovering with empty state: ${String(err)}`);
    return { observations: [], version: 1 };
  }
}

/**
 * Write the registry to disk atomically.
 */
function writeRegistry(stateDir: string, registry: ShadowRegistry): void {
  ensureRegistryDir(stateDir);
  const registryPath = getRegistryPath(stateDir);
  const tmpPath = `${registryPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf-8');
  fs.renameSync(tmpPath, registryPath);
}

/**
 * Execute a read-modify-write under an exclusive file lock.
 */
/* eslint-disable no-unused-vars -- Reason: registry param name in type signature intentionally unused - actual function uses different param name */
function withShadowRegistryLock<T>(
  stateDir: string,
  fn: (_registry: ShadowRegistry) => T
): T {
/* eslint-enable no-unused-vars */
  const registryPath = getRegistryPath(stateDir);
  return withLock(registryPath, () => {
    const registry = readRegistry(stateDir);
    return fn(registry);
  });
}

// ---------------------------------------------------------------------------
// Observation Recording
// ---------------------------------------------------------------------------

/**
 * Parameters for recording a shadow routing observation.
 */
export interface RecordObservationParams {
  /** Checkpoint being routed to in shadow mode */
  checkpointId: string;

  /** Worker profile */
  workerProfile: string;

  /** Task fingerprint for deduplication */
  taskFingerprint: string;

  /** ISO-8601 timestamp when routing decision was made */
  routedAt?: string;
}

/**
 * Record a new shadow observation (when task is routed to shadow checkpoint).
 *
 * @param stateDir - Workspace state directory
 * @param params - Observation parameters
 * @returns The created ShadowObservation
 */
export function recordShadowRouting(
  stateDir: string,
  params: RecordObservationParams
): ShadowObservation {
  const observation: ShadowObservation = {
    observationId: crypto.randomUUID(),
    checkpointId: params.checkpointId,
    workerProfile: params.workerProfile,
    taskFingerprint: params.taskFingerprint,
    routedAt: params.routedAt ?? new Date().toISOString(),
  };

  return withShadowRegistryLock(stateDir, (registry) => {
    registry.observations.push(observation);
    writeRegistry(stateDir, registry);
    return observation;
  });
}

/**
 * Parameters for completing a shadow observation.
 */
export interface CompleteObservationParams {
  /** Observation ID to complete */
  observationId: string;

  /** Outcome of the shadow routing */
  outcome: ShadowOutcome;

  /** Runtime failure signals */
  failureSignals?: RuntimeFailureSignals;
}

/**
 * Complete a pending shadow observation (when task finishes).
 *
 * @param stateDir - Workspace state directory
 * @param params - Completion parameters
 * @returns The updated ShadowObservation, or null if not found
 */
export function completeShadowObservation(
  stateDir: string,
  params: CompleteObservationParams
): ShadowObservation | null {
  return withShadowRegistryLock(stateDir, (registry) => {
    const idx = registry.observations.findIndex(
      (o) => o.observationId === params.observationId
    );

    if (idx === -1) {
      return null;
    }

    const observation = registry.observations[idx];
    observation.completedAt = new Date().toISOString();
    observation.outcome = params.outcome;
    observation.failureSignals = params.failureSignals ?? {
      timedOut: false,
      threwException: false,
      invalidOutput: false,
      profileRejected: false,
      extra: {},
    };

    writeRegistry(stateDir, registry);
    return observation;
  });
}

/**
 * Complete a shadow observation by task fingerprint (alternative lookup).
 *
 * @param stateDir - Workspace state directory
 * @param taskFingerprint - Task fingerprint to look up
 * @param outcome - Outcome of the shadow routing
 * @param failureSignals - Runtime failure signals
 * @returns The updated ShadowObservation, or null if not found
 */
// eslint-disable-next-line @typescript-eslint/max-params -- Reason: shadow observation completion requires all 4 params - refactoring would break API
export function completeShadowObservationByTask(
  stateDir: string,
  taskFingerprint: string,
  outcome: ShadowOutcome,
  failureSignals?: RuntimeFailureSignals
): ShadowObservation | null {
  return withShadowRegistryLock(stateDir, (registry) => {
    // Find the oldest pending observation for this task
    const pendingObs = registry.observations
      .filter((o) => o.taskFingerprint === taskFingerprint && !o.completedAt)
      .sort((a, b) => a.routedAt.localeCompare(b.routedAt));

    if (pendingObs.length === 0) {
      return null;
    }

    const [observation] = pendingObs;
    observation.completedAt = new Date().toISOString();
    observation.outcome = outcome;
    observation.failureSignals = failureSignals ?? {
      timedOut: false,
      threwException: false,
      invalidOutput: false,
      profileRejected: false,
      extra: {},
    };

    writeRegistry(stateDir, registry);
    return observation;
  });
}

// ---------------------------------------------------------------------------
// Statistics Computation
// ---------------------------------------------------------------------------

/**
 * Parameters for computing shadow statistics.
 */
export interface ComputeShadowStatsParams {
  /** Checkpoint ID to compute stats for */
  checkpointId: string;

  /** Time window in milliseconds (default: RECENT_WINDOW_MS) */
  windowMs?: number;

  /** Retention period in milliseconds (default: DEFAULT_RETENTION_MS) */
  retentionMs?: number;
}

/**
 * Compute shadow routing statistics for a checkpoint.
 *
 * @param stateDir - Workspace state directory
 * @param params - Computation parameters
 * @returns ShadowStats with computed rates, or null if not enough data
 */
export function computeShadowStats(
  stateDir: string,
  params: ComputeShadowStatsParams
): ShadowStats | null {
  const {
    checkpointId,
    windowMs = RECENT_WINDOW_MS,
    retentionMs = DEFAULT_RETENTION_MS,
  } = params;

  const now = Date.now();
  const windowStart = new Date(now - windowMs).toISOString();
  const windowEnd = new Date(now).toISOString();

  return withShadowRegistryLock(stateDir, (registry) => {
    // Filter observations:
    // 1. For this checkpoint
    // 2. Within the time window
    // 3. Not expired (within retention period)
    const cutoff = new Date(now - retentionMs).toISOString();

    const relevantObs = registry.observations.filter((o) => {
      if (o.checkpointId !== checkpointId) return false;
      if (o.routedAt < cutoff) return false; // expired
      if (o.routedAt < windowStart) return false; // outside window
      if (!o.completedAt) return false; // still pending
      return true;
    });

    const totalCount = relevantObs.length;

    // Not enough data - fail closed (return null to use eval proxies)
    if (totalCount < MIN_OBSERVATIONS_FOR_TRUST) {
      return null;
    }

    const acceptedCount = relevantObs.filter((o) => o.outcome === 'accepted').length;
    const rejectedCount = relevantObs.filter((o) => o.outcome === 'rejected').length;
    const escalatedCount = relevantObs.filter((o) => o.outcome === 'escalated').length;

    // Failure signal counts
    const withTimedOut = relevantObs.filter((o) => o.failureSignals?.timedOut).length;
    const withThrewException = relevantObs.filter((o) => o.failureSignals?.threwException).length;
    const withInvalidOutput = relevantObs.filter((o) => o.failureSignals?.invalidOutput).length;
    const withProfileRejected = relevantObs.filter((o) => o.failureSignals?.profileRejected).length;

    const rejectRate = totalCount > 0 ? rejectedCount / totalCount : 0;
    const escalationRate = totalCount > 0 ? escalatedCount / totalCount : 0;
    const acceptanceRate = totalCount > 0 ? acceptedCount / totalCount : 0;

    return {
      checkpointId,
      totalCount,
      acceptedCount,
      rejectedCount,
      escalatedCount,
      rejectRate: Math.round(rejectRate * 1000) / 1000,
      escalationRate: Math.round(escalationRate * 1000) / 1000,
      acceptanceRate: Math.round(acceptanceRate * 1000) / 1000,
      timedOutRate: Math.round((withTimedOut / totalCount) * 1000) / 1000,
      threwExceptionRate: Math.round((withThrewException / totalCount) * 1000) / 1000,
      invalidOutputRate: Math.round((withInvalidOutput / totalCount) * 1000) / 1000,
      profileRejectedRate: Math.round((withProfileRejected / totalCount) * 1000) / 1000,
      isStatisticallySignificant: totalCount >= MIN_OBSERVATIONS_FOR_TRUST,
      windowStart,
      windowEnd,
    };
  });
}

/**
 * Query shadow observations for a checkpoint.
 *
 * @param stateDir - Workspace state directory
 * @param checkpointId - Checkpoint ID to query
 * @param limit - Maximum observations to return (default: 100)
 * @returns Array of shadow observations
 */
export function queryShadowObservations(
  stateDir: string,
  checkpointId: string,
  limit = 100
): ShadowObservation[] {
  return withShadowRegistryLock(stateDir, (registry) => {
    return registry.observations
      .filter((o) => o.checkpointId === checkpointId)
      .sort((a, b) => b.routedAt.localeCompare(a.routedAt)) // newest first
      .slice(0, limit);
  });
}

/**
 * Mark observations as used in a promotion gate evaluation.
 *
 * @param stateDir - Workspace state directory
 * @param observationIds - IDs of observations to mark
 */
export function markObservationsUsedInGate(
  stateDir: string,
  observationIds: string[]
): void {
  withShadowRegistryLock(stateDir, (registry) => {
    for (const obs of registry.observations) {
      if (observationIds.includes(obs.observationId)) {
        obs.usedInGate = true;
      }
    }
    writeRegistry(stateDir, registry);
  });
}

/**
 * Clean up expired observations (older than retention period).
 *
 * @param stateDir - Workspace state directory
 * @param retentionMs - Retention period in milliseconds (default: DEFAULT_RETENTION_MS)
 * @returns Number of observations removed
 */
export function cleanupExpiredObservations(
  stateDir: string,
  retentionMs: number = DEFAULT_RETENTION_MS
): number {
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  let removed = 0;

  withShadowRegistryLock(stateDir, (registry) => {
    const before = registry.observations.length;
    registry.observations = registry.observations.filter(
      (o) => o.routedAt >= cutoff
    );
    removed = before - registry.observations.length;
    writeRegistry(stateDir, registry);
  });

  return removed;
}