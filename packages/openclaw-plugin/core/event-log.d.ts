import type { EventLogEntry, DailyStats, EmpathyEventStats, ToolCallEventData, PainSignalEventData, RuleMatchEventData, RulePromotionEventData, HookExecutionEventData, GateBlockEventData, GateBypassEventData, PlanApprovalEventData, EvolutionTaskEventData, DeepReflectionEventData, TrustChangeEventData, EmpathyRollbackEventData } from '../types/event-types.js';
import type { PluginLogger } from '../openclaw-sdk.js';
/**
 * EventLog - Structured event logging with daily statistics aggregation.
 */
export declare class EventLog {
    private readonly eventsFile;
    private readonly statsFile;
    private readonly logger?;
    private statsCache;
    private eventBuffer;
    private readonly maxBufferSize;
    private readonly flushIntervalMs;
    private flushTimer?;
    constructor(stateDir: string, logger?: PluginLogger);
    recordToolCall(sessionId: string | undefined, data: ToolCallEventData): void;
    recordPainSignal(sessionId: string | undefined, data: PainSignalEventData): void;
    recordRuleMatch(sessionId: string | undefined, data: RuleMatchEventData): void;
    recordRulePromotion(data: RulePromotionEventData): void;
    recordHookExecution(data: HookExecutionEventData): void;
    recordGateBlock(sessionId: string | undefined, data: GateBlockEventData): void;
    recordGateBypass(sessionId: string | undefined, data: GateBypassEventData): void;
    recordPlanApproval(sessionId: string | undefined, data: PlanApprovalEventData): void;
    recordEvolutionTask(data: EvolutionTaskEventData): void;
    recordDeepReflection(sessionId: string | undefined, data: DeepReflectionEventData): void;
    recordTrustChange(sessionId: string | undefined, data: TrustChangeEventData): void;
    recordEmpathyRollback(sessionId: string | undefined, data: EmpathyRollbackEventData): void;
    recordError(sessionId: string | undefined, message: string, context?: Record<string, unknown>): void;
    recordWarn(sessionId: string | undefined, message: string, context?: Record<string, unknown>): void;
    private record;
    private formatDate;
    private loadStats;
    private updateStats;
    private startFlushTimer;
    flush(): void;
    /**
     * Return in-memory buffered events that have not been flushed yet.
     * Intended for live runtime summaries that should not lag behind disk snapshots.
     */
    getBufferedEvents(): EventLogEntry[];
    private getEventDedupKey;
    private readPersistedEvents;
    private getMergedEvents;
    private flushEvents;
    private flushStats;
    /**
     * Get daily statistics for a specific date.
     * Returns empty stats if no events recorded for that date.
     */
    getDailyStats(date: string): DailyStats;
    /**
     * Get aggregated empathy statistics for multiple time ranges.
     * @param range 'today' | 'week' | 'session'
     * @param sessionId Optional session ID for session-scoped stats
     */
    getEmpathyStats(range: 'today' | 'week' | 'session', sessionId?: string): EmpathyEventStats;
    /**
     * Aggregate empathy stats for a specific session.
     */
    private aggregateSessionEmpathy;
    /**
     * Rollback an empathy event by ID.
     * Returns the rolled back score, or 0 if event not found.
     */
    rollbackEmpathyEvent(eventId: string, sessionId: string | undefined, reason: string, triggeredBy: 'user_command' | 'natural_language' | 'system'): number;
    /**
     * Get the last empathy event ID for a session (for rollback).
     */
    getLastEmpathyEventId(sessionId: string): string | null;
    /**
     * Dispose of the EventLog, flushing pending data and clearing timer.
     */
    dispose(): void;
}
/**
 * Service to manage multiple EventLog instances by stateDir.
 */
export declare class EventLogService {
    private static instances;
    static get(stateDir: string, logger?: PluginLogger): EventLog;
    static flushAll(): void;
    static disposeAll(): void;
}
