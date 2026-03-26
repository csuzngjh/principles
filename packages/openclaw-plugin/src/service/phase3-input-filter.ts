export interface Phase3EvolutionInput {
  id?: string | null;
  status?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  resolution?: string | null;
}

export interface Phase3TrustInput {
  score?: number | null;
  frozen?: boolean | null;
  lastUpdated?: string | null;
}

export interface Phase3EvolutionSample {
  taskId: string;
  status: 'pending' | 'in_progress' | 'completed';
  startedAt: string | null;
  completedAt: string | null;
}

export interface Phase3RejectedEvolutionSample {
  taskId: string | null;
  status: string | null;
  reasons: string[];
}

export interface Phase3TrustResult {
  eligible: boolean;
  rejectedReasons: string[];
}

export interface Phase3InputFilterResult {
  queueTruthReady: boolean;
  trustInputReady: boolean;
  phase3ShadowEligible: boolean;
  evolution: {
    eligible: Phase3EvolutionSample[];
    rejected: Phase3RejectedEvolutionSample[];
  };
  trust: Phase3TrustResult;
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

export function evaluatePhase3Inputs(
  queue: Phase3EvolutionInput[],
  trust: Phase3TrustInput
): Phase3InputFilterResult {
  const eligible: Phase3EvolutionSample[] = [];
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

    // Check for timeout-only outcomes (exclude from positive capability evidence)
    if (status === 'completed' && isTimeoutOnlyOutcome(item)) {
      reasons.push('timeout_only_outcome');
    }

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

    eligible.push({
      taskId,
      status,
      startedAt,
      completedAt,
    });
  }

  const trustRejectedReasons: string[] = [];
  const score = typeof trust.score === 'number' && Number.isFinite(trust.score) ? trust.score : null;

  if (trust.frozen !== true) {
    trustRejectedReasons.push('legacy_or_unfrozen_trust_schema');
  }

  if (score === null) {
    trustRejectedReasons.push('missing_trust_score');
  }

  const trustInputReady = trustRejectedReasons.length === 0;
  const queueTruthReady = queue.length > 0 && rejected.length === 0 && eligible.length > 0;
  const phase3ShadowEligible = queueTruthReady && trustInputReady;

  return {
    queueTruthReady,
    trustInputReady,
    phase3ShadowEligible,
    evolution: {
      eligible,
      rejected,
    },
    trust: {
      eligible: trustInputReady,
      rejectedReasons: trustRejectedReasons,
    },
  };
}
