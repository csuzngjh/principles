/**
 * Event types for structured logging and daily statistics.
 */
/**
 * Creates an empty daily stats object.
 */
export function createEmptyDailyStats(date) {
    const now = new Date().toISOString();
    return {
        date,
        createdAt: now,
        updatedAt: now,
        tools: {
            total: 0,
            success: 0,
            failure: 0,
        },
        toolCalls: {
            total: 0,
            success: 0,
            failure: 0,
            byTool: {},
        },
        errors: {
            total: 0,
            byType: {},
            byTool: {},
        },
        pain: {
            signalsDetected: 0,
            signalsBySource: {},
            rulesMatched: {},
            candidatesPromoted: 0,
            avgScore: 0,
            maxScore: 0,
        },
        empathy: {
            totalEvents: 0,
            dedupedCount: 0,
            dedupeHitRate: 0,
            totalPenaltyScore: 0,
            rolledBackScore: 0,
            rollbackCount: 0,
            bySeverity: {
                mild: 0,
                moderate: 0,
                severe: 0,
            },
            scoreBySeverity: {
                mild: 0,
                moderate: 0,
                severe: 0,
            },
            byDetectionMode: {
                structured: 0,
                legacy_tag: 0,
            },
            byOrigin: {
                assistant_self_report: 0,
                user_manual: 0,
                system_infer: 0,
            },
            confidenceDistribution: {
                high: 0,
                medium: 0,
                low: 0,
            },
            dailyTrend: [],
        },
        gfi: {
            peak: 0,
            samples: 0,
            total: 0,
            resetCount: 0,
            hourlyDistribution: new Array(24).fill(0),
        },
        evolution: {
            tasksEnqueued: 0,
            tasksCompleted: 0,
            rulesPromoted: 0,
        },
        hooks: {
            byType: {},
            errors: 0,
            totalDurationMs: 0,
        },
        deepReflection: {
            totalCalls: 0,
            passedCount: 0,
            issuesFoundCount: 0,
            timeoutCount: 0,
            errorCount: 0,
            bySelectionMode: {
                manual: { count: 0, avgDurationMs: 0, passedCount: 0 },
                auto: { count: 0, avgDurationMs: 0, passedCount: 0 },
            },
            byModel: {},
            byDepth: {},
            totalDurationMs: 0,
            avgDurationMs: 0,
            totalBlindSpots: 0,
            totalRisks: 0,
            confidenceDistribution: { LOW: 0, MEDIUM: 0, HIGH: 0 },
        },
    };
}
