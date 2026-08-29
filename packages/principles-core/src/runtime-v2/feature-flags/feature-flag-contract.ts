/**
 * Feature Flag Contract — PRI-239
 *
 * Pure types and validators for the MVP-Quiet feature flag registry.
 * No I/O — YAML loading lives in pd-cli.
 */

export const VALID_CATEGORIES = ['core', 'quiet', 'gone', 'legacy_retire'] as const;
export type FeatureFlagCategory = (typeof VALID_CATEGORIES)[number];

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ── Flag identity aliases (PRI-609) ─────────────────────────────────────────
//
// One canonical runtime identity per behavior. Snake_case IDs that were
// historically registered as independent flags are now compatibility aliases
// only: they normalize onto the canonical camelCase ID BEFORE effective-flag
// computation, so a config key can never look valid while the production
// consumer (which reads the canonical ID) ignores it.
//
// Alias keys MUST NOT appear in DEFAULT_FEATURE_FLAGS — an alias is not a
// capability. Adding an entry here requires the canonical ID to be registered.
export const FEATURE_FLAG_ALIASES: Readonly<Record<string, string>> = {
  pain_evidence_admission: 'painEvidenceAdmission',
  pain_evidence_admission_default: 'painEvidenceAdmissionDefault',
};

export interface FeatureFlagOverrideNormalization {
  /** User override map re-keyed onto canonical IDs. */
  normalized: Record<string, unknown>;
  /** Non-silent diagnostics for alias conflicts (canonical wins, never silently). */
  warnings: string[];
}

function enabledOfOverride(value: unknown): boolean | undefined {
  if (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.hasOwn(value, 'enabled')
  ) {
    const { enabled } = value as Record<string, unknown>;
    if (typeof enabled === 'boolean') return enabled;
  }
  return undefined;
}

/**
 * Normalize user flag overrides onto canonical IDs (PRI-609).
 *
 * - Alias keys are re-keyed to their canonical ID.
 * - When both the canonical ID and an alias are configured with DIFFERENT
 *   enabled values, the conflict is reported as a warning and the canonical
 *   entry wins — the outcome is deterministic and observable, never silent.
 * - Dangerous keys are dropped here so every downstream consumer inherits the
 *   same rejection.
 */
export function normalizeFeatureFlagOverrides(
  userFlags: Record<string, unknown>,
): FeatureFlagOverrideNormalization {
  const normalized: Record<string, unknown> = {};
  const warnings: string[] = [];

  // Dangerous keys are rejected observably (same warning text the legacy
  // computeEffectiveFlags filter emitted) and never reach the normalized map.
  for (const key of Object.keys(userFlags)) {
    if (DANGEROUS_KEYS.has(key)) {
      warnings.push(`flag '${key}': dangerous key rejected`);
    }
  }

  // Pass 1: canonical keys occupy their slot first so an alias can never
  // override them, regardless of key iteration order.
  for (const key of Object.keys(userFlags)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (!Object.hasOwn(FEATURE_FLAG_ALIASES, key)) {
      normalized[key] = userFlags[key];
    }
  }

  // Pass 2: alias keys fill the canonical slot only when the raw canonical
  // key is absent.
  for (const key of Object.keys(userFlags)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const aliasTarget = Object.hasOwn(FEATURE_FLAG_ALIASES, key)
      ? FEATURE_FLAG_ALIASES[key]
      : undefined;
    if (aliasTarget !== undefined && !Object.hasOwn(userFlags, aliasTarget)) {
      normalized[aliasTarget] = userFlags[key];
    }
  }

  // Pass 3: canonical + alias both configured → differing enabled values are
  // an explicit conflict (canonical wins, observably).
  for (const [alias, canonical] of Object.entries(FEATURE_FLAG_ALIASES)) {
    if (Object.hasOwn(userFlags, alias) && Object.hasOwn(userFlags, canonical)) {
      const aliasEnabled = enabledOfOverride(userFlags[alias]);
      const canonicalEnabled = enabledOfOverride(userFlags[canonical]);
      if (aliasEnabled !== canonicalEnabled) {
        warnings.push(
          `feature '${canonical}': conflicting values for canonical ID and alias '${alias}' — canonical value used (enabled=${String(canonicalEnabled)})`,
        );
      }
    }
  }

  return { normalized, warnings };
}

export interface FeatureFlagDefinition {
  id: string;
  category: FeatureFlagCategory;
  enabled: boolean;
  since: string;
  description?: string;
}

export interface EffectiveFeatureFlags {
  flags: Record<string, FeatureFlagDefinition>;
  source: 'defaults' | 'workspace_file';
  configPath: string;
  warnings: string[];
}

export interface ValidationResultOk {
  ok: true;
  value: FeatureFlagDefinition;
}

export interface ValidationResultErr {
  ok: false;
  errors: string[];
  source: string;
}

export type ValidationResult = ValidationResultOk | ValidationResultErr;

export function validateFeatureFlagRaw(raw: unknown, source: string): ValidationResult {
  const errors: string[] = [];

  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['input must be a non-null object'], source };
  }

  const obj = raw;

  const id = Object.hasOwn(obj, 'id') ? (obj as Record<string, unknown>).id : undefined;
  if (typeof id !== 'string' || id.length === 0) {
    errors.push('id must be a non-empty string');
  }

  const category = Object.hasOwn(obj, 'category') ? (obj as Record<string, unknown>).category : undefined;
  if (typeof category !== 'string' || !VALID_CATEGORIES.includes(category as FeatureFlagCategory)) {
    errors.push(`category must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }

  const enabled = Object.hasOwn(obj, 'enabled') ? (obj as Record<string, unknown>).enabled : undefined;
  if (typeof enabled !== 'boolean') {
    errors.push('enabled must be a boolean');
  }

  const since = Object.hasOwn(obj, 'since') ? (obj as Record<string, unknown>).since : undefined;
  if (typeof since !== 'string' || since.length === 0) {
    errors.push('since must be a non-empty string');
  }

  const description = Object.hasOwn(obj, 'description') ? (obj as Record<string, unknown>).description : undefined;
  if (description !== undefined && typeof description !== 'string') {
    errors.push('description must be a string when present');
  }

  if (errors.length > 0) {
    return { ok: false, errors, source };
  }

  const value: FeatureFlagDefinition = {
    id: id as string,
    category: category as FeatureFlagCategory,
    enabled: enabled as boolean,
    since: since as string,
  };

  if (description !== undefined) {
    value.description = description as string;
  }

  return { ok: true, value };
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlagDefinition[] = [
  // MVP-Core — always enabled, cannot be disabled
  { id: 'prompt', category: 'core', enabled: true, since: '2026-05-24', description: 'Prompt injection for principle application' },
  { id: 'code_tool_hook', category: 'core', enabled: true, since: '2026-05-24', description: 'Code tool hook for rule host enforcement' },
  { id: 'rulecode_safety_controls', category: 'core', enabled: true, since: '2026-08-21', description: 'Durable RuleCode safety isolation authority. Default ON; emergency enforcement shutdown remains the code_tool_hook core flag.' },
  { id: 'rulecode_owner_live_decision', category: 'core', enabled: true, since: '2026-08-21', description: 'Owner-reviewed RuleCode shadow-to-live decision authority. Default ON after the readiness, authenticated Console, CLI, audit, and rollback rollout gates passed; flag-off refuses promotion.' },
  { id: 'defer_archive', category: 'core', enabled: true, since: '2026-05-24', description: 'Defer/archive activation writer' },
  { id: 'correction_observer', category: 'quiet', enabled: false, since: '2026-06-02', description: 'Optional LLM optimization service for correction keywords; synchronous correction detection remains active independently' },
  { id: 'signal_collector', category: 'quiet', enabled: false, since: '2026-06-30', description: 'Unified signal collection host (correction + empathy upstream merge). NOTE: keyword detection (high-precision phrases) runs regardless of this flag; this flag only gates the LLM deep-judgment path (ambiguous terms / missed keywords). Quiet flag: dogfood-only until validated.' },
  { id: 'internalization_auto_consumer', category: 'quiet', enabled: true, since: '2026-06-13', description: 'Bounded auto-consumer for dreamer internalization tasks — prevents ready tasks from pending forever (PRI-381; quiet flag, default on, disableable via config)' },
  // PRI-419 amendment: internalization auto-consumer full-chain scope.
  // Extends auto-consumer advancement from dreamer-only to the full peer-runner
  // chain (dreamer→philosopher→scribe→artificer→evaluator) so artifacts reach
  // validation_status='validated' unattended. rollout_reviewer is deliberately
  // EXCLUDED — it stays a manual Owner gate before the approval queue
  // (advanced via `pd runtime internalization run-once --runner rollout_reviewer`).
  // Maintainer-approved MVP-Core (2026-08-12): default ON. Roll back = set
  // enabled: false in .pd/config.yaml → auto-consumer reverts to dreamer-only
  // (DEFAULT_CONSUMER_RUNNER_KINDS). The scope sets are independent: see
  // FULL_CHAIN_CONSUMER_RUNNER_KINDS vs DEFAULT_CONSUMER_RUNNER_KINDS in
  // internalization-consumer-decision.ts.
  { id: 'internalization_full_chain', category: 'core', enabled: true, since: '2026-08-12', description: 'PRI-419 amendment: auto-consumer advances dreamer→…→evaluator→rollout_reviewer (full chain) so artifacts reach validated and the approval queue is populated unattended. The human gate is the approval queue (Console), not the rollout_reviewer CLI trigger. Default ON; flag-off = dreamer-only.' },
  // PRI-408: Story A approval-completion orchestrator. Replaces the demo direct-writer
  // activation path with a formal ApprovalCompletionService that validates approval state,
  // enforces idempotency, and dispatches via ActivationDispatcher with rolloutDecision='approved'.
  // Registered as quiet (default on, disableable) so operators can turn off the new orchestrator
  // without affecting already-activated data — falling back to manual dispatch.
  { id: 'story_a_approval_completion', category: 'quiet', enabled: true, since: '2026-06-18', description: 'Story A approval-completion orchestrator (PRI-408) — formal service replacing demo direct-writer activation; quiet flag, default on, disableable via config' },

  // MVP-Quiet — opt-in or opt-out via config; enabled value varies per flag
  // Only flags with real consumption paths are registered (PRI-239 constraint)
  { id: 'feedback_channel', category: 'quiet', enabled: true, since: '2026-06-01', description: 'MVP seed feedback channel — privacy-preserving report drafts. PRI-543: flag scope extended to also cover the feedback SUBMIT ladder (ingest relay / gh CLI / mailto / export-file channels + submit endpoints). Flag-off = submit endpoints 403 + submit UI hidden; config `feedback:` segment and channel parameters still available.' },
  // Commercial update system Phase 3 (SPEC 2026-08-25): ReleaseManager shadow
  // mode. Read-only inspect/check with legacy-updater decision comparison;
  // apply/rollback refuse regardless of this flag (activation arrives with
  // the Phase 4 transaction rollout). Quiet per AGENTS: default off, not
  // surfaced until Phase 6 cutover.
  { id: 'release_manager_shadow', category: 'quiet', enabled: false, since: '2026-08-25', description: 'ReleaseManager shadow mode — read-only signed-metadata update checks with legacy-updater comparison diagnostics; no activation' },
  { id: 'gfi', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Global Friction Index session scoring' },
  { id: 'evolution_worker', category: 'quiet', enabled: false, since: '2026-06-01', description: 'Legacy evolution worker heartbeat (MVP-Quiet per ADR-0014 §2.5)' },
  { id: 'empathy_observer', category: 'quiet', enabled: false, since: '2026-06-02', description: 'Empathy observer service for sentiment checking (MVP-Quiet)' },
  // PRI-454: painEvidenceAdmission flipped to default-on. Gate B (TriggerController)
  // is now the primary admission gate. Roll back = set painEvidenceAdmissionDefault to false.
  { id: 'painEvidenceAdmission', category: 'quiet', enabled: true, since: '2026-06-06', description: 'Pre-diagnosis evidence triage for pain signals (PEAT-B1). PRI-454: default-on, Gate B is primary gate.' },
  // PRI-404/PRI-609: the snake_case IDs `pain_evidence_admission` and
  // `pain_evidence_admission_default` are no longer registered as independent
  // capabilities — see FEATURE_FLAG_ALIASES above.
  // PRI-454: Global kill switch for Gate B migration. When ON (default), Gate B owns admission.
  // When OFF (rollback), Gate A (PainDiagnosticGate) is re-activated on all paths.
  { id: 'painEvidenceAdmissionDefault', category: 'quiet', enabled: true, since: '2026-06-24', description: 'PRI-454: Global kill switch for Gate B migration. When ON (default), Gate B (TriggerController) owns admission. When OFF (rollback), Gate A (PainDiagnosticGate) is re-activated.' },
  { id: 'diagnostician_async_cli', category: 'quiet', enabled: false, since: '2026-06-11', description: 'Async pain-record CLI — submit and return immediately, diagnosis runs in background. Default: false until orchestrator exists.' },
  { id: 'diagnostician_core_grounding', category: 'quiet', enabled: true, since: '2026-06-11', description: 'Core principle grounding in diagnostician prompt (Arm 2)' },
  { id: 'internalization_core_grounding', category: 'quiet', enabled: true, since: '2026-06-16', description: 'Core principle grounding in internalization prompt builders (dreamer, philosopher, scribe)' },
  { id: 'diagnostician_split_pipeline', category: 'quiet', enabled: true, since: '2026-06-11', description: '3-stage split diagnostician pipeline (RootCause→Distiller→Router)' },
  // ADR-0019: Diagnostician LLM rate-limit graceful degradation. On persistent rate-limit,
  // mark task failed with `rate_limit` errorCategory + emit `diag_llm_rate_limit_degraded`
  // telemetry (observable degradation, rc-9). Graduated to default-on (PRI-571,
  // 2026-08-24) after validation; flag-off = legacy hard-fail behavior (rate_limit
  // errors flow through retryOrFail → max_attempts_exceeded).
  { id: 'diagnostician_llm_degradation', category: 'quiet', enabled: true, since: '2026-07-03', description: 'Diagnostician LLM rate-limit graceful degradation — on persistent rate-limit, emit diag_llm_rate_limit_degraded telemetry + rate_limit errorCategory instead of max_attempts_exceeded (ADR-0019). Default ON (graduated PRI-571, 2026-08-24); flag-off = hard fail (legacy behavior).' },
  // PRI-419: L2 multi-turn agent loop for the dreamer runner. Scoped single-runner exception
  // per ADR-0014 amendment (mirrors the 2026-06-10 diagnostician-split owner exception).
  // Default off; flips dreamer from one-shot completeSimple to a multi-turn agentLoop with
  // read-only tools. Roll back = flip flag, reverts to PiAiRuntimeAdapter with zero migration.
  { id: 'l2_dreamer', category: 'quiet', enabled: false, since: '2026-06-16', description: 'L2 multi-turn agent loop for the dreamer runner (PRI-419) — read-only tools + submit_output, scoped to dreamer only' },
  // PRI-435: Code-rule capability promoted to MVP-Core, default ON.
  // Atomic: ArtificerL2 + Evaluator. The RuleHost pipeline runs the adversarial
  // write-test-fix loop with the ArtificerL2Adapter when enabled. As a core flag
  // it defaults ON and cannot be disabled by omission; explicit emergency disable
  // via `enabled: false` is honored with a warning (see computeEffectiveFlags).
  // The CLI handler still checks per-agent config (artificer + evaluator enabled)
  // before invoking the pipeline; misconfigured agents fail the readiness gate.
  { id: 'code_rule_capability', category: 'core', enabled: true, since: '2026-06-18', description: 'Code-rule capability (atomic: ArtificerL2 + Evaluator) for RuleHost pipeline — MVP-Core, default ON (PRI-435)' },


  // PRI-465: Intent Engineering MVP — default off; quiet flag.
  { id: 'intent_engineering', category: 'quiet', enabled: false, since: '2026-06-25', description: 'INTENT.md-grounded constructive friction and Stage-A intent tension diagnosis (PRI-465). Default off; flag-off = no INTENT read, no prompt injection, no intentTension.' },
  // PRI-479: RuleContext v2 — foundation flag for the rule-code context vision
  // (spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md).
  // Quiet + default off: registering the flag does NOT change any production
  // behavior. Subsequent phases gate new RuleHostInput fields and context
  // builders behind this flag; v1 rule behavior is unchanged while the flag
  // is off. Roll back = leave the flag off (or set enabled: false in config).
  { id: 'rulecode_context_v2', category: 'quiet', enabled: false, since: '2026-06-27', description: 'RuleContext v2 — rule-code context vision (PRI-479). Foundation flag; default off, v1 rule behavior unchanged. See docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md' },
  // Task 7: Failed tasks observability — list/view failed pipeline tasks.
  // Unsolicited new code defaults to MVP-Quiet (ADR-0014 §2.5). Default-on so
  // operators can list failed tasks out of the box; disable via .pd/config.yaml:
  // failed_tasks_observability: { enabled: false }.
  { id: 'failed_tasks_observability', category: 'quiet', enabled: true, since: '2026-07-04', description: 'Failed tasks observability — list/view failed pipeline tasks' },
  // PRI-509/P0-D: Evaluator→Artificer repair loop. When evaluator returns needs_revision,
  // auto-seed an artificer repair task carrying the evaluator's requiredChanges/concerns
  // as repairPayload. Repair iteration capped at 2 rounds; on the 3rd needs_revision the
  // task enters needs_human_review (fail loud, EP-03). Default ON since MVP core-loop
  // closure (MVP_CORE_LOOP_CONTRACT INV-02: needs_revision MUST have an automatic
  // revision out-edge; INV-07 liveness) and now wired in the production auto-consumer
  // (previously intentionally NOT wired — audit ISSUE-005). The commit gate
  // (commitNextTaskProposal single transition decision) guarantees needs_revision
  // never ALSO seeds a normal successor. Roll back = set enabled: false in config
  // (restores legacy dead-end behavior for diagnosis only).
  { id: 'evaluator_artificer_repair_loop', category: 'quiet', enabled: true, since: '2026-07-04', description: 'PRI-509/P0-D: Evaluator→Artificer repair loop — auto-seed artificer repair on needs_revision (2-round cap → needs_human_review). Default ON (INV-02 liveness); production-wired in auto-consumer since 2026-08-18.' },
  // Issue 2 (Codex E2E): artificer pipeline fails with `output_invalid` when the
  // LLM returns malformed output instead of calling submit_rulecode. `output_invalid`
  // is in ArtificerRunner.permanentErrorCategories → immediate permanent failure,
  // no fallback. This quiet flag moves `output_invalid` OUT of
  // permanentErrorCategories so the base runner's retry policy (bounded by
  // task.maxAttempts) retries it instead of failing permanently.
  // GRADUATED default-on 2026-08-29 (PRI-621): every other peer runner already
  // retries output_invalid; artificer was the sole permanent-failure outlier,
  // dead-ending 5/6 internalization chains on one malformed LLM response.
  // Flag-off = legacy behavior: output_invalid is permanent. Roll back = set
  // enabled: false in .pd/config.yaml (quiet category keeps the override path).
  { id: 'artificer_output_retry', category: 'quiet', enabled: true, since: '2026-08-20', description: 'Issue 2/PRI-621: retry Artificer `output_invalid` (malformed LLM output, e.g. missed submit_rulecode) via the base retry policy (max 3 attempts) instead of permanent failure. Graduated default-on 2026-08-29 — aligns artificer with every other peer runner; flag-off reverts output_invalid to permanent (legacy).' },
  // Internalization progressive disclosure — Layer 0 (design §6.1, §8, PR 1).
  // Writer-side ArtifactSummary + PredecessorSummaryRef envelope, merged into
  // contentJson for all 8 SummaryRunnerKind stages. Default off; flag-off =
  // no `summary` / `predecessorSummary` fields written, byte-identical to
  // current contentJson shape (Requirement 11.5/11.8/11.9, CP-32).
  { id: 'artifact_summary_redundancy', category: 'quiet', enabled: false, since: '2026-07-26', description: 'Internalization progressive disclosure Layer 0 — writer-side ArtifactSummary + predecessorSummary envelope on all 8 SummaryRunnerKind stages. Default off; flag-off = current contentJson shape unchanged.' },
  // Internalization progressive disclosure — Layer 1 (design §6.2/§6.3/§8, PR 2).
  // Runners use a ContextManifest + PromptBudgetManager to focus injection with
  // a token budget, with an information-floor fallback to the legacy
  // full-predecessor injection when resolution is too sparse. Default off;
  // flag-off = runners use the existing buildContext assembly (byte-identical).
  // Independent of internalization_core_grounding (§8.1): budgetTokens covers
  // ONLY manifest-declared fields, never core grounding text.
  { id: 'context_manifest_budget', category: 'quiet', enabled: false, since: '2026-07-26', description: 'Internalization progressive disclosure Layer 1 — manifest + budget-driven context injection with information-floor fallback. Default off; flag-off = existing buildContext assembly unchanged.' },
  // Internalization progressive disclosure — Layer 2 two-stage evaluation
  // (design §6.5/§8, PR 4). Evaluator runs Stage 1 (summary) then optionally
  // Stage 2 (tier2 full contentJson) when flagged/forced. Adds optional
  // painCoverage / compressionFidelity to evaluator output. Default off;
  // flag-off = single-stage evaluation (current behavior).
  { id: 'progressive_evaluator', category: 'quiet', enabled: false, since: '2026-07-26', description: 'Internalization progressive disclosure Layer 2 — two-stage evaluation with flagged criteria + painCoverage/compressionFidelity output fields. Default off; flag-off = single-stage evaluation unchanged.' },
  // ADR-0020: Codex CLI host adapter. Flipped to MVP-Core (default ON) on
  // 2026-08-12 after PRI-282 E2E validation passed (pd-hook stdin/stdout
  // contract, output whitelist, HostAdapter decode/encode for all 4 events).
  // Roll back = set host.codex.enabled: false in .pd/config.yaml.
  { id: 'host.codex', category: 'core', enabled: true, since: '2026-08-11', description: 'ADR-0020: Codex CLI host adapter. Default ON (flipped 2026-08-12 after PRI-282 E2E). Flag-off = pd-hook.js outputs {} + exit 0 + SystemLogger records skip (rc-9). Disable via .pd/config.yaml: host.codex: { enabled: false }.' },
  { id: 'abstraction_layer_v1', category: 'quiet', enabled: false, since: '2026-08-13', description: 'PRI-523 shared host-runtime cutover for OpenClaw. Default OFF preserves the legacy route; enable only for controlled parity validation.' },
  // PRI-530: Principle Receipt P0 — enriched RuleHost block copy. When off,
  // the block message keeps the existing generic English template (byte
  // identical); when on, blockReason carries principle attribution (title
  // fallback chain, approval date, optional painReasonSummary source line).
  // Quiet; graduated to default-on (PRI-571, 2026-08-24) after live validation.
  // Roll back = set enabled: false in .pd/config.yaml (generic template returns).
  { id: 'principle_receipt_block_copy', category: 'quiet', enabled: true, since: '2026-08-15', description: 'Principle Receipt P0 — enriched RuleHost block copy with principle attribution (title/approval date/source summary, PRI-530). Default ON (graduated PRI-571, 2026-08-24); flag-off = generic block template unchanged.' },
  // PRI-531: Principle Receipt ledger — durable application history. When off,
  // no rows are written and console receipt surfaces show a degraded state with
  // reason + nextAction. Quiet; graduated to default-on (PRI-571, 2026-08-24)
  // so the Owner sees principle application evidence out of the box.
  { id: 'principle_receipt_ledger', category: 'quiet', enabled: true, since: '2026-08-15', description: 'Principle Receipt ledger — durable principle_applications history (effect/presence two-level semantics, PRI-531). Default ON (graduated PRI-571, 2026-08-24); flag-off = no ledger writes.' },
  // PRI-532: Principle Receipt P1-a — agent self-report line. When on, the
  // directive block gains a footer instructing the agent to append one 📌 line
  // when a directive actually changes its behavior, and llm_output /
  // before_message_write capture writes self_reported ledger rows (deduped per
  // principle×session). Governs P1-a's own ledger writes; principle_receipt_ledger
  // governs the P1-b write points. Default off; flag-off = byte-identical template.
  { id: 'principle_receipt_self_report', category: 'quiet', enabled: false, since: '2026-08-16', description: 'Principle Receipt P1-a — agent self-report 📌 line (injection instruction + capture, PRI-532). Default off; flag-off = directive template unchanged, no capture.' },
  { id: 'principle_governance_projection_v2', category: 'quiet', enabled: true, since: '2026-08-20', description: 'Read-only per-principle Owner governance projection (PRI-549). Default ON (graduated PRI-571, 2026-08-24); flag-off preserves the pre-projection Principle Detail experience.' },
  // Governance Recovery Actions v1 — Console-side recovery for failed /
  // needs_human_review internalization tasks (POST /api/v1/failed-tasks/:id/recover
  // + Recovery button on the Failed Tasks page). Reuses RecoverySweepService and
  // the extracted owner-retry sequence; CLI behavior unchanged. Default on
  // (owner decision 2026-08-24); flag-off = Console stays read-only
  // (endpoint 403 + button hidden). Roll back = set enabled: false in
  // .pd/config.yaml.
  { id: 'failed_task_recovery_console', category: 'quiet', enabled: true, since: '2026-08-23', description: 'Governance Recovery Actions v1 — Owner-triggered recovery of failed / needs_human_review tasks from Console (failed→pending via RecoverySweepService; needs_human_review→pending via owner authority reset). Default on (2026-08-24 owner decision); flag-off = Console read-only.' },
  // Pain diagnosis persistence (SPEC: PD Pain Diagnosis Persistence Enhancement).
  // Gates BOTH halves of one feature so the disable path is a single flag:
  //   1. Stage A prompt gains the Evidence First Attribution block
  //      (People/Design/Assumption/Tooling chosen strictly from evidence).
  //   2. PainSignalBridge.onDiagnosisComplete persists the diagnostician's
  //      root-cause attribution into state.db pain_diagnoses, keyed by the
  //      canonical pain_id (logical link — pain_events lives in trajectory.db).
  // Default off; flag-off = no pain_diagnoses writes AND the Stage A prompt
  // is byte-identical to the pre-feature prompt. Roll back = set enabled: false.
  { id: 'pain_diagnosis_persistence', category: 'quiet', enabled: false, since: '2026-08-23', description: 'Persist diagnostician root-cause attribution to pain_diagnoses (state.db, keyed by canonical pain_id) + Evidence First attribution rules in the Stage A prompt. Default off; flag-off = no writes, prompt byte-identical.' },
  // Governance Experience Snapshot v1.5.1 (PRI-584~587). Read-only workspace
  // governance experience: batch collector reuses the existing projection
  // (deriveOwnerGovernanceView) once per workspace; GET /api/v1/governance/experience
  // serves one snapshot; Console Focus consumes it when enabled. Explains only —
  // never authorizes (ERR-102). Default on (graduated 2026-08-29 after live-workspace
  // validation); disable via .pd/config.yaml features.governance_experience_v1.enabled: false
  // (flag-off = endpoint 403 before any DB access, legacy Focus experience unchanged).
  { id: 'governance_experience_v1', category: 'quiet', enabled: true, since: '2026-08-24', description: 'Governance Experience Snapshot v1.5.1 — read-only workspace governance experience (batch projection + GET /api/v1/governance/experience + Console Focus integration). Default on (graduated 2026-08-29); flag-off via config = endpoint 403 (no DB access) and legacy Focus behavior preserved.' },
  // Anonymous Product Telemetry v1 (PRI-595~603, "Collect signals, not users").
  // Maintainer release gate — INDEPENDENT of user consent (which lives in
  // ~/.pd/product-telemetry.json and must ALSO be 'granted'). Export requires
  // flag ON AND consent granted AND environment eligibility (host-runtime
  // product-telemetry/eligibility). One boolean-milestone snapshot per
  // installation/day over daily unlinkable IDs; zero content collection.
  // Flag-off = zero export attempts from any surface. Roll back = set
  // enabled: false in .pd/config.yaml.
  { id: 'anonymous_product_telemetry', category: 'quiet', enabled: false, since: '2026-08-26', description: 'Anonymous Product Telemetry v1 — opt-in daily boolean-milestone snapshot (initialized/pain/principle/activation/receipt presence+effect), daily unlinkable IDs, zero content collection. Default off; export also requires explicit consent (pd telemetry enable) + production eligibility.' },
  // MVP-Gone — permanently disabled, cannot be re-enabled
  { id: 'nocturnal', category: 'gone', enabled: false, since: '2026-05-24', description: 'Nocturnal trinity pipeline (retired)' },
  { id: 'idle_trigger', category: 'gone', enabled: false, since: '2026-05-24', description: 'Idle trigger for background processing (retired)' },
  // New user onboarding wizard — first-visit redirect to /welcome + demo story-a
  // trigger endpoint. Maintainer-approved MVP-Core (2026-07-01): promoted from
  // MVP-Quiet (default-off) to MVP-Core (default-on) after explicit maintainer
  // approval. As a core flag it defaults ON and cannot be disabled by omission;
  // explicit emergency disable via `enabled: false` is honored with a warning
  // (see computeEffectiveFlags core-flag branch, mirrors PRI-435 code_rule_capability).
  { id: 'new_user_onboarding', category: 'core', enabled: true, since: '2026-07-01', description: 'New user onboarding wizard — first-visit redirect to /welcome + demo story-a trigger endpoint. Maintainer-approved MVP-Core (2026-07-01): default-on; emergency disable via .pd/config.yaml: new_user_onboarding: { enabled: false }.' },
];

export function computeEffectiveFlags(
  userFlagsInput: Record<string, unknown>,
  defaults: FeatureFlagDefinition[],
  configPath: string,
): EffectiveFeatureFlags {
  const warnings: string[] = [];
  const flags: Record<string, FeatureFlagDefinition> = {};

  // PRI-609: normalize alias IDs onto canonical IDs before any computation so
  // a snake_case config key controls the same runtime flag its camelCase
  // production consumer reads.
  const { normalized: userFlags, warnings: aliasWarnings } = normalizeFeatureFlagOverrides(userFlagsInput);
  warnings.push(...aliasWarnings);

  const safeKeys = Object.keys(userFlags).filter(key => {
    if (DANGEROUS_KEYS.has(key)) {
      warnings.push(`flag '${key}': dangerous key rejected`);
      return false;
    }
    return true;
  });
  const hasUserFlags = safeKeys.length > 0;

  for (const def of defaults) {
    if (!Object.hasOwn(userFlags, def.id) || DANGEROUS_KEYS.has(def.id)) {
      flags[def.id] = { ...def };
      continue;
    }

    const override = userFlags[def.id];
    const isPlainObj = override !== null && override !== undefined && typeof override === 'object' && !Array.isArray(override);
    const enabledValue = isPlainObj && Object.hasOwn(override, 'enabled')
      ? (override as Record<string, unknown>).enabled
      : undefined;

    if (typeof enabledValue !== 'boolean') {
      flags[def.id] = { ...def };
      warnings.push(`flag '${def.id}': malformed override kept default (enabled must be boolean)`);
      continue;
    }

    // Gone flags can never be re-enabled
    if (def.category === 'gone') {
      flags[def.id] = { ...def };
      if (enabledValue) {
        warnings.push(`flag '${def.id}': gone flag cannot be re-enabled`);
      }
      continue;
    }

    // PRI-435: Core flags default ON and cannot be disabled by omission.
    // However, operators may explicitly set `enabled: false` for emergency disable
    // (e.g. `code_rule_capability.enabled: false` to halt the RuleHost pipeline).
    // This deliberate override is honored with a warning so the disable is observable
    // in logs/telemetry. Per-rule rollback remains `deactivate`.
    if (def.category === 'core') {
      if (enabledValue) {
        flags[def.id] = { ...def };
      } else {
        flags[def.id] = { ...def, enabled: false };
        warnings.push(`flag '${def.id}': core flag explicitly disabled via config (emergency disable)`);
      }
      continue;
    }

    // Quiet flags: accept valid user override
    flags[def.id] = {
      ...def,
      enabled: enabledValue,
    };
  }

  // Warn about unknown flags
  for (const key of safeKeys) {
    if (!Object.hasOwn(flags, key)) {
      warnings.push(`flag '${key}': unknown flag ignored`);
    }
  }

  return {
    flags,
    source: hasUserFlags ? 'workspace_file' : 'defaults',
    configPath,
    warnings,
  };
}
