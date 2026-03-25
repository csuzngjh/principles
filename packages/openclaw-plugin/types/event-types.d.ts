/**
 * Event types for structured logging and daily statistics.
 */
export type EventType = 'tool_call' | 'pain_signal' | 'rule_match' | 'rule_promotion' | 'hook_execution' | 'gate_block' | 'gate_bypass' | 'plan_approval' | 'evolution_task' | 'deep_reflection' | 'trust_change' | 'empathy_rollback' | 'error' | 'warn';
export type EventCategory = 'success' | 'failure' | 'detected' | 'blocked' | 'bypassed' | 'approved' | 'enqueued' | 'completed' | 'promoted' | 'passed' | 'changed' | 'rolled_back';
/**
 * Base event structure for JSONL logging.
 */
export interface EventLogEntry {
    /** ISO timestamp */
    ts: string;
    /** Date for partitioning (YYYY-MM-DD) */
    date: string;
    /** Event type */
    type: EventType;
    /** Event category */
    category: EventCategory;
    /** Session identifier */
    sessionId?: string;
    /** Workspace directory */
    workspaceDir?: string;
    /** Event-specific data */
    data: Record<string, unknown>;
}
export interface TrustChangeEventData {
    previousScore: number;
    newScore: number;
    delta: number;
    reason: string;
}
export interface ToolCallEventData {
    toolName: string;
    filePath?: string;
    error?: string;
    errorType?: string;
    gfi?: number;
    consecutiveErrors?: number;
    exitCode?: number;
}
export interface PainSignalEventData {
    score: number;
    source: string;
    eventId?: string;
    reason?: string;
    isRisky?: boolean;
    origin?: 'assistant_self_report' | 'user_manual' | 'system_infer';
    severity?: 'mild' | 'moderate' | 'severe';
    confidence?: number;
    detection_mode?: 'structured' | 'legacy_tag';
    deduped?: boolean;
    trigger_text_excerpt?: string;
    raw_score?: number;
    calibrated_score?: number;
}
export interface RuleMatchEventData {
    ruleId: string;
    layer: 'L1' | 'L2' | 'L3';
    severity: number;
    textPreview: string;
}
export interface RulePromotionEventData {
    fingerprint: string;
    ruleId: string;
    phrase: string;
    sampleCount: number;
    avgSimilarity: number;
}
export interface HookExecutionEventData {
    hookName: string;
    durationMs?: number;
    error?: string;
}
export interface GateBlockEventData {
    toolName: string;
    filePath: string;
    reason: string;
    planStatus?: string;
}
export interface GateBypassEventData {
    toolName: string;
    filePath: string;
    bypassType: 'stage4_architect' | 'plan_approved' | 'whitelisted';
    trustScore: number;
    trustStage: number;
}
export interface PlanApprovalEventData {
    toolName: string;
    filePath: string;
    pattern: string;
    planStatus: string;
}
export interface EvolutionTaskEventData {
    taskId: string;
    taskType: string;
    reason: string;
}
export interface DeepReflectionEventData {
    /** 思维模型 ID (T-01 到 T-09)，向后兼容 */
    modelId: string;
    /** 模型选择模式：'manual' = 用户指定 model_id，'auto' = 子智能体自动选择 */
    modelSelectionMode: 'manual' | 'auto';
    /** 反思深度 (1-3) */
    depth: number;
    /** 上下文摘要（前 200 字符） */
    contextPreview: string;
    /** 反思结果摘要 */
    resultPreview?: string;
    /** 执行耗时 (ms) */
    durationMs: number;
    /** 是否通过（未发现显著问题） */
    passed: boolean;
    /** 是否超时 */
    timeout: boolean;
    /** 错误信息 */
    error?: string;
    /** 输出长度 */
    outputLength?: number;
    /** 置信度（从输出中提取） */
    confidence?: 'LOW' | 'MEDIUM' | 'HIGH';
    /** 发现的盲点数量 */
    blindSpotsCount?: number;
    /** 发现的风险数量 */
    risksCount?: number;
}
export interface EmpathyRollbackEventData {
    /** Event ID being rolled back */
    eventId: string;
    /** Original penalty score that was applied */
    originalScore: number;
    /** Session ID where the original event occurred */
    originalSessionId?: string;
    /** Reason for rollback (manual, false_positive, etc.) */
    reason: string;
    /** Who initiated the rollback */
    triggeredBy: 'user_command' | 'natural_language' | 'system';
}
export interface ToolCallStats {
    total: number;
    success: number;
    failure: number;
    byTool: Record<string, {
        success: number;
        failure: number;
    }>;
}
export interface ErrorStats {
    total: number;
    byType: Record<string, number>;
    byTool: Record<string, number>;
}
export interface PainStats {
    signalsDetected: number;
    signalsBySource: Record<string, number>;
    rulesMatched: Record<string, number>;
    candidatesPromoted: number;
    avgScore: number;
    maxScore: number;
}
/**
 * Empathy Engine event statistics for tracking emotional signals.
 * Used for /pd-status empathy card and effectiveness metrics.
 */
export interface EmpathyEventStats {
    /** Total empathy events detected (excluding deduped) */
    totalEvents: number;
    /** Events that were deduped (not counted in totalEvents) */
    dedupedCount: number;
    /** Dedupe hit rate (dedupedCount / (totalEvents + dedupedCount)) */
    dedupeHitRate: number;
    /** Total penalty score applied */
    totalPenaltyScore: number;
    /** Score rolled back via manual rollback */
    rolledBackScore: number;
    /** Number of rollback operations */
    rollbackCount: number;
    /** Events by severity level */
    bySeverity: {
        mild: number;
        moderate: number;
        severe: number;
    };
    /** Score by severity level */
    scoreBySeverity: {
        mild: number;
        moderate: number;
        severe: number;
    };
    /** Events by detection mode */
    byDetectionMode: {
        structured: number;
        legacy_tag: number;
    };
    /** Events by origin */
    byOrigin: {
        assistant_self_report: number;
        user_manual: number;
        system_infer: number;
    };
    /** Confidence distribution */
    confidenceDistribution: {
        high: number;
        medium: number;
        low: number;
    };
    /** Daily trend (last 7 days) */
    dailyTrend: Array<{
        date: string;
        count: number;
        score: number;
    }>;
}
export interface GfiStats {
    peak: number;
    samples: number;
    total: number;
    resetCount: number;
    hourlyDistribution: number[];
}
export interface EvolutionStats {
    tasksEnqueued: number;
    tasksCompleted: number;
    rulesPromoted: number;
}
export interface HookStats {
    byType: Record<string, number>;
    errors: number;
    totalDurationMs: number;
}
export interface DeepReflectionStats {
    /** 总调用次数 */
    totalCalls: number;
    /** 通过次数（未发现问题） */
    passedCount: number;
    /** 发现问题的次数 */
    issuesFoundCount: number;
    /** 超时次数 */
    timeoutCount: number;
    /** 错误次数 */
    errorCount: number;
    /** 按模型选择模式统计 */
    bySelectionMode: {
        manual: {
            count: number;
            avgDurationMs: number;
            passedCount: number;
        };
        auto: {
            count: number;
            avgDurationMs: number;
            passedCount: number;
        };
    };
    /** 按模型统计（向后兼容，仅记录手动指定的 model_id） */
    byModel: Record<string, {
        count: number;
        avgDurationMs: number;
        passedCount: number;
    }>;
    /** 按深度统计 */
    byDepth: Record<number, number>;
    /** 总耗时 */
    totalDurationMs: number;
    /** 平均耗时 */
    avgDurationMs: number;
    /** 发现的总盲点数 */
    totalBlindSpots: number;
    /** 发现的总风险数 */
    totalRisks: number;
    /** 置信度分布 */
    confidenceDistribution: {
        LOW: number;
        MEDIUM: number;
        HIGH: number;
    };
}
/**
 * Daily aggregated statistics.
 */
export interface DailyStats {
    /** Date (YYYY-MM-DD) */
    date: string;
    /** Timestamp when stats were created */
    createdAt: string;
    /** Timestamp when stats were last updated */
    updatedAt: string;
    /** Tool call statistics */
    tools: {
        total: number;
        success: number;
        failure: number;
    };
    /** Tool call statistics */
    toolCalls: ToolCallStats;
    /** Error statistics */
    errors: ErrorStats;
    /** Pain signal statistics */
    pain: PainStats;
    /** Empathy Engine event statistics */
    empathy: EmpathyEventStats;
    /** GFI statistics */
    gfi: GfiStats;
    /** Evolution statistics */
    evolution: EvolutionStats;
    /** Hook execution statistics */
    hooks: HookStats;
    /** Deep Reflection statistics */
    deepReflection: DeepReflectionStats;
}
/**
 * Creates an empty daily stats object.
 */
export declare function createEmptyDailyStats(date: string): DailyStats;
