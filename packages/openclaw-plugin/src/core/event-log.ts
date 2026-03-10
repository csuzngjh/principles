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
} from '../types/event-types.js';
import { createEmptyDailyStats } from '../types/event-types.js';
import type { PluginLogger } from '../openclaw-sdk.js';

/**
 * EventLog - Structured event logging with daily statistics aggregation.
 * 
 * Features:
 * - JSONL event logging for audit trail
 * - In-memory daily statistics aggregation
 * - Periodic persistence to disk
 * 
 * Usage:
 * ```typescript
 * const eventLog = new EventLog(stateDir, consoleLogger);
 * 
 * eventLog.recordToolCall(sessionId, { toolName: 'write', error: 'EACCES' });
 * eventLog.recordPainSignal(sessionId, { score: 45, source: 'tool_failure' });
 * 
 * const stats = eventLog.getDailyStats('2026-03-08');
 * eventLog.flush();  // Persist to disk
 * ```
 */
export class EventLog {
  private readonly eventsFile: string;
  private readonly statsFile: string;
  private readonly logger?: PluginLogger;
  
  /** In-memory daily stats cache */
  private statsCache: Map<string, DailyStats> = new Map();
  
  /** Write buffer for JSONL events */
  private eventBuffer: EventLogEntry[] = [];
  
  /** Max buffer size before auto-flush */
  private readonly maxBufferSize = 20;
  
  /** Flush interval in ms */
  private readonly flushIntervalMs = 30000; // 30 seconds
  private flushTimer?: ReturnType<typeof setInterval>;
  
  constructor(stateDir: string, logger?: PluginLogger) {
    const logsDir = path.join(stateDir, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    this.eventsFile = path.join(logsDir, 'events.jsonl');
    this.statsFile = path.join(logsDir, 'daily-stats.json');
    this.logger = logger;
    
    // Load existing stats
    this.loadStats();
    
    // Start periodic flush timer
    this.startFlushTimer();
  }
  
  // ============== Public Recording Methods ==============
  
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
  
  recordError(sessionId: string | undefined, message: string, context?: Record<string, unknown>): void {
    this.record('error', 'failure', sessionId, { message, ...context });
  }
  
  recordWarn(sessionId: string | undefined, message: string, context?: Record<string, unknown>): void {
    this.record('warn', 'failure', sessionId, { message, ...context });
  }
  
  // ============== Core Recording Logic ==============
  
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
    
    // Add to buffer
    this.eventBuffer.push(entry);
    
    // Update stats
    this.updateStats(entry);
    
    // Auto-flush if buffer is full
    if (this.eventBuffer.length >= this.maxBufferSize) {
      this.flushEvents();
    }
  }
  
  // ============== Statistics Aggregation ==============
  
  private updateStats(entry: EventLogEntry): void {
    const stats = this.getOrCreateStats(entry.date);
    
    switch (entry.type) {
      case 'tool_call':
        this.updateToolCallStats(stats, entry);
        break;
      case 'pain_signal':
        this.updatePainStats(stats, entry);
        break;
      case 'rule_match':
        this.updateRuleMatchStats(stats, entry);
        break;
      case 'rule_promotion':
        this.updateRulePromotionStats(stats);
        break;
      case 'gate_block':
        this.updateGateBlockStats(stats);
        break;
      case 'evolution_task':
        this.updateEvolutionStats(stats);
        break;
      case 'hook_execution':
        this.updateHookStats(stats, entry);
        break;
      case 'deep_reflection':
        this.updateDeepReflectionStats(stats, entry);
        break;
    }
    
    stats.updatedAt = new Date().toISOString();
  }
  
  private updateToolCallStats(stats: DailyStats, entry: EventLogEntry): void {
    const data = entry.data as unknown as ToolCallEventData;
    stats.toolCalls.total++;
    
    if (entry.category === 'failure') {
      stats.toolCalls.failure++;
      stats.errors.total++;
      
      // By error type
      if (data.errorType) {
        stats.errors.byType[data.errorType] = (stats.errors.byType[data.errorType] || 0) + 1;
      }
      
      // By tool
      if (data.toolName) {
        stats.errors.byTool[data.toolName] = (stats.errors.byTool[data.toolName] || 0) + 1;
      }
    } else {
      stats.toolCalls.success++;
    }
    
    // By tool
    if (data.toolName) {
      if (!stats.toolCalls.byTool[data.toolName]) {
        stats.toolCalls.byTool[data.toolName] = { success: 0, failure: 0 };
      }
      if (entry.category === 'failure') {
        stats.toolCalls.byTool[data.toolName].failure++;
      } else {
        stats.toolCalls.byTool[data.toolName].success++;
      }
    }
    
    // GFI tracking
    if (data.gfi !== undefined) {
      const hour = new Date(entry.ts).getHours();
      stats.gfi.hourlyDistribution[hour] = Math.max(stats.gfi.hourlyDistribution[hour], data.gfi);
      stats.gfi.peak = Math.max(stats.gfi.peak, data.gfi);
      stats.gfi.samples++;
      stats.gfi.total += data.gfi;
    }
  }
  
  private updatePainStats(stats: DailyStats, entry: EventLogEntry): void {
    const data = entry.data as unknown as PainSignalEventData;
    stats.pain.signalsDetected++;
    
    // By source
    if (data.source) {
      stats.pain.signalsBySource[data.source] = (stats.pain.signalsBySource[data.source] || 0) + 1;
    }
    
    // Score tracking
    if (data.score !== undefined) {
      stats.pain.maxScore = Math.max(stats.pain.maxScore, data.score);
      const totalScore = stats.pain.avgScore * (stats.pain.signalsDetected - 1) + data.score;
      stats.pain.avgScore = totalScore / stats.pain.signalsDetected;
    }
  }
  
  private updateRuleMatchStats(stats: DailyStats, entry: EventLogEntry): void {
    const data = entry.data as unknown as RuleMatchEventData;
    if (data.ruleId) {
      stats.pain.rulesMatched[data.ruleId] = (stats.pain.rulesMatched[data.ruleId] || 0) + 1;
    }
  }
  
  private updateRulePromotionStats(stats: DailyStats): void {
    stats.pain.candidatesPromoted++;
    stats.evolution.rulesPromoted++;
  }
  
  private updateGateBlockStats(stats: DailyStats): void {
    // Gate blocks are counted in tool calls failure
  }
  
  private updateEvolutionStats(stats: DailyStats): void {
    stats.evolution.tasksEnqueued++;
  }
  
  private updateHookStats(stats: DailyStats, entry: EventLogEntry): void {
    const data = entry.data as unknown as HookExecutionEventData;
    if (data.hookName) {
      stats.hooks.byType[data.hookName] = (stats.hooks.byType[data.hookName] || 0) + 1;
    }
    if (data.durationMs) {
      stats.hooks.totalDurationMs += data.durationMs;
    }
    if (data.error) {
      stats.hooks.errors++;
    }
  }
  
  private updateDeepReflectionStats(stats: DailyStats, entry: EventLogEntry): void {
    const data = entry.data as unknown as DeepReflectionEventData;
    stats.deepReflection.totalCalls++;
    
    // 按状态统计
    if (data.passed) {
      stats.deepReflection.passedCount++;
    } else if (data.timeout) {
      stats.deepReflection.timeoutCount++;
    } else if (data.error) {
      stats.deepReflection.errorCount++;
    } else {
      stats.deepReflection.issuesFoundCount++;
    }
    
    // 按模型统计
    if (data.modelId) {
      if (!stats.deepReflection.byModel[data.modelId]) {
        stats.deepReflection.byModel[data.modelId] = { 
          count: 0, 
          avgDurationMs: 0,
          passedCount: 0 
        };
      }
      const modelStats = stats.deepReflection.byModel[data.modelId];
      modelStats.count++;
      modelStats.avgDurationMs = (modelStats.avgDurationMs * (modelStats.count - 1) + data.durationMs) / modelStats.count;
      if (data.passed) modelStats.passedCount++;
    }
    
    // 按深度统计
    if (data.depth) {
      stats.deepReflection.byDepth[data.depth] = (stats.deepReflection.byDepth[data.depth] || 0) + 1;
    }
    
    // 耗时统计
    stats.deepReflection.totalDurationMs += data.durationMs;
    stats.deepReflection.avgDurationMs = stats.deepReflection.totalDurationMs / stats.deepReflection.totalCalls;
    
    // 盲点和风险统计
    if (data.blindSpotsCount) {
      stats.deepReflection.totalBlindSpots += data.blindSpotsCount;
    }
    if (data.risksCount) {
      stats.deepReflection.totalRisks += data.risksCount;
    }
    
    // 置信度分布
    if (data.confidence) {
      stats.deepReflection.confidenceDistribution[data.confidence]++;
    }
  }
  
  // ============== Persistence ==============
  
  getDailyStats(date: string): DailyStats {
    return this.getOrCreateStats(date);
  }
  
  getTodayStats(): DailyStats {
    return this.getOrCreateStats(this.formatDate(new Date()));
  }
  
  private getOrCreateStats(date: string): DailyStats {
    if (!this.statsCache.has(date)) {
      this.statsCache.set(date, createEmptyDailyStats(date));
    }
    return this.statsCache.get(date)!;
  }
  
  flush(): void {
    this.flushEvents();
    this.flushStats();
  }
  
  /**
   * Force flush and stop timer (call on shutdown)
   */
  shutdown(): void {
    this.stopFlushTimer();
    this.flush();
  }
  
  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.flushIntervalMs);
    // Don't prevent process exit
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }
  
  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }
  
  private flushEvents(): void {
    if (this.eventBuffer.length === 0) return;
    
    try {
      const lines = this.eventBuffer.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.appendFileSync(this.eventsFile, lines, 'utf-8');
      this.eventBuffer = [];
    } catch (err) {
      this.logger?.error(`[EventLog] Failed to flush events: ${String(err)}`);
    }
  }
  
  private flushStats(): void {
    try {
      const allStats: Record<string, DailyStats> = {};
      for (const [date, stats] of this.statsCache) {
        allStats[date] = stats;
      }
      fs.writeFileSync(this.statsFile, JSON.stringify(allStats, null, 2), 'utf-8');
    } catch (err) {
      this.logger?.error(`[EventLog] Failed to flush stats: ${String(err)}`);
    }
  }
  
  private loadStats(): void {
    try {
      if (fs.existsSync(this.statsFile)) {
        const content = fs.readFileSync(this.statsFile, 'utf-8');
        const data = JSON.parse(content) as Record<string, DailyStats>;
        for (const [date, stats] of Object.entries(data)) {
          this.statsCache.set(date, stats);
        }
      }
    } catch (err) {
      this.logger?.warn(`[EventLog] Failed to load stats: ${String(err)}`);
    }
  }
  
  // ============== Helpers ==============
  
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }
  
  /**
   * Record GFI reset (success after failure)
   */
  recordGfiReset(sessionId: string | undefined, previousGfi: number): void {
    const stats = this.getTodayStats();
    stats.gfi.resetCount++;
    this.logger?.debug?.(`[EventLog] GFI reset from ${previousGfi}`);
  }
}

// ============== Singleton Service ==============
//
// DESIGN NOTE: This singleton is per-process. In OpenClaw, each session runs in the same
// process, so stateDir should be consistent. If stateDir changes (rare), a new instance
// is created. For multi-process scenarios, each process has its own instance, which is
// acceptable since event logs are persisted to disk and can be merged later.
//

let instance: EventLog | null = null;
let lastStateDir: string | null = null;

export const EventLogService = {
  get(stateDir: string, logger?: PluginLogger): EventLog {
    if (!instance || lastStateDir !== stateDir) {
      instance = new EventLog(stateDir, logger);
      lastStateDir = stateDir;
    }
    return instance;
  },
  
  reset(): void {
    instance = null;
    lastStateDir = null;
  },
};
