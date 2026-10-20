/**
 * Shared wire-shape contract for the prompt-injection budget forecast on
 * `/api/v1/approvals/grouped` (PRI-908).
 *
 * Single source of truth for the field shape within pd-console: the server
 * model (server/models/ApprovalsGroupedConsoleModel.ts) emits it and the UI
 * validator (ui/utils/validators.ts) parses it. Import this type from both
 * sides — do not redefine the fields locally, or server and UI drift.
 *
 * Type-only module: emits no runtime code, so the browser bundle never
 * pulls server dependencies through it (precedent: shared/feedback-contract.ts).
 * If fields are ever extended and validation rules added, follow the
 * feedback-contract pilot (TypeBox schema + schema-vs-validator equivalence test).
 */
export type PromptInjectionTargetHostName = 'openclaw' | 'codex' | 'workbuddy';
export type PromptInjectionRouteName = 'legacy_trim' | 'shared_render';
export type PromptInjectionBudgetScopeName = 'selected_lines' | 'full_directive_context';

export interface PromptInjectionPerHostForecast {
  hostKind: PromptInjectionTargetHostName;
  route: PromptInjectionRouteName;
  usedChars: number;
  truncated: boolean;
}

/**
 * PD_PROMPT_CAPACITY_V1 R-A3: per-live-prompt-activation injection status on
 * the activations surface. Every value carries positive single-item evidence
 * (the row's own serialized entry measured with the production serializer for
 * the bound route) — never an inference from a bounded diagnostic list.
 */
export interface PromptActivationInjectionStatusWire {
  activationId: string;
  /**
   * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: `model_dependent` = the row's own
   * entry misses the CURRENT projection budget but fits within the supported
   * [min, max] budget range — injectability depends on the runtime model's
   * context window, which this surface cannot see (never displayed as a
   * definite yes or a permanent no).
   */
  status: 'injectable' | 'oversized' | 'model_dependent' | 'window_excluded' | 'resolution_failed' | 'route_unconfirmed';
  inCurrentWindow?: boolean;
  costChars?: number;
  budget?: number;
  budgetScope?: PromptInjectionBudgetScopeName;
  route?: PromptInjectionRouteName;
  reason?: string;
  perHostFits?: { hostKind: PromptInjectionTargetHostName; tierFit: PromptBudgetTierFitName }[];
}

/** Tier classification of a single serialized entry vs the supported budget range. */
export type PromptBudgetTierFitName = 'fits_all_tiers' | 'model_dependent' | 'exceeds_max_tier';

/** Route context attached to the activations payload (AC-01 visibility). */
export interface PromptInjectionRouteSummaryWire {
  status: 'confirmed' | 'unconfirmed';
  hostKind?: PromptInjectionTargetHostName;
  route?: PromptInjectionRouteName;
  flagEnabled: boolean;
  unconfirmedReason?: string;
  nextAction?: string;
  /** Present when no status could be computed at all (fail-loud degradation). */
  globalReason?: string;
}

export interface PromptInjectionBudgetStatus {
  /** Hard char cap of the prompt injection surface (e.g. 2000). */
  budget: number;
  /** Chars currently injected into the agent prompt. */
  usedChars: number;
  /**
   * True when the CURRENT projection already truncated — the newly approved
   * principle may not enter the prompt on this turn. PR-1894: this is
   * policy-dependent (see `selectionPolicy`); the badge copy must not imply
   * permanent starvation when rotation is in play.
   */
  truncated: boolean;
  /**
   * PR-1894: whether the PRODUCTION route rotates. This — not the forecast's
   * own selection policy — decides whether an out-of-window approval is queued
   * behind rotation or genuinely starved, and therefore which badge copy is
   * truthful. Optional so a pre-PR-1894 payload still validates; absent
   * behaves as `false` (the conservative pre-PR-1894 reading).
   */
  productionRotates?: boolean;
  /** PR-1894: eligible activations that reached the selector. */
  eligibleCount?: number;
  /**
   * PD_PROMPT_CAPACITY_V1 R-A1: 'unconfirmed' when the applicable hosts would
   * take different routes and no request-level target host was supplied — the
   * numbers above are then the flag-based view and MUST be presented as
   * "容量未确认" with per-host forecasts, never as a single authoritative
   * forecast. Absent behaves as 'confirmed' (pre-SPEC payload compat).
   */
  capacityStatus?: 'confirmed' | 'unconfirmed';
  /** Present when capacityStatus === 'confirmed' and a single host is bound. */
  hostKind?: PromptInjectionTargetHostName;
  /** Which real injection route produced these numbers (confirmed only). */
  route?: PromptInjectionRouteName;
  /** R-A2: the unit budget/usedChars are counted in. */
  unit?: 'utf16_code_units';
  /** R-A2: which serialization the budget is charged against on this route. */
  budgetScope?: PromptInjectionBudgetScopeName;
  /**
   * R-A2 (list route only): length of the FULL directive render of the
   * injected set — the whole PD output block, NOT the host request, NOT
   * tokens.
   */
  fullRenderChars?: number;
  /** R-A3: bounded diagnostic list; absence from it is NOT evidence of fitting. */
  oversizedActivationIds?: string[];
  oversizedDiagnosticTruncated?: boolean;
  /** Present when capacityStatus === 'unconfirmed'. */
  unconfirmedReason?: string;
  /** Present when capacityStatus === 'unconfirmed'. */
  nextAction?: string;
  /** Present when capacityStatus === 'unconfirmed': per-host forecasts. */
  perHost?: PromptInjectionPerHostForecast[];
  /**
   * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §7: provenance of `budget` — the
   * same resolution the real injection runs. `legacy_fallback` + `unknown`
   * means these numbers are the fixed-budget view (no runtime model capacity
   * was confirmed); the UI must present them as such, not as a
   * model-accurate forecast. Absent behaves as the legacy fixed view
   * (pre-SPEC payload compat).
   */
  budgetCapacitySource?: 'host_effective_window' | 'pi_catalog_exact' | 'legacy_fallback';
  /** confirmed = a real context window was resolved; unknown = fixed-budget fallback. */
  budgetCapacityStatus?: 'confirmed' | 'unknown';
  /** The context window the budget was derived from; present only when confirmed. */
  budgetContextWindowTokens?: number;
  /**
   * SPEC §7 v0.2: bounded machine-readable reason — present only when
   * budgetCapacityStatus is 'unknown'. Closed set mirroring the core
   * `PromptBudgetFallbackReason`; never free-form detail or user content.
   */
  budgetFallbackReason?:
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
}
