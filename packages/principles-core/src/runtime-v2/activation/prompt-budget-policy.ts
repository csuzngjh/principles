/**
 * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 (v0.2): model-context-aware prompt
 * injection budget policy.
 *
 * Single authority for translating a model's effective context window
 * (tokens) into the Runtime V2 principle injection budget (UTF-16 code
 * units). Pure policy — no I/O, no host facts, no catalog import: the Pi AI
 * catalog arrives as an injectable seam so tests can pin the priority chain
 * without patching module state, and production callers share one catalog
 * binding (`getPromptModelCatalog` in adapter/pi-ai-catalog.ts).
 *
 * Priority chain (SPEC §4.3 v0.2, amended by
 * SPEC-PD-OPERATOR-DECLARED-PROMPT-BUDGET-001):
 *   0. operator_declared — the Owner's explicit per-workspace capacity
 *      declaration (`.pd/config.yaml` promptBudget, per-host override over a
 *      global value). An authored explicit cap — the same trust class as
 *      `agentContextTokens` — and the workspace's final authority;
 *   1. host_effective_window — the host hook's effective context-token
 *      budget when its source is model-specific or an explicit cap
 *      (model | modelsConfig | agentContextTokens; `default` and unknown
 *      sources are NOT trusted);
 *   2. pi_catalog_exact — the host DECLARED the provider id and the exact
 *      provider+modelId pair exists in the installed catalog;
 *   3. legacy_fallback — everything else (no trusted capacity), status
 *      unknown, with a bounded machine-readable fallback reason.
 *
 * v0.2 trust amendment: the former `pi_catalog_unambiguous` tier (same
 * modelId unanimous across providers, no provider identity) was REMOVED.
 * A name-only match — however unanimous — cannot prove the deployment is
 * not a custom endpoint/proxy with different limits, so it can never be
 * `confirmed` (SPEC §4.3 rule: only capacity bound to the RUNNING model or
 * its effective cap may be confirmed). Provider-less lookups fall back;
 * the ambiguity probe is kept purely for the diagnostic reason code.
 *
 * Measured floors (real production serializers, see the 2026-10-20 fix
 * round): the shared route's full directive render of one minimum viable
 * principle (86-char statement) costs 849 chars with the self-report flag
 * off and 1204 chars with it on — so a 500 or 1000 floor produces ZERO
 * injection on 32K-window models (the audited defect). 1250 is the first
 * round value above 1204 and is the verified usable floor for BOTH flag
 * states. The list route's single entry costs ~132 chars — far below.
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
/**
 * Dynamic budget floor — measured, not assumed: the shared route bills the
 * FULL directive render, whose fixed wrapper + one minimum viable principle
 * costs 849 chars (self-report off) / 1204 chars (self-report on). Anything
 * below 1225 re-creates the audited 32K zero-injection defect.
 */
export const PROMPT_BUDGET_MIN_CHARS = 1250;
/**
 * Dynamic budget hard ceiling (Owner target): a 1M-token window maps to
 * floor(2000 × 1_000_000 / 128_000) = 15625 — the cap is an upper bound,
 * not a value the formula must reach; windows ≥ 1.024M tokens hit 16000.
 */
export const PROMPT_BUDGET_MAX_CHARS = 16000;
/** Unknown/untrusted capacity: keep the historical budget (rollback target). */
export const PROMPT_BUDGET_FALLBACK_CHARS = RUNTIME_V2_PRINCIPLE_BUDGET;

/**
 * PRI-1065: the fixed background allowance the total-injection ceiling adds
 * on top of the principle budget. One model window pays for BOTH the
 * owner-approved directives and the background blocks (project context,
 * intent block, working memory, thinking_os, current focus), so the ceiling
 * must grow with the principle budget instead of pinning the total to a
 * constant — the former 9000 size guard left a 1M-window model only 9000-5145
 * chars for background and stripped every block in one turn.
 *
 * 7000 keeps the historical total of 9000 at the reference window
 * (2000 principle budget + 7000 = 9000), so existing 128K behavior is
 * byte-identical; a 1M window resolves to 15625 + 7000.
 */
const PROMPT_BACKGROUND_ALLOWANCE_CHARS = 7000;

/**
 * Total character ceiling for the assembled injection (prependSystemContext +
 * prependContext + appendSystemContext). Derives from the SAME principle
 * budget its directives were rendered under — one authority, no second
 * constant (PRI-1065). Pure: one number in, one number out.
 */
export function resolveTotalInjectionBudgetChars(principleBudgetChars: number): number {
  return principleBudgetChars + PROMPT_BACKGROUND_ALLOWANCE_CHARS;
}

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
  | 'operator_declared'
  | 'host_effective_window'
  | 'pi_catalog_exact'
  | 'legacy_fallback';

/**
 * Bounded machine-readable reason for the legacy fallback (SPEC §7 v0.2).
 * Closed set — events carry this code verbatim, never free-form detail;
 * `PromptBudgetResolution.fallbackDetail` holds the non-sensitive context
 * (provider/model ids) for logs only.
 */
export type PromptBudgetFallbackReason =
  | 'host_capacity_absent'
  | 'host_capacity_source_untrusted'
  | 'host_capacity_invalid_value'
  | 'catalog_unavailable'
  | 'model_identity_absent'
  | 'catalog_no_exact_match'
  | 'catalog_no_match_for_model_id'
  | 'catalog_ambiguous_model_id'
  | 'catalog_provider_absent'
  | 'catalog_metadata_invalid';

export type PromptBudgetCapacityStatus = 'confirmed' | 'unknown';

export interface PromptBudgetResolution {
  /** Effective injection budget in UTF-16 code units. */
  budgetChars: number;
  capacitySource: PromptBudgetCapacitySource;
  capacityStatus: PromptBudgetCapacityStatus;
  /** The context window the budget was derived from; null when unknown. */
  contextWindowTokens: number | null;
  policyVersion: typeof PROMPT_BUDGET_POLICY_VERSION;
  /** Present only on legacy_fallback — bounded reason code (closed set). */
  fallbackReason?: PromptBudgetFallbackReason;
  /** Non-sensitive context for logs (provider/model ids); never emitted to events. */
  fallbackDetail?: string;
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
 * can produce a precise diagnostic reason (ambiguous vs provider-absent).
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
  /**
   * Owner-declared workspace capacity (SPEC-PD-OPERATOR-DECLARED-PROMPT-BUDGET-001):
   * the promptBudget section of `.pd/config.yaml`, resolved by the caller to
   * the per-host value (`hosts[hostKind] ?? declaredContextWindowTokens`).
   * Untrusted here (rc-1) — validated with the same plausibility guard; an
   * invalid declaration is ignored and the chain falls through (the config
   * layer already hard-errors on it at load time).
   */
  operatorDeclared?: {
    contextWindowTokens?: unknown;
  };
  hostCapacity?: PromptBudgetHostCapacityFact;
  modelIdentity?: {
    providerId?: unknown;
    modelId?: unknown;
  };
  /** Absent catalog ⇒ priorities 1-2 cannot use metadata (pure-fallback callers). */
  catalog?: PromptModelCatalog;
}

interface FallbackInput {
  reason: PromptBudgetFallbackReason;
  detail: string;
}

function fallbackResolution(input: FallbackInput): PromptBudgetResolution {
  return {
    budgetChars: PROMPT_BUDGET_FALLBACK_CHARS,
    capacitySource: 'legacy_fallback',
    capacityStatus: 'unknown',
    contextWindowTokens: null,
    policyVersion: PROMPT_BUDGET_POLICY_VERSION,
    fallbackReason: input.reason,
    fallbackDetail: input.detail,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Catalog stage of the priority chain. Exact provider+modelId (the host
 * DECLARED the provider) may confirm; a provider-less same-name match may
 * not — see the v0.2 trust amendment in the module header.
 */
function resolveFromCatalog(input: ResolvePromptBudgetInput | undefined, hostStage: { skipReason: PromptBudgetFallbackReason | null; detail: string }): PromptBudgetResolution {
  const detailPrefix = hostStage.skipReason === null
    ? 'host_capacity_absent'
    : hostStage.skipReason;
  // Trust precedence: when the host stage already failed for a SPECIFIC
  // reason (untrusted source / invalid value), that reason is the primary
  // one to report — the catalog could not rescue the request.
  const primary = (reason: PromptBudgetFallbackReason, extra: string): PromptBudgetResolution =>
    fallbackResolution({
      reason: hostStage.skipReason ?? reason,
      detail: `${detailPrefix};${reason}:${extra}`,
    });

  const catalog = input?.catalog;
  const modelId = nonEmptyString(input?.modelIdentity?.modelId);
  const providerId = nonEmptyString(input?.modelIdentity?.providerId);
  if (catalog === undefined) {
    // With NO host facts and NO model identity there is literally nothing to
    // resolve from — the root cause is absence, not the missing catalog.
    if (hostStage.skipReason === null && modelId === undefined) {
      return fallbackResolution({ reason: 'host_capacity_absent', detail: 'host_capacity_absent;no-facts-at-all' });
    }
    return primary('catalog_unavailable', 'no-catalog-binding');
  }
  if (modelId === undefined) {
    // The host made no model claim either — root cause is absence of host
    // facts, not a catalog problem.
    if (hostStage.skipReason === null) {
      return fallbackResolution({ reason: 'host_capacity_absent', detail: 'host_capacity_absent;no-model-context' });
    }
    return primary('model_identity_absent', 'no-model-id');
  }
  if (providerId !== undefined) {
    const exact = catalog.exact(providerId, modelId);
    if (exact === undefined) {
      return primary('catalog_no_exact_match', `${providerId}/${modelId}`);
    }
    if (!isValidContextWindowTokens(exact.contextWindowTokens)) {
      return primary('catalog_metadata_invalid', `${providerId}/${modelId}`);
    }
    return {
      budgetChars: promptBudgetCharsForContextWindow(exact.contextWindowTokens),
      capacitySource: 'pi_catalog_exact',
      capacityStatus: 'confirmed',
      contextWindowTokens: exact.contextWindowTokens,
      policyVersion: PROMPT_BUDGET_POLICY_VERSION,
    };
  }
  // No provider identity: NEVER confirmed (v0.2). Diagnose why the name
  // alone cannot be used, then fall back honestly.
  const matches = catalog.byModelId(modelId);
  if (matches.length === 0) {
    return primary('catalog_no_match_for_model_id', modelId);
  }
  const [first] = matches;
  if (first === undefined || !isValidContextWindowTokens(first.contextWindowTokens)) {
    return primary('catalog_metadata_invalid', modelId);
  }
  const unanimous = matches.every(
    (entry) => entry.contextWindowTokens === first.contextWindowTokens && isValidContextWindowTokens(entry.contextWindowTokens),
  );
  if (!unanimous) {
    return primary('catalog_ambiguous_model_id', modelId);
  }
  // Unanimous on paper, still unproven for THIS deployment (custom
  // endpoint/proxy risk) — the name is not evidence of the running limit.
  return primary('catalog_provider_absent', modelId);
}

/**
 * THE single budget resolver (SPEC §4.3, amended by
 * SPEC-PD-OPERATOR-DECLARED-PROMPT-BUDGET-001). Deterministic pure function:
 * same facts in, same resolution out, one result per request reused by the
 * selector, serializer, projection and precheck (SPEC §6.1).
 */
export function resolvePromptBudget(input?: ResolvePromptBudgetInput): PromptBudgetResolution {
  // Tier 0 — the Owner's explicit declaration is the workspace's final
  // capacity authority (an authored explicit cap, the same trust class as
  // agentContextTokens). Invalid values are ignored defensively — the config
  // layer hard-errors on them at load time, so reaching here with an invalid
  // value means a direct API caller bypassed config validation; the chain
  // then behaves exactly as if nothing was declared.
  const declaredWindow = input?.operatorDeclared?.contextWindowTokens;
  if (declaredWindow !== undefined && isValidContextWindowTokens(declaredWindow)) {
    return {
      budgetChars: promptBudgetCharsForContextWindow(declaredWindow),
      capacitySource: 'operator_declared',
      capacityStatus: 'confirmed',
      contextWindowTokens: declaredWindow,
      policyVersion: PROMPT_BUDGET_POLICY_VERSION,
    };
  }
  const hostCapacity = input?.hostCapacity;
  if (hostCapacity !== undefined) {
    const hasBudget = hostCapacity.contextTokenBudget !== undefined;
    const hasSource = hostCapacity.contextWindowSource !== undefined;
    if (!hasBudget && !hasSource) {
      // The host carried model identity but made NO capacity claim at all
      // (e.g. modelContext = { modelId }) — that is absence, not untrust.
      return resolveFromCatalog(input, { skipReason: null, detail: 'host_capacity_absent' });
    }
    const source = nonEmptyString(hostCapacity.contextWindowSource);
    const trustedSource = source !== undefined && TRUSTED_HOST_CONTEXT_WINDOW_SOURCES.has(source);
    if (!trustedSource) {
      // Fall through to catalog lookup below — but remember why.
      return resolveFromCatalog(input, {
        skipReason: 'host_capacity_source_untrusted',
        detail: `host_capacity_source_untrusted:${source ?? 'absent'}`,
      });
    }
    if (!isValidContextWindowTokens(hostCapacity.contextTokenBudget)) {
      return resolveFromCatalog(input, {
        skipReason: 'host_capacity_invalid_value',
        detail: 'host_capacity_invalid_value',
      });
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
  return resolveFromCatalog(input, { skipReason: null, detail: 'host_capacity_absent' });
}
