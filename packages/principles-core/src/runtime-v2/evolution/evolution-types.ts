/**
 * Evolution Points System V2.0 - MVP
 *
 * Core Philosophy: Growth-driven替代Penalty-driven
 * - 起点0分，只能增加，不扣分
 * - 失败记录教训，不扣分
 * - 同类任务失败后首次成功 = 双倍奖励（1小时冷却）
 * - 5级成长路径：Seed → Forest
 */
import { Type, type Static } from '@sinclair/typebox';
import type { PainEvidenceEntry } from '../pain-signal-bridge.js';

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
  { tier: EvolutionTier.Forest,  name: 'Forest',  requiredPoints: 1000, permissions: { maxLinesPerWrite: Number.MAX_SAFE_INTEGER, maxFilesPerTask: Number.MAX_SAFE_INTEGER, allowRiskPath: true,  allowSubagentSpawn: true }},
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

// Serialized form is [string, string] tuple (for JSON compatibility)
export type RecentFailureHashEntry = [string, string];

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

import type { PrincipleStatus } from '../types/principle-enums.js';
// PRI-612: derived from the canonical PrincipleStatus authority — same 5 states.
export type EvolutionPrincipleStatus = PrincipleStatus;

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
  const stringArray2d = (arr: unknown): boolean =>
    Array.isArray(arr) &&
    arr.every((inner) => Array.isArray(inner) && inner.every((s) => typeof s === 'string'));
  return (
    nonEmptyStringArray(m.applicabilityTags) &&
    nonEmptyStringArray(m.positiveSignals) &&
    nonEmptyStringArray(m.negativeSignals) &&
    stringArray2d(m.toolSequenceHints)
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
  provenance?: 'openclaw_context_bound' | 'owner_reported_no_host_trace' | 'automatic_hook';
  evidence?: PainEvidenceEntry[];
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

// ===== TypeBox Schemas =====

export const EvolutionTierSchema = Type.Union([
  Type.Literal(EvolutionTier.Seed),
  Type.Literal(EvolutionTier.Sprout),
  Type.Literal(EvolutionTier.Sapling),
  Type.Literal(EvolutionTier.Tree),
  Type.Literal(EvolutionTier.Forest),
]);
export type EvolutionTierTB = Static<typeof EvolutionTierSchema>;

export const TierPermissionsSchema = Type.Object({
  maxLinesPerWrite: Type.Number(),
  maxFilesPerTask: Type.Number(),
  allowRiskPath: Type.Boolean(),
  allowSubagentSpawn: Type.Boolean(),
});
export type TierPermissionsTB = Static<typeof TierPermissionsSchema>;

export const TierDefinitionSchema = Type.Object({
  tier: EvolutionTierSchema,
  name: Type.String(),
  requiredPoints: Type.Number(),
  permissions: TierPermissionsSchema,
});
export type TierDefinitionTB = Static<typeof TierDefinitionSchema>;

export const TaskDifficultySchema = Type.Union([
  Type.Literal('trivial'),
  Type.Literal('normal'),
  Type.Literal('hard'),
]);
export type TaskDifficultyTB = Static<typeof TaskDifficultySchema>;

export const TaskDifficultyConfigSchema = Type.Object({
  basePoints: Type.Number(),
  description: Type.String(),
});
export type TaskDifficultyConfigTB = Static<typeof TaskDifficultyConfigSchema>;

export const EvolutionEventTypeSchema = Type.Union([
  Type.Literal('success'),
  Type.Literal('failure'),
]);
export type EvolutionEventTypeTB = Static<typeof EvolutionEventTypeSchema>;

export const EvolutionEventSchema = Type.Object({
  id: Type.String(),
  timestamp: Type.String(),
  type: EvolutionEventTypeSchema,
  taskHash: Type.String(),
  taskDifficulty: TaskDifficultySchema,
  toolName: Type.Optional(Type.String()),
  filePath: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  pointsAwarded: Type.Number(),
  isDoubleReward: Type.Boolean(),
  sessionId: Type.Optional(Type.String()),
});
export type EvolutionEventTB = Static<typeof EvolutionEventSchema>;

export const EvolutionStatsSchema = Type.Object({
  totalSuccesses: Type.Number(),
  totalFailures: Type.Number(),
  consecutiveSuccesses: Type.Number(),
  consecutiveFailures: Type.Number(),
  doubleRewardsEarned: Type.Number(),
  tierPromotions: Type.Number(),
  pointsByDifficulty: Type.Object({
    trivial: Type.Number(),
    normal: Type.Number(),
    hard: Type.Number(),
  }),
});
export type EvolutionStatsTB = Static<typeof EvolutionStatsSchema>;

export const RecentFailureHashEntrySchema = Type.Tuple([
  Type.String(),
  Type.String(),
]);
export type RecentFailureHashEntryTB = Static<typeof RecentFailureHashEntrySchema>;

export const EvolutionScorecardSchema = Type.Object({
  version: Type.Literal('2.0'),
  agentId: Type.String(),
  totalPoints: Type.Number(),
  availablePoints: Type.Number(),
  currentTier: EvolutionTierSchema,
  lastDoubleRewardTime: Type.Optional(Type.String()),
  recentFailureHashes: Type.Array(RecentFailureHashEntrySchema),
  stats: EvolutionStatsSchema,
  recentEvents: Type.Array(EvolutionEventSchema),
  lastUpdated: Type.String(),
});
export type EvolutionScorecardTB = Static<typeof EvolutionScorecardSchema>;

export const EvolutionStorageSchema = Type.Object({
  scorecard: EvolutionScorecardSchema,
  archivedStats: Type.Object({
    totalEventsProcessed: Type.Number(),
    pointsFromTrivial: Type.Number(),
    pointsFromNormal: Type.Number(),
    pointsFromHard: Type.Number(),
  }),
});
export type EvolutionStorageTB = Static<typeof EvolutionStorageSchema>;

export const EvolutionConfigSchema = Type.Object({
  doubleRewardCooldownMs: Type.Number(),
  maxRecentEvents: Type.Number(),
  difficultyPenalty: Type.Object({
    tier4Trivial: Type.Number(),
    tier4Normal: Type.Number(),
    tier5Trivial: Type.Number(),
    tier5Normal: Type.Number(),
  }),
});
export type EvolutionConfigTB = Static<typeof EvolutionConfigSchema>;

export const ArchivedEventStatsSchema = Type.Object({
  totalEventsProcessed: Type.Number(),
  pointsFromTrivial: Type.Number(),
  pointsFromNormal: Type.Number(),
  pointsFromHard: Type.Number(),
});
export type ArchivedEventStatsTB = Static<typeof ArchivedEventStatsSchema>;

export const GateDecisionSchema = Type.Object({
  allowed: Type.Boolean(),
  reason: Type.Optional(Type.String()),
  currentTier: Type.Optional(EvolutionTierSchema),
  requiredTier: Type.Optional(EvolutionTierSchema),
});
export type GateDecisionTB = Static<typeof GateDecisionSchema>;

export const ToolCallContextSchema = Type.Object({
  toolName: Type.String(),
  filePath: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  lineCount: Type.Optional(Type.Number()),
  isRiskPath: Type.Optional(Type.Boolean()),
});
export type ToolCallContextTB = Static<typeof ToolCallContextSchema>;

export const TierPromotionEventSchema = Type.Object({
  previousTier: EvolutionTierSchema,
  newTier: EvolutionTierSchema,
  totalPoints: Type.Number(),
  timestamp: Type.String(),
  newPermissions: TierPermissionsSchema,
});
export type TierPromotionEventTB = Static<typeof TierPromotionEventSchema>;

export const EvolutionPrincipleStatusSchema = Type.Union([
  Type.Literal('candidate'),
  Type.Literal('probation'),
  Type.Literal('active'),
  Type.Literal('deprecated'),
  Type.Literal('archived'),
]);
export type EvolutionPrincipleStatusTB = Static<typeof EvolutionPrincipleStatusSchema>;

export const PrincipleEvaluatorLevelSchema = Type.Union([
  Type.Literal('deterministic'),
  Type.Literal('weak_heuristic'),
  Type.Literal('manual_only'),
]);
export type PrincipleEvaluatorLevelTB = Static<typeof PrincipleEvaluatorLevelSchema>;

export const EvaluabilitySchema = PrincipleEvaluatorLevelSchema;
export type EvaluabilityTB = Static<typeof EvaluabilitySchema>;

export const PrincipleDetectorSpecSchema = Type.Object({
  applicabilityTags: Type.Array(Type.String()),
  positiveSignals: Type.Array(Type.String()),
  negativeSignals: Type.Array(Type.String()),
  toolSequenceHints: Type.Array(Type.Array(Type.String())),
  confidence: Type.Union([
    Type.Literal('high'),
    Type.Literal('medium'),
    Type.Literal('low'),
  ]),
});
export type PrincipleDetectorSpecTB = Static<typeof PrincipleDetectorSpecSchema>;

export const EvolutionPrincipleSuggestedRuleSchema = Type.Object({
  name: Type.String(),
  type: Type.Union([
    Type.Literal('hook'),
    Type.Literal('gate'),
    Type.Literal('skill'),
    Type.Literal('test'),
    Type.Literal('prompt'),
  ]),
  triggerCondition: Type.String(),
  enforcement: Type.Union([
    Type.Literal('block'),
    Type.Literal('warn'),
    Type.Literal('log'),
  ]),
  action: Type.String(),
  implementationHint: Type.Optional(Type.String()),
});
export type EvolutionPrincipleSuggestedRuleTB = Static<typeof EvolutionPrincipleSuggestedRuleSchema>;

export const EvolutionPrincipleValueMetricsSnapshotSchema = Type.Object({
  painPreventedCount: Type.Number(),
  lastPainPreventedAt: Type.Optional(Type.String()),
  calculatedAt: Type.String(),
});
export type EvolutionPrincipleValueMetricsSnapshotTB = Static<typeof EvolutionPrincipleValueMetricsSnapshotSchema>;

export const EvolutionPrincipleSchema = Type.Object({
  id: Type.String(),
  version: Type.Number(),
  text: Type.String(),
  source: Type.Object({
    painId: Type.String(),
    painType: Type.Union([
      Type.Literal('tool_failure'),
      Type.Literal('dispatch_error'),
      Type.Literal('subagent_error'),
      Type.Literal('user_frustration'),
    ]),
    timestamp: Type.String(),
  }),
  trigger: Type.String(),
  action: Type.String(),
  guardrails: Type.Optional(Type.Array(Type.String())),
  contextTags: Type.Array(Type.String()),
  validation: Type.Object({
    successCount: Type.Number(),
    conflictCount: Type.Number(),
  }),
  status: EvolutionPrincipleStatusSchema,
  feedbackScore: Type.Number(),
  usageCount: Type.Number(),
  createdAt: Type.String(),
  activatedAt: Type.Optional(Type.String()),
  deprecatedAt: Type.Optional(Type.String()),
  evaluability: PrincipleEvaluatorLevelSchema,
  detectorMetadata: Type.Optional(PrincipleDetectorSpecSchema),
  abstractedPrinciple: Type.Optional(Type.String()),
  coreAxiomId: Type.Optional(Type.String()),
  priority: Type.Optional(Type.Union([Type.Literal('P0'), Type.Literal('P1'), Type.Literal('P2')])),
  scope: Type.Optional(Type.Union([Type.Literal('general'), Type.Literal('domain')])),
  domain: Type.Optional(Type.String()),
  suggestedRules: Type.Optional(Type.Array(EvolutionPrincipleSuggestedRuleSchema)),
  valueMetrics: Type.Optional(EvolutionPrincipleValueMetricsSnapshotSchema),
});
export type EvolutionPrincipleTB = Static<typeof EvolutionPrincipleSchema>;

export const EvolutionLoopEventTypeSchema = Type.Union([
  Type.Literal('pain_detected'),
  Type.Literal('candidate_created'),
  Type.Literal('principle_promoted'),
  Type.Literal('principle_deprecated'),
  Type.Literal('principle_rolled_back'),
  Type.Literal('circuit_breaker_opened'),
  Type.Literal('legacy_import'),
]);
export type EvolutionLoopEventTypeTB = Static<typeof EvolutionLoopEventTypeSchema>;

export const EvolutionPainDetectedDataSchema = Type.Object({
  painId: Type.String(),
  painType: Type.Union([
    Type.Literal('tool_failure'),
    Type.Literal('dispatch_error'),
    Type.Literal('subagent_error'),
    Type.Literal('user_frustration'),
  ]),
  source: Type.String(),
  reason: Type.String(),
  score: Type.Optional(Type.Number()),
  sessionId: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
  traceId: Type.Optional(Type.String()),
  provenance: Type.Optional(Type.Union([
    Type.Literal('openclaw_context_bound'),
    Type.Literal('owner_reported_no_host_trace'),
    Type.Literal('automatic_hook'),
  ])),
});
export type EvolutionPainDetectedDataTB = Static<typeof EvolutionPainDetectedDataSchema>;

export const CandidateCreatedDataSchema = Type.Object({
  painId: Type.String(),
  principleId: Type.String(),
  trigger: Type.String(),
  action: Type.String(),
  status: Type.Literal('candidate'),
  painType: Type.Optional(Type.Union([
    Type.Literal('tool_failure'),
    Type.Literal('dispatch_error'),
    Type.Literal('subagent_error'),
    Type.Literal('user_frustration'),
  ])),
  evaluability: Type.Optional(PrincipleEvaluatorLevelSchema),
  detectorMetadata: Type.Optional(PrincipleDetectorSpecSchema),
  abstractedPrinciple: Type.Optional(Type.String()),
  coreAxiomId: Type.Optional(Type.String()),
});
export type CandidateCreatedDataTB = Static<typeof CandidateCreatedDataSchema>;

export const PrinciplePromotedDataSchema = Type.Object({
  principleId: Type.String(),
  from: EvolutionPrincipleStatusSchema,
  to: EvolutionPrincipleStatusSchema,
  reason: Type.String(),
  successCount: Type.Optional(Type.Number()),
});
export type PrinciplePromotedDataTB = Static<typeof PrinciplePromotedDataSchema>;

export const PrincipleDeprecatedDataSchema = Type.Object({
  principleId: Type.String(),
  reason: Type.String(),
  triggeredBy: Type.Union([
    Type.Literal('auto'),
    Type.Literal('manual'),
  ]),
});
export type PrincipleDeprecatedDataTB = Static<typeof PrincipleDeprecatedDataSchema>;

export const PrincipleRolledBackDataSchema = Type.Object({
  principleId: Type.String(),
  reason: Type.String(),
  triggeredBy: Type.Union([
    Type.Literal('user_command'),
    Type.Literal('auto_conflict'),
  ]),
  blacklistPattern: Type.Optional(Type.String()),
  relatedPainId: Type.Optional(Type.String()),
});
export type PrincipleRolledBackDataTB = Static<typeof PrincipleRolledBackDataSchema>;

export const CircuitBreakerOpenedDataSchema = Type.Object({
  taskId: Type.String(),
  painId: Type.String(),
  failCount: Type.Number(),
  reason: Type.String(),
  requireHuman: Type.Boolean(),
  nextRetryAt: Type.Optional(Type.String()),
});
export type CircuitBreakerOpenedDataTB = Static<typeof CircuitBreakerOpenedDataSchema>;

export const LegacyImportDataSchema = Type.Object({
  sourceFile: Type.String(),
  content: Type.String(),
  contentHash: Type.Optional(Type.String()),
});
export type LegacyImportDataTB = Static<typeof LegacyImportDataSchema>;

export const EvolutionLoopEventSchema = Type.Union([
  Type.Object({
    ts: Type.String(),
    type: Type.Literal('pain_detected'),
    data: EvolutionPainDetectedDataSchema,
  }),
  Type.Object({
    ts: Type.String(),
    type: Type.Literal('pain_recorded'),
    data: EvolutionPainDetectedDataSchema,
  }),
  Type.Object({
    ts: Type.String(),
    type: Type.Literal('candidate_created'),
    data: CandidateCreatedDataSchema,
  }),
  Type.Object({
    ts: Type.String(),
    type: Type.Literal('principle_promoted'),
    data: PrinciplePromotedDataSchema,
  }),
  Type.Object({
    ts: Type.String(),
    type: Type.Literal('principle_deprecated'),
    data: PrincipleDeprecatedDataSchema,
  }),
  Type.Object({
    ts: Type.String(),
    type: Type.Literal('principle_rolled_back'),
    data: PrincipleRolledBackDataSchema,
  }),
  Type.Object({
    ts: Type.String(),
    type: Type.Literal('circuit_breaker_opened'),
    data: CircuitBreakerOpenedDataSchema,
  }),
  Type.Object({
    ts: Type.String(),
    type: Type.Literal('legacy_import'),
    data: LegacyImportDataSchema,
  }),
]);
export type EvolutionLoopEventTB = Static<typeof EvolutionLoopEventSchema>;
