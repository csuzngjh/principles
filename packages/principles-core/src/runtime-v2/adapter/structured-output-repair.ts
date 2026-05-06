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
 *
 * PRI-71: First integration target is Diagnostician via PiAiRuntimeAdapter.
 * Future peer runners (Dreamer, Philosopher, etc.) can reuse the same module.
 */

/** A single TypeBox validation error from Value.Errors(). */
export interface SchemaValidationError {
  readonly path: string;
  readonly message: string;
  readonly value: unknown;
}

/** Configuration for the repair loop. */
export interface RepairConfig {
  /** Maximum repair attempts. Default: 1. */
  readonly maxRepairAttempts?: number;
  /** Maximum number of errors to include in repair prompt. Default: 10. */
  readonly maxErrorsInPrompt?: number;
  /** Maximum characters per error description. Default: 200. */
  readonly maxErrorChars?: number;
  /** Maximum characters of raw JSON to include in prompt. Default: 2000. */
  readonly maxRawOutputChars?: number;
}

/** Sensible defaults for repair configuration. */
export const DEFAULT_REPAIR_CONFIG: Required<RepairConfig> = {
  maxRepairAttempts: 1,
  maxErrorsInPrompt: 10,
  maxErrorChars: 200,
  maxRawOutputChars: 2000,
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
}

/** Callback for invoking an LLM during repair. Runtime-agnostic. */
export type RepairLLMCaller = (prompt: string) => Promise<string | null>;

/** Callbacks injected into the repair loop. */
export interface RepairCallbacks {
  readonly llmCaller: RepairLLMCaller;
  readonly schemaCheck: (value: unknown) => boolean;
}

// Re-export from json-extractor so callers can use a single import path
export { extractJsonObject } from './json-extractor.js';
import { extractJsonObject } from './json-extractor.js';

/**
 * Format TypeBox schema errors into a bounded, human-readable repair prompt.
 */
export function formatRepairPrompt(
  invalidJson: unknown,
  errors: readonly SchemaValidationError[],
  config: RepairConfig = {},
): string {
  const cfg = { ...DEFAULT_REPAIR_CONFIG, ...config };

  let rawJson = JSON.stringify(invalidJson, null, 2);
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

  return [
    'This is a schema validation repair loop. Your previous JSON output still has errors. Fix ALL remaining errors and return the complete corrected JSON object.',
    '',
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

/**
 * Attempt to repair structurally invalid LLM output by re-prompting
 * the LLM with specific validation errors.
 *
 * Returns RepairResult<T> — either repaired+validated output or null.
 * Bounded by maxRepairAttempts (default 1).
 */
// eslint-disable-next-line @typescript-eslint/max-params -- callbacks and config are intentionally separate for clarity
export async function attemptStructuredOutputRepair<T>(
  invalidOutput: unknown,
  schemaErrors: readonly SchemaValidationError[],
  callbacks: RepairCallbacks,
  config?: RepairConfig,
): Promise<RepairResult<T>> {
  const cfg = { ...DEFAULT_REPAIR_CONFIG, ...config };

  if (schemaErrors.length === 0 || cfg.maxRepairAttempts <= 0) {
    return {
      repaired: false,
      output: null,
      attemptsUsed: 0,
      repairSummary: `Repair skipped: ${schemaErrors.length === 0 ? 'no errors' : 'maxRepairAttempts=0'}`,
    };
  }

  const errorSummary = `${schemaErrors.length} errors: ${schemaErrors.slice(0, 3).map(e => e.path).join(', ')}`;

  for (let attempt = 0; attempt < cfg.maxRepairAttempts; attempt++) {
    const prompt = formatRepairPrompt(invalidOutput, schemaErrors, cfg);

    // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in try block below
    let rawResponse: string | null;
    try {
      rawResponse = await callbacks.llmCaller(prompt);
    } catch (err: unknown) {
      const errorDetail = err instanceof Error ? err.message : String(err);
      return {
        repaired: false,
        output: null,
        attemptsUsed: attempt + 1,
        repairSummary: `Repair failed at attempt ${attempt + 1}: llmCaller threw "${errorDetail}". ${errorSummary}`,
      };
    }

    if (!rawResponse) {
      continue;
    }

    const repairedCandidate = extractJsonObject(rawResponse);
    if (!repairedCandidate) {
      continue;
    }

    if (callbacks.schemaCheck(repairedCandidate)) {
      return {
        repaired: true,
        output: repairedCandidate as T,
        attemptsUsed: attempt + 1,
        repairSummary: `Repair succeeded at attempt ${attempt + 1}. ${errorSummary}`,
      };
    }

    invalidOutput = repairedCandidate;
  }

  return {
    repaired: false,
    output: null,
    attemptsUsed: cfg.maxRepairAttempts,
    repairSummary: `Repair failed after ${cfg.maxRepairAttempts} attempt(s). ${errorSummary}`,
  };
}
