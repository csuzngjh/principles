/**
 * Nocturnal Snapshot Contract — Ingress Validation
 * =================================================
 *
 * PURPOSE: Validate incoming NocturnalSessionSnapshot data at the boundary
 * before it enters the nocturnal pipeline. Pure validation logic with zero I/O.
 */

import { Type, type Static } from '@sinclair/typebox';

// ---------------------------------------------------------------------------
// Inlined Types (from plugin-only modules — pure interfaces only)
// ---------------------------------------------------------------------------

/**
 * Minimal sanitized assistant turn for nocturnal snapshot.
 * Contains ONLY sanitizedText — raw_text is never exposed.
 */
export const NocturnalAssistantTurnSchema = Type.Object({
  turnIndex: Type.Integer({ minimum: 0 }),
  sanitizedText: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 1 }),
  createdAt: Type.String({ minLength: 1 }),
});
export type NocturnalAssistantTurn = Static<typeof NocturnalAssistantTurnSchema>

/**
 * Minimal sanitized user turn for nocturnal snapshot.
 * Contains only derived cues — NO raw user text.
 */
export const NocturnalUserTurnSchema = Type.Object({
  turnIndex: Type.Integer({ minimum: 0 }),
  correctionDetected: Type.Boolean(),
  correctionCue: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ minLength: 1 }),
});
export type NocturnalUserTurn = Static<typeof NocturnalUserTurnSchema>

/**
 * Tool call event for nocturnal snapshot.
 */
export const NocturnalToolCallSchema = Type.Object({
  toolName: Type.String({ minLength: 1 }),
  outcome: Type.Union([
    Type.Literal('success'),
    Type.Literal('failure'),
    Type.Literal('blocked'),
  ]),
  filePath: Type.Union([Type.String(), Type.Null()]),
  durationMs: Type.Union([Type.Integer(), Type.Null()]),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  errorType: Type.Union([Type.String(), Type.Null()]),
  errorMessage: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ minLength: 1 }),
});
export type NocturnalToolCall = Static<typeof NocturnalToolCallSchema>

/**
 * Pain signal for nocturnal snapshot.
 */
export const NocturnalPainEventSchema = Type.Object({
  source: Type.String({ minLength: 1 }),
  score: Type.Number(),
  severity: Type.Union([Type.String(), Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ minLength: 1 }),
});
export type NocturnalPainEvent = Static<typeof NocturnalPainEventSchema>

/**
 * Gate block event for nocturnal snapshot.
 */
export const NocturnalGateBlockSchema = Type.Object({
  toolName: Type.String({ minLength: 1 }),
  filePath: Type.Union([Type.String(), Type.Null()]),
  reason: Type.String({ minLength: 1 }),
  planStatus: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ minLength: 1 }),
});
export type NocturnalGateBlock = Static<typeof NocturnalGateBlockSchema>

export const NocturnalUserCorrectionSchema = Type.Object({
  correctionCue: Type.Union([Type.String(), Type.Null()]),
});
export type NocturnalUserCorrection = Static<typeof NocturnalUserCorrectionSchema>

/**
 * A structured nocturnal session snapshot.
 * Contains all information needed for a reflector to generate decision-point samples.
 *
 * GUARANTEES:
 * - NO raw_text exposed
 * - NO blob references resolved
 * - All text is sanitized or derived-cue only
 * - Self-contained (principle-relevant metadata included)
 */
export const NocturnalSessionSnapshotSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  startedAt: Type.String({ minLength: 1 }),
  updatedAt: Type.String({ minLength: 1 }),
  assistantTurns: Type.Array(NocturnalAssistantTurnSchema),
  userTurns: Type.Array(NocturnalUserTurnSchema),
  toolCalls: Type.Array(NocturnalToolCallSchema),
  painEvents: Type.Array(NocturnalPainEventSchema),
  gateBlocks: Type.Array(NocturnalGateBlockSchema),
  userCorrections: Type.Array(NocturnalUserCorrectionSchema),
  stats: Type.Object({
    totalAssistantTurns: Type.Integer({ minimum: 0 }),
    totalToolCalls: Type.Integer({ minimum: 0 }),
    totalPainEvents: Type.Integer({ minimum: 0 }),
    totalGateBlocks: Type.Integer({ minimum: 0 }),
    failureCount: Type.Integer({ minimum: 0 }),
  }),
  _dataSource: Type.Optional(Type.Literal('pain_context_fallback')),
});
export type NocturnalSessionSnapshot = Static<typeof NocturnalSessionSnapshotSchema>

// ---------------------------------------------------------------------------
// Validation Logic
// ---------------------------------------------------------------------------

export const NocturnalSnapshotContractResultSchema = Type.Object({
  status: Type.Union([Type.Literal('valid'), Type.Literal('invalid')]),
  reasons: Type.Array(Type.String()),
  snapshot: Type.Optional(NocturnalSessionSnapshotSchema),
});
export type NocturnalSnapshotContractResult = Static<typeof NocturnalSnapshotContractResultSchema>

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** #246: Stats fields must now be finite numbers — null is no longer accepted. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateNocturnalSnapshotIngress(
  value: unknown
): NocturnalSnapshotContractResult {
  const reasons: string[] = [];

  if (!isObjectRecord(value)) {
    return { status: 'invalid', reasons: ['snapshot must be an object'] };
  }

  if (!isNonEmptyString(value.sessionId)) {
    reasons.push('snapshot.sessionId must be a non-empty string');
  }

  if (!isNonEmptyString(value.startedAt)) {
    reasons.push('snapshot.startedAt must be a non-empty string');
  }

  if (!isNonEmptyString(value.updatedAt)) {
    reasons.push('snapshot.updatedAt must be a non-empty string');
  }

  const arrayFields = [
    'assistantTurns',
    'userTurns',
    'toolCalls',
    'painEvents',
    'gateBlocks',
  ] as const;
  for (const field of arrayFields) {
    if (!Array.isArray(value[field])) {
      reasons.push(`snapshot.${field} must be an array`);
    }
  }

  const { stats } = value;
  if (!isObjectRecord(stats)) {
    reasons.push('snapshot.stats must be an object');
  } else {
    if (!isFiniteNumber(stats.totalAssistantTurns)) {
      reasons.push('snapshot.stats.totalAssistantTurns must be a finite number');
    }
    if (!isFiniteNumber(stats.totalToolCalls)) {
      reasons.push('snapshot.stats.totalToolCalls must be a finite number');
    }
    if (!isFiniteNumber(stats.totalPainEvents)) {
      reasons.push('snapshot.stats.totalPainEvents must be a finite number');
    }
    if (!isFiniteNumber(stats.totalGateBlocks)) {
      reasons.push('snapshot.stats.totalGateBlocks must be a finite number');
    }
    if (!isFiniteNumber(stats.failureCount)) {
      reasons.push('snapshot.stats.failureCount must be a finite number');
    }
  }

  const isFallback = value._dataSource === 'pain_context_fallback';
  if (value._dataSource !== undefined && !isFallback) {
    reasons.push('snapshot._dataSource must be omitted or pain_context_fallback');
  }

  if (isFallback && isObjectRecord(stats) && Array.isArray(value.painEvents)) {
    const hasPainSignal = value.painEvents.length > 0 || ((stats.totalPainEvents as number) > 0);
    if (!hasPainSignal) {
      reasons.push('fallback snapshot must contain at least one pain signal');
    }
  }

  if (reasons.length > 0) {
    return { status: 'invalid', reasons };
  }

  return {
    status: 'valid',
    reasons: [],
    snapshot: value as unknown as NocturnalSessionSnapshot,
  };
}
