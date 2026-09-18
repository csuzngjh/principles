/**
 * TelemetryEvent schema for the Evolution SDK.
 *
 * TypeBox schema describing the shape of in-process evolution events.
 * The union below is the SINGLE registration authority for every event name
 * that flows through StoreEventEmitter: an unregistered name is silently
 * rewritten to `degradation_triggered` (ERR-060). scripts/check-telemetry-events.cjs
 * (verify:merge --strict since PRI-773) keeps this union two-way in sync with
 * the real emit sites — add a Type.Literal here in the same PR that adds the
 * emit call.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

// ---------------------------------------------------------------------------
// Event Type Union
// ---------------------------------------------------------------------------

/**
 * Telemetry event types (361 registered names after the PRI-773 catch-up —
 * see the family comments inside the union for per-family provenance).
 *
 * Historical note: the original D-07/D-08 design covered only 3 core events
 * (pain_detected / principle_candidate_created / principle_promoted) plus a
 * diagnostician_* monolith family; those were pruned in PRI-773 after their
 * emit sites disappeared (the live surface is the per-runner prefixed
 * families registered below).
 *
 * M2 state transition events (task/run lifecycle):
 * - lease_acquired, lease_released, lease_renewed, lease_expired
 * - task_retried, task_failed, task_succeeded
 * - run_completed
 *
 * M3 degradation events:
 * - degradation_triggered — graceful degradation fallback activated
 *
 * M6 runtime adapter events:
 * - runtime_adapter_selected — runtime adapter selected for invocation (pd diagnose TELE-01)
 * - runtime_invocation_started — runtime invocation started
 * - runtime_invocation_succeeded — runtime invocation succeeded
 * - runtime_invocation_failed — runtime invocation failed
 * - output_repair_attempted — PRI-71 schema repair attempted (bounded by maxRepairAttempts)
 * - output_extraction_failed — JSON extraction from LLM response failed (no parseable JSON found)
 * - output_schema_invalid — PRI-200 schema validation failed (before repair)
 * - output_repair_exhausted — PRI-200 repair loop exhausted, output still invalid
 * - output_path_chosen / output_path_fallback — PRI-271 weak-model output path
 */
export const TelemetryEventType = Type.Union([
  // M2: Task/Run state transition events
  Type.Literal('lease_acquired'),
  Type.Literal('lease_released'),
  Type.Literal('lease_renewed'),
  Type.Literal('lease_expired'),
  Type.Literal('task_retried'),
  Type.Literal('task_failed'),
  Type.Literal('task_succeeded'),
  Type.Literal('run_completed'),
// M3: Degradation events
  Type.Literal('degradation_triggered'),
  // M4: Diagnostician runner events — the monolithic diagnostician_* family
  // was pruned in PRI-773 (zero emit sites since the PRI-625 split pipeline;
  // the live surface is the prefixed diag_router_/diag_distiller_/diag_rootcause_
  // families registered in the PRI-773 catch-up block below).
  Type.Literal('diag_router_invariant_override'),
  // (PRI-371 core-grounding and M5 artifact-commit events were pruned in
  // PRI-773 together with the diagnostician_* monolith family above.)
  // M6: Runtime adapter events
  Type.Literal('runtime_adapter_selected'),
  Type.Literal('runtime_invocation_started'),
  Type.Literal('runtime_invocation_succeeded'),
  Type.Literal('runtime_invocation_failed'),
  Type.Literal('output_repair_attempted'),
  Type.Literal('output_extraction_failed'),
  Type.Literal('output_schema_invalid'),
  Type.Literal('output_repair_exhausted'),
  // PRI-271: Weak-model output path events
  Type.Literal('output_path_chosen'),
  Type.Literal('output_path_fallback'),
  // PRI-67: Dreamer runner events
  Type.Literal('dreamer_task_leased'),
  Type.Literal('dreamer_context_built'),
  Type.Literal('dreamer_run_started'),
  Type.Literal('dreamer_run_failed'),
  Type.Literal('dreamer_output_invalid'),
  Type.Literal('dreamer_output_validated'),
  Type.Literal('dreamer_task_succeeded'),
  Type.Literal('dreamer_task_retried'),
  Type.Literal('dreamer_task_failed'),
  Type.Literal('dreamer_candidate_generated'),
  Type.Literal('dreamer_cancel_run_failed'),
  Type.Literal('dreamer_output_extraction_failed'),
  Type.Literal('dreamer_mark_succeeded_failed'),
  Type.Literal('dreamer_update_output_failed'),
  Type.Literal('dreamer_context_partial'),
  Type.Literal('dreamer_mark_failed_error'),
  Type.Literal('dreamer_mark_retry_error'),
  // PRI-new: Philosopher runner events (BasePeerRunner migration)
  Type.Literal('philosopher_task_leased'),
  Type.Literal('philosopher_context_built'),
  Type.Literal('philosopher_run_started'),
  Type.Literal('philosopher_run_failed'),
  Type.Literal('philosopher_output_invalid'),
  Type.Literal('philosopher_output_validated'),
  Type.Literal('philosopher_task_succeeded'),
  Type.Literal('philosopher_task_retried'),
  Type.Literal('philosopher_task_failed'),
  Type.Literal('philosopher_principle_candidate_generated'),
  Type.Literal('philosopher_cancel_run_failed'),
  Type.Literal('philosopher_mark_succeeded_failed'),
  Type.Literal('philosopher_update_output_failed'),
  Type.Literal('philosopher_dependency_not_succeeded'),
  Type.Literal('philosopher_lineage_resolve_failed'),
  Type.Literal('philosopher_lineage_partial'),
  Type.Literal('philosopher_artifact_write_failed'),
  Type.Literal('philosopher_wrong_task_kind'),
  Type.Literal('philosopher_output_extraction_failed'),
  Type.Literal('philosopher_mark_failed_error'),
  Type.Literal('philosopher_mark_retry_error'),
  // PRI-302: Artificer runner events (BasePeerRunner migration)
  Type.Literal('artificer_task_leased'),
  Type.Literal('artificer_context_built'),
  Type.Literal('artificer_run_started'),
  Type.Literal('artificer_run_failed'),
  Type.Literal('artificer_output_invalid'),
  Type.Literal('artificer_output_validated'),
  Type.Literal('artificer_task_succeeded'),
  Type.Literal('artificer_task_retried'),
  Type.Literal('artificer_task_failed'),
  Type.Literal('artificer_implementation_plan_generated'),
  Type.Literal('artificer_cancel_run_failed'),
  Type.Literal('artificer_mark_succeeded_failed'),
  Type.Literal('artificer_update_output_failed'),
  Type.Literal('artificer_dependency_not_succeeded'),
  Type.Literal('artificer_lineage_resolve_failed'),
  Type.Literal('artificer_lineage_partial'),
  Type.Literal('artificer_artifact_write_failed'),
  Type.Literal('artificer_wrong_task_kind'),
  Type.Literal('artificer_output_extraction_failed'),
  Type.Literal('artificer_mark_failed_error'),
  Type.Literal('artificer_mark_retry_error'),
  // PRI-302: Evaluator runner events (BasePeerRunner migration)
  Type.Literal('evaluator_task_leased'),
  Type.Literal('evaluator_context_built'),
  Type.Literal('evaluator_run_started'),
  Type.Literal('evaluator_run_failed'),
  Type.Literal('evaluator_output_invalid'),
  Type.Literal('evaluator_output_validated'),
  Type.Literal('evaluator_task_succeeded'),
  Type.Literal('evaluator_task_retried'),
  Type.Literal('evaluator_task_failed'),
  Type.Literal('evaluator_cancel_run_failed'),
  Type.Literal('evaluator_mark_succeeded_failed'),
  Type.Literal('evaluator_update_output_failed'),
  Type.Literal('evaluator_dependency_not_succeeded'),
  Type.Literal('evaluator_lineage_resolve_failed'),
  Type.Literal('evaluator_lineage_partial'),
  Type.Literal('evaluator_artifact_write_failed'),
  Type.Literal('evaluator_wrong_task_kind'),
  Type.Literal('evaluator_output_extraction_failed'),
  Type.Literal('evaluator_mark_failed_error'),
  Type.Literal('evaluator_mark_retry_error'),
  Type.Literal('evaluator_decision_recorded'),
  // PRI-302: Scribe runner events (BasePeerRunner migration)
  Type.Literal('scribe_task_leased'),
  Type.Literal('scribe_context_built'),
  Type.Literal('scribe_run_started'),
  Type.Literal('scribe_run_failed'),
  Type.Literal('scribe_output_invalid'),
  Type.Literal('scribe_output_validated'),
  Type.Literal('scribe_task_succeeded'),
  Type.Literal('scribe_task_retried'),
  Type.Literal('scribe_task_failed'),
  Type.Literal('scribe_principle_draft_generated'),
  // PRI-758/EP002-R3: scribe normalized a string-encoded intentContract carrier
  // before validation (glm-5.3-flash structured-output path evidence).
  Type.Literal('scribe_intent_contract_string_normalized'),
  Type.Literal('scribe_cancel_run_failed'),
  Type.Literal('scribe_mark_succeeded_failed'),
  Type.Literal('scribe_update_output_failed'),
  Type.Literal('scribe_dependency_not_succeeded'),
  Type.Literal('scribe_lineage_resolve_failed'),
  Type.Literal('scribe_lineage_partial'),
  Type.Literal('scribe_artifact_write_failed'),
  Type.Literal('scribe_wrong_task_kind'),
  Type.Literal('scribe_output_extraction_failed'),
  Type.Literal('scribe_mark_failed_error'),
  Type.Literal('scribe_mark_retry_error'),
  // PRI-419: Dreamer L2 multi-turn agent loop telemetry.
  // - dreamer_l2_turn: emitted per tool-execution turn inside the L2 loop
  // - dreamer_l2_complete: emitted when the loop finishes (turnCount, toolsInvoked, usedFallback, retryCount)
  // - dreamer_l2_fallback_to_l1: emitted when L2 exhausts retries and falls back to L1 one-shot (PRI-420)
  Type.Literal('dreamer_l2_turn'),
  Type.Literal('dreamer_l2_complete'),
  Type.Literal('dreamer_l2_fallback_to_l1'),
  // PRI-424/PRI-439: Artificer L2 agent loop telemetry.
  // - artificer_l2_turn: per tool-execution turn inside the L2 agent loop (PRI-439 Phase 4)
  // - artificer_l2_complete: when the loop finishes (turnCount, toolsInvoked, succeeded, abortOwner, budgetMs, elapsedMs, stopReason, tokenUsage)
  // (artificer_l2_attempt pruned in PRI-773: legacy write-test-fix loop event,
  // zero emit sites since PRI-439 replaced the loop.)
  Type.Literal('artificer_l2_turn'),
  Type.Literal('artificer_l2_complete'),
  // PRI-634 PR-A: repair-round deterministic replay evidence resolution
  // (read-only, by reference, from the source Evaluator artifact).
  // - artificer_repair_replay_evidence_resolved: evidence block built
  //   (payload: sourceEvaluatorArtifactId, failedCaseCount, truncated).
  // - artificer_repair_replay_evidence_unavailable: diagnosticReplay says
  //   FAILED but the durable evidence cannot be resolved — the repair round
  //   refuses to blind-retry and fails loud (payload: reason, detail).
  Type.Literal('artificer_repair_replay_evidence_resolved'),
  Type.Literal('artificer_repair_replay_evidence_unavailable'),
  // PRI-819 R-06: the Layer 1/2 context-resolution telemetry members
  // (<kind>_manifest_resolution_insufficient, <kind>_context_truncated,
  // <kind>_context_lineage_unavailable, <kind>_required_context_evidence_unresolved,
  // evaluator_stage2_required_evidence_unavailable,
  // evaluator_stage1_output_contract_violation) and the Layer 0
  // <kind>_artifact_summary_* members were removed together with their emit
  // sites when the dormant progressive-disclosure flags were retired.
  // PRI-426: Evaluator single-round adversarial sandbox replay telemetry.
  // - evaluator_adversarial_replay: emitted after each gate invocation with the
  //   gate decision, case count, and failed-case count.
  // - evaluator_adversarial_replay_skipped: emitted when replay is intentionally
  //   skipped (passive review failed, no adversarial cases, no positive case to
  //   merge, sandbox threw) with a structured reason.
  Type.Literal('evaluator_adversarial_replay'),
  Type.Literal('evaluator_adversarial_replay_skipped'),
  // PRI-741: emitted when the host-name parity replay case is intentionally
  // not generated (no host semantic projection, author name already host-real,
  // no host tool with the author's canonical kind) with a structured reason.
  Type.Literal('evaluator_host_alias_case_skipped'),
  // PRI-634 R4: needs_revision diagnostic replay outcome (evidence only — the
  // verdict is never overridden). diagnostic_passed = the deterministic gate
  // passed despite needs_revision; diagnostic_failed = the replay ran but did
  // not fully pass (or could not produce a result).
  Type.Literal('evaluator_adversarial_replay_diagnostic_passed'),
  Type.Literal('evaluator_adversarial_replay_diagnostic_failed'),
  // PRI-634 PR-A: merged real trace case IDs must be unique before the sandbox
  // runs — a duplicate would silently overwrite evidence Maps. The approved
  // binding path turns this into a permanent fail via the R3 terminal-state
  // guard; the needs_revision diagnostic path records it observably.
  Type.Literal('evaluator_adversarial_replay_case_id_conflict'),
  // PRI-427: Evaluator rule artifact assembly telemetry.
  // - evaluator_rule_assembled: emitted after a rule artifact is written AND
  //   marked validated (payload: artifactId, affectedTools, traceCaseCount).
  // - evaluator_rule_assembly_failed: emitted when assembly degrades (missing
  //   code/trace, write failure, validation-update failure) with a structured
  //   reason. Non-fatal — principle artifact is already written.
  Type.Literal('evaluator_rule_assembled'),
  Type.Literal('evaluator_rule_assembly_failed'),
  // ── PRI-773 catch-up: register the remaining real emit surface. ──
  // Every name below has a live this.emitEvent/emitRolloutReviewerEvent/
  // eventType call site in principles-core (verified by
  // scripts/check-telemetry-events.cjs). Before this PR they were silently
  // rewritten to degradation_triggered (ERR-060).
  // Artificer runner (PRI-302 family, expanded surface)
  Type.Literal('artificer_agent_draft_insert_failed'),
  Type.Literal('artificer_agent_draft_inserted'),
  Type.Literal('artificer_diag_llm_rate_limit_degraded'),
  Type.Literal('artificer_lineage_echo_corrected'),
  Type.Literal('artificer_no_dependencies'),
  Type.Literal('artificer_no_scribe_artifact'),
  Type.Literal('artificer_prior_validator_errors_suppressed'),
  Type.Literal('artificer_scribe_dep_selected'),
  // Dreamer runner (expanded surface)
  Type.Literal('dreamer_agent_draft_insert_failed'),
  Type.Literal('dreamer_agent_draft_inserted'),
  Type.Literal('dreamer_artifact_write_failed'),
  Type.Literal('dreamer_diag_llm_rate_limit_degraded'),
  Type.Literal('dreamer_lineage_echo_corrected'),
  Type.Literal('dreamer_lineage_partial'),
  Type.Literal('dreamer_lineage_resolve_failed'),
  Type.Literal('dreamer_wrong_task_kind'),
  // Philosopher runner (expanded surface)
  Type.Literal('philosopher_agent_draft_insert_failed'),
  Type.Literal('philosopher_agent_draft_inserted'),
  Type.Literal('philosopher_diag_llm_rate_limit_degraded'),
  Type.Literal('philosopher_lineage_echo_corrected'),
  // Scribe runner (expanded surface)
  Type.Literal('scribe_agent_draft_insert_failed'),
  Type.Literal('scribe_agent_draft_inserted'),
  Type.Literal('scribe_diag_llm_rate_limit_degraded'),
  Type.Literal('scribe_lineage_echo_corrected'),
  // Evaluator runner (expanded surface)
  Type.Literal('evaluator_adversarial_replay_error'),
  Type.Literal('evaluator_adversarial_result_persist_failed'),
  Type.Literal('evaluator_agent_draft_insert_failed'),
  Type.Literal('evaluator_agent_draft_inserted'),
  Type.Literal('evaluator_artificer_dep_selected'),
  Type.Literal('evaluator_attribution_scope_resolve_failed'),
  Type.Literal('evaluator_completion_intent_finalize_terminal'),
  Type.Literal('evaluator_completion_intent_read_failed'),
  Type.Literal('evaluator_completion_intent_resumed'),
  Type.Literal('evaluator_completion_intent_stale_epoch'),
  Type.Literal('evaluator_completion_mark_applied_failed'),
  Type.Literal('evaluator_completion_record_failed'),
  Type.Literal('evaluator_diag_llm_rate_limit_degraded'),
  Type.Literal('evaluator_governance_effect_out_of_scope_selected'),
  Type.Literal('evaluator_intent_contract_absent_on_principle'),
  Type.Literal('evaluator_lineage_echo_corrected'),
  Type.Literal('evaluator_lineage_integrity_violation'),
  Type.Literal('evaluator_no_artificer_artifact'),
  Type.Literal('evaluator_no_dependencies'),
  Type.Literal('evaluator_no_principle_bearer_found'),
  Type.Literal('evaluator_owner_resolution_applying'),
  Type.Literal('evaluator_owner_resolution_rejected_by_policy'),
  Type.Literal('evaluator_previous_evaluation_context_degraded'),
  Type.Literal('evaluator_principle_bearer_ambiguous'),
  Type.Literal('evaluator_repair_loop_idempotent_reuse'),
  Type.Literal('evaluator_repair_loop_lineage_missing'),
  Type.Literal('evaluator_repair_loop_mark_review_failed'),
  Type.Literal('evaluator_repair_loop_max_iterations'),
  Type.Literal('evaluator_repair_loop_seeder_missing'),
  Type.Literal('evaluator_repair_loop_test_out_of_scope'),
  Type.Literal('evaluator_repair_task_seed_failed'),
  Type.Literal('evaluator_repair_task_seeded'),
  Type.Literal('evaluator_rule_principle_id_resolve_failed'),
  Type.Literal('evaluator_scribe_artifact_not_principle'),
  Type.Literal('evaluator_scribe_artifact_unresolvable'),
  Type.Literal('evaluator_source_validation_update_failed'),
  Type.Literal('evaluator_source_validation_update_not_found'),
  Type.Literal('evaluator_task_needs_human_review'),
  Type.Literal('evaluator_v2_adversarial_cases_skipped'),
  // Diag router runner (PRI-625 split pipeline)
  Type.Literal('diag_router_agent_draft_insert_failed'),
  Type.Literal('diag_router_agent_draft_inserted'),
  Type.Literal('diag_router_artifact_commit_failed'),
  Type.Literal('diag_router_artifact_committed'),
  Type.Literal('diag_router_artifact_write_failed'),
  Type.Literal('diag_router_cancel_run_failed'),
  Type.Literal('diag_router_candidate_registered'),
  Type.Literal('diag_router_context_built'),
  Type.Literal('diag_router_diag_llm_rate_limit_degraded'),
  Type.Literal('diag_router_mark_failed_error'),
  Type.Literal('diag_router_mark_retry_error'),
  Type.Literal('diag_router_mark_succeeded_failed'),
  Type.Literal('diag_router_output_extraction_failed'),
  Type.Literal('diag_router_output_invalid'),
  Type.Literal('diag_router_output_validated'),
  Type.Literal('diag_router_router_completed'),
  Type.Literal('diag_router_run_failed'),
  Type.Literal('diag_router_run_started'),
  Type.Literal('diag_router_task_failed'),
  Type.Literal('diag_router_task_leased'),
  Type.Literal('diag_router_task_retried'),
  Type.Literal('diag_router_task_succeeded'),
  Type.Literal('diag_router_update_output_failed'),
  Type.Literal('diag_router_wrong_task_kind'),
  // Diag distiller runner (PRI-625 split pipeline)
  Type.Literal('diag_distiller_agent_draft_insert_failed'),
  Type.Literal('diag_distiller_agent_draft_inserted'),
  Type.Literal('diag_distiller_artifact_write_failed'),
  Type.Literal('diag_distiller_cancel_run_failed'),
  Type.Literal('diag_distiller_context_built'),
  Type.Literal('diag_distiller_diag_llm_rate_limit_degraded'),
  Type.Literal('diag_distiller_distiller_completed'),
  Type.Literal('diag_distiller_lineage_integrity_violation'),
  Type.Literal('diag_distiller_lineage_partial'),
  Type.Literal('diag_distiller_lineage_resolve_failed'),
  Type.Literal('diag_distiller_mark_failed_error'),
  Type.Literal('diag_distiller_mark_retry_error'),
  Type.Literal('diag_distiller_mark_succeeded_failed'),
  Type.Literal('diag_distiller_output_extraction_failed'),
  Type.Literal('diag_distiller_output_invalid'),
  Type.Literal('diag_distiller_output_validated'),
  Type.Literal('diag_distiller_run_failed'),
  Type.Literal('diag_distiller_run_started'),
  Type.Literal('diag_distiller_task_failed'),
  Type.Literal('diag_distiller_task_leased'),
  Type.Literal('diag_distiller_task_retried'),
  Type.Literal('diag_distiller_task_succeeded'),
  Type.Literal('diag_distiller_update_output_failed'),
  Type.Literal('diag_distiller_wrong_task_kind'),
  // Diag rootcause runner (PRI-625 split pipeline)
  Type.Literal('diag_rootcause_agent_draft_insert_failed'),
  Type.Literal('diag_rootcause_agent_draft_inserted'),
  Type.Literal('diag_rootcause_artifact_write_failed'),
  Type.Literal('diag_rootcause_cancel_run_failed'),
  Type.Literal('diag_rootcause_context_built'),
  Type.Literal('diag_rootcause_diag_llm_rate_limit_degraded'),
  Type.Literal('diag_rootcause_intent_doc_read_failed'),
  Type.Literal('diag_rootcause_lineage_partial'),
  Type.Literal('diag_rootcause_lineage_resolve_failed'),
  Type.Literal('diag_rootcause_mark_failed_error'),
  Type.Literal('diag_rootcause_mark_retry_error'),
  Type.Literal('diag_rootcause_mark_succeeded_failed'),
  Type.Literal('diag_rootcause_output_extraction_failed'),
  Type.Literal('diag_rootcause_output_invalid'),
  Type.Literal('diag_rootcause_output_validated'),
  Type.Literal('diag_rootcause_rootcause_completed'),
  Type.Literal('diag_rootcause_run_failed'),
  Type.Literal('diag_rootcause_run_started'),
  Type.Literal('diag_rootcause_task_failed'),
  Type.Literal('diag_rootcause_task_leased'),
  Type.Literal('diag_rootcause_task_retried'),
  Type.Literal('diag_rootcause_task_succeeded'),
  Type.Literal('diag_rootcause_update_output_failed'),
  Type.Literal('diag_rootcause_wrong_task_kind'),
  // Rollout reviewer (PRI-653 family)
  Type.Literal('rollout_activation_candidate_resolved'),
  Type.Literal('rollout_activation_candidate_unresolved'),
  Type.Literal('rollout_completion_intent_finalize_terminal'),
  Type.Literal('rollout_completion_intent_resumed'),
  Type.Literal('rollout_completion_intent_stale_epoch'),
  Type.Literal('rollout_completion_mark_applied_failed'),
  Type.Literal('rollout_completion_record_failed'),
  Type.Literal('rollout_dispatch_not_wired'),
  Type.Literal('rollout_mark_human_review_failed'),
  Type.Literal('rollout_owner_resolution_applying'),
  Type.Literal('rollout_reviewer_artifact_write_failed'),
  Type.Literal('rollout_reviewer_cancel_run_failed'),
  Type.Literal('rollout_reviewer_context_built'),
  Type.Literal('rollout_reviewer_dependency_not_succeeded'),
  Type.Literal('rollout_reviewer_evaluator_dep_selected'),
  Type.Literal('rollout_reviewer_lineage_echo_corrected'),
  Type.Literal('rollout_reviewer_mark_failed_error'),
  Type.Literal('rollout_reviewer_mark_retry_error'),
  Type.Literal('rollout_reviewer_mark_succeeded_failed'),
  Type.Literal('rollout_reviewer_no_dependencies'),
  Type.Literal('rollout_reviewer_no_evaluator_artifact'),
  // PRI-720: principle semantic review mode events.
  Type.Literal('rollout_reviewer_no_scribe_artifact'),
  Type.Literal('rollout_reviewer_scribe_dep_selected'),
  Type.Literal('rollout_principle_validated'),
  Type.Literal('rollout_principle_validation_update_failed'),
  Type.Literal('rollout_principle_validation_update_not_found'),
  Type.Literal('rollout_reviewer_output_invalid'),
  Type.Literal('rollout_reviewer_output_validated'),
  Type.Literal('rollout_reviewer_run_failed'),
  Type.Literal('rollout_reviewer_run_started'),
  Type.Literal('rollout_reviewer_task_failed'),
  Type.Literal('rollout_reviewer_task_leased'),
  Type.Literal('rollout_reviewer_task_needs_human_review'),
  Type.Literal('rollout_reviewer_task_retried'),
  Type.Literal('rollout_reviewer_task_succeeded'),
  Type.Literal('rollout_reviewer_update_output_failed'),
  Type.Literal('rollout_reviewer_wrong_task_kind'),
  Type.Literal('rollout_revision_already_materialized'),
  Type.Literal('rollout_revision_not_wired'),
  Type.Literal('rollout_revision_record_failed'),
  Type.Literal('rollout_revision_route_failed'),
  Type.Literal('rollout_revision_routed'),
  // Singles (admission/evidence-triage + refusal paths)
  Type.Literal('admission_decision'),
  Type.Literal('diagnosis_task_created'),
  Type.Literal('evidence_only_recorded'),
  Type.Literal('skipped_refused'),
]);

// eslint-disable-next-line @typescript-eslint/no-redeclare
export type TelemetryEventType = Static<typeof TelemetryEventType>;

// ---------------------------------------------------------------------------
// TelemetryEvent Schema
// ---------------------------------------------------------------------------

/**
 * Schema for an in-process telemetry event.
 *
 * Fields align with existing EvolutionLogEntry:
 * - traceId <-> EvolutionLogEntry.traceId
 * - timestamp <-> EvolutionLogEntry.timestamp
 * - sessionId <-> EvolutionLogEntry.sessionId
 * - payload <-> EvolutionLogEntry.metadata
 *
 * No PII fields. The agentId field is optional and contains only
 * system identifiers (e.g., 'main', 'builder'), never user data.
 */
export const TelemetryEventSchema = Type.Object({
  /** Event type (one of the 3 core types) */
  eventType: TelemetryEventType,
  /** Correlation trace ID for linking events across the pipeline */
  traceId: Type.String({ minLength: 1 }),
  /** ISO 8601 timestamp */
  timestamp: Type.String({ minLength: 1 }),
  /** Session identifier */
  sessionId: Type.String(),
  /** Agent identifier (system identifier only, no PII) */
  agentId: Type.Optional(Type.String()),
  /** Event-specific payload */
  payload: Type.Record(Type.String(), Type.Unknown()),
});

export type TelemetryEvent = Static<typeof TelemetryEventSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface TelemetryEventValidationResult {
  valid: boolean;
  errors: string[];
  event?: TelemetryEvent;
}

/**
 * Validates an arbitrary object against the TelemetryEvent schema.
 *
 * Returns a structured result with:
 * - `valid`: whether the input conforms to the schema
 * - `errors`: human-readable list of validation failures
 * - `event`: the typed event (only present when valid)
 */
export function validateTelemetryEvent(input: unknown): TelemetryEventValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['Input must be a non-null object'] };
  }

  const raw = input as Record<string, unknown>;

  // Validate ISO 8601 timestamp format
  if (
    typeof raw.timestamp === 'string' &&
    isNaN(Date.parse(raw.timestamp))
  ) {
    return { valid: false, errors: ['timestamp must be a valid ISO 8601 date string'] };
  }

  const errors = [...Value.Errors(TelemetryEventSchema, input)];
  if (errors.length > 0) {
    return {
      valid: false,
      errors: errors.map(
        (e) => `${e.path ? `${e.path}: ` : ''}${e.message}`,
      ),
    };
  }

  return {
    valid: true,
    errors: [],
    event: Value.Cast(TelemetryEventSchema, input),
  };
}
