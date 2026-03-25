function normalizeTaskId(value) {
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim();
    return normalized ? normalized : null;
}
function normalizeStatus(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'in_progress' || normalized === 'completed')
        return normalized;
    if (normalized === 'pending')
        return 'pending';
    return null;
}
function normalizeTimestamp(value) {
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim();
    if (!normalized)
        return null;
    const timestamp = Date.parse(normalized);
    return Number.isNaN(timestamp) ? null : normalized;
}
function dedupe(values) {
    return [...new Set(values)];
}
export function evaluatePhase3Inputs(queue, trust) {
    const eligible = [];
    const rejected = [];
    const taskIdCounts = new Map();
    for (const item of queue) {
        const taskId = normalizeTaskId(item?.id);
        if (!taskId)
            continue;
        taskIdCounts.set(taskId, (taskIdCounts.get(taskId) ?? 0) + 1);
    }
    for (const item of queue) {
        const taskId = normalizeTaskId(item?.id);
        const status = normalizeStatus(item?.status);
        const reasons = [];
        const startedAt = normalizeTimestamp(item?.started_at);
        const completedAt = normalizeTimestamp(item?.completed_at);
        if (!taskId) {
            reasons.push('missing_task_id');
        }
        else if ((taskIdCounts.get(taskId) ?? 0) > 1) {
            reasons.push('reused_task_id');
        }
        if (!status) {
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
    const trustRejectedReasons = [];
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
