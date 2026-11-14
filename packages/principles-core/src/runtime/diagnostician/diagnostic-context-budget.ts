/**
 * DiagnosticContextBudget — SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §6.1.
 *
 * Stage B/C previously serialized the whole upstream artifact with no budget.
 * The only guard was the adapter's pre-flight `context_overflow` failure, which
 * tells the operator that a request was too large but not which stage, which
 * field, or what was intended to be sent.
 *
 * This module derives a per-stage budget from the SAME model catalog the
 * adapter uses. It never claims a precise tokenizer: every number produced here
 * is an ESTIMATE (pi-ai's chars-based heuristic), labelled as such, so a
 * `provider_reported` usage value is never confused with it.
 */
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { resolveContextBudget } from '../adapter/context-budget.js';
import type { RuntimeModelInfo } from '../runtime-protocol.js';

export type DiagnosticStage = 'A' | 'B' | 'C';

/** Model metadata needed to size a request. Absent values stay `null`. */
export type ModelCapabilityInfo = RuntimeModelInfo;

export interface DiagnosticContextBudget {
  readonly stage: DiagnosticStage;
  readonly provider: string;
  readonly model: string;
  readonly contextWindowLimit: number | null;
  readonly maxOutputTokens: number | null;
  /** Estimated tokens consumed by the system prompt (not part of the message). */
  readonly systemPromptTokens: number;
  /** Input tokens available to the message; `null` when the window is unknown. */
  readonly inputBudgetTokens: number | null;
  readonly safetyMarginTokens: number;
  /** Estimated tokens of the message actually assembled for this call. */
  readonly estimatedInputTokens: number;
  /** Provider-reported input tokens for this call, when it reports them. */
  readonly actualInputTokens: number | null;
  readonly truncationMetadata: {
    readonly truncated: boolean;
    readonly droppedFieldCount: number;
    readonly budgetExceeded: boolean;
  } | null;
  readonly estimates: {
    /** Every token count here is an estimate, never a provider measurement. */
    readonly tokenizer: 'heuristic_chars';
    readonly contextWindowSource: 'model_catalog' | 'unknown';
  };
}

/**
 * Safety margin for messages the adapter adds (tools, envelopes) and for the
 * estimator's own error. Capped so small windows still get a usable budget.
 */
function resolveSafetyMarginTokens(budget: number): number {
  return Math.min(4_096, Math.max(256, Math.floor(budget * 0.1)));
}

export interface BuildDiagnosticContextBudgetInput {
  readonly stage: DiagnosticStage;
  readonly modelInfo: ModelCapabilityInfo | null;
  readonly systemPrompt: string;
  readonly estimatedInputTokens?: number;
}

/**
 * Build the budget for one stage call.
 *
 * With an unknown model window the input budget is `null` (unbounded) and the
 * source is recorded as `unknown` — inventing a limit would reject requests the
 * provider accepts and hide the missing metadata.
 */
export function buildDiagnosticContextBudget(
  input: BuildDiagnosticContextBudgetInput,
): DiagnosticContextBudget {
  const { stage, modelInfo, systemPrompt } = input;
  const systemPromptTokens = systemPrompt ? estimateTextTokens(systemPrompt) : 0;
  const provider = modelInfo?.provider ?? 'unknown';
  const model = modelInfo?.model ?? 'unknown';
  const window = modelInfo?.contextWindowTokens;
  const maxOutputTokens = typeof modelInfo?.maxOutputTokens === 'number' ? modelInfo.maxOutputTokens : null;

  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) {
    return {
      stage,
      provider,
      model,
      contextWindowLimit: null,
      maxOutputTokens,
      systemPromptTokens,
      inputBudgetTokens: null,
      safetyMarginTokens: 0,
      estimatedInputTokens: input.estimatedInputTokens ?? 0,
      actualInputTokens: null,
      truncationMetadata: null,
      estimates: { tokenizer: 'heuristic_chars', contextWindowSource: 'unknown' },
    };
  }

  const { budgetTokens } = resolveContextBudget(window, maxOutputTokens ?? 0);
  const safetyMarginTokens = Number.isFinite(budgetTokens) ? resolveSafetyMarginTokens(budgetTokens) : 0;
  const inputBudgetTokens = Number.isFinite(budgetTokens)
    ? Math.max(0, budgetTokens - systemPromptTokens - safetyMarginTokens)
    : null;

  return {
    stage,
    provider,
    model,
    contextWindowLimit: window,
    maxOutputTokens,
    systemPromptTokens,
    inputBudgetTokens,
    safetyMarginTokens,
    estimatedInputTokens: input.estimatedInputTokens ?? 0,
    actualInputTokens: null,
    truncationMetadata: null,
    estimates: { tokenizer: 'heuristic_chars', contextWindowSource: 'model_catalog' },
  };
}
