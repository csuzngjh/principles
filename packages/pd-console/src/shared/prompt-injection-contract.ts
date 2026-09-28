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
export interface PromptInjectionBudgetStatus {
  /** Hard char cap of the prompt injection surface (e.g. 2000). */
  budget: number;
  /** Chars currently injected into the agent prompt. */
  usedChars: number;
  /**
   * True when the CURRENT projection already truncated — the newly approved
   * principle may not enter the prompt on this turn. PRI-935: this is
   * policy-dependent (see `selectionPolicy`); the badge copy must not imply
   * permanent starvation when rotation is in play.
   */
  truncated: boolean;
  /**
   * PRI-935: whether the PRODUCTION route rotates. This — not the forecast's
   * own selection policy — decides whether an out-of-window approval is queued
   * behind rotation or genuinely starved, and therefore which badge copy is
   * truthful. Optional so a pre-PRI-935 payload still validates; absent
   * behaves as `false` (the conservative pre-PRI-935 reading).
   */
  productionRotates?: boolean;
  /** PRI-935: eligible activations that reached the selector. */
  eligibleCount?: number;
}
