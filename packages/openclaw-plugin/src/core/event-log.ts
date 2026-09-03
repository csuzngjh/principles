
import * as fs from 'fs';
import * as path from 'path';
import { guardWorkspaceLeak } from '@principles/core/runtime-v2';
import type {
  EventLogEntry,
  EventType,
  EventCategory,
  DailyStats,
  EmpathyEventStats,
  ToolCallEventData,
  PainSignalEventData,
  RulePromotionEventData,
  GovernanceActionEventData,
  HookExecutionEventData,
  GateBlockEventData,
  GateBypassEventData,
  EvolutionTaskEventData,
  EmpathyRollbackEventData,
  DiagnosisTaskEventData,
  HeartbeatDiagnosisEventData,
  DiagnosticianReportEventData,
  PrincipleCandidateEventData,
  RuleEnforcedEventData,
  RuleHostEvaluatedEventData,
  RuleHostBlockedEventData,
  RuleHostRequireApprovalEventData,
  RuleHostAutoCorrectProposedEventData,
  RuleHostAutoCorrectAppliedEventData,
  RuntimeV2PromptActivationsInjectedEventData,
  RuleHostUnhealthyEventData,
  RuleHostSkippedEventData,
  TrajectoryObservabilityFailureEventData,
} from '../types/event-types.js';
import { createEmptyDailyStats } from '../types/event-types.js';
import { atomicWriteFileSync } from '../utils/io.js';
import type { PluginLogger } from '../openclaw-sdk.js';
import { redactTelemetryString } from '@principles/core/runtime-v2';

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

  private currentEventsFile: string | undefined;
  private currentDate: string | undefined;

  // painScoreSums map removed (PRI-451 Wave 1.5): it only fed the dead
  // stats.pain.avgScore counter, which is also removed.

  constructor(stateDir: string, logger?: PluginLogger) {
    // Guard against mock-leak state paths (e.g. '/fake/state') that pollute
    // filesystem root on Windows. See workspace-leak-guard.ts.
    const safeStateDir = guardWorkspaceLeak(stateDir);
    this.logsDir = path.join(safeStateDir, 'logs');
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    this.statsFile = path.join(this.logsDir, 'daily-stats.json');
    this.logger = logger;

    this.loadStats();
    this.startFlushTimer();
  }

  private getEventsFile(date: string): string {
    return path.join(this.logsDir, `events_${date}.jsonl`);
  }

  private getTodayStr(): string {
    return new Date().toISOString().split('T')[0] ?? '';
  }

  private ensureEventsFile(): string {
    const today = this.getTodayStr();
    if (this.currentDate !== today || !this.currentEventsFile) {
      this.currentDate = today;
      this.currentEventsFile = this.getEventsFile(today);
      this.cleanupOldEventFiles(today);
    }
    return this.currentEventsFile;
  }

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
    const category = data.error || (data.exitCode !== undefined && data.exitCode !== 0) ? 'failure' : 'success';
    this.record('tool_call', category, sessionId, data);
  }
  
  recordPainSignal(sessionId: string | undefined, data: PainSignalEventData): void {
    this.record('pain_signal', 'detected', sessionId, data);
  }

  recordRulePromotion(data: RulePromotionEventData): void {
    this.record('rule_promotion', 'promoted', undefined, data);
  }

  recordGovernanceAction(data: GovernanceActionEventData, opts?: { flushImmediately?: boolean }): void {
    this.record('governance_action', 'approved', undefined, data);
    if (opts?.flushImmediately) {
      this.flushEvents();
    }
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

  recordEvolutionTask(data: EvolutionTaskEventData): void {
    this.record('evolution_task', 'enqueued', undefined, data);
  }

  recordEvolutionTaskCompleted(data: EvolutionTaskEventData): void {
    this.record('evolution_task', 'completed', undefined, data);
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

  recordDiagnosisTask(data: DiagnosisTaskEventData): void {
    this.record('diagnosis_task', 'written', undefined, data);
  }

  recordHeartbeatDiagnosis(data: HeartbeatDiagnosisEventData): void {
    this.record('heartbeat_diagnosis', 'injected', undefined, data);
  }

  recordDiagnosticianReport(data: DiagnosticianReportEventData): void {
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

  recordRuleHostEvaluated(data: RuleHostEvaluatedEventData): void {
    this.record('rulehost_evaluated', 'evaluated', undefined, data);
  }

  recordRuleHostBlocked(data: RuleHostBlockedEventData): void {
    this.record('rulehost_blocked', 'blocked', undefined, data);
  }

  recordRuleHostRequireApproval(data: RuleHostRequireApprovalEventData): void {
    this.record('rulehost_requireApproval', 'requireApproval', undefined, data);
  }

  recordRuleHostAutoCorrectProposed(data: RuleHostAutoCorrectProposedEventData): void {
    this.record('rulehost_auto_correct_proposed', 'auto_correct', undefined, data);
  }

  recordRuleHostAutoCorrectApplied(data: RuleHostAutoCorrectAppliedEventData): void {
    this.record('rulehost_auto_correct_applied', 'auto_correct', undefined, data);
  }

  recordRuntimeV2ActivationsInjected(data: RuntimeV2PromptActivationsInjectedEventData): void {
    this.record('runtime_v2_prompt_activations_injected', 'injected', data.sessionId, data);
  }

  /**
   * PRI-437: Record that an approved rule failed to compile or load.
   *
   * This is NOT just a logger.warn — the unhealthy state is persisted to EventLog
   * so it's visible to CLI (pd runtime health) and Console API.
   *
   * ERR-002: degradation includes a reason and nextAction (not silent).
   */
  recordRuleHostUnhealthy(data: RuleHostUnhealthyEventData): void {
    this.record('rulehost_unhealthy', 'failure', undefined, data);
  }

  /**
   * PRI-491: Record that an active activation was skipped at load time for a
   * structured reason (flag-off v2, unsupported action, unsupported context
   * version, missing target_ref). Unlike rulehost_unhealthy (compile/load
   * failures), these are configuration/flag issues — the RuleCode itself may
   * be valid, but the runtime chose not to execute it.
   *
   * ERR-002: degradation/suspension includes reason + nextAction (rc-9).
   */
  recordRuleHostSkipped(data: RuleHostSkippedEventData): void {
    this.record('rulehost_skipped', 'failure', undefined, data);
  }

  /**
   * PRI-647: trajectory observability side-channel failed (closed/disposed
   * SQLite connection) while the prompt build continued (fail-open). Recorded
   * as a structured event so the unavailable state stays observable via the
   * existing events read model — never logged silently.
   */
  recordTrajectoryObservabilityFailure(data: TrajectoryObservabilityFailureEventData): void {
    this.record('trajectory_observability_failure', 'failure', data.sessionId, data);
  }

  /**
   * Redact telemetry-sensitive string values in event data before persistence.
   * Applies redactTelemetryString to known high-risk fields (filePath, command,
   * reason, args, new_string, old_string, text, paramsSummary values) and to all
   * string values in tool_call/rulehost_* data as a safety net.
   *
   * ERR-002: never throws; returns data unchanged on error.
   * ERR-045/046: covers composite command strings, Authorization headers, env vars.
   */
  private redactEventData(
    type: EventType,
    data: Record<string, unknown>
  ): Record<string, unknown> {
    try {
      // Known high-risk event types — telemetry that carries tool commands / paths
      const telemetryTypes: Set<EventType> = new Set([
        'tool_call',
        'rulehost_evaluated',
        'rulehost_blocked',
        'rulehost_requireApproval',
        'rulehost_auto_correct_proposed',
        'rulehost_auto_correct_applied',
        'rulehost_skipped',
        'trajectory_observability_failure',
        'rule_enforced',
        'hook_execution',
        'gate_block',
        'gate_bypass',
      ]);

      if (!telemetryTypes.has(type)) return data;

      const redacted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string') {
          redacted[key] = redactTelemetryString(value);
        } else if (Array.isArray(value)) {
          // Recurse into arrays (e.g. correctedFields with original/applied)
          redacted[key] = value.map((item: unknown) => {
            if (typeof item === 'string') {
              return redactTelemetryString(item);
            }
            if (typeof item === 'object' && item !== null) {
              const nested: Record<string, unknown> = {};
              for (const [nk, nv] of Object.entries(item as Record<string, unknown>)) {
                nested[nk] = typeof nv === 'string' ? redactTelemetryString(nv) : nv;
              }
              return nested;
            }
            return item;
          });
        } else if (typeof value === 'object' && value !== null) {
          // Recurse one level for nested objects (e.g. paramsSummary)
          const nested: Record<string, unknown> = {};
          for (const [nk, nv] of Object.entries(value as Record<string, unknown>)) {
            if (typeof nv === 'string') {
              nested[nk] = redactTelemetryString(nv);
            } else {
              nested[nk] = nv;
            }
          }
          redacted[key] = nested;
        } else {
          redacted[key] = value;
        }
      }
      return redacted;
    } catch (e) {
      // ERR-002: fail safe — never write raw payload on redaction failure.
      // Return a masked payload with context so downstream knows what happened.
      const errStr = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
      const masked: Record<string, unknown> = {
        redactionFailure: true,
        redactionStatus: 'failed',
        'redaction.status': 'failed',
        redactionReason: errStr || 'unknown error',
        redactionDataDropped: true,
        originalType: type,
        originalSessionId: data.sessionId ?? null,
      };
      return masked;
    }
  }

  private record(
    type: EventType, 
    category: EventCategory, 
    sessionId: string | undefined, 
    data: object
  ): void {
    const now = new Date();
    const date = this.formatDate(now);
    
    const redactedData = this.redactEventData(type, data as Record<string, unknown>);
    
    const entry: EventLogEntry = {
      ts: now.toISOString(),
      date,
      type,
      category,
      sessionId,
      data: redactedData,
    };
    
    this.eventBuffer.push(entry);
    this.updateStats(entry);
    
    if (this.eventBuffer.length >= this.maxBufferSize) {
      this.flushEvents();
    }
  }

  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0] ?? '';
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

      const tcData = entry.data as unknown as ToolCallEventData;
      const observedGfi = tcData.gfiAfter ?? tcData.gfi;
      if (observedGfi !== undefined) {
        stats.gfi.samples++;
        stats.gfi.total += observedGfi;
        stats.gfi.peak = Math.max(stats.gfi.peak, observedGfi);
      }
    } else if (entry.type === 'pain_signal') {
      const data = entry.data as unknown as PainSignalEventData;
      // stats.pain.* counters removed (PRI-451 Wave 1.5): no live reader.
      // The user_empathy aggregation below (stats.empathy.*) is LIVE and stays.

      if (data.source === 'user_empathy') {
        if (data.deduped) {
          stats.empathy.dedupedCount++;
        } else {
          stats.empathy.totalEvents++;
          stats.empathy.totalPenaltyScore += data.score || 0;

          if (data.severity) {
            stats.empathy.bySeverity[data.severity]++;
            stats.empathy.scoreBySeverity[data.severity] += data.score || 0;
          }

          if (data.detection_mode) {
            stats.empathy.byDetectionMode[data.detection_mode]++;
          }

          if (data.origin) {
            stats.empathy.byOrigin[data.origin]++;
          }

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

      if (data.hook) {
        if (!stats.hooks.byType[data.hook]) {
          stats.hooks.byType[data.hook] = { total: 0, success: 0, failure: 0 };
        }
        const hookStats = stats.hooks.byType[data.hook];
        if (hookStats) {
          hookStats.total++;
          if (entry.category === 'success') hookStats.success++;
          else hookStats.failure++;
        }
      }
    } else if (entry.type === 'empathy_rollback') {
      const data = entry.data as unknown as EmpathyRollbackEventData;
      stats.empathy.rollbackCount++;
      stats.empathy.rolledBackScore += data.originalScore || 0;
    }
    else if (entry.type === 'rule_promotion') {
      // stats.pain.candidatesPromoted removed (PRI-451 Wave 1.5): dead counter.
      stats.evolution.rulesPromoted++;
    } else if (entry.type === 'evolution_task') {
      if (entry.category === 'completed') {
        stats.evolution.tasksCompleted++;
      } else if (entry.category === 'enqueued') {
        stats.evolution.tasksEnqueued++;
      }
    }
    else if (entry.type === 'diagnosis_task') {
      stats.evolution.diagnosisTasksWritten++;
    } else if (entry.type === 'heartbeat_diagnosis') {
      stats.evolution.heartbeatsInjected++;
    } else if (entry.type === 'diagnostician_report') {
      const raw = entry.data as unknown as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(raw, 'category')) {
        const cat = raw['category'];
        if (typeof cat === 'string' && (cat === 'success' || cat === 'missing_json' || cat === 'incomplete_fields')) {
          stats.evolution.diagnosticianReportsWritten++;
        }
        if (typeof cat === 'string' && cat === 'missing_json') {
          stats.evolution.reportsMissingJson++;
        }
        if (typeof cat === 'string' && cat === 'incomplete_fields') {
          stats.evolution.reportsIncompleteFields++;
        }
      } else if (Object.prototype.hasOwnProperty.call(raw, 'success')) {
        stats.evolution.diagnosticianReportsWritten++;
      }
    } else if (entry.type === 'principle_candidate') {
      stats.evolution.principleCandidatesCreated++;
    } else if (entry.type === 'rule_enforced') {
      stats.evolution.rulesEnforced++;
    }
    else if (entry.type === 'rulehost_evaluated') {
      stats.evolution.rulehostEvaluated++;
    } else if (entry.type === 'rulehost_blocked') {
      stats.evolution.rulehostBlocked++;
    } else if (entry.type === 'rulehost_requireApproval') {
      stats.evolution.rulehostRequireApproval++;
    } else if (entry.type === 'rulehost_auto_correct_proposed') {
      stats.evolution.rulehostAutoCorrectProposed++;
    } else if (entry.type === 'rulehost_auto_correct_applied') {
      stats.evolution.rulehostAutoCorrectApplied++;
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.flushTimer.unref();
  }

  flush(): void {
    this.flushEvents();
    this.flushStats();
  }

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

  getDailyStats(date: string): DailyStats {
    let stats = this.statsCache.get(date);
    if (!stats) {
      stats = createEmptyDailyStats(date);
      this.statsCache.set(date, stats);
    }
    return stats;
  }

  getEmpathyStats(range: 'today' | 'week' | 'session', sessionId?: string): EmpathyEventStats {
    const now = new Date();
    const today = this.formatDate(now);

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
      this.aggregateSessionEmpathy(sessionId, result);
    } else if (range === 'week') {
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

    const total = result.totalEvents + result.dedupedCount;
    result.dedupeHitRate = total > 0 ? result.dedupedCount / total : 0;

    return result;
  }

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

    this.recordEmpathyRollback(sessionId, {
      eventId,
      originalScore,
      originalSessionId: foundEvent.entry.sessionId,
      reason,
      triggeredBy,
    });

    return originalScore;
  }

  getLastEmpathyEventId(sessionId: string): string | null {
    const allEvents = this.getMergedEvents();
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const entry = allEvents[i];
      if (!entry) continue;
      if (entry.sessionId === sessionId && entry.type === 'pain_signal') {
        const data = entry.data as unknown as PainSignalEventData;
        if (data.source === 'user_empathy' && !data.deduped) {
          return data.eventId || null;
        }
      }
    }

    return null;
  }

  findLatestPainSignal(sessionId: string | undefined): PainSignalEventData | null {
    const allEvents = this.getMergedEvents();
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const entry = allEvents[i];
      if (!entry) continue;
      if (entry.sessionId === sessionId && entry.type === "pain_signal") {
        return entry.data as unknown as PainSignalEventData;
      }
    }
    return null;
  }

  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush();
  }
}

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
