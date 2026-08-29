/**
 * Structured output repair module — reusable, runtime-agnostic schema repair loop.
 *
 * When an LLM returns valid JSON that fails TypeBox schema validation, this module
 * generates a bounded repair prompt containing the previous output and specific
 * validation errors, then calls the LLM again for a corrected response.
 *
 * Design principles:
 *   - Generic over T — no Diagnostician-specific knowledge
 *   - Callback-based — schemaCheck and llmCaller are injected, no pi-ai imports
 *   - Bounded — all prompts and error summaries are size-limited
 *   - Fail-closed — if repair output still fails schemaCheck, return repaired=false
 *   - Lineage-safe — repair must not silently override lineage fields (PRI-200)
 *
 * PRI-71: First integration target is Diagnostician via PiAiRuntimeAdapter.
 * PRI-200: Evidence pack, schemaRef in prompt, lineage protection, repairAttempts[].
 * Future peer runners (Dreamer, Philosopher, etc.) can reuse the same module.
 */

import type { OutputRepairAttempt, OutputValidationErrorEntry } from './output-repair-contract.js';
import { REPAIR_PROMPT_VERSION, preserveLineageFields, truncatePreview, formatValidationErrorEntry, normalizeMaxRepairAttempts, safeStringifyPreview } from './output-repair-contract.js';

/** A single TypeBox validation error from Value.Errors(). */
export interface SchemaValidationError {
  readonly path: string;
  readonly message: string;
  readonly value: unknown;
}

/** Configuration for the repair loop. */
export interface RepairConfig {
  /** Maximum repair attempts. Default: 3. */
  readonly maxRepairAttempts?: number;
  /** Maximum number of errors to include in repair prompt. Default: 10. */
  readonly maxErrorsInPrompt?: number;
  /** Maximum characters per error description. Default: 200. */
  readonly maxErrorChars?: number;
  /** Maximum characters of raw JSON to include in prompt. Default: 2000. */
  readonly maxRawOutputChars?: number;
  /** Schema reference for the output being repaired (PRI-200). Included in repair prompt. */
  readonly schemaRef?: string;
  /** Original output with lineage fields to preserve during repair (PRI-200). */
  readonly originalOutput?: Record<string, unknown>;
  /** Human-readable schema summary to include in repair prompt (PRI-271 A2). */
  readonly schemaSummary?: string;
  /**
   * Complete JSON Schema (serialized) to include in the repair prompt
   * (PRI-621 RC2). Preferred over schemaSummary when present: the summary
   * only lists top-level field names, which left the repair LLM guessing
   * nested enums/constraints and failing all attempts.
   */
  readonly schemaJson?: string;
  /** Maximum characters of the serialized schema. Default: 8000. */
  readonly maxSchemaJsonChars?: number;
  /** Internal override for jitter between repair attempts (PRI-271 A3). Set to 0 to disable. */
  readonly _testJitterMs?: number;
}

/** Sensible defaults for repair configuration. */
export const DEFAULT_REPAIR_CONFIG: Required<Omit<RepairConfig, 'schemaRef' | 'originalOutput' | 'schemaSummary' | 'schemaJson' | '_testJitterMs'>> = {
  maxRepairAttempts: 3,
  maxErrorsInPrompt: 10,
  maxErrorChars: 200,
  maxRawOutputChars: 2000,
  maxSchemaJsonChars: 8000,
} as const;

/** Result of a repair attempt. */
export interface RepairResult<T> {
  /** Whether repair succeeded and output passes schema validation. */
  readonly repaired: boolean;
  /** The repaired and validated output (set when repaired=true). */
  readonly output: T | null;
  /** Number of repair attempts made. */
  readonly attemptsUsed: number;
  /** Bounded summary of what was tried (for telemetry). */
  readonly repairSummary: string;
  /** Detailed repair attempt records for evidence pack (PRI-200). */
  readonly repairAttempts: readonly OutputRepairAttempt[];
}

/** Callback for invoking an LLM during repair. Runtime-agnostic. */
export type RepairLLMCaller = (prompt: string) => Promise<string | null>;

/** Callbacks injected into the repair loop. */
export interface RepairCallbacks {
  readonly llmCaller: RepairLLMCaller;
  readonly schemaCheck: (value: unknown) => boolean;
  /** Optional: re-validate schema errors on repaired output for evidence pack. */
  readonly schemaErrors?: (value: unknown) => SchemaValidationError[];
}

// Re-export from json-extractor so callers can use a single import path
export { extractJsonObject } from './json-extractor.js';
import { extractJsonObjectForSchema } from './json-extractor.js';
import type { TSchema } from '@sinclair/typebox';

/**
 * Derive a human-readable schema summary from a TypeBox schema (PRI-271 A2).
 *
 * Produces a compact text description of field names, types, required status,
 * and enum values — suitable for inclusion in repair prompts so the LLM knows
 * the target schema structure without needing the full JSON Schema.
 */
export function deriveSchemaSummary(schema: TSchema): string {
  if (!schema || typeof schema !== 'object') return '(unknown schema)';

  // Handle Object schemas
  if (schema.type === 'object' && schema.properties) {
    const required = Array.isArray(schema.required) ? new Set(schema.required as string[]) : new Set<string>();
    const lines: string[] = [];
    const props = schema.properties as Record<string, TSchema>;

    for (const [key, propSchema] of Object.entries(props)) {
      if (typeof propSchema !== 'object' || propSchema === null) continue;
      const isReq = required.has(key);
      const reqMark = isReq ? ' (required)' : ' (optional)';

      if (propSchema.type === 'array') {
        const items = propSchema.items as TSchema | undefined;
        const itemType = items?.type ?? 'unknown';
        lines.push(`  ${key}: ${itemType}[]${reqMark}`);
      } else if (propSchema.enum) {
        const values = (propSchema.enum as unknown[]).map(String).join(' | ');
        lines.push(`  ${key}: enum(${values})${reqMark}`);
      } else if (propSchema.type) {
        const typeStr = typeof propSchema.type === 'string' ? propSchema.type : 'unknown';
        const constraints: string[] = [];
        if (typeof propSchema.minimum === 'number') constraints.push(`min: ${propSchema.minimum}`);
        if (typeof propSchema.maximum === 'number') constraints.push(`max: ${propSchema.maximum}`);
        if (typeof propSchema.minLength === 'number') constraints.push(`minLength: ${propSchema.minLength}`);
        const constraintStr = constraints.length > 0 ? ` {${constraints.join(', ')}}` : '';
        lines.push(`  ${key}: ${typeStr}${constraintStr}${reqMark}`);
      } else if (propSchema.anyOf || propSchema.allOf || propSchema.oneOf) {
        lines.push(`  ${key}: union${reqMark}`);
      }
    }
    return lines.join('\n');
  }

  // Fallback for non-object schemas
  if (schema.type) return `type: ${schema.type}`;
  return '(complex schema)';
}

/**
 * Compute jitter delay for repair attempt backoff (PRI-271 A3).
 * Returns delay in milliseconds: 200-500ms random jitter.
 * Overridable via config._testJitterMs for deterministic tests.
 */
function computeJitterDelay(config: RepairConfig): number {
  if (config._testJitterMs !== undefined) return config._testJitterMs;
  return 200 + Math.random() * 300;
}

/**
 * Format TypeBox schema errors into a bounded, human-readable repair prompt.
 *
 * PRI-200: Includes schemaRef when available.
 */
export function formatRepairPrompt(
  invalidJson: unknown,
  errors: readonly SchemaValidationError[],
  config: RepairConfig = {},
): string {
  const cfg = { ...DEFAULT_REPAIR_CONFIG, ...config };

  let rawJson = safeStringifyPreview(invalidJson, cfg.maxRawOutputChars);
  if (rawJson.length > cfg.maxRawOutputChars) {
    rawJson = rawJson.slice(0, cfg.maxRawOutputChars) + '\n...[truncated]';
  }

  const boundedErrors = errors.slice(0, cfg.maxErrorsInPrompt);
  const errorLines = boundedErrors.map(e => {
    const msg = e.message.length > cfg.maxErrorChars
      ? e.message.slice(0, cfg.maxErrorChars) + '...'
      : e.message;
    return `- ${e.path}: ${msg}`;
  });

  const skippedCount = errors.length > cfg.maxErrorsInPrompt
    ? errors.length - cfg.maxErrorsInPrompt
    : 0;

  const schemaRefLine = cfg.schemaRef
    ? [`SCHEMA REF: ${cfg.schemaRef}`, '']
    : [];

  // PRI-621 RC2: the complete schema (bounded) beats the top-level-only
  // summary — the repair LLM needs nested enums/constraints to fix errors
  // instead of guessing them. Summary remains the fallback.
  let schemaBlock: string[] = [];
  if (cfg.schemaJson) {
    let schemaText = cfg.schemaJson;
    if (schemaText.length > cfg.maxSchemaJsonChars) {
      schemaText = `${schemaText.slice(0, cfg.maxSchemaJsonChars)}\n...[truncated]`;
    }
    schemaBlock = ['EXPECTED SCHEMA (complete JSON Schema — the output MUST conform):', schemaText, ''];
  } else if (cfg.schemaSummary) {
    schemaBlock = ['EXPECTED SCHEMA:', cfg.schemaSummary, ''];
  }

  return [
    'This is a schema validation repair loop. Your previous JSON output still has errors. Fix ALL remaining errors and return the complete corrected JSON object.',
    '',
    ...schemaRefLine,
    ...schemaBlock,
    'PREVIOUS OUTPUT:',
    rawJson,
    '',
    'SCHEMA ERRORS:',
    ...errorLines,
    ...(skippedCount > 0 ? [`${skippedCount} more error(s) omitted`] : []),
    '',
    'INSTRUCTION: Output ONLY the complete corrected JSON object. No markdown, no explanation.',
  ].join('\n');
}

function buildValidationErrorEntries(
  errors: readonly SchemaValidationError[],
): OutputValidationErrorEntry[] {
  return errors.slice(0, 10).map(e => formatValidationErrorEntry(e.path, e.message, e.value));
}

/**
 * Attempt to repair structurally invalid LLM output by re-prompting
 * the LLM with specific validation errors.
 *
 * Returns RepairResult<T> — either repaired+validated output or null.
 * Bounded by maxRepairAttempts (default 3).
 *
 * PRI-200: Returns repairAttempts[] for evidence pack, protects lineage fields.
 */
// eslint-disable-next-line @typescript-eslint/max-params -- callbacks and config are intentionally separate for clarity
export async function attemptStructuredOutputRepair<T>(
  invalidOutput: unknown,
  schemaErrors: readonly SchemaValidationError[],
  callbacks: RepairCallbacks,
  config?: RepairConfig,
): Promise<RepairResult<T>> {
  const cfg = { ...DEFAULT_REPAIR_CONFIG, ...config, maxRepairAttempts: normalizeMaxRepairAttempts(config?.maxRepairAttempts, DEFAULT_REPAIR_CONFIG.maxRepairAttempts) };
  const repairAttempts: OutputRepairAttempt[] = [];
  let currentErrors: readonly SchemaValidationError[] = schemaErrors;

  if (currentErrors.length === 0 || cfg.maxRepairAttempts <= 0) {
    return {
      repaired: false,
      output: null,
      attemptsUsed: 0,
      repairSummary: `Repair skipped: ${currentErrors.length === 0 ? 'no errors' : 'maxRepairAttempts=0'}`,
      repairAttempts,
    };
  }

  const errorSummary = `${currentErrors.length} errors: ${currentErrors.slice(0, 3).map(e => e.path).join(', ')}`;

  // PRI-621 RC3: required top-level keys parsed (defensively) from the
  // serialized schema the adapter supplies — used to select the right object
  // out of multi-object repair responses.
  let repairRequiredKeys: readonly string[] | undefined;
  if (cfg.schemaJson) {
    try {
      const parsedSchema: unknown = JSON.parse(cfg.schemaJson);
      if (typeof parsedSchema === 'object' && parsedSchema !== null && !Array.isArray(parsedSchema)) {
        const { required } = parsedSchema as { required?: unknown };
        if (Array.isArray(required)) {
          const keys = required.filter((k): k is string => typeof k === 'string');
          repairRequiredKeys = keys.length > 0 ? keys : undefined;
        }
      }
    } catch { /* unparseable schemaJson — fall back to first-object extraction */ }
  }

  for (let attempt = 0; attempt < cfg.maxRepairAttempts; attempt++) {
    const attemptValidationErrors = buildValidationErrorEntries(currentErrors);
    const prompt = formatRepairPrompt(invalidOutput, currentErrors, cfg);

     
    let rawResponse: string | null;
    try {
      rawResponse = await callbacks.llmCaller(prompt);
    } catch (err: unknown) {
      const errorDetail = err instanceof Error ? err.message : String(err);
      repairAttempts.push({
        schemaRef: cfg.schemaRef ?? 'unknown',
        attempt: attempt + 1,
        rawOutputPreview: safeStringifyPreview(invalidOutput),
        validationErrors: attemptValidationErrors,
        repairPromptVersion: REPAIR_PROMPT_VERSION,
        repaired: false,
      });
      return {
        repaired: false,
        output: null,
        attemptsUsed: attempt + 1,
        repairSummary: `Repair failed at attempt ${attempt + 1}: llmCaller threw "${errorDetail}". ${errorSummary}`,
        repairAttempts,
      };
    }

    if (!rawResponse) {
      repairAttempts.push({
        schemaRef: cfg.schemaRef ?? 'unknown',
        attempt: attempt + 1,
        rawOutputPreview: safeStringifyPreview(invalidOutput),
        validationErrors: attemptValidationErrors,
        repairPromptVersion: REPAIR_PROMPT_VERSION,
        repaired: false,
      });
      continue;
    }

    // PRI-621 RC3: schema-aware selection — the repair response may echo the
    // PREVIOUS OUTPUT fragment plus the corrected object; pick by required
    // keys derived from cfg.schemaJson when available.
    const repairedCandidate = extractJsonObjectForSchema(rawResponse, repairRequiredKeys);
    if (!repairedCandidate) {
      repairAttempts.push({
        schemaRef: cfg.schemaRef ?? 'unknown',
        attempt: attempt + 1,
        rawOutputPreview: truncatePreview(rawResponse),
        validationErrors: attemptValidationErrors,
        repairPromptVersion: REPAIR_PROMPT_VERSION,
        repaired: false,
      });
      continue;
    }

    // PRI-200: Protect lineage fields — if originalOutput provided, preserve lineage
    let candidateWithLineage = repairedCandidate;
    if (cfg.originalOutput && typeof repairedCandidate === 'object' && repairedCandidate !== null) {
      candidateWithLineage = preserveLineageFields(cfg.originalOutput, repairedCandidate);
    }

    if (callbacks.schemaCheck(candidateWithLineage)) {
      repairAttempts.push({
        schemaRef: cfg.schemaRef ?? 'unknown',
        attempt: attempt + 1,
        rawOutputPreview: truncatePreview(rawResponse),
        validationErrors: attemptValidationErrors,
        repairPromptVersion: REPAIR_PROMPT_VERSION,
        repaired: true,
      });
      return {
        repaired: true,
        output: candidateWithLineage as T,
        attemptsUsed: attempt + 1,
        repairSummary: `Repair succeeded at attempt ${attempt + 1}. ${errorSummary}`,
        repairAttempts,
      };
    }

    const nextErrors = callbacks.schemaErrors
      ? callbacks.schemaErrors(candidateWithLineage)
      : currentErrors;

    repairAttempts.push({
      schemaRef: cfg.schemaRef ?? 'unknown',
      attempt: attempt + 1,
      rawOutputPreview: truncatePreview(rawResponse),
      validationErrors: attemptValidationErrors,
      repairPromptVersion: REPAIR_PROMPT_VERSION,
      repaired: false,
    });

    invalidOutput = candidateWithLineage;
    currentErrors = nextErrors;

    // PRI-271 A3: Jitter between repair attempts to avoid provider rate limits
    if (attempt < cfg.maxRepairAttempts - 1) {
      const jitterMs = computeJitterDelay(cfg);
      await new Promise(r => setTimeout(r, jitterMs));
    }
  }

  return {
    repaired: false,
    output: null,
    attemptsUsed: cfg.maxRepairAttempts,
    repairSummary: `Repair failed after ${cfg.maxRepairAttempts} attempt(s). ${errorSummary}`,
    repairAttempts,
  };
}
