/**
 * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: model-context-aware prompt
 * injection budget policy.
 *
 * Single authority for translating a model's effective context window
 * (tokens) into the Runtime V2 principle injection budget (UTF-16 code
 * units). Pure policy — no I/O, no host facts, no catalog import: the Pi AI
 * catalog arrives as an injectable seam so tests can pin the priority chain
 * without patching module state, and production callers share one catalog
 * binding (`getPromptModelCatalog` in adapter/pi-ai-catalog.ts).
 *
 * Priority chain (SPEC §4.3):
 *   1. host_effective_window — the host hook's effective context-token
 *      budget when its source is model-specific or an explicit cap
 *      (model | modelsConfig | agentContextTokens; `default` and unknown
 *      sources are NOT trusted);
 *   2. pi_catalog_exact — exact provider+modelId match in the installed
 *      catalog;
 *   3. pi_catalog_unambiguous — no provider, but EVERY exact modelId match
 *      across providers reports the same valid contextWindow;
 *   4. legacy_fallback — the historical 2000-char budget, status unknown.
 *
 * This module computes a budget from the model's TOTAL context window — it
 * is not a measurement of the current request's REMAINING context, and it
 * never treats `maxTokens` (an output cap) as a context window.
 */
import { RUNTIME_V2_PRINCIPLE_BUDGET } from './prompt-activation-reader-contract.js';

export const PROMPT_BUDGET_POLICY_VERSION = 'model_aware_v1' as const;

/** Baseline budget at the reference context window (SPEC §4.1). */
export const PROMPT_BUDGET_BASE_CHARS = 2000;
/** Policy anchor: the context window that maps to the baseline budget. */
export const PROMPT_BUDGET_REFERENCE_CONTEXT_WINDOW_TOKENS = 128000;
/** Dynamic budget floor (a 32K-window model still gets a usable budget). */
export const PROMPT_BUDGET_MIN_CHARS = 500;
/** Dynamic budget hard ceiling — bigger windows must not grow the block forever. */
export const PROMPT_BUDGET_MAX_CHARS = 4000;
/** Unknown/untrusted capacity: keep the historical budget (rollback target). */
export const PROMPT_BUDGET_FALLBACK_CHARS = RUNTIME_V2_PRINCIPLE_BUDGET;

/**
 * Plausibility bounds for a claimed context window (tokens). Values outside
 * this range are rejected as malformed rather than clamped — a corrupted
 * field must degrade to the fallback, never look like a confirmed capacity.
 */
export const MIN_PLAUSIBLE_CONTEXT_WINDOW_TOKENS = 1024;
export const MAX_PLAUSIBLE_CONTEXT_WINDOW_TOKENS = 100_000_000;

/**
 * Upstream OpenClaw `PluginHookContextWindowSource` values that prove the
 * hook's `contextTokenBudget` reflects this model's real window or a
 * deliberate cap: "model" (model metadata), "modelsConfig" (per-model
 * config), "agentContextTokens" (agent-level cap). "default" means the host
 * had no model-specific fact — SPEC §4.3 keeps looking (catalog) instead of
 * trusting it; unknown future values get the same conservative treatment.
 */
export const TRUSTED_HOST_CONTEXT_WINDOW_SOURCES: ReadonlySet<string> = new Set([
  'model',
  'modelsConfig',
  'agentContextTokens',
]);

export type PromptBudgetCapacitySource =
  | 'host_effective_window'
  | 'pi_catalog_exact'
  | 'pi_catalog_unambiguous'
  | 'legacy_fallback';

export type PromptBudgetCapacityStatus = 'confirmed' | 'unknown';

export interface PromptBudgetResolution {
  /** Effective injection budget in UTF-16 code units. */
  budgetChars: number;
  capacitySource: PromptBudgetCapacitySource;
  capacityStatus: PromptBudgetCapacityStatus;
  /** The context window the budget was derived from; null when unknown. */
  contextWindowTokens: number | null;
  policyVersion: typeof PROMPT_BUDGET_POLICY_VERSION;
  /** Present only on legacy_fallback — why no capacity could be confirmed. */
  fallbackReason?: string;
}

/** Runtime-validation guard for an untrusted context-window claim (rc-1/rc-2). */
export function isValidContextWindowTokens(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_PLAUSIBLE_CONTEXT_WINDOW_TOKENS &&
    value <= MAX_PLAUSIBLE_CONTEXT_WINDOW_TOKENS
  );
}

/** The dynamic formula (SPEC §4.2): clamp(floor(base * W / ref), min, max). */
export function promptBudgetCharsForContextWindow(windowTokens: number): number {
  if (!isValidContextWindowTokens(windowTokens)) {
    return PROMPT_BUDGET_FALLBACK_CHARS;
  }
  const scaled = Math.floor(
    (PROMPT_BUDGET_BASE_CHARS * windowTokens) / PROMPT_BUDGET_REFERENCE_CONTEXT_WINDOW_TOKENS,
  );
  return Math.min(PROMPT_BUDGET_MAX_CHARS, Math.max(PROMPT_BUDGET_MIN_CHARS, scaled));
}

/**
 * Tier classification for a single-item serialized cost, independent of any
 * particular resolution (SPEC §6.3): the supported budget range is
 * [MIN, MAX]; a cost within (MIN, MAX] may or may not fit depending on the
 * runtime model — that uncertainty must be reported, not resolved by guess.
 */
export type PromptBudgetTierFit = 'fits_all_tiers' | 'model_dependent' | 'exceeds_max_tier';

export function classifySingleItemBudgetTier(costChars: number): PromptBudgetTierFit {
  if (costChars <= PROMPT_BUDGET_MIN_CHARS) return 'fits_all_tiers';
  if (costChars <= PROMPT_BUDGET_MAX_CHARS) return 'model_dependent';
  return 'exceeds_max_tier';
}

/** Catalog entry shape the policy consumes (provider-qualified model facts). */
export interface PromptModelCatalogEntry {
  provider: string;
  modelId: string;
  contextWindowTokens: number;
}

/**
 * Injectable catalog seam. `exact` is a provider-qualified lookup;
 * `byModelId` returns EVERY exact-id match across providers so the caller
 * can require unanimity instead of silently taking the first hit.
 */
export interface PromptModelCatalog {
  exact(providerId: string, modelId: string): PromptModelCatalogEntry | undefined;
  byModelId(modelId: string): readonly PromptModelCatalogEntry[];
}

/** Host-provided capacity facts — untrusted until validated here (rc-1). */
export interface PromptBudgetHostCapacityFact {
  contextTokenBudget?: unknown;
  contextWindowSource?: unknown;
}

export interface ResolvePromptBudgetInput {
  hostCapacity?: PromptBudgetHostCapacityFact;
  modelIdentity?: {
    providerId?: unknown;
    modelId?: unknown;
  };
  /** Absent catalog ⇒ priorities 2-3 are skipped (pure-fallback callers). */
  catalog?: PromptModelCatalog;
}

function fallbackResolution(reason: string): PromptBudgetResolution {
  return {
    budgetChars: PROMPT_BUDGET_FALLBACK_CHARS,
    capacitySource: 'legacy_fallback',
    capacityStatus: 'unknown',
    contextWindowTokens: null,
    policyVersion: PROMPT_BUDGET_POLICY_VERSION,
    fallbackReason: reason,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveFromCatalog(input: ResolvePromptBudgetInput | undefined, hostSkipReason: string): PromptBudgetResolution {
  const catalog = input?.catalog;
  const modelId = nonEmptyString(input?.modelIdentity?.modelId);
  const providerId = nonEmptyString(input?.modelIdentity?.providerId);
  if (catalog === undefined) {
    return fallbackResolution(`${hostSkipReason};catalog_unavailable`);
  }
  if (modelId === undefined) {
    return fallbackResolution(`${hostSkipReason};model_identity_absent`);
  }
  if (providerId !== undefined) {
    const exact = catalog.exact(providerId, modelId);
    if (exact === undefined) {
      return fallbackResolution(`${hostSkipReason};catalog_no_exact_match:${providerId}/${modelId}`);
    }
    if (!isValidContextWindowTokens(exact.contextWindowTokens)) {
      return fallbackResolution(`${hostSkipReason};catalog_metadata_invalid:${providerId}/${modelId}`);
    }
    return {
      budgetChars: promptBudgetCharsForContextWindow(exact.contextWindowTokens),
      capacitySource: 'pi_catalog_exact',
      capacityStatus: 'confirmed',
      contextWindowTokens: exact.contextWindowTokens,
      policyVersion: PROMPT_BUDGET_POLICY_VERSION,
    };
  }
  // No provider identity: only a UNANIMOUS catalog is usable. Same modelId
  // under multiple providers with different windows (real cases: gpt-5,
  // claude-sonnet-4-5 behind gateways) is an ambiguity, not a default.
  const matches = catalog.byModelId(modelId);
  if (matches.length === 0) {
    return fallbackResolution(`${hostSkipReason};catalog_no_match_for_model_id:${modelId}`);
  }
  const [first] = matches;
  if (first === undefined || !isValidContextWindowTokens(first.contextWindowTokens)) {
    return fallbackResolution(`${hostSkipReason};catalog_metadata_invalid:${modelId}`);
  }
  const unanimous = matches.every(
    (entry) => entry.contextWindowTokens === first.contextWindowTokens && isValidContextWindowTokens(entry.contextWindowTokens),
  );
  if (!unanimous) {
    return fallbackResolution(`${hostSkipReason};catalog_ambiguous_model_id:${modelId}`);
  }
  return {
    budgetChars: promptBudgetCharsForContextWindow(first.contextWindowTokens),
    capacitySource: 'pi_catalog_unambiguous',
    capacityStatus: 'confirmed',
    contextWindowTokens: first.contextWindowTokens,
    policyVersion: PROMPT_BUDGET_POLICY_VERSION,
  };
}

/**
 * THE single budget resolver (SPEC §4.3). Deterministic pure function:
 * same facts in, same resolution out, one result per request reused by the
 * selector, serializer, projection and precheck (SPEC §6.1).
 */
export function resolvePromptBudget(input?: ResolvePromptBudgetInput): PromptBudgetResolution {
  const hostCapacity = input?.hostCapacity;
  if (hostCapacity !== undefined) {
    const source = nonEmptyString(hostCapacity.contextWindowSource);
    const trustedSource = source !== undefined && TRUSTED_HOST_CONTEXT_WINDOW_SOURCES.has(source);
    if (!trustedSource) {
      // Fall through to catalog lookup below — but remember why.
      return resolveFromCatalog(input, `host_capacity_source_untrusted:${source ?? 'absent'}`);
    }
    if (!isValidContextWindowTokens(hostCapacity.contextTokenBudget)) {
      return resolveFromCatalog(input, 'host_capacity_invalid_value');
    }
    const windowTokens: number = hostCapacity.contextTokenBudget;
    return {
      budgetChars: promptBudgetCharsForContextWindow(windowTokens),
      capacitySource: 'host_effective_window',
      capacityStatus: 'confirmed',
      contextWindowTokens: windowTokens,
      policyVersion: PROMPT_BUDGET_POLICY_VERSION,
    };
  }
  return resolveFromCatalog(input, 'host_capacity_absent');
}
