/**
 * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 (v0.3): model-context-aware prompt
 * injection budget policy.
 *
 * Single authority for translating a model's effective context window
 * (tokens) into the Runtime principle injection budget (UTF-16 code
 * units). Pure policy — no I/O, no host facts, no catalog import: the Pi AI
 * catalog arrives as an injectable seam so tests can pin the priority chain
 * without patching module state, and production callers share one catalog
 * binding (`getPromptModelCatalog` in adapter/pi-ai-catalog.ts).
 *
 * Priority chain (SPEC §4.3 v0.3, amended by
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
 *   3. pi_catalog_model_id — the host declared ONLY a model id, and every
 *      installed catalog entry for that id reports the SAME context window,
 *      so there is exactly one catalogue answer to infer from;
 *   4. legacy_fallback — everything else (no trusted capacity), status
 *      unknown, with a bounded machine-readable fallback reason.
 *
 * v0.3 amendment (PRI-1066, Owner directive "能推算就推算"): the v0.2
 * removal of name-only matching left every provider-less host (Codex,
 * WorkBuddy) on the fixed fallback even when the installed catalog had one
 * unambiguous answer (e.g. `glm-4.7`: one provider, 204800 tokens;
 * `deepseek-v4.1-flash`: five providers, all 1000000 tokens). The Owner's
 * requirement is that a derivable window is USED, not discarded. Tier 3
 * therefore derives from a unanimous name-only match. It is a weaker tier
 * than `pi_catalog_exact` (it cannot prove the deployment is not a proxy
 * with different limits), so it carries its own source label, and the
 * Owner's tier-0 declaration remains the override for an unusual deployment.
 * Names whose catalog entries DISAGREE still fall back with
 * `catalog_ambiguous_model_id` — never pick a provider by guess.
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
import { RUNTIME_PRINCIPLE_BUDGET } from './prompt-activation-reader-contract.js';

/**
 * The policy provenance id every current writer stamps into injection events
 * (`budgetPolicyVersion`). PRI-1139 (PR-6) renamed the id from the generational
 * `model_aware_v2` to the version-neutral `model_aware` — the FORMULA is
 * unchanged. Historical `model_aware_v2` events stay readable through the
 * observation whitelist (prompt-injection-budget-observation.ts), which also
 * keeps `model_aware` events readable if this cutover is ever reverted.
 */
export const PROMPT_BUDGET_POLICY_VERSION = 'model_aware' as const;

/**
 * Baseline budget at the reference context window (SPEC §4.1).
 *
 * v2 recalibration (PRI-1066, 2026-11-03): the Owner reported that activating
 * a handful of principles already filled the budget on every host. The v1
 * baseline was a conservative opening value, never a measured optimum; at
 * 2000 chars a 128K window fitted ~15 list entries or ~2 shared-route
 * directives. Doubling the baseline makes the same window fit twice as many
 * while staying a tiny fraction of the model's window (~1% of 128K tokens
 * for Chinese text). 128K remains the policy anchor: it is the smallest
 * common production window, and moving it down would SHRINK budgets on
 * 128K models.
 */
export const PROMPT_BUDGET_BASE_CHARS = 4000;
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
 * Dynamic budget hard ceiling — a POLICY ANCHOR (an upper bound for output
 * sanity), not a value the formula must reach: a 1M-token window maps to
 * floor(4000 × 1_000_000 / 128_000) = 31250; windows ≥ 1.024M tokens hit
 * 32000 (still ~3% of a 1M window, and the total ceiling stays below ~4%).
 * It exists so no malformed/huge window can ask the prompt builder for an
 * unbounded render; raising it is a deliberate policy change.
 */
export const PROMPT_BUDGET_MAX_CHARS = 32000;
/**
 * Unknown/untrusted capacity: the policy baseline, NOT a second hard-coded
 * value. This is a deliberate fallback anchor (see SPEC §4.1 / §7): hosts
 * that expose no capacity fact still get the reference-window budget, and
 * every such injection carries `legacy_fallback` + a reason code so the
 * Owner can see WHY it was used. It tracks BASE so the two can never drift.
 */
export const PROMPT_BUDGET_FALLBACK_CHARS = RUNTIME_PRINCIPLE_BUDGET;

/**
 * PRI-1065: the fixed background allowance the total-injection ceiling adds
 * on top of the principle budget. One model window pays for BOTH the
 * owner-approved directives and the background blocks (project context,
 * intent block, working memory, thinking_os, current focus), so the ceiling
 * must grow with the principle budget instead of pinning the total to a
 * constant — the former 9000 size guard left a 1M-window model only 9000-5145
 * chars for background and stripped every block in one turn.
 *
 * 7000 is kept from PRI-1065 (it was sized so the reference window's total
 * stayed at the historical 9000 when the baseline was 2000). With the v2
 * baseline of 4000 the reference total is 11000 and a 1M window resolves to
 * 31250 + 7000 = 38250 — the allowance protects the same background blocks
 * without pinning the total.
 */
const PROMPT_BACKGROUND_ALLOWANCE_CHARS = 7000;

/**
 * Total injection ceiling when the host capacity is unknown. Derived, not a
 * second hard-coded number: the prompt-builder size guard falls back to this
 * when a caller does not resolve a model-aware total (PRI-1066).
 */
export const PROMPT_TOTAL_INJECTION_FALLBACK_CHARS =
  PROMPT_BUDGET_FALLBACK_CHARS + PROMPT_BACKGROUND_ALLOWANCE_CHARS;

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
  | 'pi_catalog_model_id'
  | 'legacy_fallback';

/**
 * Bounded machine-readable reason for the legacy fallback (SPEC §7 v0.3).
 * Closed set — events carry this code verbatim, never free-form detail;
 * `PromptBudgetResolution.fallbackDetail` holds the non-sensitive context
 * (provider/model ids) for logs only.
 *
 * `catalog_provider_absent` is retained for reading v0.2-era events: v0.3
 * derives from a unanimous name-only match instead of emitting it, but old
 * records keep their code and must stay readable.
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
 * DECLARED the provider) confirms directly; a provider-less same-name match
 * confirms only when every catalog entry agrees on the window — see the
 * v0.3 amendment in the module header.
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
  // No provider identity (v0.3): a name-only match may be used ONLY when the
  // installed catalog gives exactly one answer for the window. Disagreeing
  // entries stay ambiguous — never pick a provider by guess.
  const matches = catalog.byModelId(modelId);
  if (matches.length === 0) {
    return primary('catalog_no_match_for_model_id', modelId);
  }
  const [first] = matches;
  // Any invalid context window is a metadata defect regardless of ENTRY ORDER:
  // "[valid, invalid]" must not be reported as `catalog_ambiguous_model_id`
  // while "[invalid, valid]" reports `catalog_metadata_invalid` (rc-3 — never
  // let a malformed fact survive as a weaker verdict just because a good
  // entry happened to come first).
  if (first === undefined || !matches.every((entry) => isValidContextWindowTokens(entry.contextWindowTokens))) {
    return primary('catalog_metadata_invalid', modelId);
  }
  const unanimous = matches.every((entry) => entry.contextWindowTokens === first.contextWindowTokens);
  if (!unanimous) {
    return primary('catalog_ambiguous_model_id', modelId);
  }
  // One catalog answer, but a weaker tier than `pi_catalog_exact`: the id is
  // bound to the running model, while the provider (and any proxy rewrite)
  // is not. The source label records the weaker basis; tier-0 declaration
  // remains the Owner's override for an unusual deployment.
  return {
    budgetChars: promptBudgetCharsForContextWindow(first.contextWindowTokens),
    capacitySource: 'pi_catalog_model_id',
    capacityStatus: 'confirmed',
    contextWindowTokens: first.contextWindowTokens,
    policyVersion: PROMPT_BUDGET_POLICY_VERSION,
  };
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
