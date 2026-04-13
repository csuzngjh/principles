import type { NocturnalSessionSnapshot } from './nocturnal-trajectory-extractor.js';

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

  // eslint-disable-next-line @typescript-eslint/prefer-destructuring
  const stats = value.stats;
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
