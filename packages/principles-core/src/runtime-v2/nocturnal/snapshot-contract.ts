/**
 * Nocturnal Snapshot Contract — Ingress Validation
 * =================================================
 *
 * PURPOSE: Validate incoming NocturnalSessionSnapshot data at the boundary
 * before it enters the nocturnal pipeline. Pure validation logic with zero I/O.
 *
 * Migrated from openclaw-plugin/src/core/nocturnal-snapshot-contract.ts.
 * NocturnalSessionSnapshot interface inlined from nocturnal-trajectory-extractor.ts
 * (plugin-only I/O module) to keep this module free of I/O imports.
 */

// ---------------------------------------------------------------------------
// Inlined Types (from plugin-only modules — pure interfaces only)
// ---------------------------------------------------------------------------

/**
 * Minimal sanitized assistant turn for nocturnal snapshot.
 * Contains ONLY sanitizedText — raw_text is never exposed.
 */
export interface NocturnalAssistantTurn {
  turnIndex: number;
  sanitizedText: string;
  model: string;
  createdAt: string;
}

/**
 * Minimal sanitized user turn for nocturnal snapshot.
 * Contains only derived cues — NO raw user text.
 */
export interface NocturnalUserTurn {
  turnIndex: number;
  correctionDetected: boolean;
  correctionCue: string | null;
  createdAt: string;
}

/**
 * Tool call event for nocturnal snapshot.
 */
export interface NocturnalToolCall {
  toolName: string;
  outcome: 'success' | 'failure' | 'blocked';
  filePath: string | null;
  durationMs: number | null;
  exitCode: number | null;
  errorType: string | null;
  errorMessage: string | null;
  createdAt: string;
}

/**
 * Pain signal for nocturnal snapshot.
 */
export interface NocturnalPainEvent {
  source: string;
  score: number;
  severity: string | null;
  reason: string | null;
  createdAt: string;
}

/**
 * Gate block event for nocturnal snapshot.
 */
export interface NocturnalGateBlock {
  toolName: string;
  filePath: string | null;
  reason: string;
  planStatus: string | null;
  createdAt: string;
}

export interface NocturnalUserCorrection {
  correctionCue: string | null;
}

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
export interface NocturnalSessionSnapshot {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  assistantTurns: NocturnalAssistantTurn[];
  userTurns: NocturnalUserTurn[];
  toolCalls: NocturnalToolCall[];
  painEvents: NocturnalPainEvent[];
  gateBlocks: NocturnalGateBlock[];
  userCorrections: NocturnalUserCorrection[];
  stats: {
    totalAssistantTurns: number;
    totalToolCalls: number;
    totalPainEvents: number;
    totalGateBlocks: number;
    failureCount: number;
  };
  _dataSource?: 'pain_context_fallback';
}

// ---------------------------------------------------------------------------
// Validation Logic
// ---------------------------------------------------------------------------

export interface NocturnalSnapshotContractResult {
  status: 'valid' | 'invalid';
  reasons: string[];
  snapshot?: NocturnalSessionSnapshot;
}

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
