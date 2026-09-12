/**
 * Evolution Loop domain types (PRI-612 lineage).
 *
 * Historical note (PRI-770): the Evolution Points/Tier scoring subsystem
 * (tiers, scorecards, storage/config contracts and their TypeBox mirrors) was
 * deleted here — its engine was retired in PRI-737 and no production consumer
 * remained. What survives is the live Evolution Loop / EvolutionPrinciple
 * type surface consumed by the principle lifecycle pipeline.
 */
import { Type, type Static } from '@sinclair/typebox';
import type { PainEvidenceEntry } from '../pain-signal-bridge.js';
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
  provenance?: 'host_context_bound' | 'owner_reported_no_host_trace' | 'automatic_hook';
  hostKind?: 'openclaw' | 'codex';
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
    Type.Literal('host_context_bound'),
    Type.Literal('owner_reported_no_host_trace'),
    Type.Literal('automatic_hook'),
    Type.Literal('openclaw_context_bound'),
  ])),
  hostKind: Type.Optional(Type.Union([Type.Literal('openclaw'), Type.Literal('codex')])),
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
