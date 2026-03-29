/**
 * Phase 3 Input Filter
 *
 * CRITICAL: evaluatePhase3Inputs() does NOT read or use evolution_directive.json
 * Directive is a compatibility-only display artifact, not a truth source.
 *
 * Phase 3 eligibility depends ONLY on:
 * - Queue truth (valid evolution samples from queue)
 *
 * Any directive file is ignored for eligibility decisions.
 *
 * THREE-LANE CLASSIFICATION:
 * - authoritative: Valid inputs that can be used for Phase 3 eligibility decisions
 * - reference_only: Valid evidence that must NOT be used as positive eligibility input
 *   (e.g., timeout-only outcomes - they indicate completion but not success)
 * - rejected: Invalid, corrupt, or policy-prohibited input
 */

/**
 * Classification for Phase 3 inputs.
 * - authoritative: Can be used for Phase 3 eligibility decisions
 * - reference_only: Valid data but not for eligibility (e.g., timeout outcomes)
 * - rejected: Invalid or corrupt data
 */
export type Phase3Classification = 'authoritative' | 'reference_only' | 'rejected';

export interface Phase3EvolutionInput {
  id?: string | null;
  status?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  resolution?: string | null;
}

export interface Phase3EvolutionSample {
  taskId: string;
  status: 'pending' | 'in_progress' | 'completed';
  startedAt: string | null;
  completedAt: string | null;
}

export interface Phase3ReferenceOnlySample {
  taskId: string;
  status: string;
  classification: 'timeout_only' | 'other_reference';
  reason: string;
}

export interface Phase3RejectedEvolutionSample {
  taskId: string | null;
  status: string | null;
  reasons: string[];
}

export interface Phase3InputFilterResult {
  queueTruthReady: boolean;
  phase3ShadowEligible: boolean;
  evolution: {
    eligible: Phase3EvolutionSample[];
    referenceOnly: Phase3ReferenceOnlySample[];
    rejected: Phase3RejectedEvolutionSample[];
  };
}

/**
 * Legacy queue statuses that are rejected for Phase 3
 */
const LEGACY_QUEUE_STATUSES = ['resolved', 'blocked', 'failed', 'cancelled', 'paused'];

function normalizeTaskId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeStatus(value: unknown): 'pending' | 'in_progress' | 'completed' | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'in_progress' || normalized === 'completed') return normalized;
  if (normalized === 'pending') return 'pending';
  return null;
}

/**
 * Checks if a status is a legacy value that should be rejected
 */
function isLegacyStatus(value: unknown): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return LEGACY_QUEUE_STATUSES.includes(normalized);
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : normalized;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Checks if a task has a timeout-only outcome (resolution indicates only timeout)
 */
function isTimeoutOnlyOutcome(item: Phase3EvolutionInput): boolean {
  const resolution = typeof item?.resolution === 'string' ? item.resolution.trim().toLowerCase() : '';
  return resolution === 'auto_completed_timeout';
}

/**
 * Evaluates Phase 3 readiness based on queue inputs.
 *
 * IMPORTANT: Does NOT use evolution_directive.json.
 * Directive is compatibility-only display artifact, not a truth source.
 * Queue is the only authoritative execution truth source for Phase 3.
 *
 * THREE-LANE CLASSIFICATION:
 * - authoritative: Valid inputs for Phase 3 eligibility
 * - reference_only: Valid evidence but not for eligibility (e.g., timeout outcomes)
 * - rejected: Invalid, corrupt, or policy-prohibited input
 *
 * @param queue - Evolution queue items to validate
 * @returns Phase 3 eligibility results
 */
export function evaluatePhase3Inputs(
  queue: Phase3EvolutionInput[]
): Phase3InputFilterResult {
  const eligible: Phase3EvolutionSample[] = [];
  const referenceOnly: Phase3ReferenceOnlySample[] = [];
  const rejected: Phase3RejectedEvolutionSample[] = [];
  const taskIdCounts = new Map<string, number>();

  for (const item of queue) {
    const taskId = normalizeTaskId(item?.id);
    if (!taskId) continue;
    taskIdCounts.set(taskId, (taskIdCounts.get(taskId) ?? 0) + 1);
  }

  for (const item of queue) {
    const taskId = normalizeTaskId(item?.id);
    const status = normalizeStatus(item?.status);
    const reasons: string[] = [];
    const startedAt = normalizeTimestamp(item?.started_at);
    const completedAt = normalizeTimestamp(item?.completed_at);

    // Check for legacy statuses first (before other status validation)
    if (isLegacyStatus(item?.status)) {
      reasons.push('legacy_queue_status');
    }

    // Check for null status separately
    if (item?.status === null) {
      reasons.push('missing_status');
    }

    if (!taskId) {
      reasons.push('missing_task_id');
    } else if ((taskIdCounts.get(taskId) ?? 0) > 1) {
      reasons.push('reused_task_id');
    }

    // Only add invalid_status if it's not a legacy status and not null
    if (!status && !isLegacyStatus(item?.status) && item?.status !== null) {
      reasons.push('invalid_status');
    }

    if (typeof item?.started_at === 'string' && item.started_at.trim() && !startedAt) {
      reasons.push('invalid_started_at');
    }

    if (typeof item?.completed_at === 'string' && item.completed_at.trim() && !completedAt) {
      reasons.push('invalid_completed_at');
    }

    if (status === 'in_progress' && !startedAt) {
      reasons.push('missing_started_at');
    }

    if (status === 'completed' && !completedAt) {
      reasons.push('missing_completed_at');
    }

    // Handle rejected items first
    if (reasons.length > 0) {
      rejected.push({
        taskId,
        status: typeof item?.status === 'string' ? item.status : null,
        reasons: dedupe(reasons),
      });
      continue;
    }

    if (!taskId || !status) {
      continue;
    }

    // Check for timeout-only outcomes (REFERENCE_ONLY, not rejected)
    // These are valid completions but shouldn't count as positive evidence
    if (status === 'completed' && isTimeoutOnlyOutcome(item)) {
      referenceOnly.push({
        taskId,
        status: 'completed',
        classification: 'timeout_only',
        reason: 'Task completed via timeout - valid execution but not positive capability evidence',
      });
      continue;
    }

    // Valid eligible sample
    eligible.push({
      taskId,
      status,
      startedAt,
      completedAt,
    });
  }

  // Queue is ready when:
  // 1. Queue has items
  // 2. No invalid/corrupt items (rejected is empty)
  // 3. Either eligible OR referenceOnly has items (valid data exists)
  // Note: referenceOnly (timeout outcomes) is valid data, just not positive evidence
  const hasValidData = eligible.length > 0 || referenceOnly.length > 0;
  const queueTruthReady = queue.length > 0 && rejected.length === 0 && hasValidData;
  const phase3ShadowEligible = queueTruthReady && eligible.length > 0;

  return {
    queueTruthReady,
    phase3ShadowEligible,
    evolution: {
      eligible,
      referenceOnly,
      rejected,
    },
  };
}
