/**
 * Layer 2 — Progressive Evaluator: two-stage evaluation with flagged criteria
 * (design §6.5).
 *
 * Pure logic only (Core vs Plugin boundary, `antipattern-core-io`).
 *
 * The progressive evaluator runs Stage 1 (summary-level context) first; only
 * when flagged / undetermined / forced-sample does it trigger Stage 2 (tier2
 * full-contentJson re-evaluation). This keeps daily cost low while enabling
 * deep diagnosis on demand.
 *
 * Key invariants:
 *   - Stage 2 output is INDEPENDENT — never merged with Stage 1 (rc-7 /
 *     ERR-015 / ERR-018 / ERR-019). `stagesRun === 2` ⟹ `finalOutput` is
 *     entirely the Stage 2 result.
 *   - flagged criteria read DIMENSION_COVERAGE_POLICY (single source of truth),
 *     never inline a dimension-name array. Untrusted LLM input is filtered by
 *     the policy table before flagging (rc-1 / rc-4).
 *   - Deterministic forced sampling via fnv1a32 (no Math.random, design §4.4).
 */

import {
  DIMENSION_COVERAGE_POLICY,
  REQUIRED_FIDELITY_DIMENSIONS,
  isRequiredDimension,
  type DreamerDimension,
} from './dimension-coverage-policy.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const IMPLEMENTATION_FIDELITY_THRESHOLD = 0.7;
export const FORCED_STAGE2_SAMPLE_MODULUS = 20; // ~5%

export type FlaggedReasonCode =
  | 'missing_dimensions'
  | 'pain_not_fully_covered'
  | 'implementation_fidelity_below_threshold';

export interface FlaggedDecision {
  readonly flagged: boolean;
  readonly reasons: readonly FlaggedReasonCode[];
  /** Fields that could not be determined (missing/malformed) — rc-3 + rc-9. */
  readonly undetermined: readonly string[];
}

export interface ProgressiveEvaluationOutcome {
  /** Stage 2 ran → entirely Stage 2's result; never merged with Stage 1. */
  readonly finalOutput: unknown;
  readonly stagesRun: 1 | 2;
  readonly stage1Decision: FlaggedDecision;
  readonly forcedStage2: boolean;
  readonly stage1FalseNegative?: { readonly newConcernKeys: readonly string[] };
  readonly stage2Aborted?: { readonly reason: 'lineage_error'; readonly detail: string };
}

// ── Runtime guards (rc-1 / rc-2 / rc-5) ──────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNumber(source: unknown, key: string): number | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  const v = source[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readBoolean(source: unknown, key: string): boolean | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  const v = source[key];
  return typeof v === 'boolean' ? v : null;
}

function readStringArray(source: unknown, key: string): readonly string[] | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  const v = source[key];
  if (!Array.isArray(v)) return null;
  return v.filter((el): el is string => typeof el === 'string');
}

// ── Deterministic forced sampling (design §4.4) ───────────────────────────────

/**
 * FNV-1a 32-bit hash. Pure, deterministic, no crypto, no Math.random.
 * Supports the full Unicode range in the input string.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime multiplication with 32-bit overflow wrapping.
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert to unsigned 32-bit.
  return hash >>> 0;
}

/**
 * Deterministic ~5% forced Stage 2 sampling. `fnv1a32(taskId) % modulus === 0`.
 * Never uses Math.random or any non-deterministic source (design §4.4).
 */
export function isForcedStage2(taskId: string, modulus: number = FORCED_STAGE2_SAMPLE_MODULUS): boolean {
  if (modulus <= 0) return false;
  return fnv1a32(taskId) % modulus === 0;
}

// ── Flagged criteria (design §6.5.3) ─────────────────────────────────────────

/**
 * Evaluate the three flagged criteria against Stage 1 output (design §6.5.3).
 *
 * Preconditions: none — `stage1Output` is untrusted LLM output (rc-1), read
 * via `Object.hasOwn` (rc-5 / ERR-013).
 *
 * Postconditions:
 *   - `flagged === true` iff `reasons` is non-empty.
 *   - Three criteria: required-dimension missing, painCoverage.fullyCovered === false,
 *     implementationFidelity.score < 0.7.
 *   - Fields missing or wrong type → `undetermined` (rc-3: fail loud, never
 *     silently pass).
 *
 * Dimension criterion (§6.5.3, measurement-driven tightening):
 *   - Only **required** dimension names in `missingDimensions` count. The LLM
 *     may stuff optional/excluded/unknown strings in — all filtered out by
 *     `isRequiredDimension` before checking. `optionalUncovered` never enters
 *     `reasons`.
 */
export function evaluateFlaggedCriteria(stage1Output: unknown): FlaggedDecision {
  const reasons: FlaggedReasonCode[] = [];
  const undetermined: string[] = [];

  if (!isRecord(stage1Output)) {
    // Entire output is malformed — all criteria undetermined.
    return { flagged: false, reasons: [], undetermined: ['output_not_object'] };
  }

  // Criterion 1: required dimension missing (filtered, §6.5.3).
  const compressionFidelity = Object.hasOwn(stage1Output, 'compressionFidelity')
    ? stage1Output.compressionFidelity
    : undefined;
  if (isRecord(compressionFidelity)) {
    const missingDims = readStringArray(compressionFidelity, 'missingDimensions');
    if (missingDims === null) {
      undetermined.push('compressionFidelity.missingDimensions');
    } else {
      // rc-4: filter untrusted input through the policy table.
      const requiredMissing = missingDims.filter((d) => isRequiredDimension(d));
      if (requiredMissing.length > 0) {
        reasons.push('missing_dimensions');
      }
    }
  } else {
    undetermined.push('compressionFidelity');
  }

  // Criterion 2: painCoverage.fullyCovered === false.
  const painCoverage = Object.hasOwn(stage1Output, 'painCoverage')
    ? stage1Output.painCoverage
    : undefined;
  if (isRecord(painCoverage)) {
    const fullyCovered = readBoolean(painCoverage, 'fullyCovered');
    if (fullyCovered === null) {
      undetermined.push('painCoverage.fullyCovered');
    } else if (fullyCovered === false) {
      reasons.push('pain_not_fully_covered');
    }
  } else {
    undetermined.push('painCoverage');
  }

  // Criterion 3: implementationFidelity.score < threshold.
  const implFidelity = Object.hasOwn(stage1Output, 'implementationFidelity')
    ? stage1Output.implementationFidelity
    : undefined;
  if (isRecord(implFidelity)) {
    const score = readNumber(implFidelity, 'score');
    if (score === null) {
      undetermined.push('implementationFidelity.score');
    } else if (score < IMPLEMENTATION_FIDELITY_THRESHOLD) {
      reasons.push('implementation_fidelity_below_threshold');
    }
  } else {
    undetermined.push('implementationFidelity');
  }

  return {
    flagged: reasons.length > 0,
    reasons,
    undetermined,
  };
}

// ── Two-stage evaluation (design §6.5) ───────────────────────────────────────

/**
 * LLM evaluator callback type. The caller injects the actual LLM invocation;
 * this module is pure logic and never calls an LLM directly.
 */
export interface ProgressiveEvaluatorLLM {
  /** Evaluate using the provided context fields. Returns the raw LLM output (unknown). */
  evaluate(fields: Readonly<Record<string, string>>): Promise<unknown>;
}

/**
 * Lineage resolver type (CandidateLineage from Layer 2, injected by caller).
 */
export interface ProgressiveEvaluatorLineage {
  resolve(startArtifactId: string): Promise<
    | { readonly ok: true; readonly value: { readonly nodes: readonly unknown[] } }
    | { readonly ok: false; readonly error: { readonly kind: string } }
  >;
}

export interface ProgressiveEvaluatorDeps {
  readonly taskId: string;
  readonly startArtifactId: string;
  readonly stage1Context: Readonly<Record<string, string>>;
  readonly stage2Context?: Readonly<Record<string, string>>;
  readonly llm: ProgressiveEvaluatorLLM;
  readonly lineage?: ProgressiveEvaluatorLineage;
  readonly emit?: (event: ProgressiveEvaluatorEvent) => void;
}

export type ProgressiveEvaluatorEvent =
  | { readonly type: 'lineage_data_corrupt'; readonly detail: string }
  | { readonly type: 'stage1_false_negative'; readonly newConcernKeys: readonly string[] };

/**
 * Run the two-stage progressive evaluation (design §6.5).
 *
 * Stage 1: evaluate with summary-level context → flagged criteria.
 * If not flagged AND not forced AND no undetermined → return Stage 1 result.
 * Otherwise → Stage 2: resolve tier2 lineage, evaluate independently.
 *
 * Stage 2 output is INDEPENDENT (rc-7 / ERR-015 / ERR-018 / ERR-019):
 *   - Stage 1 output is NOT injected into Stage 2 context.
 *   - Stage 2 concerns are NOT merged with Stage 1.
 *   - `stagesRun === 2` → `finalOutput` is entirely Stage 2's result.
 *
 * Forced sampling (~5%) serves as a false-negative check: if Stage 1 passed
 * but Stage 2 finds new concerns, emit `stage1_false_negative`.
 */
export async function runProgressiveEvaluation(
  deps: ProgressiveEvaluatorDeps,
): Promise<ProgressiveEvaluationOutcome> {
  const emit = deps.emit ?? (() => undefined);

  // Stage 1: summary-level evaluation.
  const out1 = await deps.llm.evaluate(deps.stage1Context);
  const d1 = evaluateFlaggedCriteria(out1);
  const forced = isForcedStage2(deps.taskId);

  // No Stage 2 needed.
  if (!d1.flagged && !forced && d1.undetermined.length === 0) {
    return { finalOutput: out1, stagesRun: 1, stage1Decision: d1, forcedStage2: false };
  }

  // Stage 2 triggered. Resolve tier2 lineage first.
  if (deps.lineage !== undefined) {
    const tier2 = await deps.lineage.resolve(deps.startArtifactId);
    if (!tier2.ok) {
      emit({ type: 'lineage_data_corrupt', detail: tier2.error.kind });
      return {
        finalOutput: out1,
        stagesRun: 1,
        stage1Decision: d1,
        forcedStage2: forced,
        stage2Aborted: { reason: 'lineage_error', detail: tier2.error.kind },
      };
    }
  }

  // Stage 2: independent re-evaluation with tier2 context.
  // rc-7: do NOT inject out1, d1, or Stage 1 concerns into Stage 2.
  const stage2Ctx = deps.stage2Context ?? deps.stage1Context;
  const out2 = await deps.llm.evaluate(stage2Ctx);

  // False-negative check (forced sample only, Stage 1 not flagged).
  let falseNeg: { readonly newConcernKeys: readonly string[] } | undefined;
  if (forced && !d1.flagged) {
    const newKeys = diffConcernKeys(out2, out1);
    if (newKeys.length > 0) {
      falseNeg = { newConcernKeys: newKeys };
      emit({ type: 'stage1_false_negative', newConcernKeys: newKeys });
    }
  }

  return {
    finalOutput: out2,
    stagesRun: 2,
    stage1Decision: d1,
    forcedStage2: forced,
    stage1FalseNegative: falseNeg,
  };
}

/**
 * Compute the set difference of concern keys between Stage 2 and Stage 1.
 * Returns keys present in Stage 2 but not in Stage 1.
 */
function diffConcernKeys(stage2Output: unknown, stage1Output: unknown): readonly string[] {
  const keys1 = extractConcernKeys(stage1Output);
  const keys2 = extractConcernKeys(stage2Output);
  const set1 = new Set(keys1);
  return keys2.filter((k) => !set1.has(k));
}

/**
 * Extract concern identifiers from an evaluator output (best-effort).
 * Concerns are an array of objects with a `key` or `description` field.
 */
function extractConcernKeys(output: unknown): readonly string[] {
  if (!isRecord(output)) return [];
  const evaluation = Object.hasOwn(output, 'evaluation') ? output.evaluation : undefined;
  if (!isRecord(evaluation)) return [];
  const concerns = Object.hasOwn(evaluation, 'concerns') ? evaluation.concerns : undefined;
  if (!Array.isArray(concerns)) return [];
  return concerns
    .map((c): string => {
      if (!isRecord(c)) return '';
      if (Object.hasOwn(c, 'key') && typeof c.key === 'string') return c.key;
      if (Object.hasOwn(c, 'description') && typeof c.description === 'string') return c.description;
      return '';
    })
    .filter((k) => k !== '');
}
