/**
 * Output repair contract — types for the bounded structured-output repair loop.
 *
 * Per AGENT_SOFTWARE_CONTRACT.md Layer 2:
 *   raw LLM output → JSON extraction → schema validation →
 *   schema invalid → build repair prompt → bounded retry →
 *   still invalid → output_invalid + evidence pack
 *
 * Design principles:
 *   - Evidence pack is always observable (schemaRef, provider, model, errors, attempts)
 *   - Repair loop is bounded (max 1-2 attempts)
 *   - Lineage fields are protected during repair
 *   - Failure types are classified for telemetry routing
 */

export type OutputFailureKind =
  | 'extraction_failed'
  | 'schema_invalid'
  | 'repair_exhausted';

export interface OutputValidationErrorEntry {
  readonly path: string;
  readonly expected: string;
  readonly actualPreview: string;
}

export interface OutputRepairAttempt {
  readonly schemaRef: string;
  readonly attempt: number;
  readonly rawOutputPreview: string;
  readonly validationErrors: readonly OutputValidationErrorEntry[];
  readonly repairPromptVersion: string;
  readonly repaired: boolean;
}

export interface OutputEvidencePack {
  readonly schemaRef: string;
  readonly provider: string;
  readonly model: string;
  readonly promptContractVersion?: string;
  readonly rawOutputPreview: string;
  readonly validationErrors: readonly OutputValidationErrorEntry[];
  readonly repairAttempts: readonly OutputRepairAttempt[];
  readonly finalFailureReason: OutputFailureKind;
  /** PRI-621 RC3: complete JSON objects found in the answer (diagnostic). */
  readonly extractionCandidateCount?: number;
  /** PRI-621 RC3: selected object matched none of the schema's required keys. */
  readonly truncationSuspected?: true;
}

// v2 (PRI-621 RC2): repair prompt carries the complete JSON Schema
// (schemaJson, bounded by maxSchemaJsonChars) instead of a top-level-only
// summary, so the repair LLM can fix nested enum/constraint violations.
export const REPAIR_PROMPT_VERSION = '2';

export const MAX_REPAIR_ATTEMPTS = 3;

export function normalizeMaxRepairAttempts(raw: number | undefined, defaultVal: number): number {
  if (raw === undefined) return defaultVal;
  if (!Number.isFinite(raw)) return defaultVal;
  if (raw < 0) return 0;
  const floored = Math.floor(raw);
  if (floored > MAX_REPAIR_ATTEMPTS) return MAX_REPAIR_ATTEMPTS;
  return floored;
}

export function truncatePreview(text: string, maxLen = 500): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  const sliceLen = Math.max(0, maxLen - 3);
  return text.slice(0, sliceLen) + '...';
}

export function safeStringifyPreview(value: unknown, maxLen = 500): string {
  try {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'bigint') return truncatePreview(`${value}n`, maxLen);
    const serialized = JSON.stringify(value);
    return truncatePreview(serialized, maxLen);
  } catch {
    if (typeof value === 'object' && value !== null) {
      const ctor = (value as Record<string, unknown>).constructor;
      return truncatePreview(`[unserializable: ${ctor?.name ?? 'Object'}]`, maxLen);
    }
    return truncatePreview(String(value), maxLen);
  }
}

export const LINEAGE_FIELDS = [
  'taskId',
  'sourcePainId',
  'sourceTaskId',
  'sourceRunIds',
  'sourceArtifactId',
  'sourceRefs',
] as const;

export type LineageField = typeof LINEAGE_FIELDS[number];

const LINE_FIELDS_SET: ReadonlySet<string> = new Set<string>(LINEAGE_FIELDS);

export function isLineageField(key: string): key is LineageField {
  return LINE_FIELDS_SET.has(key);
}

export function preserveLineageFields(
  original: Record<string, unknown>,
  repaired: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...repaired };
  for (const field of LINEAGE_FIELDS) {
    if (Object.hasOwn(original, field)) {
      result[field] = original[field];
    }
  }
  return result;
}

export function stripLineageFields(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...obj };
  for (const field of LINEAGE_FIELDS) {
    delete result[field];
  }
  return result;
}

export function formatValidationErrorEntry(
  path: string,
  message: string,
  value: unknown,
): OutputValidationErrorEntry {
  const actualPreview = typeof value === 'string'
    ? truncatePreview(value, 100)
    : value === undefined || value === null
      ? String(value)
      : safeStringifyPreview(value, 100);
  return {
    path,
    expected: message,
    actualPreview,
  };
}
