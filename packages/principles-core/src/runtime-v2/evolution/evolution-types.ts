/**
 * Evolution Points System V2.0 - MVP
 *
 * Core Philosophy: Growth-driven替代Penalty-driven
 * - 起点0分，只能增加，不扣分
 * - 失败记录教训，不扣分
 * - 同类任务失败后首次成功 = 双倍奖励（1小时冷却）
 * - 5级成长路径：Seed → Forest
 *
 * Migrated from openclaw-plugin/src/core/evolution-types.ts
 */

// ===== 等级定义 =====

export enum EvolutionTier {
  Seed = 1,
  Sprout = 2,
  Sapling = 3,
  Tree = 4,
  Forest = 5,
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

export const TIER_DEFINITIONS: TierDefinition[] = [
  { tier: EvolutionTier.Seed,    name: 'Seed',    requiredPoints: 0,    permissions: { maxLinesPerWrite: 150,  maxFilesPerTask: 3,  allowRiskPath: false, allowSubagentSpawn: true  }},
  { tier: EvolutionTier.Sprout,  name: 'Sprout',  requiredPoints: 50,   permissions: { maxLinesPerWrite: 300,  maxFilesPerTask: 5,  allowRiskPath: false, allowSubagentSpawn: true  }},
  { tier: EvolutionTier.Sapling, name: 'Sapling', requiredPoints: 200,  permissions: { maxLinesPerWrite: 500,  maxFilesPerTask: 10, allowRiskPath: true,  allowSubagentSpawn: true  }},
  { tier: EvolutionTier.Tree,    name: 'Tree',    requiredPoints: 500,  permissions: { maxLinesPerWrite: 1000, maxFilesPerTask: 20, allowRiskPath: true,  allowSubagentSpawn: true  }},
  { tier: EvolutionTier.Forest,  name: 'Forest',  requiredPoints: 1000, permissions: { maxLinesPerWrite: Infinity, maxFilesPerTask: Infinity, allowRiskPath: true,  allowSubagentSpawn: true }},
];

export function getTierDefinition(tier: EvolutionTier): TierDefinition {
  for (const def of TIER_DEFINITIONS) {
    if (def.tier === tier) {
      return def;
    }
  }
  return TIER_DEFINITIONS[0] as TierDefinition;
}

export function getTierByPoints(totalPoints: number): EvolutionTier {
  for (let i = TIER_DEFINITIONS.length - 1; i >= 0; i--) {
    const def = TIER_DEFINITIONS[i];
    if (def && totalPoints >= def.requiredPoints) {
      return def.tier;
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
  id: string;
  timestamp: string;
  type: EvolutionEventType;
  taskHash: string;
  taskDifficulty: TaskDifficulty;
  toolName?: string;
  filePath?: string;
  reason?: string;
  pointsAwarded: number;
  isDoubleReward: boolean;
  sessionId?: string;
}

// ===== 积分卡 =====

export interface EvolutionScorecard {
  version: '2.0';
  agentId: string;

  totalPoints: number;
  availablePoints: number;

  currentTier: EvolutionTier;

  lastDoubleRewardTime?: string;
  recentFailureHashes: Map<string, string>;

  stats: EvolutionStats;

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
  doubleRewardCooldownMs: number;
  maxRecentEvents: number;
  difficultyPenalty: {
    tier4Trivial: number;
    tier4Normal: number;
    tier5Trivial: number;
    tier5Normal: number;
  };
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  doubleRewardCooldownMs: 60 * 60 * 1000,
  maxRecentEvents: 50,
  difficultyPenalty: {
    tier4Trivial: 0.1,
    tier4Normal: 0.5,
    tier5Trivial: 0.1,
    tier5Normal: 0.5,
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
  content?: string;
  lineCount?: number;
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

export type EvolutionPrincipleStatus = 'candidate' | 'probation' | 'active' | 'deprecated' | 'archived';

export type PrincipleEvaluatorLevel = 'deterministic' | 'weak_heuristic' | 'manual_only';

export type Evaluability = PrincipleEvaluatorLevel;

export interface PrincipleDetectorSpec {
  applicabilityTags: string[];
  positiveSignals: string[];
  negativeSignals: string[];
  toolSequenceHints: string[][];
  confidence: 'high' | 'medium' | 'low';
}

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

export interface EvolutionPrinciple {
  id: string;
  version: number;
  text: string;
  source: {
    painId: string;
    painType: 'tool_failure' | 'dispatch_error' | 'subagent_error' | 'user_frustration';
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
  status: EvolutionPrincipleStatus;
  feedbackScore: number;
  usageCount: number;
  createdAt: string;
  activatedAt?: string;
  deprecatedAt?: string;
  evaluability: PrincipleEvaluatorLevel;
  detectorMetadata?: PrincipleDetectorSpec;
  abstractedPrinciple?: string;
  coreAxiomId?: string;

  priority?: 'P0' | 'P1' | 'P2';
  scope?: 'general' | 'domain';
  domain?: string;
  suggestedRules?: EvolutionPrincipleSuggestedRule[];
  valueMetrics?: EvolutionPrincipleValueMetricsSnapshot;
}

export interface EvolutionPrincipleSuggestedRule {
  name: string;
  type: 'hook' | 'gate' | 'skill' | 'test' | 'prompt';
  triggerCondition: string;
  enforcement: 'block' | 'warn' | 'log';
  action: string;
  implementationHint?: string;
}

export interface EvolutionPrincipleValueMetricsSnapshot {
  painPreventedCount: number;
  lastPainPreventedAt?: string;
  calculatedAt: string;
}

export type EvolutionLoopEventType =
  | 'pain_detected'
  | 'candidate_created'
  | 'principle_promoted'
  | 'principle_deprecated'
  | 'principle_rolled_back'
  | 'circuit_breaker_opened'
  | 'legacy_import';

export interface EvolutionPainDetectedData {
  painId: string;
  painType: 'tool_failure' | 'dispatch_error' | 'subagent_error' | 'user_frustration';
  source: string;
  reason: string;
  score?: number;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  traceId?: string;
}

export interface CandidateCreatedData {
  painId: string;
  principleId: string;
  trigger: string;
  action: string;
  status: 'candidate';
  painType?: 'tool_failure' | 'dispatch_error' | 'subagent_error' | 'user_frustration';
  evaluability?: PrincipleEvaluatorLevel;
  detectorMetadata?: PrincipleDetectorSpec;
  abstractedPrinciple?: string;
  coreAxiomId?: string;
}

export interface PrinciplePromotedData {
  principleId: string;
  from: EvolutionPrincipleStatus;
  to: EvolutionPrincipleStatus;
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
  | { ts: string; type: 'pain_detected'; data: EvolutionPainDetectedData }
  | { ts: string; type: 'pain_recorded'; data: EvolutionPainDetectedData }
  | { ts: string; type: 'candidate_created'; data: CandidateCreatedData }
  | { ts: string; type: 'principle_promoted'; data: PrinciplePromotedData }
  | { ts: string; type: 'principle_deprecated'; data: PrincipleDeprecatedData }
  | { ts: string; type: 'principle_rolled_back'; data: PrincipleRolledBackData }
  | { ts: string; type: 'circuit_breaker_opened'; data: CircuitBreakerOpenedData }
  | { ts: string; type: 'legacy_import'; data: LegacyImportData };
