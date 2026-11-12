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
  /**
   * PRI-707: provider finish metadata, preserved only when the adapter's
   * response actually carried it — never fabricated. `truncated` is set
   * exclusively from finish_reason=length (definitive), unlike the
   * `truncationSuspected` heuristic which also fires for wrong-shape output.
   */
  readonly stopReason?: string;
  readonly truncated?: true;
  /** Provider-reported output token count when usage was supplied. */
  readonly outputTokens?: number;
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
    if (typeof value === 'object') {
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

type LineageField = typeof LINEAGE_FIELDS[number];

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitJsonPointer(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/** Walk the schema to the node addressed by a TypeBox error path. */
function schemaNodeAtPath(schema: unknown, segments: readonly string[]): Record<string, unknown> | null {
  let node: unknown = schema;
  for (const segment of segments) {
    if (!isPlainRecord(node)) return null;
    const properties = isPlainRecord(node.properties) ? node.properties : null;
    if (properties !== null && Object.hasOwn(properties, segment)) {
      node = properties[segment];
      continue;
    }
    // Array index (or any item) → item schema.
    if (Object.hasOwn(node, 'items')) {
      node = node.items;
      continue;
    }
    return null;
  }
  return isPlainRecord(node) ? node : null;
}

function valueAtPath(value: unknown, segments: readonly string[]): unknown {
  let node: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      node = node[index];
      continue;
    }
    if (!isPlainRecord(node) || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

function unionKindLiterals(variant: Record<string, unknown>): string[] {
  const properties = isPlainRecord(variant.properties) ? variant.properties : null;
  const kind = properties && Object.hasOwn(properties, 'kind') ? properties.kind : null;
  if (!isPlainRecord(kind)) return [];
  if (typeof kind.const === 'string') return [kind.const];
  const alternatives = Array.isArray(kind.anyOf) ? kind.anyOf : [];
  return alternatives
    .filter(isPlainRecord)
    .map((entry) => entry.const)
    .filter((entry): entry is string => typeof entry === 'string');
}

/**
 * P1-3: TypeBox reports a failed discriminated union as a single
 * `Expected union value` at the union's path. That message names no field, so
 * it flowed into the repair prompt as noise — exactly the class of low-signal
 * feedback that made a schema-invalid output repeat until the budget was gone.
 *
 * When the failing value carries a `kind`, resolve the variant selected by that
 * kind and name its missing required fields. Every other failure is returned
 * unchanged (this is a formatter, never a second validator).
 */
export function explainUnionValidationFailure(input: {
  readonly schema: unknown;
  readonly rootValue: unknown;
  readonly path: string;
  readonly message: string;
}): string {
  const { schema, rootValue, path, message } = input;
  if (message !== 'Expected union value') return message;
  const segments = splitJsonPointer(path);
  const node = schemaNodeAtPath(schema, segments);
  if (node === null || !Array.isArray(node.anyOf)) return message;

  const failingValue = valueAtPath(rootValue, segments);
  if (!isPlainRecord(failingValue) || !Object.hasOwn(failingValue, 'kind')) return message;
  const { kind } = failingValue;
  if (typeof kind !== 'string') return message;

  const variants = node.anyOf.filter(isPlainRecord);
  const selectedVariant = variants.find((variant) => unionKindLiterals(variant).includes(kind));
  if (selectedVariant === undefined) {
    const allKinds = variants.flatMap(unionKindLiterals);
    return `${message}: kind "${kind}" is not one of ${allKinds.map((entry) => `"${entry}"`).join(' | ')}`;
  }

  const properties = isPlainRecord(selectedVariant.properties) ? selectedVariant.properties : {};
  const required = Array.isArray(selectedVariant.required)
    ? selectedVariant.required.filter((entry): entry is string => typeof entry === 'string')
    : Object.keys(properties);
  const missing = required.filter((key) => !Object.hasOwn(failingValue, key));
  if (missing.length === 0) return message;
  return `${message}: kind "${kind}" requires ${missing.join(', ')}`;
}

