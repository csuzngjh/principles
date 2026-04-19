 
import * as fs from 'fs';
import * as path from 'path';
import type {
  EventLogEntry,
  EventType,
  EventCategory,
  DailyStats,
  EmpathyEventStats,
  ToolCallEventData,
  PainSignalEventData,
  RuleMatchEventData,
  RulePromotionEventData,
  HookExecutionEventData,
  GateBlockEventData,
  GateBypassEventData,
  PlanApprovalEventData,
  EvolutionTaskEventData,
  DeepReflectionEventData,
  EmpathyRollbackEventData,
  // C: New event data types
  DiagnosisTaskEventData,
  HeartbeatDiagnosisEventData,
  DiagnosticianReportEventData,
  PrincipleCandidateEventData,
  RuleEnforcedEventData,
  // C: Nocturnal funnel events (PD-FUNNEL-2.3)
  NocturnalDreamerCompletedEventData,
  NocturnalArtifactPersistedEventData,
  NocturnalCodeCandidateCreatedEventData,
  // C: RuleHost funnel events (PD-FUNNEL-2.4)
  RuleHostEvaluatedEventData,
  RuleHostBlockedEventData,
  RuleHostRequireApprovalEventData,
} from '../types/event-types.js';
import { createEmptyDailyStats } from '../types/event-types.js';
import { atomicWriteFileSync } from '../utils/io.js';
import type { PluginLogger } from '../openclaw-sdk.js';

/**
 * EventLog - Structured event logging with daily statistics aggregation.
 *
 * Log files are date-stamped: events_YYYY-MM-DD.jsonl
 * Old event files are automatically cleaned up based on retention policy.
 */

/**
 * Event log retention in days.
 * Files older than this are deleted on cleanup.
 */
const EVENT_LOG_RETENTION_DAYS = 7;

export class EventLog {
  private readonly logsDir: string;
  private readonly statsFile: string;
  private readonly logger?: PluginLogger;

  private readonly statsCache: Map<string, DailyStats> = new Map();
  private eventBuffer: EventLogEntry[] = [];
  private readonly maxBufferSize = 20;
  private readonly flushIntervalMs = 30000;
  private flushTimer?: ReturnType<typeof setInterval>;

  // Cached event file path for current date
  private currentEventsFile: string | undefined;
  private currentDate: string | undefined;

  // Pain score sum per date (for avgScore calculation)
  private readonly painScoreSums: Map<string, number> = new Map();

  constructor(stateDir: string, logger?: PluginLogger) {
    this.logsDir = path.join(stateDir, 'logs');
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    this.statsFile = path.join(this.logsDir, 'daily-stats.json');
    this.logger = logger;

    this.loadStats();
    this.startFlushTimer();
  }

  /**
   * Get the event file path for a given date.
   */
  private getEventsFile(date: string): string {
    return path.join(this.logsDir, `events_${date}.jsonl`);
  }

  /**
   * Get today's date string (YYYY-MM-DD).
   */
  private getTodayStr(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Ensure we have the correct events file for today's date.
   */
  private ensureEventsFile(): string {
    const today = this.getTodayStr();
    if (this.currentDate !== today || !this.currentEventsFile) {
      this.currentDate = today;
      this.currentEventsFile = this.getEventsFile(today);
      // Run cleanup if date changed
      this.cleanupOldEventFiles(today);
    }
    return this.currentEventsFile;
  }

  /**
   * Clean up event files older than EVENT_LOG_RETENTION_DAYS.
   */
  private cleanupOldEventFiles(_today: string): void {
    if (EVENT_LOG_RETENTION_DAYS <= 0) return;

    try {
      const cutoffMs = Date.now() - EVENT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const files = fs.readdirSync(this.logsDir);

      for (const file of files) {
        if (!file.startsWith('events_') || !file.endsWith('.jsonl')) continue;

        const filePath = path.join(this.logsDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoffMs) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (err) {
      this.logger?.debug?.(`[PD] Event file cleanup failed (non-blocking): ${String(err)}`);
    }
  }
  
  recordToolCall(sessionId: string | undefined, data: ToolCallEventData): void {
    const category = data.error ? 'failure' : 'success';
    this.record('tool_call', category, sessionId, data);
  }
  
  recordPainSignal(sessionId: string | undefined, data: PainSignalEventData): void {
    this.record('pain_signal', 'detected', sessionId, data);
  }
  
  recordRuleMatch(sessionId: string | undefined, data: RuleMatchEventData): void {
    this.record('rule_match', 'detected', sessionId, data);
  }
  
  recordRulePromotion(data: RulePromotionEventData): void {
    this.record('rule_promotion', 'promoted', undefined, data);
  }
  
  recordHookExecution(data: HookExecutionEventData, opts?: { flushImmediately?: boolean }): void {
    const category = data.error ? 'failure' : 'success';
    this.record('hook_execution', category, undefined, data);
    if (opts?.flushImmediately) {
      this.flushEvents();
    }
  }
  
  recordGateBlock(sessionId: string | undefined, data: GateBlockEventData): void {
    this.record('gate_block', 'blocked', sessionId, data);
  }

  recordGateBypass(sessionId: string | undefined, data: GateBypassEventData): void {
    this.record('gate_bypass', 'bypassed', sessionId, data);
  }

  recordPlanApproval(sessionId: string | undefined, data: PlanApprovalEventData): void {
    this.record('plan_approval', 'approved', sessionId, data);
  }
  
  recordEvolutionTask(data: EvolutionTaskEventData): void {
    this.record('evolution_task', 'enqueued', undefined, data);
  }

  recordEvolutionTaskCompleted(data: EvolutionTaskEventData): void {
    this.record('evolution_task', 'completed', undefined, data);
  }
  
  recordDeepReflection(sessionId: string | undefined, data: DeepReflectionEventData): void {
    const category = data.passed ? 'passed' : data.timeout ? 'failure' : 'completed';
    this.record('deep_reflection', category, sessionId, data);
  }

  recordEmpathyRollback(sessionId: string | undefined, data: EmpathyRollbackEventData): void {
    this.record('empathy_rollback', 'rolled_back', sessionId, data);
  }
  
  recordError(sessionId: string | undefined, message: string, context?: Record<string, unknown>): void {
    this.record('error', 'failure', sessionId, { message, ...context });
  }
  
  recordWarn(sessionId: string | undefined, message: string, context?: Record<string, unknown>): void {
    this.record('warn', 'failure', sessionId, { message, ...context });
  }

  // C: Diagnostician heartbeat chain event recorders
  recordDiagnosisTask(data: DiagnosisTaskEventData): void {
    this.record('diagnosis_task', 'written', undefined, data);
  }

  recordHeartbeatDiagnosis(data: HeartbeatDiagnosisEventData): void {
    this.record('heartbeat_diagnosis', 'injected', undefined, data);
  }

  recordDiagnosticianReport(data: DiagnosticianReportEventData): void {
    // Map three-state category to EventCategory
    // Both missing_json and incomplete_fields map to 'failure' in EventCategory
    const categoryMap: Record<DiagnosticianReportEventData['category'], EventCategory> = {
      success: 'completed',
      missing_json: 'failure',
      incomplete_fields: 'failure',
    };
    this.record('diagnostician_report', categoryMap[data.category], undefined, data);
  }

  recordPrincipleCandidate(data: PrincipleCandidateEventData): void {
    this.record('principle_candidate', 'created', undefined, data);
  }

  recordRuleEnforced(data: RuleEnforcedEventData): void {
    this.record('rule_enforced', 'matched', undefined, data);
  }

  // C: Nocturnal funnel event recorders (PD-FUNNEL-2.3)
  recordNocturnalDreamerCompleted(data: NocturnalDreamerCompletedEventData): void {
    this.record('nocturnal_dreamer_completed', 'completed', undefined, data);
  }

  recordNocturnalArtifactPersisted(data: NocturnalArtifactPersistedEventData): void {
    this.record('nocturnal_artifact_persisted', 'completed', undefined, data);
  }

  recordNocturnalCodeCandidateCreated(data: NocturnalCodeCandidateCreatedEventData): void {
    this.record('nocturnal_code_candidate_created', 'created', undefined, data);
  }

  // C: RuleHost funnel event recorders (PD-FUNNEL-2.4)
  recordRuleHostEvaluated(data: RuleHostEvaluatedEventData): void {
    this.record('rulehost_evaluated', 'evaluated', undefined, data);
  }

  recordRuleHostBlocked(data: RuleHostBlockedEventData): void {
    this.record('rulehost_blocked', 'blocked', undefined, data);
  }

  recordRuleHostRequireApproval(data: RuleHostRequireApprovalEventData): void {
    this.record('rulehost_requireApproval', 'requireApproval', undefined, data);
  }

  private record(
    type: EventType, 
    category: EventCategory, 
    sessionId: string | undefined, 
    data: object
  ): void {
    const now = new Date();
    const date = this.formatDate(now);
    
    const entry: EventLogEntry = {
      ts: now.toISOString(),
      date,
      type,
      category,
      sessionId,
      data: data as Record<string, unknown>,
    };
    
    this.eventBuffer.push(entry);
    this.updateStats(entry);
    
    if (this.eventBuffer.length >= this.maxBufferSize) {
      this.flushEvents();
    }
  }

   
   
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  private loadStats(): void {
    if (fs.existsSync(this.statsFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.statsFile, 'utf-8'));
        for (const date in data) {
          this.statsCache.set(date, data[date]);
        }
      } catch (e) {
        if (this.logger) this.logger.error(`[PD] Failed to load daily-stats.json: ${String(e)}`);
      }
    }
  }

   
  private updateStats(entry: EventLogEntry): void {
    let stats = this.statsCache.get(entry.date);
    if (!stats) {
      stats = createEmptyDailyStats(entry.date);
      this.statsCache.set(entry.date, stats);
    }

    if (entry.type === 'tool_call') {
      stats.tools.total++;
      if (entry.category === 'success') stats.tools.success++;
      else stats.tools.failure++;
    } else if (entry.type === 'pain_signal') {
      const data = entry.data as unknown as PainSignalEventData;
      stats.pain.signalsDetected++;
      stats.pain.maxScore = Math.max(stats.pain.maxScore, data.score);

      // Track signals by source
      if (data.source) {
        stats.pain.signalsBySource[data.source] = (stats.pain.signalsBySource[data.source] || 0) + 1;
      }

      // Accumulate score for avg calculation
      const currentSum = this.painScoreSums.get(entry.date) ?? 0;
      this.painScoreSums.set(entry.date, currentSum + (data.score || 0));
      stats.pain.avgScore = stats.pain.signalsDetected > 0
        ? Math.round((currentSum + (data.score || 0)) / stats.pain.signalsDetected)
        : 0;

      // Update empathy stats for user_empathy source
      if (data.source === 'user_empathy') {
        if (data.deduped) {
          stats.empathy.dedupedCount++;
        } else {
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
          if (conf >= 0.8) stats.empathy.confidenceDistribution.high++;
          else if (conf >= 0.5) stats.empathy.confidenceDistribution.medium++;
          else stats.empathy.confidenceDistribution.low++;
        }

        const total = stats.empathy.totalEvents + stats.empathy.dedupedCount;
        stats.empathy.dedupeHitRate = total > 0 ? stats.empathy.dedupedCount / total : 0;
      }
    } else if (entry.type === 'hook_execution') {
      const data = entry.data as unknown as HookExecutionEventData;
      stats.hooks.total++;
      if (entry.category === 'success') stats.hooks.success++;
      else stats.hooks.failure++;

      // Track by type
      if (data.hook) {
        if (!stats.hooks.byType[data.hook]) {
          stats.hooks.byType[data.hook] = { total: 0, success: 0, failure: 0 };
        }
        stats.hooks.byType[data.hook].total++;
        if (entry.category === 'success') stats.hooks.byType[data.hook].success++;
        else stats.hooks.byType[data.hook].failure++;
      }
    } else if (entry.type === 'empathy_rollback') {
      const data = entry.data as unknown as EmpathyRollbackEventData;
      stats.empathy.rollbackCount++;
      stats.empathy.rolledBackScore += data.originalScore || 0;
    } else if (entry.type === 'rule_match') {
      const data = entry.data as unknown as RuleMatchEventData;
      if (data.ruleId) {
        stats.pain.rulesMatched[data.ruleId] = (stats.pain.rulesMatched[data.ruleId] || 0) + 1;
      }
    } else if (entry.type === 'rule_promotion') {
      stats.pain.candidatesPromoted++;
      stats.evolution.rulesPromoted++;
    } else if (entry.type === 'evolution_task') {
      if (entry.category === 'completed') {
        stats.evolution.tasksCompleted++;
      } else if (entry.category === 'enqueued') {
        stats.evolution.tasksEnqueued++;
      }
    }
    // C: Diagnostician heartbeat chain event counters
    else if (entry.type === 'diagnosis_task') {
      stats.evolution.diagnosisTasksWritten++;
    } else if (entry.type === 'heartbeat_diagnosis') {
      stats.evolution.heartbeatsInjected++;
    } else if (entry.type === 'diagnostician_report') {
      // Backward compat: handle old events with success:boolean and new events with category:string
      // Widen to Record<string, unknown> because DiagnosticianReportEventData requires
      // category (new format) but legacy persisted events have { success: boolean }.
      const raw = entry.data as unknown as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(raw, 'category')) {
        // New format: category is 'success' | 'missing_json' | 'incomplete_fields'
        // All three categories mean diagnosis completed and attempted to produce a report
        const cat = raw['category'] as string;
        if (cat === 'success' || cat === 'missing_json' || cat === 'incomplete_fields') {
          stats.evolution.diagnosticianReportsWritten++;
        }
        if (cat === 'missing_json') {
          stats.evolution.reportsMissingJson++;
        }
        if (cat === 'incomplete_fields') {
          stats.evolution.reportsIncompleteFields++;
        }
      } else if (Object.prototype.hasOwnProperty.call(raw, 'success')) {
        // Legacy format: { success: boolean }
        // Apply agreed default semantics: treat as 'success' if true, 'missing_json' if false
        if (raw['success']) {
          stats.evolution.diagnosticianReportsWritten++;
        }
        // Note: legacy 'false' entries are not counted in any sub-counter since
        // the old system had no such breakdown; they are invisible in sub-stats.
      }
    } else if (entry.type === 'principle_candidate') {
      stats.evolution.principleCandidatesCreated++;
    } else if (entry.type === 'rule_enforced') {
      stats.evolution.rulesEnforced++;
    }
    // C: Nocturnal funnel event counters (PD-FUNNEL-2.3)
    else if (entry.type === 'nocturnal_dreamer_completed') {
      const data = entry.data as unknown as NocturnalDreamerCompletedEventData;
      stats.evolution.nocturnalDreamerCompleted++;
      if (data.chainMode === 'trinity') {
        stats.evolution.nocturnalTrinityCompleted++;
      }
    } else if (entry.type === 'nocturnal_artifact_persisted') {
      stats.evolution.nocturnalArtifactPersisted++;
    } else if (entry.type === 'nocturnal_code_candidate_created') {
      stats.evolution.nocturnalCodeCandidateCreated++;
    }
    // C: RuleHost funnel event counters (PD-FUNNEL-2.4)
    else if (entry.type === 'rulehost_evaluated') {
      stats.evolution.rulehostEvaluated++;
    } else if (entry.type === 'rulehost_blocked') {
      stats.evolution.rulehostBlocked++;
    } else if (entry.type === 'rulehost_requireApproval') {
      stats.evolution.rulehostRequireApproval++;
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    // Don't keep the process alive just for this timer
    // This allows tests and CLI to exit without waiting for flush
    this.flushTimer.unref();
  }

  flush(): void {
    this.flushEvents();
    this.flushStats();
  }

  /**
   * Return in-memory buffered events that have not been flushed yet.
   * Intended for live runtime summaries that should not lag behind disk snapshots.
   */
  getBufferedEvents(): EventLogEntry[] {
    return this.eventBuffer.map((entry) => ({ ...entry, data: { ...entry.data } }));
  }

   
     
  private getEventDedupKey(entry: EventLogEntry): string {
    const eventId = typeof (entry.data as { eventId?: unknown } | undefined)?.eventId === 'string'
      ? String((entry.data as { eventId?: string }).eventId)
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

  private readPersistedEvents(): EventLogEntry[] {
    const eventsFile = this.ensureEventsFile();
    if (!fs.existsSync(eventsFile)) return [];

    try {
      const content = fs.readFileSync(eventsFile, 'utf-8');
      return content
        .trim()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as EventLogEntry;
          } catch (err) {
            this.logger?.warn?.(`[PD] Corrupted event line skipped: ${String(err).slice(0, 100)}`);
            return null;
          }
        })
        .filter((entry): entry is EventLogEntry => entry !== null);
    } catch (e) {
      if (this.logger) this.logger.error(`[PD] Failed to read events file: ${String(e)}`);
      return [];
    }
  }

  private getMergedEvents(): EventLogEntry[] {
    const merged = new Map<string, EventLogEntry>();
    for (const entry of [...this.readPersistedEvents(), ...this.getBufferedEvents()]) {
      merged.set(this.getEventDedupKey(entry), entry);
    }
    return [...merged.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  }

  private flushEvents(): void {
    if (this.eventBuffer.length === 0) return;

    const eventsFile = this.ensureEventsFile();
    const lines = this.eventBuffer.map(e => JSON.stringify(e)).join('\n') + '\n';
    try {
      fs.appendFileSync(eventsFile, lines, 'utf-8');
      this.eventBuffer = [];
    } catch (e) {
      if (this.logger) this.logger.error(`[PD] Failed to flush events: ${String(e)}`);
    }
  }

  private flushStats(): void {
    if (this.statsCache.size === 0) return;
    
    const data: Record<string, DailyStats> = {};
    this.statsCache.forEach((stats, date) => {
      data[date] = stats;
    });
    
    try {
      atomicWriteFileSync(this.statsFile, JSON.stringify(data, null, 2));
    } catch (e) {
      if (this.logger) this.logger.error(`[PD] Failed to flush daily-stats.json: ${String(e)}`);
    }
  }

  /**
   * Get daily statistics for a specific date.
   * Returns empty stats if no events recorded for that date.
   */
  getDailyStats(date: string): DailyStats {
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
     
  getEmpathyStats(range: 'today' | 'week' | 'session', sessionId?: string): EmpathyEventStats {
    const now = new Date();
    const today = this.formatDate(now);

    // Aggregate stats based on range
    const result: EmpathyEventStats = {
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
    } else if (range === 'week') {
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

        for (const sev of ['mild', 'moderate', 'severe'] as const) {
          result.bySeverity[sev] += stats.empathy.bySeverity[sev];
          result.scoreBySeverity[sev] += stats.empathy.scoreBySeverity[sev];
        }

        result.byDetectionMode.structured += stats.empathy.byDetectionMode.structured;
        result.byDetectionMode.legacy_tag += stats.empathy.byDetectionMode.legacy_tag;

        for (const org of ['assistant_self_report', 'user_manual', 'system_infer'] as const) {
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
    } else {
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
   
  private aggregateSessionEmpathy(sessionId: string, result: EmpathyEventStats): void {
    for (const entry of this.getMergedEvents()) {
      if (entry.sessionId === sessionId && entry.type === 'pain_signal') {
        const data = entry.data as unknown as PainSignalEventData;
        if (data.source === 'user_empathy') {
          if (data.deduped) {
            result.dedupedCount++;
          } else {
            result.totalEvents++;
            result.totalPenaltyScore += data.score || 0;
            if (data.severity) {
              result.bySeverity[data.severity]++;
              result.scoreBySeverity[data.severity] += data.score || 0;
            }
            if (data.detection_mode) result.byDetectionMode[data.detection_mode]++;
            if (data.origin) result.byOrigin[data.origin]++;
            const conf = data.confidence ?? 1;
            if (conf >= 0.8) result.confidenceDistribution.high++;
            else if (conf >= 0.5) result.confidenceDistribution.medium++;
            else result.confidenceDistribution.low++;
          }
        }
      } else if (entry.sessionId === sessionId && entry.type === 'empathy_rollback') {
        const data = entry.data as unknown as EmpathyRollbackEventData;
        result.rollbackCount++;
        result.rolledBackScore += data.originalScore || 0;
      }
    }

  }

  /**
   * Rollback an empathy event by ID.
   * Returns the rolled back score, or 0 if event not found.
   */
   
   
  rollbackEmpathyEvent(eventId: string, sessionId: string | undefined, reason: string, triggeredBy: 'user_command' | 'natural_language' | 'system'): number {
    const allEvents = this.getMergedEvents();
    let foundEvent: { entry: EventLogEntry; data: PainSignalEventData } | null = null;

    for (const entry of allEvents) {
      if (entry.type === 'pain_signal') {
        const data = entry.data as unknown as PainSignalEventData;
        if (data.eventId === eventId && data.source === 'user_empathy') {
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
  getLastEmpathyEventId(sessionId: string): string | null {
    const allEvents = this.getMergedEvents();
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const entry = allEvents[i];
      if (entry.sessionId === sessionId && entry.type === 'pain_signal') {
        const data = entry.data as unknown as PainSignalEventData;
        if (data.source === 'user_empathy' && !data.deduped) {
          return data.eventId || null;
        }
      }
    }

    return null;
  }

  /**
   * Find the latest pain signal for a given session.
   */
  findLatestPainSignal(sessionId: string | undefined): PainSignalEventData | null {
    const allEvents = this.getMergedEvents();
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const entry = allEvents[i];
      if (entry.sessionId === sessionId && entry.type === "pain_signal") {
        return entry.data as unknown as PainSignalEventData;
      }
    }
    return null;
  }

  /**
   * Dispose of the EventLog, flushing pending data and clearing timer.
   */
  dispose(): void {
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
  private static readonly instances: Map<string, EventLog> = new Map();
  
  static get(stateDir: string, logger?: PluginLogger): EventLog {
    let instance = this.instances.get(stateDir);
    if (!instance) {
      instance = new EventLog(stateDir, logger);
      this.instances.set(stateDir, instance);
    }
    return instance;
  }
  
  static flushAll(): void {
    for (const instance of this.instances.values()) {
      instance.flush();
    }
  }

  static disposeAll(): void {
    for (const instance of this.instances.values()) {
      instance.dispose();
    }
    this.instances.clear();
  }
}
