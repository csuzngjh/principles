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
export type PromptInjectionTargetHostName = 'openclaw' | 'codex';
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
  status: 'injectable' | 'oversized' | 'window_excluded' | 'resolution_failed' | 'route_unconfirmed';
  inCurrentWindow?: boolean;
  costChars?: number;
  budget?: number;
  budgetScope?: PromptInjectionBudgetScopeName;
  route?: PromptInjectionRouteName;
  reason?: string;
  perHostFits?: { hostKind: PromptInjectionTargetHostName; fits: boolean }[];
}

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
}
