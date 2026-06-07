/**
 * Source Descriptors — PEAT-B1
 *
 * Declarative policy mapping from SourceKind to default TriageDecision.
 * This is pure data — no I/O, no plugin imports.
 *
 * Each descriptor defines:
 * - kind: the SourceKind it describes
 * - defaultDecision: the default triage decision
 * - reason: why this default was chosen
 * - nextAction: what should happen when this decision is applied
 * - canUpgrade: whether the plugin adapter may upgrade the decision
 *   (e.g., rulehost_block can be upgraded to 'admit' for unsafe actions)
 *
 * ERR checklist:
 * - ERR-002: Every descriptor carries reason + nextAction.
 * - ERR-005: Descriptors are data, not assumptions about callers.
 */

import type { SourceKind, TriageDecision } from './types.js';

// ── Descriptor Type ─────────────────────────────────────────────────────────

export interface SourceDescriptor {
  readonly kind: SourceKind;
  readonly defaultDecision: TriageDecision;
  readonly reason: string;
  readonly nextAction: string;
  /**
   * Whether the plugin adapter may upgrade this decision.
   * When true, the adapter can override defaultDecision based on context
   * (e.g., isUnsafeHighConfidence for rulehost_block).
   */
  readonly canUpgrade: boolean;
}

// ── Descriptor Registry ─────────────────────────────────────────────────────

/**
 * Source kind descriptors. Order does not matter — lookup is by kind.
 *
 * Design rationale per PRODUCT_IDENTITY.md and ADR-0014:
 * - PD owns owner-relevant behavior evidence, not tool repair.
 * - Manual/owner-reported pain has highest confidence.
 * - Tool failures are infrastructure noise (OpenClaw's job, not PD's).
 * - Empathy-inferred frustration must never silently create diagnosis.
 * - GFI alone cannot trigger diagnosis (it's a session health metric).
 */
export const SOURCE_DESCRIPTORS: ReadonlyMap<SourceKind, SourceDescriptor> = new Map<SourceKind, SourceDescriptor>([
  ['owner_reported', {
    kind: 'owner_reported',
    defaultDecision: 'admit',
    reason: 'Owner explicitly reported pain. Highest confidence signal.',
    nextAction: 'none',
    canUpgrade: false,
  }],
  ['agent_on_owner_request', {
    kind: 'agent_on_owner_request',
    defaultDecision: 'admit',
    reason: 'Agent recorded pain at owner request. Owner intent preserved.',
    nextAction: 'none',
    canUpgrade: false,
  }],
  ['tool_failure', {
    kind: 'tool_failure',
    defaultDecision: 'evidence_only',
    reason: 'Tool failure is infrastructure noise. PD does not own tool repair (ADR-0014).',
    nextAction: 'store_as_evidence_for_later_correlation',
    canUpgrade: false,
  }],
  ['dispatch_error', {
    kind: 'dispatch_error',
    defaultDecision: 'evidence_only',
    reason: 'Dispatch/subagent routing error. Not a behavior pattern.',
    nextAction: 'store_as_evidence_for_later_correlation',
    canUpgrade: false,
  }],
  ['provider_failure', {
    kind: 'provider_failure',
    defaultDecision: 'health_only',
    reason: 'LLM provider failure. Infrastructure health signal, not owner-relevant behavior.',
    nextAction: 'record_in_health_telemetry',
    canUpgrade: false,
  }],
  ['rate_limit', {
    kind: 'rate_limit',
    defaultDecision: 'health_only',
    reason: 'LLM provider rate limit. Infrastructure health signal, not owner-relevant behavior.',
    nextAction: 'record_in_health_telemetry',
    canUpgrade: false,
  }],
  ['rulehost_block', {
    kind: 'rulehost_block',
    defaultDecision: 'evidence_only',
    reason: 'RuleHost block is near-miss evidence. Default evidence-only.',
    nextAction: 'store_as_evidence_for_later_correlation',
    canUpgrade: true, // adapter can upgrade to 'admit' for high-confidence unsafe actions
  }],
  ['empathy_inferred', {
    kind: 'empathy_inferred',
    defaultDecision: 'owner_confirm',
    reason: 'Empathy-inferred frustration. Never silently creates diagnosis (PRODUCT_IDENTITY: owner-governed).',
    nextAction: 'request_owner_confirmation_before_diagnosis',
    canUpgrade: false,
  }],
  ['semantic', {
    kind: 'semantic',
    defaultDecision: 'evidence_only',
    reason: 'Keyword/detection match. Not explicit owner pain. Needs accumulation.',
    nextAction: 'store_as_evidence_for_later_correlation',
    canUpgrade: false,
  }],
  ['llm_paralysis', {
    kind: 'llm_paralysis',
    defaultDecision: 'evidence_only',
    reason: 'Session health signal. GFI alone cannot create diagnosis.',
    nextAction: 'store_as_evidence_for_later_correlation',
    canUpgrade: false,
  }],
  ['subagent_error', {
    kind: 'subagent_error',
    defaultDecision: 'evidence_only',
    reason: 'Subagent workflow failure. Not a behavior pattern by itself.',
    nextAction: 'store_as_evidence_for_later_correlation',
    canUpgrade: false,
  }],
  ['gfi_threshold', {
    kind: 'gfi_threshold',
    defaultDecision: 'evidence_only',
    reason: 'Accumulated GFI. GFI alone cannot create diagnosis per acceptance criteria.',
    nextAction: 'store_as_evidence_for_later_correlation',
    canUpgrade: false,
  }],
  ['unknown', {
    kind: 'unknown',
    defaultDecision: 'evidence_only',
    reason: 'Unclassified source. Conservative default.',
    nextAction: 'classify_source_kind_and_store_as_evidence',
    canUpgrade: false,
  }],
]);

// ── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Get the source descriptor for a given kind.
 * Returns undefined if the kind is not registered (caller should treat as 'unknown').
 */
export function getSourceDescriptor(kind: SourceKind): SourceDescriptor | undefined {
  return SOURCE_DESCRIPTORS.get(kind);
}
