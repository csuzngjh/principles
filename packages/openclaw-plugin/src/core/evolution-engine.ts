/**
 * Evolution Engine V2.0 - MVP
 * 
 * 成长驱动的进化积分系统，替代惩罚驱动的 Trust Engine。
 * 
 * 核心原则：
 * 1. 起点0分，只能增加，不扣分
 * 2. 失败记录教训，不扣分
 * 3. 同类任务失败后首次成功 = 双倍奖励（1小时冷却）
 * 4. 高等级做低级任务积分衰减
 * 5. 原子写入防止并发损坏
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolvePdPath } from './paths.js';
import { withLock } from '../utils/file-lock.js';
import {
  CONSTRUCTIVE_TOOLS,
  EXPLORATORY_TOOLS,
  HIGH_RISK_TOOLS,
} from '../constants/tools.js';

import type {
  EvolutionEvent,
  EvolutionScorecard,
  EvolutionStats,
  EvolutionConfig,
  TaskDifficulty,
  TierDefinition,
  GateDecision,
  ToolCallContext} from './evolution-types.js';
import {
  EvolutionTier,
  DEFAULT_EVOLUTION_CONFIG,
  TIER_DEFINITIONS,
  TASK_DIFFICULTY_CONFIG,
  getTierDefinition,
  getTierByPoints,
} from './evolution-types.js';

// ===== 主引擎 =====

export class EvolutionEngine {
  private readonly scorecard: EvolutionScorecard;
  private readonly workspaceDir: string;
  private readonly stateDir: string;
  private readonly config: EvolutionConfig;
  private readonly storagePath: string;

  constructor(workspaceDir: string, config?: Partial<EvolutionConfig>) {
    this.workspaceDir = workspaceDir;
    this.stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config };
    this.storagePath = path.join(this.stateDir, 'evolution-scorecard.json');
    this.scorecard = this.loadOrCreateScorecard();
  }

  // ===== 公共 API =====

  /** 获取当前积分 */
  public getPoints(): number {
    return this.scorecard.totalPoints;
  }

  /** 获取可用积分 */
  public getAvailablePoints(): number {
    return this.scorecard.availablePoints;
  }

  /** 获取当前等级 */
  public getTier(): EvolutionTier {
    return this.scorecard.currentTier;
  }

  /** 获取当前等级定义 */
  public getTierDefinition(): TierDefinition {
    return getTierDefinition(this.scorecard.currentTier);
  }

  /** 获取完整积分卡 */
  public getScorecard(): EvolutionScorecard {
    return { ...this.scorecard };
  }

  /** 获取统计信息 */
  public getStats(): EvolutionStats {
    return { ...this.scorecard.stats };
  }

  /** 获取状态摘要 */
  public getStatusSummary() {
    const tierDef = this.getTierDefinition();
    const nextTierDef = TIER_DEFINITIONS[this.scorecard.currentTier]; // undefined if max
    
    return {
      tier: this.scorecard.currentTier,
      tierName: tierDef.name,
      totalPoints: this.scorecard.totalPoints,
      availablePoints: this.scorecard.availablePoints,
      permissions: tierDef.permissions,
      stats: this.scorecard.stats,
      nextTier: nextTierDef ? {
        tier: nextTierDef.tier,
        name: nextTierDef.name,
        pointsNeeded: nextTierDef.requiredPoints - this.scorecard.totalPoints,
      } : null,
    };
  }

  // ===== 记录成功 =====

  public recordSuccess(
    toolName: string,
    options?: {
      filePath?: string;
      difficulty?: TaskDifficulty;
      reason?: string;
      sessionId?: string;
    }
  ): { pointsAwarded: number; isDoubleReward: boolean; newTier?: EvolutionTier } {
    // 探索性工具成功不给积分，只重置失败记录
    if (EXPLORATORY_TOOLS.has(toolName)) {
      const taskHash = EvolutionEngine.computeTaskHash(toolName, options?.filePath);
      this.scorecard.recentFailureHashes.delete(taskHash);
      this.saveScorecard();
      return { pointsAwarded: 0, isDoubleReward: false };
    }

    const difficulty = options?.difficulty || EvolutionEngine.inferDifficulty(toolName);
    const taskHash = EvolutionEngine.computeTaskHash(toolName, options?.filePath);
    
    // 计算积分
    let points = this.calculatePoints(difficulty, taskHash);
    const isDoubleReward = points > TASK_DIFFICULTY_CONFIG[difficulty].basePoints;

    // 更新积分
    this.scorecard.totalPoints += points;
    this.scorecard.availablePoints += points;

    // 更新统计
    this.scorecard.stats.totalSuccesses++;
    this.scorecard.stats.consecutiveSuccesses++;
    this.scorecard.stats.consecutiveFailures = 0;
    this.scorecard.stats.pointsByDifficulty[difficulty] += points;
    if (isDoubleReward) {
      this.scorecard.stats.doubleRewardsEarned++;
      this.scorecard.lastDoubleRewardTime = new Date().toISOString();
    }

    // 清除失败记录
    this.scorecard.recentFailureHashes.delete(taskHash);

    // 记录事件
    const event = this.createEvent('success', taskHash, difficulty, toolName, options?.filePath, options?.reason, points, isDoubleReward, options?.sessionId);
    this.addEvent(event);

    // 检查升级
    const newTier = this.checkAndApplyPromotion();

    this.saveScorecard();

    return { pointsAwarded: points, isDoubleReward, newTier };
  }

  // ===== 记录失败 =====

  public recordFailure(
    toolName: string,
    options?: {
      filePath?: string;
      difficulty?: TaskDifficulty;
      reason?: string;
      sessionId?: string;
    }
  ): { pointsAwarded: number; lessonRecorded: boolean } {
    // 探索性工具失败：记录但几乎不影响
    if (EXPLORATORY_TOOLS.has(toolName)) {
      const event = this.createEvent('failure', EvolutionEngine.computeTaskHash(toolName, options?.filePath), 'trivial', toolName, options?.filePath, options?.reason, 0, false, options?.sessionId);
      this.addEvent(event);
      this.saveScorecard();
      return { pointsAwarded: 0, lessonRecorded: true };
    }

    const difficulty = options?.difficulty || EvolutionEngine.inferDifficulty(toolName);
    const taskHash = EvolutionEngine.computeTaskHash(toolName, options?.filePath);

    // 失败不扣分，但记录教训（用于后续双倍奖励）
    this.scorecard.recentFailureHashes.set(taskHash, new Date().toISOString());

    // 更新统计
    this.scorecard.stats.totalFailures++;
    this.scorecard.stats.consecutiveFailures++;
    this.scorecard.stats.consecutiveSuccesses = 0;

    // 记录事件（0分）
    const event = this.createEvent('failure', taskHash, difficulty, toolName, options?.filePath, options?.reason, 0, false, options?.sessionId);
    this.addEvent(event);

    this.saveScorecard();

    return { pointsAwarded: 0, lessonRecorded: true };
  }

  // ===== Gate 集成 =====

  /** 工具调用前检查 */
  public beforeToolCall(context: ToolCallContext): GateDecision {
    const tierDef = this.getTierDefinition();
    const perms = tierDef.permissions;

    // 风险路径检查
    if (context.isRiskPath && !perms.allowRiskPath) {
      return {
        allowed: false,
        reason: `Tier ${this.scorecard.currentTier} (${tierDef.name}) 未解锁风险路径权限`,
        currentTier: this.scorecard.currentTier,
      };
    }

    // 高风险工具检查（不包括子智能体，它们有单独控制）
    if (HIGH_RISK_TOOLS.has(context.toolName) && !perms.allowRiskPath) {
      return {
        allowed: false,
        reason: `Tier ${this.scorecard.currentTier} (${tierDef.name}) 未解锁高风险工具权限`,
        currentTier: this.scorecard.currentTier,
      };
    }

    // 子智能体检查
    if (context.toolName === 'sessions_spawn' && !perms.allowSubagentSpawn) {
      return {
        allowed: false,
        reason: `Tier ${this.scorecard.currentTier} (${tierDef.name}) 未解锁子智能体权限`,
        currentTier: this.scorecard.currentTier,
      };
    }

    return { allowed: true, currentTier: this.scorecard.currentTier };
  }

  // ===== 积分计算 =====

  private calculatePoints(difficulty: TaskDifficulty, taskHash: string): number {
    const {basePoints} = TASK_DIFFICULTY_CONFIG[difficulty];
    
    // 难度衰减
    const penalty = this.getDifficultyPenalty(difficulty);
    let points = Math.max(1, Math.floor(basePoints * penalty));

    // 双倍奖励检查
    if (this.canReceiveDoubleReward(taskHash)) {
      points *= 2;
    }

    return points;
  }

  private getDifficultyPenalty(difficulty: TaskDifficulty): number {
    const tier = this.scorecard.currentTier;
    const dc = this.config.difficultyPenalty;

    if (tier >= EvolutionTier.Tree) {
      if (difficulty === 'trivial') return dc.tier4Trivial;
      if (difficulty === 'normal') return dc.tier4Normal;
    }
    if (tier >= EvolutionTier.Forest) {
      if (difficulty === 'trivial') return dc.tier5Trivial;
      if (difficulty === 'normal') return dc.tier5Normal;
    }
    return 1.0;
  }

  private canReceiveDoubleReward(taskHash: string): boolean {
    // 必须有该任务的失败记录
    if (!this.scorecard.recentFailureHashes.has(taskHash)) {
      return false;
    }

    // 冷却检查：1小时内最多1次双倍奖励
    if (this.scorecard.lastDoubleRewardTime) {
      const elapsed = Date.now() - new Date(this.scorecard.lastDoubleRewardTime).getTime();
      if (elapsed < this.config.doubleRewardCooldownMs) {
        return false;
      }
    }

    return true;
  }

  // ===== 等级晋升 =====

  private checkAndApplyPromotion(): EvolutionTier | undefined {
    const newTier = getTierByPoints(this.scorecard.totalPoints);
    
    if (newTier > this.scorecard.currentTier) {
      const previousTier = this.scorecard.currentTier;
      this.scorecard.currentTier = newTier;
      this.scorecard.stats.tierPromotions++;

      console.log(`[Evolution] 🎉 Tier promotion: ${previousTier} → ${newTier} (${getTierDefinition(newTier).name})`);
      
      return newTier;
    }

    return undefined;
  }

  // ===== 任务难度推断 =====

  private static inferDifficulty(toolName: string): TaskDifficulty {
    if (HIGH_RISK_TOOLS.has(toolName)) return 'hard';
    if (CONSTRUCTIVE_TOOLS.has(toolName)) return 'normal';
    return 'trivial';
  }

  // ===== 任务哈希 =====

  private static computeTaskHash(toolName: string, filePath?: string): string {
    const normalizedPath = filePath ? path.normalize(filePath) : '_nofile';
    return `${toolName}:${normalizedPath}`;
  }

  // ===== 事件管理 =====

  // eslint-disable-next-line @typescript-eslint/max-params -- Reason: event creation requires all event fields - refactoring would break internal structure
  private createEvent(
    type: 'success' | 'failure',
    taskHash: string,
    difficulty: TaskDifficulty,
    toolName: string,
    filePath: string | undefined,
    reason: string | undefined,
    points: number,
    isDoubleReward: boolean,
    sessionId?: string
  ): EvolutionEvent {
    return {
      id: this.generateId(),
      timestamp: new Date().toISOString(),
      type,
      taskHash,
      taskDifficulty: difficulty,
      toolName,
      filePath,
      reason,
      pointsAwarded: points,
      isDoubleReward,
      sessionId,
    };
  }

  private addEvent(event: EvolutionEvent): void {
    this.scorecard.recentEvents.push(event);
    
    // 限制事件数量
    if (this.scorecard.recentEvents.length > this.config.maxRecentEvents) {
      this.scorecard.recentEvents.shift();
    }
  }

  // ===== 存储 =====

  private loadOrCreateScorecard(): EvolutionScorecard {
    // 尝试从文件加载
    if (fs.existsSync(this.storagePath)) {
      try {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const data = JSON.parse(raw);
        if (data.version === '2.0') {
          // 恢复 Map 类型
          if (data.recentFailureHashes && Array.isArray(data.recentFailureHashes)) {
            data.recentFailureHashes = new Map(data.recentFailureHashes);
          } else if (!data.recentFailureHashes) {
            data.recentFailureHashes = new Map();
          }
          return data;
        }
      } catch (e) {
        console.error(`[Evolution] Failed to parse scorecard at ${this.storagePath}. Creating new.`, e);
      }
    }

    // 创建新的积分卡
    return this.createNewScorecard();
  }

  private createNewScorecard(): EvolutionScorecard {
    const now = new Date().toISOString();
    return {
      version: '2.0',
      agentId: 'default',
      totalPoints: 0,
      availablePoints: 0,
      currentTier: EvolutionTier.Seed,
      recentFailureHashes: new Map(),
      stats: {
        totalSuccesses: 0,
        totalFailures: 0,
        consecutiveSuccesses: 0,
        consecutiveFailures: 0,
        doubleRewardsEarned: 0,
        tierPromotions: 0,
        pointsByDifficulty: { trivial: 0, normal: 0, hard: 0 },
      },
      recentEvents: [],
      lastUpdated: now,
    };
  }

  /** 持久化评分卡（含锁保护） */
  private saveScorecard(): void {
    this.scorecard.lastUpdated = new Date().toISOString();

    // 确保目录存在
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 序列化（Map 转 Array）
    const serializable = {
      ...this.scorecard,
      recentFailureHashes: Array.from(this.scorecard.recentFailureHashes.entries()),
    };

    const tempPath = `${this.storagePath}.tmp.${Date.now()}.${process.pid}`;
    try {
      withLock(this.storagePath, () => {
        fs.writeFileSync(tempPath, JSON.stringify(serializable, null, 2), 'utf8');

        // fsync 确保数据落盘
        const fd = fs.openSync(tempPath, 'r+');
        fs.fsyncSync(fd);
        fs.closeSync(fd);

        // 原子重命名
        fs.renameSync(tempPath, this.storagePath);
      }, {
        lockSuffix: '.lock',
        lockStaleMs: 30_000,
      });
    } catch (e) {
      console.error(`[Evolution] Failed to save scorecard: ${String(e)}`);
      this.scheduleRetrySave();
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }

  /** Per-instance retry queue (P0 fix: was static, causing cross-instance race) */
  private retryQueue: { engine: EvolutionEngine; data: Partial<EvolutionScorecard> }[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** 调度重试保存 */
  private scheduleRetrySave(): void {
    // 每个引擎只保留最新数据
    this.retryQueue = this.retryQueue.filter(item => item.engine !== this);
    this.retryQueue.push({ engine: this, data: { ...this.scorecard } });

    // 启动重试定时器（每个实例独立）
    if (!this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.processRetryQueue();
      }, 1000);
    }
  }

  /** 处理重试队列 */
  private processRetryQueue(): void {
    this.retryTimer = null;

    const latestByEngine = new Map<EvolutionEngine, Partial<EvolutionScorecard>>();
    for (const item of this.retryQueue) {
      latestByEngine.set(item.engine, item.data);
    }
    this.retryQueue = [];

    for (const [engine, data] of latestByEngine) {
      try {
        engine.saveScorecardImmediate(data);
        console.log(`[Evolution] Retry save succeeded for ${engine.workspaceDir}`);
      } catch (e) {
        console.error(`[Evolution] Retry save failed: ${String(e)}`);
        engine.scheduleRetrySave(); // 每个引擎独立重试
      }
    }
  }

  /** 无锁快速保存（用于重试） */
  private saveScorecardImmediate(data: Partial<EvolutionScorecard>): void {
    const serializable = {
      ...this.scorecard,
      ...data,
      recentFailureHashes: Array.from(this.scorecard.recentFailureHashes.entries()),
    };

    const tempPath = `${this.storagePath}.tmp.retry.${Date.now()}.${process.pid}`;
    withLock(this.storagePath, () => {
      try {
        fs.writeFileSync(tempPath, JSON.stringify(serializable, null, 2), 'utf8');

        const fd = fs.openSync(tempPath, 'r');
        fs.fsyncSync(fd);
        fs.closeSync(fd);

        fs.renameSync(tempPath, this.storagePath);
      } catch (error) {
        // Clean up temp file on failure
        try {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        } catch {
          // Ignore cleanup errors
        }
        throw error;
      }
    }, {
      lockSuffix: '.lock',
      lockStaleMs: 30_000,
    });
  }

  // ===== 工具方法 =====

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  dispose(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryQueue = [];
  }
}

// ===== 便捷函数 =====

// 使用 Map 按 workspace 隔离实例，避免多 workspace 场景状态串扰
const _instances = new Map<string, EvolutionEngine>();

/** 获取指定 workspace 的引擎实例 */
export function getEvolutionEngine(workspaceDir: string): EvolutionEngine {
  const resolved = path.resolve(workspaceDir);
  if (!_instances.has(resolved)) {
    _instances.set(resolved, new EvolutionEngine(resolved));
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Reason: set() above guarantees get() returns non-null
  return _instances.get(resolved)!;
}

export function disposeEvolutionEngine(workspaceDir: string): void {
  const resolved = path.resolve(workspaceDir);
  const instance = _instances.get(resolved);
  if (!instance) return;
  instance.dispose();
  _instances.delete(resolved);
}

export function disposeAllEvolutionEngines(): void {
  for (const instance of _instances.values()) {
    instance.dispose();
  }
  _instances.clear();
}

/** 记录成功（便捷函数） */
export function recordEvolutionSuccess(
  workspaceDir: string,
  toolName: string,
  options?: {
    filePath?: string;
    difficulty?: TaskDifficulty;
    reason?: string;
    sessionId?: string;
  }
): { pointsAwarded: number; isDoubleReward: boolean; newTier?: EvolutionTier } {
  return getEvolutionEngine(workspaceDir).recordSuccess(toolName, options);
}

/** 记录失败（便捷函数） */
export function recordEvolutionFailure(
  workspaceDir: string,
  toolName: string,
  options?: {
    filePath?: string;
    difficulty?: TaskDifficulty;
    reason?: string;
    sessionId?: string;
  }
): { pointsAwarded: number; lessonRecorded: boolean } {
  return getEvolutionEngine(workspaceDir).recordFailure(toolName, options);
}

/** Gate 检查（便捷函数） */
export function checkEvolutionGate(
  workspaceDir: string,
  context: ToolCallContext
): GateDecision {
  return getEvolutionEngine(workspaceDir).beforeToolCall(context);
}
