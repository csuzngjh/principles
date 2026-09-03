/**
 * TelemetryEvent schema for the Evolution SDK.
 *
 * TypeBox schema describing the shape of in-process evolution events.
 * Per D-07, this is a documentation artifact -- the existing EvolutionLogger
 * output should conform to this schema. No new TelemetryService is created.
 *
 * Per D-08, covers the 3 core events aligned with EvolutionHook:
 * - pain_detected (maps to EvolutionStage 'pain_detected')
 * - principle_candidate_created (maps to EvolutionStage 'principle_generated')
 * - principle_promoted (maps to EvolutionStage 'completed')
 *
 * Injection and storage events are out of scope for this phase.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

// ---------------------------------------------------------------------------
// Event Type Union
// ---------------------------------------------------------------------------

/**
 * The 30+ telemetry event types: 3 core evolution + 8 M2 state transition + 1 M3 degradation + 8 M4 diagnostician + 3 M5 commit + 7 M6 runtime adapter + 2 PRI-419 L2 agent loop (dreamer_l2_turn, dreamer_l2_complete).
 *
 * Core evolution events (aligned with EvolutionHook methods):
 * - pain_detected -> EvolutionStage 'pain_detected'
 * - principle_candidate_created -> EvolutionStage 'principle_generated'
 * - principle_promoted -> EvolutionStage 'completed'
 *
 * M2 state transition events (task/run lifecycle):
 * - lease_acquired, lease_released, lease_renewed, lease_expired
 * - task_retried, task_failed, task_succeeded
 * - run_started, run_completed
 *
 * M3 degradation events:
 * - degradation_triggered — graceful degradation fallback activated
 *
 * M4 diagnostician runner events:
 * - diagnostician_task_leased — runner acquired lease on a task
 * - diagnostician_context_built — context assembly completed
 * - diagnostician_run_started — runtime invocation started
 * - diagnostician_run_failed — runtime execution failed
 * - diagnostician_output_invalid — output validation failed
 * - diagnostician_task_succeeded — task marked succeeded
 * - diagnostician_task_retried — task sent to retry_wait
 * - diagnostician_task_failed — task permanently failed
 *
 * M5: Artifact commit + candidate registration events:
 * - diagnostician_artifact_committed — artifact + candidates committed successfully
 * - diagnostician_artifact_commit_failed — commit attempt threw
 * - principle_candidate_registered — individual candidate registered
 *
 * M6: Runtime adapter events:
 * - runtime_adapter_selected — runtime adapter selected for invocation
 * - runtime_invocation_started — runtime invocation started
 * - runtime_invocation_succeeded — runtime invocation succeeded
 * - runtime_invocation_failed — runtime invocation failed
 * - output_validation_succeeded — output validation passed
 * - output_validation_failed — output validation failed
 * - output_repair_attempted — PRI-71 schema repair attempted (bounded by maxRepairAttempts)
 * - output_extraction_failed — JSON extraction from LLM response failed (no parseable JSON found)
 * - output_schema_invalid — PRI-200 schema validation failed (before repair)
 * - output_repair_exhausted — PRI-200 repair loop exhausted, output still invalid
 */
export const TelemetryEventType = Type.Union([
  Type.Literal('pain_detected'),
  Type.Literal('principle_candidate_created'),
  Type.Literal('principle_promoted'),
  // M2: Task/Run state transition events
  Type.Literal('lease_acquired'),
  Type.Literal('lease_released'),
  Type.Literal('lease_renewed'),
  Type.Literal('lease_expired'),
  Type.Literal('task_retried'),
  Type.Literal('task_failed'),
  Type.Literal('task_succeeded'),
  Type.Literal('run_started'),
  Type.Literal('run_completed'),
// M3: Degradation events
  Type.Literal('degradation_triggered'),
  // M4: Diagnostician runner events
  Type.Literal('diagnostician_task_leased'),
  Type.Literal('diagnostician_context_built'),
  Type.Literal('diagnostician_run_started'),
  Type.Literal('diagnostician_run_failed'),
  Type.Literal('diagnostician_output_invalid'),
  Type.Literal('diagnostician_task_succeeded'),
  Type.Literal('diagnostician_task_retried'),
  Type.Literal('diagnostician_task_failed'),
  Type.Literal('diagnostician_cancel_run_failed'),
  Type.Literal('diagnostician_mark_succeeded_failed'),
  Type.Literal('diag_router_invariant_override'),
  // PRI-371: Core grounding telemetry
  Type.Literal('diagnostician_core_grounding_result'),
  // M5: Artifact commit events
  Type.Literal('diagnostician_artifact_committed'),
  Type.Literal('diagnostician_artifact_commit_failed'),
  Type.Literal('principle_candidate_registered'),
  // M6: Runtime adapter events
  Type.Literal('runtime_adapter_selected'),
  Type.Literal('runtime_invocation_started'),
  Type.Literal('runtime_invocation_succeeded'),
  Type.Literal('runtime_invocation_failed'),
  Type.Literal('output_validation_succeeded'),
  Type.Literal('output_validation_failed'),
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
  // - artificer_l2_attempt: per LLM attempt in the legacy write-test-fix loop (kept for backward compat)
  // - artificer_l2_turn: per tool-execution turn inside the L2 agent loop (PRI-439 Phase 4)
  // - artificer_l2_complete: when the loop finishes (turnCount, toolsInvoked, succeeded, timedOut)
  Type.Literal('artificer_l2_attempt'),
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
  // PRI-634 PR-B: Shared Information Plane context-resolution telemetry.
  // NOTE ON NAMING: `BasePeerRunner.emitEvent` prefixes every event with
  // `runnerName` (`evaluator_manifest_resolution_insufficient`), so this union
  // must list the PREFIXED literal — an unprefixed entry can never match and
  // the event is silently rewritten to `degradation_triggered`.
  // - <kind>_context_lineage_unavailable: CandidateLineage hit data corruption
  //   or a store failure while resolving ancestry evidence (payload: errorKind,
  //   detail). The runner degrades to the legacy full-predecessor injection —
  //   never a silently thinner context.
  // - <kind>_required_context_evidence_unresolved: a caller-declared required
  //   field (e.g. Stage2's `diagnostician.raw.evidence`, or a repair's replay
  //   evidence) was absent OR budget-truncated, so the focused context was
  //   rejected in favor of the authoritative fallback (payload: requiredPaths).
  //   Only artificer/evaluator declare required paths today, so only those two
  //   prefixes are registered.
  Type.Literal('artificer_context_lineage_unavailable'),
  Type.Literal('artificer_required_context_evidence_unresolved'),
  Type.Literal('evaluator_context_lineage_unavailable'),
  Type.Literal('evaluator_required_context_evidence_unresolved'),
  // - evaluator_stage2_required_evidence_unavailable: the progressive
  //   evaluator reached Stage 2 (deep-evidence re-evaluation) but the REQUIRED
  //   tier2 evidence could not be resolved from the durable lineage. The
  //   runner REFUSES the Stage-2 LLM round (0 extra calls) and fails loud
  //   (input_invalid, permanent) — telemetry alone is not correctness, and no
  //   legacy fallback can carry the missing deep evidence (payload:
  //   requiredPaths). Mirror of PR-A's repair-evidence-unavailable contract.
  Type.Literal('evaluator_stage2_required_evidence_unavailable'),
  // Layer 1 allocation degradations, emitted by the shared
  // `runResolveInjection` core and therefore reachable from ALL FOUR
  // manifest-owning runners. These were already emitted but missing from this
  // union, so schema validation silently rewrote every one of them to
  // `degradation_triggered` — the Layer 3 surface could never see which
  // manifest went thin or which field the budget dropped. Registered so the
  // information floor stays observable (rc-9).
  // - <kind>_manifest_resolution_insufficient: too many declared fields were
  //   absent; the runner fell back to the full-predecessor injection (payload:
  //   absentCount, declaredCount, absentRatio).
  // - <kind>_context_truncated: the budget dropped or truncated a field
  //   (payload: fieldPath, reason, remainingBudgetTokens).
  Type.Literal('dreamer_manifest_resolution_insufficient'),
  Type.Literal('dreamer_context_truncated'),
  Type.Literal('scribe_manifest_resolution_insufficient'),
  Type.Literal('scribe_context_truncated'),
  Type.Literal('artificer_manifest_resolution_insufficient'),
  Type.Literal('artificer_context_truncated'),
  Type.Literal('evaluator_manifest_resolution_insufficient'),
  Type.Literal('evaluator_context_truncated'),
  // PRI-426: Evaluator single-round adversarial sandbox replay telemetry.
  // - evaluator_adversarial_replay: emitted after each gate invocation with the
  //   gate decision, case count, and failed-case count.
  // - evaluator_adversarial_replay_skipped: emitted when replay is intentionally
  //   skipped (passive review failed, no adversarial cases, no positive case to
  //   merge, sandbox threw) with a structured reason.
  Type.Literal('evaluator_adversarial_replay'),
  Type.Literal('evaluator_adversarial_replay_skipped'),
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
