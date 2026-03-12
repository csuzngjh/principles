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
import { EventLogService } from './event-log.js';
import {
  EvolutionTier,
  EvolutionEvent,
  EvolutionScorecard,
  EvolutionStats,
  EvolutionConfig,
  EvolutionStorage,
  TaskDifficulty,
  TierDefinition,
  TierPermissions,
  GateDecision,
  ToolCallContext,
  TierPromotionEvent,
  DEFAULT_EVOLUTION_CONFIG,
  TIER_DEFINITIONS,
  TASK_DIFFICULTY_CONFIG,
  getTierDefinition,
  getTierByPoints,
} from './evolution-types.js';

// ===== 工具分类（复用 Trust Engine 的分类） =====

const EXPLORATORY_TOOLS = new Set([
  'read', 'read_file', 'read_many_files', 'image_read',
  'search_file_content', 'grep', 'grep_search', 'list_directory', 'ls', 'glob',
  'web_fetch', 'web_search',
  'ask_user', 'ask_user_question',
  'memory_recall', 'save_memory',
]);

const CONSTRUCTIVE_TOOLS = new Set([
  'write', 'write_file', 'edit', 'edit_file', 'replace', 'apply_patch',
  'insert', 'patch', 'delete_file', 'move_file', 'run_shell_command',
  'pd_spawn_agent', 'sessions_spawn',
]);

const HIGH_RISK_TOOLS = new Set([
  'run_shell_command', 'delete_file', 'move_file',
  'pd_spawn_agent', 'sessions_spawn',
]);

// ===== 主引擎 =====

export class EvolutionEngine {
  private scorecard: EvolutionScorecard;
  private workspaceDir: string;
  private stateDir: string;
  private config: EvolutionConfig;
  private storagePath: string;

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
      const taskHash = this.computeTaskHash(toolName, options?.filePath);
      this.scorecard.recentFailureHashes.delete(taskHash);
      this.saveScorecard();
      return { pointsAwarded: 0, isDoubleReward: false };
    }

    const difficulty = options?.difficulty || this.inferDifficulty(toolName);
    const taskHash = this.computeTaskHash(toolName, options?.filePath);
    
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
      const event = this.createEvent('failure', this.computeTaskHash(toolName, options?.filePath), 'trivial', toolName, options?.filePath, options?.reason, 0, false, options?.sessionId);
      this.addEvent(event);
      this.saveScorecard();
      return { pointsAwarded: 0, lessonRecorded: true };
    }

    const difficulty = options?.difficulty || this.inferDifficulty(toolName);
    const taskHash = this.computeTaskHash(toolName, options?.filePath);

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

    // 行数检查
    if (context.content) {
      const lineCount = context.content.split('\n').length;
      if (lineCount > perms.maxLinesPerWrite) {
        return {
          allowed: false,
          reason: `Tier ${this.scorecard.currentTier} (${tierDef.name}) 限制: 最多 ${perms.maxLinesPerWrite} 行，当前 ${lineCount} 行`,
          currentTier: this.scorecard.currentTier,
        };
      }
    }

    if (context.lineCount && context.lineCount > perms.maxLinesPerWrite) {
      return {
        allowed: false,
        reason: `Tier ${this.scorecard.currentTier} (${tierDef.name}) 限制: 最多 ${perms.maxLinesPerWrite} 行`,
        currentTier: this.scorecard.currentTier,
      };
    }

    // 风险路径检查
    if (context.isRiskPath && !perms.allowRiskPath) {
      return {
        allowed: false,
        reason: `Tier ${this.scorecard.currentTier} (${tierDef.name}) 未解锁风险路径权限`,
        currentTier: this.scorecard.currentTier,
      };
    }

    // 高风险工具检查
    if (HIGH_RISK_TOOLS.has(context.toolName) && !perms.allowRiskPath) {
      return {
        allowed: false,
        reason: `Tier ${this.scorecard.currentTier} (${tierDef.name}) 未解锁高风险工具权限`,
        currentTier: this.scorecard.currentTier,
      };
    }

    // 子智能体检查
    if ((context.toolName === 'pd_spawn_agent' || context.toolName === 'sessions_spawn') && !perms.allowSubagentSpawn) {
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
    const basePoints = TASK_DIFFICULTY_CONFIG[difficulty].basePoints;
    
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

      // 记录升级事件
      const promotionEvent: TierPromotionEvent = {
        previousTier,
        newTier,
        totalPoints: this.scorecard.totalPoints,
        timestamp: new Date().toISOString(),
        newPermissions: getTierDefinition(newTier).permissions,
      };

      console.log(`[Evolution] 🎉 Tier promotion: ${previousTier} → ${newTier} (${getTierDefinition(newTier).name})`);
      
      return newTier;
    }

    return undefined;
  }

  // ===== 任务难度推断 =====

  private inferDifficulty(toolName: string): TaskDifficulty {
    if (HIGH_RISK_TOOLS.has(toolName)) return 'hard';
    if (CONSTRUCTIVE_TOOLS.has(toolName)) return 'normal';
    return 'trivial';
  }

  // ===== 任务哈希 =====

  private computeTaskHash(toolName: string, filePath?: string): string {
    const normalizedPath = filePath ? path.normalize(filePath) : '_nofile';
    return `${toolName}:${normalizedPath}`;
  }

  // ===== 事件管理 =====

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

    // 文件锁：防止并发写入导致数据损坏
    const lockPath = `${this.storagePath}.lock`;
    const maxRetries = 10;
    const retryDelayMs = 20;

    // 获取锁
    let acquired = false;
    for (let i = 0; i < maxRetries; i++) {
      try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        acquired = true;
        break;
      } catch {
        // 锁被占用，等待后重试
        const start = Date.now();
        while (Date.now() - start < retryDelayMs) { /* busy wait */ }
      }
    }

    if (!acquired) {
      console.error(`[Evolution] Failed to acquire lock after ${maxRetries} retries`);
      // 强制清除过期锁（超过5秒视为过期）
      try {
        const lockStat = fs.statSync(lockPath);
        if (Date.now() - lockStat.mtimeMs > 5000) {
          fs.unlinkSync(lockPath);
        }
      } catch {}
      return;
    }

    // 原子写入：先写临时文件，再重命名
    const tempPath = `${this.storagePath}.tmp.${Date.now()}`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(serializable, null, 2), 'utf8');
      fs.renameSync(tempPath, this.storagePath);
    } catch (e) {
      console.error(`[Evolution] Failed to save scorecard: ${String(e)}`);
      try { fs.unlinkSync(tempPath); } catch {}
    } finally {
      // 释放锁
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  // ===== 工具方法 =====

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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
  return _instances.get(resolved)!;
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
