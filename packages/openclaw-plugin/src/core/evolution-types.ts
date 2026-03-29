/**
 * Evolution Points System V2.0 - MVP
 * 
 * Core Philosophy: Growth-driven替代Penalty-driven
 * - 起点0分，只能增加，不扣分
 * - 失败记录教训，不扣分
 * - 同类任务失败后首次成功 = 双倍奖励（1小时冷却）
 * - 5级成长路径：Seed → Forest
 */

// ===== 等级定义 =====

export enum EvolutionTier {
  Seed = 1,      // 起步：150行 + 3文件 + 子智能体（现代 AI 能力已足够强）
  Sprout = 2,    // 成长：300行 + 5文件
  Sapling = 3,   // 独当：500行 + 10文件 + 风险路径
  Tree = 4,      // 专家：1000行 + 20文件
  Forest = 5     // 大师：完全自主
}

export interface TierPermissions {
  maxLinesPerWrite: number;
  maxFilesPerTask: number;
  allowRiskPath: boolean;
  allowSubagentSpawn: boolean;
}

export interface TierDefinition {
  tier: EvolutionTier;
  name: string;
  requiredPoints: number;
  permissions: TierPermissions;
}

export const TIER_DEFINITIONS: readonly TierDefinition[] = [
  // 2026-03-28: 大幅放宽限制，现代 AI 能力已很强
  // Seed: 从 20 行提升到 150 行，允许 3 文件，允许子智能体
  { tier: EvolutionTier.Seed,    name: 'Seed',    requiredPoints: 0,    permissions: { maxLinesPerWrite: 150,  maxFilesPerTask: 3,  allowRiskPath: false, allowSubagentSpawn: true  }},
  // Sprout: 中等规模开发
  { tier: EvolutionTier.Sprout,  name: 'Sprout',  requiredPoints: 50,   permissions: { maxLinesPerWrite: 300,  maxFilesPerTask: 5,  allowRiskPath: false, allowSubagentSpawn: true  }},
  // Sapling: 较大规模开发，可访问风险路径（需 PLAN）
  { tier: EvolutionTier.Sapling, name: 'Sapling', requiredPoints: 200,  permissions: { maxLinesPerWrite: 500,  maxFilesPerTask: 10, allowRiskPath: true,  allowSubagentSpawn: true  }},
  // Tree: 大型重构
  { tier: EvolutionTier.Tree,    name: 'Tree',    requiredPoints: 500,  permissions: { maxLinesPerWrite: 1000, maxFilesPerTask: 20, allowRiskPath: true,  allowSubagentSpawn: true  }},
  // Forest: 完全自主
  { tier: EvolutionTier.Forest,  name: 'Forest',  requiredPoints: 1000, permissions: { maxLinesPerWrite: Infinity, maxFilesPerTask: Infinity, allowRiskPath: true, allowSubagentSpawn: true }},
] as const;

export function getTierDefinition(tier: EvolutionTier): TierDefinition {
  return TIER_DEFINITIONS[tier - 1];
}

export function getTierByPoints(totalPoints: number): EvolutionTier {
  // 从高到低检查，找到最高匹配等级
  for (let i = TIER_DEFINITIONS.length - 1; i >= 0; i--) {
    if (totalPoints >= TIER_DEFINITIONS[i].requiredPoints) {
      return TIER_DEFINITIONS[i].tier;
    }
  }
  return EvolutionTier.Seed;
}

// ===== 任务难度 =====

export type TaskDifficulty = 'trivial' | 'normal' | 'hard';

export interface TaskDifficultyConfig {
  basePoints: number;
  description: string;
}

export const TASK_DIFFICULTY_CONFIG: Record<TaskDifficulty, TaskDifficultyConfig> = {
  trivial: { basePoints: 1,  description: '简单任务：读取、搜索、状态查询' },
  normal:  { basePoints: 3,  description: '常规任务：单文件编辑、测试编写' },
  hard:    { basePoints: 8,  description: '困难任务：多文件重构、架构变更' },
} as const;

// ===== 进化事件 =====

export type EvolutionEventType = 'success' | 'failure';

export interface EvolutionEvent {
  id: string;                    // 事件 ID (UUID)
  timestamp: string;             // ISO 8601
  type: EvolutionEventType;
  taskHash: string;              // 任务唯一哈希 (工具名 + 文件路径)
  taskDifficulty: TaskDifficulty;
  toolName?: string;
  filePath?: string;
  reason?: string;               // 人类可读原因
  pointsAwarded: number;         // 本次获得积分 (>=0)
  isDoubleReward: boolean;       // 是否双倍奖励
  sessionId?: string;
}

// ===== 积分卡 =====

export interface EvolutionScorecard {
  version: '2.0';
  agentId: string;
  
  // 双积分模型
  totalPoints: number;           // 历史累计（用于等级计算）
  availablePoints: number;       // 可用积分（可用于能力消耗）
  
  // 当前等级
  currentTier: EvolutionTier;
  
  // 防刷分状态
  lastDoubleRewardTime?: string; // 上次双倍奖励时间（冷却用）
  recentFailureHashes: Map<string, string>;  // taskHash → 失败时间戳
  
  // 统计
  stats: EvolutionStats;
  
  // 事件历史（最近N条）
  recentEvents: EvolutionEvent[];
  
  lastUpdated: string;
}

export interface EvolutionStats {
  totalSuccesses: number;
  totalFailures: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  doubleRewardsEarned: number;
  tierPromotions: number;
  pointsByDifficulty: Record<TaskDifficulty, number>;
}

// ===== 存储结构 =====

export interface EvolutionStorage {
  scorecard: EvolutionScorecard;
  archivedStats: {
    totalEventsProcessed: number;
    pointsFromTrivial: number;
    pointsFromNormal: number;
    pointsFromHard: number;
  };
}

// ===== 配置 =====

export interface EvolutionConfig {
  /** 双倍奖励冷却时间（毫秒），默认1小时 */
  doubleRewardCooldownMs: number;
  
  /** 保存的最近事件数量，默认50 */
  maxRecentEvents: number;
  
  /** 高等级做低级任务的积分衰减系数 */
  difficultyPenalty: {
    tier4Trivial: number;   // Tree级做trivial任务的系数
    tier4Normal: number;    // Tree级做normal任务的系数
    tier5Trivial: number;   // Forest级做trivial任务的系数
    tier5Normal: number;    // Forest级做normal任务的系数
  };
  
  /** 信任分系统双轨运行时的配置 */
  dualTrack: {
    enabled: boolean;
    primarySystem: 'evolution';  // 主决策系统 (trust 已废弃)
  };
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  doubleRewardCooldownMs: 60 * 60 * 1000,  // 1小时
  maxRecentEvents: 50,
  difficultyPenalty: {
    tier4Trivial: 0.1,
    tier4Normal: 0.5,
    tier5Trivial: 0.1,
    tier5Normal: 0.5,
  },
  dualTrack: {
    enabled: true,
    primarySystem: 'evolution',
  },
};

// ===== 事件归档 =====

export interface ArchivedEventStats {
  totalEventsProcessed: number;
  pointsFromTrivial: number;
  pointsFromNormal: number;
  pointsFromHard: number;
}

// ===== Gate 集成接口 =====

export interface GateDecision {
  allowed: boolean;
  reason?: string;
  currentTier?: EvolutionTier;
  requiredTier?: EvolutionTier;
}

export interface ToolCallContext {
  toolName: string;
  filePath?: string;
  content?: string;        // 写入的内容（用于行数检查）
  lineCount?: number;      // 显式行数（如果已知）
  isRiskPath?: boolean;
}

// ===== 升级事件 =====

export interface TierPromotionEvent {
  previousTier: EvolutionTier;
  newTier: EvolutionTier;
  totalPoints: number;
  timestamp: string;
  newPermissions: TierPermissions;
}


// ===== Evolution Loop Schema =====

export type PrincipleStatus = 'candidate' | 'probation' | 'active' | 'deprecated';

/**
 * Evaluability classification — determines whether a P_xxx principle can enter
 * automatic nocturnal targeting.
 *
 * - deterministic:    Machine-checkable via deterministic rules/tool detectors
 * - weak_heuristic:  Checkable via heuristic signals, may have false positives
 * - manual_only:     No machine-checkable detector — stays in prompts only
 */
export type PrincipleEvaluatorLevel = 'deterministic' | 'weak_heuristic' | 'manual_only';

/**
 * Shared alias for PrincipleEvaluatorLevel — used by modules that reference
 * the same evaluability classification without direct coupling to evolution-types.
 * @deprecated Use PrincipleEvaluatorLevel directly. This alias exists for
 * backwards compatibility with principle-training-state.ts.
 */
export type Evaluability = PrincipleEvaluatorLevel;

/**
 * Structured detector metadata for P_xxx principles.
 * Allows the principle to enter automatic nocturnal targeting.
 *
 * If any required field is missing, the principle defaults to 'manual_only'.
 */
export interface PrincipleDetectorSpec {
  /** Topic/scenario tags where this detector applies */
  applicabilityTags: string[];
  /** Evidence that the principle was followed */
  positiveSignals: string[];
  /** Evidence that the principle was violated */
  negativeSignals: string[];
  /** Tool call sequences that indicate the principle is relevant */
  toolSequenceHints: string[][];
  /** Confidence in the detector's signal quality */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Validates that a detector metadata object has all required fields with non-empty values.
 * Used as defense-in-depth before accepting detectorMetadata for auto-trainable principles.
 */
export function isCompleteDetectorMetadata(
  meta: unknown
): meta is PrincipleDetectorSpec {
  if (!meta || typeof meta !== 'object') return false;
  const m = meta as Record<string, unknown>;
  const VALID_CONFIDENCE = ['high', 'medium', 'low'] as const;
  if (
    typeof m.confidence !== 'string' ||
    !(VALID_CONFIDENCE as readonly string[]).includes(m.confidence)
  ) {
    return false;
  }
  const nonEmptyStringArray = (arr: unknown): boolean =>
    Array.isArray(arr) &&
    arr.length > 0 &&
    arr.every((s) => typeof s === 'string' && s.length > 0);
  return (
    nonEmptyStringArray(m.applicabilityTags) &&
    nonEmptyStringArray(m.positiveSignals) &&
    nonEmptyStringArray(m.negativeSignals)
  );
}

export interface Principle {
  id: string;
  version: number;
  text: string;
  source: {
    painId: string;
    painType: 'tool_failure' | 'subagent_error' | 'user_frustration';
    timestamp: string;
  };
  trigger: string;
  action: string;
  guardrails?: string[];
  contextTags: string[];
  validation: {
    successCount: number;
    conflictCount: number;
  };
  status: PrincipleStatus;
  feedbackScore: number;
  usageCount: number;
  createdAt: string;
  activatedAt?: string;
  deprecatedAt?: string;
  /**
   * Evaluability classification. Defaults to 'manual_only' if not set.
   * Principles with 'manual_only' evaluability cannot enter automatic
   * nocturnal targeting.
   */
  evaluability: PrincipleEvaluatorLevel;
  /**
   * Structured detector metadata. If present and valid, the principle
   * may be auto-trainable (deterministic / weak_heuristic).
   * Absent or malformed = 'manual_only' evaluability.
   */
  detectorMetadata?: PrincipleDetectorSpec;
}

export type EvolutionLoopEventType =
  | 'pain_detected'
  | 'candidate_created'
  | 'principle_promoted'
  | 'principle_deprecated'
  | 'principle_rolled_back'
  | 'circuit_breaker_opened'
  | 'legacy_import';

export interface PainDetectedData {
  painId: string;
  painType: 'tool_failure' | 'subagent_error' | 'user_frustration';
  source: string;
  reason: string;
  score?: number;
  sessionId?: string;
  agentId?: string;  // 用于定位 JSONL 路径: ~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl
  taskId?: string;
  traceId?: string;
}

export interface CandidateCreatedData {
  painId: string;
  principleId: string;
  trigger: string;
  action: string;
  status: 'candidate';
  /** Pain type that generated this candidate — preserved on replay */
  painType?: 'tool_failure' | 'subagent_error' | 'user_frustration';
  /** Optional evaluability — defaults to 'manual_only' if omitted */
  evaluability?: PrincipleEvaluatorLevel;
  /** Optional detector metadata — absent = manual_only */
  detectorMetadata?: PrincipleDetectorSpec;
}

export interface PrinciplePromotedData {
  principleId: string;
  from: 'candidate' | 'probation';
  to: 'probation' | 'active';
  reason: string;
  successCount?: number;
}

export interface PrincipleDeprecatedData {
  principleId: string;
  reason: string;
  triggeredBy: 'auto' | 'manual';
}

export interface PrincipleRolledBackData {
  principleId: string;
  reason: string;
  triggeredBy: 'user_command' | 'auto_conflict';
  blacklistPattern?: string;
  relatedPainId?: string;
}

export interface CircuitBreakerOpenedData {
  taskId: string;
  painId: string;
  failCount: number;
  reason: string;
  requireHuman: boolean;
  nextRetryAt?: string;
}

export interface LegacyImportData {
  sourceFile: string;
  content: string;
  contentHash?: string;
}

export type EvolutionLoopEvent =
  | { ts: string; type: 'pain_detected'; data: PainDetectedData }
  | { ts: string; type: 'pain_recorded'; data: PainDetectedData }
  | { ts: string; type: 'candidate_created'; data: CandidateCreatedData }
  | { ts: string; type: 'principle_promoted'; data: PrinciplePromotedData }
  | { ts: string; type: 'principle_deprecated'; data: PrincipleDeprecatedData }
  | { ts: string; type: 'principle_rolled_back'; data: PrincipleRolledBackData }
  | { ts: string; type: 'circuit_breaker_opened'; data: CircuitBreakerOpenedData }
  | { ts: string; type: 'legacy_import'; data: LegacyImportData };
