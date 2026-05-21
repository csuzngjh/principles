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
}

export const REPAIR_PROMPT_VERSION = '1';

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

export function truncatePreview(text: string, maxLen = 500): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  const sliceLen = Math.max(0, maxLen - 3);
  return text.slice(0, sliceLen) + '...';
}

export function formatValidationErrorEntry(
  path: string,
  message: string,
  value: unknown,
): OutputValidationErrorEntry {
  const actualPreview = typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? String(value)
      : truncatePreview(JSON.stringify(value), 100);
  return {
    path,
    expected: message,
    actualPreview,
  };
}
