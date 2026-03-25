import * as fs from 'fs';
import * as path from 'path';
import { createEmptyDailyStats } from '../types/event-types.js';
/**
 * EventLog - Structured event logging with daily statistics aggregation.
 */
export class EventLog {
    eventsFile;
    statsFile;
    logger;
    statsCache = new Map();
    eventBuffer = [];
    maxBufferSize = 20;
    flushIntervalMs = 30000;
    flushTimer;
    constructor(stateDir, logger) {
        const logsDir = path.join(stateDir, 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        this.eventsFile = path.join(logsDir, 'events.jsonl');
        this.statsFile = path.join(logsDir, 'daily-stats.json');
        this.logger = logger;
        this.loadStats();
        this.startFlushTimer();
    }
    recordToolCall(sessionId, data) {
        const category = data.error ? 'failure' : 'success';
        this.record('tool_call', category, sessionId, data);
    }
    recordPainSignal(sessionId, data) {
        this.record('pain_signal', 'detected', sessionId, data);
    }
    recordRuleMatch(sessionId, data) {
        this.record('rule_match', 'detected', sessionId, data);
    }
    recordRulePromotion(data) {
        this.record('rule_promotion', 'promoted', undefined, data);
    }
    recordHookExecution(data) {
        const category = data.error ? 'failure' : 'success';
        this.record('hook_execution', category, undefined, data);
    }
    recordGateBlock(sessionId, data) {
        this.record('gate_block', 'blocked', sessionId, data);
    }
    recordGateBypass(sessionId, data) {
        this.record('gate_bypass', 'bypassed', sessionId, data);
    }
    recordPlanApproval(sessionId, data) {
        this.record('plan_approval', 'approved', sessionId, data);
    }
    recordEvolutionTask(data) {
        this.record('evolution_task', 'enqueued', undefined, data);
    }
    recordDeepReflection(sessionId, data) {
        const category = data.passed ? 'passed' : data.timeout ? 'failure' : 'completed';
        this.record('deep_reflection', category, sessionId, data);
    }
    recordTrustChange(sessionId, data) {
        this.record('trust_change', 'changed', sessionId, data);
    }
    recordEmpathyRollback(sessionId, data) {
        this.record('empathy_rollback', 'rolled_back', sessionId, data);
    }
    recordError(sessionId, message, context) {
        this.record('error', 'failure', sessionId, { message, ...context });
    }
    recordWarn(sessionId, message, context) {
        this.record('warn', 'failure', sessionId, { message, ...context });
    }
    record(type, category, sessionId, data) {
        const now = new Date();
        const date = this.formatDate(now);
        const entry = {
            ts: now.toISOString(),
            date,
            type,
            category,
            sessionId,
            data: data,
        };
        this.eventBuffer.push(entry);
        this.updateStats(entry);
        if (this.eventBuffer.length >= this.maxBufferSize) {
            this.flushEvents();
        }
    }
    formatDate(date) {
        return date.toISOString().split('T')[0];
    }
    loadStats() {
        if (fs.existsSync(this.statsFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.statsFile, 'utf-8'));
                for (const date in data) {
                    this.statsCache.set(date, data[date]);
                }
            }
            catch (e) {
                if (this.logger)
                    this.logger.error(`[PD] Failed to load daily-stats.json: ${String(e)}`);
            }
        }
    }
    updateStats(entry) {
        let stats = this.statsCache.get(entry.date);
        if (!stats) {
            stats = createEmptyDailyStats(entry.date);
            this.statsCache.set(entry.date, stats);
        }
        if (entry.type === 'tool_call') {
            const data = entry.data;
            stats.tools.total++;
            if (entry.category === 'success')
                stats.tools.success++;
            else
                stats.tools.failure++;
        }
        else if (entry.type === 'pain_signal') {
            const data = entry.data;
            stats.pain.signalsDetected++;
            stats.pain.maxScore = Math.max(stats.pain.maxScore, data.score);
            // Update empathy stats for user_empathy source
            if (data.source === 'user_empathy') {
                if (data.deduped) {
                    stats.empathy.dedupedCount++;
                }
                else {
                    stats.empathy.totalEvents++;
                    stats.empathy.totalPenaltyScore += data.score || 0;
                    // By severity
                    if (data.severity) {
                        stats.empathy.bySeverity[data.severity]++;
                        stats.empathy.scoreBySeverity[data.severity] += data.score || 0;
                    }
                    // By detection mode
                    if (data.detection_mode) {
                        stats.empathy.byDetectionMode[data.detection_mode]++;
                    }
                    // By origin
                    if (data.origin) {
                        stats.empathy.byOrigin[data.origin]++;
                    }
                    // Confidence distribution
                    const conf = data.confidence ?? 1;
                    if (conf >= 0.8)
                        stats.empathy.confidenceDistribution.high++;
                    else if (conf >= 0.5)
                        stats.empathy.confidenceDistribution.medium++;
                    else
                        stats.empathy.confidenceDistribution.low++;
                }
                // Update dedupe hit rate
                const total = stats.empathy.totalEvents + stats.empathy.dedupedCount;
                stats.empathy.dedupeHitRate = total > 0 ? stats.empathy.dedupedCount / total : 0;
            }
        }
        else if (entry.type === 'empathy_rollback') {
            const data = entry.data;
            stats.empathy.rollbackCount++;
            stats.empathy.rolledBackScore += data.originalScore || 0;
        }
    }
    startFlushTimer() {
        this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    }
    flush() {
        this.flushEvents();
        this.flushStats();
    }
    /**
     * Return in-memory buffered events that have not been flushed yet.
     * Intended for live runtime summaries that should not lag behind disk snapshots.
     */
    getBufferedEvents() {
        return this.eventBuffer.map((entry) => ({ ...entry, data: { ...entry.data } }));
    }
    getEventDedupKey(entry) {
        const eventId = typeof entry.data?.eventId === 'string'
            ? String(entry.data.eventId)
            : null;
        if (eventId) {
            return `${entry.type}:${entry.sessionId ?? 'none'}:${eventId}`;
        }
        const data = entry.data ?? {};
        return [
            entry.ts ?? 'no-ts',
            entry.type ?? 'no-type',
            entry.category ?? 'no-category',
            entry.sessionId ?? 'no-session',
            typeof data.source === 'string' ? data.source : 'no-source',
            typeof data.toolName === 'string' ? data.toolName : 'no-tool',
            typeof data.reason === 'string' ? data.reason : 'no-reason',
        ].join('::');
    }
    readPersistedEvents() {
        if (!fs.existsSync(this.eventsFile))
            return [];
        try {
            const content = fs.readFileSync(this.eventsFile, 'utf-8');
            return content
                .trim()
                .split('\n')
                .filter((line) => line.trim().length > 0)
                .map((line) => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    return null;
                }
            })
                .filter((entry) => entry !== null);
        }
        catch (e) {
            if (this.logger)
                this.logger.error(`[PD] Failed to read events.jsonl: ${String(e)}`);
            return [];
        }
    }
    getMergedEvents() {
        const merged = new Map();
        for (const entry of [...this.readPersistedEvents(), ...this.getBufferedEvents()]) {
            merged.set(this.getEventDedupKey(entry), entry);
        }
        return [...merged.values()].sort((a, b) => a.ts.localeCompare(b.ts));
    }
    flushEvents() {
        if (this.eventBuffer.length === 0)
            return;
        const lines = this.eventBuffer.map(e => JSON.stringify(e)).join('\n') + '\n';
        try {
            fs.appendFileSync(this.eventsFile, lines, 'utf-8');
            this.eventBuffer = [];
        }
        catch (e) {
            if (this.logger)
                this.logger.error(`[PD] Failed to flush events.jsonl: ${String(e)}`);
        }
    }
    flushStats() {
        if (this.statsCache.size === 0)
            return;
        const data = {};
        this.statsCache.forEach((stats, date) => {
            data[date] = stats;
        });
        try {
            fs.writeFileSync(this.statsFile, JSON.stringify(data, null, 2), 'utf-8');
        }
        catch (e) {
            if (this.logger)
                this.logger.error(`[PD] Failed to flush daily-stats.json: ${String(e)}`);
        }
    }
    /**
     * Get daily statistics for a specific date.
     * Returns empty stats if no events recorded for that date.
     */
    getDailyStats(date) {
        let stats = this.statsCache.get(date);
        if (!stats) {
            stats = createEmptyDailyStats(date);
            this.statsCache.set(date, stats);
        }
        return stats;
    }
    /**
     * Get aggregated empathy statistics for multiple time ranges.
     * @param range 'today' | 'week' | 'session'
     * @param sessionId Optional session ID for session-scoped stats
     */
    getEmpathyStats(range, sessionId) {
        const now = new Date();
        const today = this.formatDate(now);
        // Aggregate stats based on range
        const result = {
            totalEvents: 0,
            dedupedCount: 0,
            dedupeHitRate: 0,
            totalPenaltyScore: 0,
            rolledBackScore: 0,
            rollbackCount: 0,
            bySeverity: { mild: 0, moderate: 0, severe: 0 },
            scoreBySeverity: { mild: 0, moderate: 0, severe: 0 },
            byDetectionMode: { structured: 0, legacy_tag: 0 },
            byOrigin: { assistant_self_report: 0, user_manual: 0, system_infer: 0 },
            confidenceDistribution: { high: 0, medium: 0, low: 0 },
            dailyTrend: [],
        };
        if (range === 'session' && sessionId) {
            // For session range, scan event buffer and events file
            this.aggregateSessionEmpathy(sessionId, result);
        }
        else if (range === 'week') {
            // For week range, aggregate last 7 days
            for (let i = 0; i < 7; i++) {
                const date = new Date(now);
                date.setDate(date.getDate() - i);
                const dateStr = this.formatDate(date);
                const stats = this.getDailyStats(dateStr);
                result.totalEvents += stats.empathy.totalEvents;
                result.dedupedCount += stats.empathy.dedupedCount;
                result.totalPenaltyScore += stats.empathy.totalPenaltyScore;
                result.rolledBackScore += stats.empathy.rolledBackScore;
                result.rollbackCount += stats.empathy.rollbackCount;
                for (const sev of ['mild', 'moderate', 'severe']) {
                    result.bySeverity[sev] += stats.empathy.bySeverity[sev];
                    result.scoreBySeverity[sev] += stats.empathy.scoreBySeverity[sev];
                }
                result.byDetectionMode.structured += stats.empathy.byDetectionMode.structured;
                result.byDetectionMode.legacy_tag += stats.empathy.byDetectionMode.legacy_tag;
                for (const org of ['assistant_self_report', 'user_manual', 'system_infer']) {
                    result.byOrigin[org] += stats.empathy.byOrigin[org];
                }
                result.confidenceDistribution.high += stats.empathy.confidenceDistribution.high;
                result.confidenceDistribution.medium += stats.empathy.confidenceDistribution.medium;
                result.confidenceDistribution.low += stats.empathy.confidenceDistribution.low;
                if (stats.empathy.totalEvents > 0 || stats.empathy.dedupedCount > 0) {
                    result.dailyTrend.push({
                        date: dateStr,
                        count: stats.empathy.totalEvents,
                        score: stats.empathy.totalPenaltyScore,
                    });
                }
            }
        }
        else {
            // Today only
            const stats = this.getDailyStats(today);
            Object.assign(result, stats.empathy);
            if (stats.empathy.totalEvents > 0 || stats.empathy.dedupedCount > 0) {
                result.dailyTrend = [{
                        date: today,
                        count: stats.empathy.totalEvents,
                        score: stats.empathy.totalPenaltyScore,
                    }];
            }
        }
        // Calculate dedupe hit rate
        const total = result.totalEvents + result.dedupedCount;
        result.dedupeHitRate = total > 0 ? result.dedupedCount / total : 0;
        return result;
    }
    /**
     * Aggregate empathy stats for a specific session.
     */
    aggregateSessionEmpathy(sessionId, result) {
        for (const entry of this.getMergedEvents()) {
            if (entry.sessionId === sessionId && entry.type === 'pain_signal') {
                const data = entry.data;
                if (data.source === 'user_empathy') {
                    if (data.deduped) {
                        result.dedupedCount++;
                    }
                    else {
                        result.totalEvents++;
                        result.totalPenaltyScore += data.score || 0;
                        if (data.severity) {
                            result.bySeverity[data.severity]++;
                            result.scoreBySeverity[data.severity] += data.score || 0;
                        }
                        if (data.detection_mode)
                            result.byDetectionMode[data.detection_mode]++;
                        if (data.origin)
                            result.byOrigin[data.origin]++;
                        const conf = data.confidence ?? 1;
                        if (conf >= 0.8)
                            result.confidenceDistribution.high++;
                        else if (conf >= 0.5)
                            result.confidenceDistribution.medium++;
                        else
                            result.confidenceDistribution.low++;
                    }
                }
            }
            else if (entry.sessionId === sessionId && entry.type === 'empathy_rollback') {
                const data = entry.data;
                result.rollbackCount++;
                result.rolledBackScore += data.originalScore || 0;
            }
        }
    }
    /**
     * Rollback an empathy event by ID.
     * Returns the rolled back score, or 0 if event not found.
     */
    rollbackEmpathyEvent(eventId, sessionId, reason, triggeredBy) {
        const allEvents = this.getMergedEvents();
        let foundEvent = null;
        for (const entry of allEvents) {
            if (entry.type === 'pain_signal') {
                const data = entry.data;
                if (entry.data.eventId === eventId && data.source === 'user_empathy') {
                    foundEvent = { entry, data };
                    break;
                }
            }
        }
        if (!foundEvent || foundEvent.data.deduped) {
            return 0;
        }
        const originalScore = foundEvent.data.score || 0;
        // Record the rollback event
        this.recordEmpathyRollback(sessionId, {
            eventId,
            originalScore,
            originalSessionId: foundEvent.entry.sessionId,
            reason,
            triggeredBy,
        });
        return originalScore;
    }
    /**
     * Get the last empathy event ID for a session (for rollback).
     */
    getLastEmpathyEventId(sessionId) {
        const allEvents = this.getMergedEvents();
        for (let i = allEvents.length - 1; i >= 0; i--) {
            const entry = allEvents[i];
            if (entry.sessionId === sessionId && entry.type === 'pain_signal') {
                const data = entry.data;
                if (data.source === 'user_empathy' && !data.deduped) {
                    return entry.data.eventId || null;
                }
            }
        }
        return null;
    }
    /**
     * Dispose of the EventLog, flushing pending data and clearing timer.
     */
    dispose() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = undefined;
        }
        this.flush();
    }
}
/**
 * Service to manage multiple EventLog instances by stateDir.
 */
export class EventLogService {
    static instances = new Map();
    static get(stateDir, logger) {
        let instance = this.instances.get(stateDir);
        if (!instance) {
            instance = new EventLog(stateDir, logger);
            this.instances.set(stateDir, instance);
        }
        return instance;
    }
    static flushAll() {
        for (const instance of this.instances.values()) {
            instance.flush();
        }
    }
    static disposeAll() {
        for (const instance of this.instances.values()) {
            instance.dispose();
        }
        this.instances.clear();
    }
}
