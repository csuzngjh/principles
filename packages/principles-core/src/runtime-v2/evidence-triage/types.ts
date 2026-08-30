/**
 * Evidence Triage Types — PEAT-B1
 *
 * Pure types for pre-diagnosis evidence triage.
 * No I/O, no plugin imports, no side effects.
 *
 * These types classify incoming pain evidence by source kind and
 * determine the default triage decision before the diagnostician runs.
 *
 * ERR checklist:
 * - ERR-001: No `as` casts. Source kind validated with runtime guards.
 * - ERR-002: Every TriageResult carries structured reason + nextAction.
 * - ERR-005: Input is unknown, validated field-by-field.
 */

// ── Source Kind ─────────────────────────────────────────────────────────────

/**
 * Source kinds for pre-diagnosis evidence triage.
 *
 * Each kind maps to a default admission policy.
 * The plugin adapter is responsible for mapping raw hook context to these kinds.
 */
export type SourceKind =
  | 'owner_reported'           // /pd-pain command, manual CLI entry
  | 'agent_on_owner_request'   // pain tool called by agent at owner's request
  | 'tool_failure'             // after_tool_call: tool returned error or non-zero exit
  | 'dispatch_error'           // after_tool_call: tool not found, unknown tool
  | 'provider_failure'         // LLM provider error (timeout, 5xx, etc.)
  | 'rate_limit'               // LLM provider rate limit (429)
  | 'rulehost_block'           // RuleHost principle blocked a tool call
  | 'empathy_inferred'         // LLM output contained empathy/damage signal
  | 'semantic'                 // Keyword or detection service matched
  | 'llm_paralysis'            // Agent stuck in low-output loops
  | 'subagent_error'           // Subagent workflow failure
  | 'gfi_threshold'            // Accumulated GFI crossed threshold
  | 'unknown';                 // Unclassified source

// ── Triage Decision ─────────────────────────────────────────────────────────

/**
 * Possible triage decisions for incoming evidence.
 *
 * These are distinct from post-diagnosis admission decisions
 * (admitted / needs_evidence / deferred) in admission-gate.ts.
 */
export type TriageDecision =
  | 'admit'          // Allow to proceed to diagnostician
  | 'evidence_only'  // Store as evidence, do not trigger diagnosis
  | 'owner_confirm'  // Requires owner confirmation before diagnosis
  | 'health_only'    // Health/infra signal, store in health telemetry only
  | 'reject';        // Drop entirely (unused in B1, reserved for future)

// ── Triage Result ───────────────────────────────────────────────────────────

/**
 * Structured result from evidence triage evaluation.
 *
 * Every decision MUST carry reason and nextAction (ERR-002).
 */
export interface TriageResult {
  /** Whether this evidence should proceed to diagnosis */
  readonly decision: TriageDecision;
  /** The source kind that was evaluated */
  readonly sourceKind: SourceKind;
  /** Human-readable reason for the decision */
  readonly reason: string;
  /** What should happen next */
  readonly nextAction: string;
}

// ── Triage Input ────────────────────────────────────────────────────────────

/**
 * Input to the triage policy evaluation.
 *
 * The plugin adapter is responsible for constructing this from hook context.
 * All fields are required to avoid silent defaults (ERR-002).
 */
export interface TriageInput {
  /** Classified source kind */
  readonly sourceKind: SourceKind;
  /** Pain score (0-100) */
  readonly score: number;
  /** Whether the action is high-confidence unsafe (for rulehost_block) */
  readonly isUnsafeHighConfidence?: boolean;
  /** Provenance: how was this pain observed? */
  readonly provenance?: 'host_context_bound' | 'owner_reported_no_host_trace' | 'automatic_hook';
  /**
   * Whether the failed action was risky/irreversible.
   *
   * Migrated from the plugin triage-adapter (PRI-446): a risky action with
   * a high pain score upgrades an evidence_only decision to admit.
   */
  readonly isRisky?: boolean;
  /**
   * Number of consecutive failures observed for the current session/tool.
   *
   * Migrated from the plugin triage-adapter (PRI-446): repeated failures
   * (>= RISKY_HIGH_SCORE_THRESHOLD) upgrade an evidence_only decision to admit.
   */
  readonly consecutiveErrors?: number;
}

// ── Source Kind Validation ───────────────────────────────────────────────────

const VALID_SOURCE_KINDS: ReadonlySet<string> = new Set<SourceKind>([
  'owner_reported',
  'agent_on_owner_request',
  'tool_failure',
  'dispatch_error',
  'provider_failure',
  'rate_limit',
  'rulehost_block',
  'empathy_inferred',
  'semantic',
  'llm_paralysis',
  'subagent_error',
  'gfi_threshold',
  'unknown',
]);

/**
 * Runtime guard for SourceKind.
 * ERR-001: no `as` cast, validated with Set membership.
 */
export function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === 'string' && VALID_SOURCE_KINDS.has(value);
}
