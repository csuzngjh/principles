import * as fs from 'fs';
import * as path from 'path';
import type { 
  EventLogEntry, 
  EventType, 
  EventCategory,
  DailyStats,
  ToolCallEventData,
  PainSignalEventData,
  RuleMatchEventData,
  RulePromotionEventData,
  HookExecutionEventData,
  GateBlockEventData,
  EvolutionTaskEventData,
  DeepReflectionEventData,
  TrustChangeEventData,
} from '../types/event-types.js';
import { createEmptyDailyStats } from '../types/event-types.js';
import type { PluginLogger } from '../openclaw-sdk.js';

/**
 * EventLog - Structured event logging with daily statistics aggregation.
 */
export class EventLog {
  private readonly eventsFile: string;
  private readonly statsFile: string;
  private readonly logger?: PluginLogger;
  
  private statsCache: Map<string, DailyStats> = new Map();
  private eventBuffer: EventLogEntry[] = [];
  private readonly maxBufferSize = 20;
  private readonly flushIntervalMs = 30000;
  private flushTimer?: ReturnType<typeof setInterval>;
  
  constructor(stateDir: string, logger?: PluginLogger) {
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
  
  recordHookExecution(data: HookExecutionEventData): void {
    const category = data.error ? 'failure' : 'success';
    this.record('hook_execution', category, undefined, data);
  }
  
  recordGateBlock(sessionId: string | undefined, data: GateBlockEventData): void {
    this.record('gate_block', 'blocked', sessionId, data);
  }
  
  recordEvolutionTask(data: EvolutionTaskEventData): void {
    this.record('evolution_task', 'enqueued', undefined, data);
  }
  
  recordDeepReflection(sessionId: string | undefined, data: DeepReflectionEventData): void {
    const category = data.passed ? 'passed' : data.timeout ? 'failure' : 'completed';
    this.record('deep_reflection', category, sessionId, data);
  }

  recordTrustChange(sessionId: string | undefined, data: TrustChangeEventData): void {
    this.record('trust_change', 'changed', sessionId, data);
  }
  
  recordError(sessionId: string | undefined, message: string, context?: Record<string, unknown>): void {
    this.record('error', 'failure', sessionId, { message, ...context });
  }
  
  recordWarn(sessionId: string | undefined, message: string, context?: Record<string, unknown>): void {
    this.record('warn', 'failure', sessionId, { message, ...context });
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
      const data = entry.data as unknown as ToolCallEventData;
      stats.tools.total++;
      if (entry.category === 'success') stats.tools.success++;
      else stats.tools.failure++;
    } else if (entry.type === 'pain_signal') {
      const data = entry.data as unknown as PainSignalEventData;
      stats.pain.signalsDetected++;
      stats.pain.maxScore = Math.max(stats.pain.maxScore, data.score);
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  flush(): void {
    this.flushEvents();
    this.flushStats();
  }

  private flushEvents(): void {
    if (this.eventBuffer.length === 0) return;
    
    const lines = this.eventBuffer.map(e => JSON.stringify(e)).join('\n') + '\n';
    try {
      fs.appendFileSync(this.eventsFile, lines, 'utf-8');
      this.eventBuffer = [];
    } catch (e) {
      if (this.logger) this.logger.error(`[PD] Failed to flush events.jsonl: ${String(e)}`);
    }
  }

  private flushStats(): void {
    if (this.statsCache.size === 0) return;
    
    const data: Record<string, DailyStats> = {};
    this.statsCache.forEach((stats, date) => {
      data[date] = stats;
    });
    
    try {
      fs.writeFileSync(this.statsFile, JSON.stringify(data, null, 2), 'utf-8');
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
  private static instances: Map<string, EventLog> = new Map();
  
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
}
