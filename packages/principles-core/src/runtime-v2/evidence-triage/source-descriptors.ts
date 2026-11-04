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
 *
 * Phase A: descriptor decisions are final. Technical failures and RuleHost
 * blocks never upgrade to an admitted Pain (no context flags, no escalation).
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
}

// ── Descriptor Registry ─────────────────────────────────────────────────────

/**
 * Source kind descriptors. Order does not matter — lookup is by kind.
 *
 * Design rationale per docs/product/PRODUCT_IDENTITY.md and ADR-0014:
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
  }],
  ['agent_on_owner_request', {
    kind: 'agent_on_owner_request',
    defaultDecision: 'admit',
    reason: 'Agent recorded pain at owner request. Owner intent preserved.',
    nextAction: 'none',
  }],
  ['tool_failure', {
    kind: 'tool_failure',
    defaultDecision: 'evidence_only',
    reason: 'Tool failure is a technical trajectory fact, never a behavioral-deviation Pain by itself (Phase A).',
    nextAction: 'store_as_evidence_for_later_correlation',
  }],
  ['dispatch_error', {
    kind: 'dispatch_error',
    defaultDecision: 'evidence_only',
    reason: 'Dispatch/subagent routing error. Not a behavior pattern.',
    nextAction: 'store_as_evidence_for_later_correlation',
  }],
  ['provider_failure', {
    kind: 'provider_failure',
    defaultDecision: 'health_only',
    reason: 'LLM provider failure. Infrastructure health signal, not owner-relevant behavior.',
    nextAction: 'record_in_health_telemetry',
  }],
  ['rate_limit', {
    kind: 'rate_limit',
    defaultDecision: 'health_only',
    reason: 'LLM provider rate limit. Infrastructure health signal, not owner-relevant behavior.',
    nextAction: 'record_in_health_telemetry',
  }],
  ['rulehost_block', {
    kind: 'rulehost_block',
    defaultDecision: 'evidence_only',
    reason: 'RuleHost block is a technical block fact. Correct blocks are not Owner pain; wrong blocks reach correction detection (Phase A).',
    nextAction: 'store_as_evidence_for_later_correlation',
  }],
  ['empathy_inferred', {
    kind: 'empathy_inferred',
    defaultDecision: 'owner_confirm',
    reason: 'Empathy-inferred frustration. Never silently creates diagnosis (PRODUCT_IDENTITY: owner-governed).',
    nextAction: 'request_owner_confirmation_before_diagnosis',
  }],
  ['semantic', {
    kind: 'semantic',
    defaultDecision: 'evidence_only',
    reason: 'Keyword/detection match. Not explicit owner pain. Needs accumulation.',
    nextAction: 'store_as_evidence_for_later_correlation',
  }],
  ['llm_paralysis', {
    kind: 'llm_paralysis',
    defaultDecision: 'evidence_only',
    reason: 'Session health signal. GFI alone cannot create diagnosis.',
    nextAction: 'store_as_evidence_for_later_correlation',
  }],
  ['subagent_error', {
    kind: 'subagent_error',
    defaultDecision: 'evidence_only',
    reason: 'Subagent workflow failure. Not a behavior pattern by itself.',
    nextAction: 'store_as_evidence_for_later_correlation',
  }],
  ['unknown', {
    kind: 'unknown',
    defaultDecision: 'evidence_only',
    reason: 'Unclassified source. Conservative default.',
    nextAction: 'classify_source_kind_and_store_as_evidence',
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
