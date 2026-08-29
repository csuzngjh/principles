/**
 * Feature Flag Lifecycle Registry — PRI-610
 *
 * Evidence-backed lifecycle decision for every quiet flag in
 * DEFAULT_FEATURE_FLAGS. This is the machine-checked census: the contract
 * test in __tests__/feature-flag-lifecycle.test.ts enforces that no quiet
 * flag exists without a lifecycle decision ("feature purgatory = 0").
 *
 * Decisions:
 * - KEEP_QUIET — real production consumer; stays quiet with explicit
 *   graduation + retirement criteria.
 * - GRADUATE   — default-on after validation (PRI-571 pattern); category
 *   stays quiet so config rollback remains available.
 * - RETIRE     — removal decided; carries the removal condition.
 * - STAGED     — registered ahead of an approved roadmap phase; activation
 *   wiring arrives with that phase (e.g. PRI-614 update convergence).
 *
 * Adding a new quiet flag REQUIRES a lifecycle entry here stating:
 * Purpose / Default / Rollback / Graduation criteria / Retirement criteria /
 * Exit path (see docs/governance/feature-flag-lifecycle-census.md §New-flag rule).
 */

export type QuietFlagLifecycleDecision = 'KEEP_QUIET' | 'GRADUATE' | 'RETIRE' | 'STAGED';

export interface QuietFlagLifecycleEntry {
  decision: QuietFlagLifecycleDecision;
  /** Where the flag is consumed in production ('staged — none yet' for STAGED). */
  consumers: readonly string[];
  /** What evidence proves this decision (validation run, owner decision, roadmap issue). */
  evidence: string;
  /** YYYY-MM-DD decision date. */
  decided: string;
  /** REQUIRED for KEEP_QUIET/STAGED: what proves promotion to default-on/GATE B wiring. */
  graduationCriteria: string;
  /** REQUIRED for all: the condition under which the flag (and its code) disappears. */
  retirementCriteria: string;
}

export const QUIET_FLAG_LIFECYCLE: Readonly<Record<string, QuietFlagLifecycleEntry>> = {
  correction_observer: {
    decision: 'KEEP_QUIET',
    consumers: ['openclaw-plugin/src/service/correction-observer*', 'openclaw-plugin/src/index.ts'],
    evidence: 'Dogfood LLM keyword optimization; synchronous detection runs independently (since 2026-06-02)',
    decided: '2026-08-27',
    graduationCriteria: 'Dogfood evidence that LLM keyword optimization beats synchronous detection on precision',
    retirementCriteria: 'No dogfood activation for 6 months (ADR-0014 §2.5) or owner abandons LLM optimization path',
  },
  signal_collector: {
    decision: 'KEEP_QUIET',
    consumers: ['openclaw-plugin/src/core/signal-collect*'],
    evidence: 'LLM deep-judgment path for ambiguous correction/empathy terms; keyword path runs regardless (since 2026-06-30)',
    decided: '2026-08-27',
    graduationCriteria: 'Dogfood evidence that LLM deep judgment catches missed signals without false positives',
    retirementCriteria: 'No dogfood activation for 6 months or signal merge design replaced',
  },
  internalization_auto_consumer: {
    decision: 'KEEP_QUIET',
    consumers: ['openclaw-plugin/src/service/internalization-auto-consumer*', 'pd-cli runtime-internalization commands'],
    evidence: 'MVP core-loop liveness — advances ready internalization tasks (PRI-381; default-on since 2026-06-13)',
    decided: '2026-08-27',
    graduationCriteria: 'Core-loop closure validated (PR #1358, merged 2026-08-20) — promotion to core optional once stability window passes',
    retirementCriteria: 'Consumer removed from production auto-consumer wiring (would break INV-07 liveness — retire only with replacement)',
  },
  story_a_approval_completion: {
    decision: 'KEEP_QUIET',
    consumers: ['pd-console/src/server/models/ApprovalsConsoleModel*'],
    evidence: 'PRI-408 approval-completion orchestrator; default-on, disableable (since 2026-06-18)',
    decided: '2026-08-27',
    graduationCriteria: 'Approval queue operates through orchestrator without manual dispatch fallback for a stability window',
    retirementCriteria: 'Direct-writer activation path permanently removed from approvals surface',
  },
  feedback_channel: {
    decision: 'KEEP_QUIET',
    consumers: ['pd-console/src/server/routes/feedback-report*', 'openclaw-plugin feedback skill surface'],
    evidence: 'MVP seed feedback channel incl. submit ladder (PRI-543); default-on (since 2026-06-01)',
    decided: '2026-08-27',
    graduationCriteria: 'Channel is part of the default product experience already; category stays quiet for per-workspace disable',
    retirementCriteria: 'Owner removes the feedback product surface',
  },
  release_manager_shadow: {
    decision: 'STAGED',
    consumers: ['staged — none yet; wiring arrives with PRI-614 Gate B'],
    evidence: 'Commercial update system Phase 3 (SPEC 2026-08-25): ReleaseManager shadow mode, read-only inspect/check with legacy comparison. Explicitly NOT dead — activation is gated on the PRI-614 update-convergence roadmap.',
    decided: '2026-08-27',
    graduationCriteria: 'PRI-614 Gate B wires a live update surface through ReleaseManager with parity evidence',
    retirementCriteria: 'PRI-614 update roadmap cancelled, or shadow comparison retired once ReleaseManager is the sole authority',
  },
  gfi: {
    decision: 'KEEP_QUIET',
    consumers: ['openclaw-plugin/src/commands/evolution-status*', 'host-runtime/src/production-pain-evidence*'],
    evidence: 'Global Friction Index session scoring surfaced in console/plugin (38 src references)',
    decided: '2026-08-27',
    graduationCriteria: 'GFI validated as an Owner-facing signal worth default-on surfacing',
    retirementCriteria: 'Friction scoring superseded by telemetry milestones (anonymous_product_telemetry) with owner decision',
  },
  evolution_worker: {
    decision: 'KEEP_QUIET',
    consumers: ['openclaw-plugin/src/index.ts (heartbeat registration, quarantined)', 'openclaw-plugin tests: evolution-worker-quarantine/slimming'],
    evidence: 'Legacy heartbeat quarantined behind flag (ADR-0014 §2.5; quarantine tests enforce off-by-default)',
    decided: '2026-08-27',
    graduationCriteria: 'None — will not graduate',
    retirementCriteria: 'Quarantine validated stable → delete worker + flag (MVP-Gone) once 6-month no-activation window closes (2026-12-01)',
  },
  empathy_observer: {
    decision: 'KEEP_QUIET',
    consumers: ['pd-console/src/ui/pages/control-center/EmpathyObserver*', 'openclaw-plugin observer wiring'],
    evidence: 'Empathy observer service for sentiment checking (since 2026-06-02); default-off',
    decided: '2026-08-27',
    graduationCriteria: 'Dogfood evidence that sentiment checking changes owner-visible behavior positively',
    retirementCriteria: 'No dogfood activation for 6 months (2026-12-02) or signal_collector merge removes the standalone observer',
  },
  painEvidenceAdmission: {
    decision: 'KEEP_QUIET',
    consumers: ['openclaw-plugin/src/hooks/pain.ts', 'openclaw-plugin/src/hooks/llm.ts', 'openclaw-plugin/src/hooks/gate-block-helper.ts'],
    evidence: 'PEAT-B1 admission gate; PRI-454 default-on, Gate B (TriggerController) primary (since 2026-06-06)',
    decided: '2026-08-27',
    graduationCriteria: 'Already default-on; promotion to core optional — quiet retained so Gate A rollback stays config-only',
    retirementCriteria: 'Gate A/B duality resolved (Gate A deleted) — flag collapses into Gate B default behavior',
  },
  painEvidenceAdmissionDefault: {
    decision: 'KEEP_QUIET',
    consumers: ['openclaw-plugin/src/hooks/pain.ts', 'openclaw-plugin/src/hooks/llm.ts', 'openclaw-plugin/src/hooks/gate-block-helper.ts'],
    evidence: 'PRI-454 Gate B migration kill switch; default-on, OFF re-activates Gate A (since 2026-06-24)',
    decided: '2026-08-27',
    graduationCriteria: 'Kill-switch semantics — will not graduate',
    retirementCriteria: 'Gate A (PainDiagnosticGate) deleted after Gate B stability window; kill switch then meaningless',
  },
  diagnostician_async_cli: {
    decision: 'KEEP_QUIET',
    consumers: ['pd-cli/src/commands/pain-record.ts', 'principles-core pain-sign* async path'],
    evidence: 'Async pain-record submission (since 2026-06-11); default-off until orchestrator exists',
    decided: '2026-08-27',
    graduationCriteria: 'Background orchestrator shipped and validated',
    retirementCriteria: 'Async path abandoned (orchestrator descoped) — delete CLI path + flag',
  },
  diagnostician_core_grounding: {
    decision: 'KEEP_QUIET',
    consumers: ['principles-core/src/runtime-v2/internaliz*/diagnostician prompt builders'],
    evidence: 'Core principle grounding in diagnostician prompt (Arm 2, since 2026-06-11); default-on',
    decided: '2026-08-27',
    graduationCriteria: 'Stable prompt feature; promotion to core optional',
    retirementCriteria: 'Prompt design drops grounding block',
  },
  internalization_core_grounding: {
    decision: 'KEEP_QUIET',
    consumers: ['principles-core/src/runtime-v2/internaliz*', 'principles-core/src/runtime-v2/runner/pe*'],
    evidence: 'Core principle grounding in internalization prompt builders (since 2026-06-16); default-on',
    decided: '2026-08-27',
    graduationCriteria: 'Stable prompt feature; promotion to core optional',
    retirementCriteria: 'Prompt design drops grounding block',
  },
  diagnostician_split_pipeline: {
    decision: 'KEEP_QUIET',
    consumers: ['pd-cli/src/commands/diagnose.ts', 'pd-cli/src/commands/pain-retry.ts'],
    evidence: '3-stage split diagnostician (RootCause→Distiller→Router, since 2026-06-11); default-on',
    decided: '2026-08-27',
    graduationCriteria: 'Split pipeline is the operating default; promotion to core optional',
    retirementCriteria: 'Pipeline re-merged or diagnostician redesigned',
  },
  diagnostician_llm_degradation: {
    decision: 'GRADUATE',
    consumers: ['pd-cli/src/commands/diagnose.ts', 'principles-core diagnostician retry policy'],
    evidence: 'ADR-0019 graceful rate-limit degradation; graduated default-on PRI-571 (2026-08-24) after validation',
    decided: '2026-08-24',
    graduationCriteria: 'MET — PRI-571 graduation executed 2026-08-24',
    retirementCriteria: 'Flag-off legacy hard-fail branch deleted after stability window; flag then collapses to always-on',
  },
  l2_dreamer: {
    decision: 'KEEP_QUIET',
    consumers: ['openclaw-plugin/src/service/internaliz* dreamer runner', 'pd-cli runtime-adapter resolution'],
    evidence: 'PRI-419 L2 multi-turn agent loop for dreamer (since 2026-06-16); default-off, zero-migration rollback',
    decided: '2026-08-27',
    graduationCriteria: 'L2 loop quality validated over one-shot baseline on dogfood artifacts',
    retirementCriteria: 'Agent-loop direction abandoned for dreamer runner',
  },
  intent_engineering: {
    decision: 'KEEP_QUIET',
    consumers: ['openclaw-plugin/src/core/intent-doc-read*', 'openclaw-plugin/src/hooks/pain.ts (intent tension)'],
    evidence: 'PRI-465 INTENT.md-grounded constructive friction (since 2026-06-25); default-off',
    decided: '2026-08-27',
    graduationCriteria: 'Intent friction validated as owner-valued in dogfood workspace',
    retirementCriteria: 'INTENT.md direction descoped by owner',
  },
  rulecode_context_v2: {
    decision: 'KEEP_QUIET',
    consumers: ['openclaw-plugin/src/core/rule-host.ts', 'openclaw-plugin/src/hooks/gate.ts'],
    evidence: 'PRI-479 RuleContext v2 foundation flag (since 2026-06-27); default-off, v1 behavior unchanged while off',
    decided: '2026-08-27',
    graduationCriteria: 'RuleContext v2 phases land and context vision validated (docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md)',
    retirementCriteria: 'RuleCode context vision descoped',
  },
  failed_tasks_observability: {
    decision: 'KEEP_QUIET',
    consumers: ['pd-console/src/server/routes/failed-task*', 'pd-console Failed Tasks page'],
    evidence: 'Task 7 failed-task list/view (since 2026-07-04); default-on for out-of-box operator value',
    decided: '2026-08-27',
    graduationCriteria: 'Already the default experience; promotion to core optional',
    retirementCriteria: 'Failed-task surface redesigned (flag collapses into new surface)',
  },
  evaluator_artificer_repair_loop: {
    decision: 'KEEP_QUIET',
    consumers: ['openclaw-plugin/src/service/auto-consume*', 'pd-cli rulehost-pipeline runner'],
    evidence: 'PRI-509/P0-D repair loop; MVP_CORE_LOOP_CONTRACT INV-02 (needs_revision out-edge); production-wired since 2026-08-18; default-on',
    decided: '2026-08-27',
    graduationCriteria: 'INV-02 liveness depends on it — promotion to core warranted',
    retirementCriteria: 'Repair loop becomes unconditional part of the consumer contract',
  },
  artificer_output_retry: {
    decision: 'GRADUATE',
    consumers: ['openclaw-plugin internaliz* artificer runner', 'pd-cli rulehost-pipeline runner'],
    evidence: 'Flag graduated to default-on 2026-08-29 (PRI-621). Live 2026-08-28 evidence: 5/6 internalization chains dead-ended at artificer output_invalid (permanent, no retry) while dreamer recovered from the SAME error category via the base retry policy (task 48371236 dreamer: attempt 1 output_invalid → attempt 2 succeeded); Codex E2E Issue 2 (2026-08-20) originally validated the retry semantics. Retry is bounded by task.maxAttempts=3, so real failures still surface.',
    decided: '2026-08-29',
    graduationCriteria: 'Executed: retry improves completion without masking real failures — dreamer same-category self-heal observed live; artificer chains recover instead of dead-ending (PRI-621 recovery plan)',
    retirementCriteria: 'Codex host output contract fixed upstream (submit_rulecode reliable) — retry unnecessary',
  },
  artifact_summary_redundancy: {
    decision: 'KEEP_QUIET',
    consumers: ['principles-core internaliz* summary writers', 'pd-cli rulehost-pipeline runner'],
    evidence: 'Progressive disclosure Layer 0 writer-side envelope (since 2026-07-26); default-off, byte-identical off',
    decided: '2026-08-27',
    graduationCriteria: 'Layer 0+1+2 validated together as the progressive-disclosure design (§6, §8)',
    retirementCriteria: 'Progressive disclosure design descoped',
  },
  context_manifest_budget: {
    decision: 'KEEP_QUIET',
    consumers: ['principles-core internaliz* context builders', 'principles-core/src/runtime-v2/runner/ba*'],
    evidence: 'Progressive disclosure Layer 1 manifest+budget injection (since 2026-07-26); default-off, byte-identical off',
    decided: '2026-08-27',
    graduationCriteria: 'Layer 1 information-floor fallback validated against full-predecessor baseline',
    retirementCriteria: 'Progressive disclosure design descoped',
  },
  progressive_evaluator: {
    decision: 'KEEP_QUIET',
    consumers: ['principles-core internaliz* evaluator', 'principles-core/src/runtime-v2/runner/ba*'],
    evidence: 'Progressive disclosure Layer 2 two-stage evaluation (since 2026-07-26); default-off',
    decided: '2026-08-27',
    graduationCriteria: 'Two-stage evaluation quality validated over single-stage',
    retirementCriteria: 'Progressive disclosure design descoped',
  },
  abstraction_layer_v1: {
    decision: 'KEEP_QUIET',
    consumers: ['openclaw-plugin/src/index.ts (host-runtime cutover gate)'],
    evidence: 'PRI-523 shared host-runtime cutover for OpenClaw (since 2026-08-13); default-off for controlled parity validation',
    decided: '2026-08-27',
    graduationCriteria: 'Host-runtime parity validation passes on live install (parity contract tests green)',
    retirementCriteria: 'Cutover completed (legacy route deleted) or cutover abandoned (shared host-runtime reverted)',
  },
  principle_receipt_block_copy: {
    decision: 'GRADUATE',
    consumers: ['openclaw-plugin/src/hooks/gate-block-helper.ts (block copy)'],
    evidence: 'PRI-530 enriched block copy; graduated default-on PRI-571 (2026-08-24)',
    decided: '2026-08-24',
    graduationCriteria: 'MET — PRI-571 graduation executed 2026-08-24',
    retirementCriteria: 'Generic-template branch deleted after stability window; flag collapses to enriched copy',
  },
  principle_receipt_ledger: {
    decision: 'GRADUATE',
    consumers: ['openclaw-plugin ledger writers', 'host-runtime product-telemetry milestone readers'],
    evidence: 'PRI-531 durable application history; graduated default-on PRI-571 (2026-08-24)',
    decided: '2026-08-24',
    graduationCriteria: 'MET — PRI-571 graduation executed 2026-08-24',
    retirementCriteria: 'Ledger becomes unconditional durability contract; flag-off branch removed',
  },
  principle_receipt_self_report: {
    decision: 'KEEP_QUIET',
    consumers: ['openclaw-plugin/src/core/principle-applica* (self-report capture)', 'host-runtime active-principle-prompt*'],
    evidence: 'PRI-532 P1-a agent self-report 📌 line (since 2026-08-16); default-off pending agent-compliance validation',
    decided: '2026-08-27',
    graduationCriteria: 'Self-report line proven reliable across hosts (agents actually append 📌 when behavior changes)',
    retirementCriteria: 'Self-report mechanism abandoned (ledger covers evidence need)',
  },
  principle_governance_projection_v2: {
    decision: 'GRADUATE',
    consumers: ['pd-console/src/server/routes/principles* (per-principle projection)'],
    evidence: 'PRI-549 read-only governance projection; graduated default-on PRI-571 (2026-08-24)',
    decided: '2026-08-24',
    graduationCriteria: 'MET — PRI-571 graduation executed 2026-08-24',
    retirementCriteria: 'Pre-projection detail view branch deleted; projection becomes the only view',
  },
  failed_task_recovery_console: {
    decision: 'KEEP_QUIET',
    consumers: ['pd-console/src/server/routes/failed-task* recover endpoint', 'pd-console Failed Tasks recovery button'],
    evidence: 'Governance Recovery Actions v1; owner decision default-on (2026-08-24); flag-off = read-only console',
    decided: '2026-08-24',
    graduationCriteria: 'Recovery actions validated without misuse on live workspace',
    retirementCriteria: 'Recovery becomes core console capability (flag collapses)',
  },
  pain_diagnosis_persistence: {
    decision: 'KEEP_QUIET',
    consumers: ['principles-core diagnostician stage-A prompt', 'PainSignalBridge persistence'],
    evidence: 'Pain diagnosis persistence (since 2026-08-23, PR #1389); default-off pending review merge + validation',
    decided: '2026-08-27',
    graduationCriteria: 'Root-cause attribution proven accurate in dogfood pain diagnoses',
    retirementCriteria: 'Attribution persistence direction descoped',
  },
  governance_experience_v1: {
    decision: 'GRADUATE',
    consumers: ['pd-console/src/server/routes/governance* experience endpoint', 'pd-console Focus page'],
    evidence: 'Governance Experience Snapshot v1.5.1 (PRI-584~587, PR #1409 merged); validated on live workspace 2026-08-29 (action-0): flag probe true with user_config, endpoint 200 returning real snapshot (ownerIdentityConfiguration=missing, rulecode_owner_decision=blocked/owner_identity_missing with nextAction configure_owner); explains-only design (ERR-102 guard)',
    decided: '2026-08-29',
    graduationCriteria: 'MET — graduated default-on 2026-08-29 after live-workspace validation (flag probe true, endpoint 200 + real snapshot)',
    retirementCriteria: 'Legacy Focus view deleted (snapshot becomes the only experience) or feature descoped',
  },
  anonymous_product_telemetry: {
    decision: 'KEEP_QUIET',
    consumers: ['host-runtime/src/product-telemetry/service*', 'pd-cli/src/commands/telemetry.ts'],
    evidence: 'Anonymous Product Telemetry v1 (PRI-595~603, PR #1419 merged); maintainer release gate, default-off; export also requires explicit consent',
    decided: '2026-08-27',
    graduationCriteria: 'Maintainer flips release gate after dogfood period (consent UX + data quality validated)',
    retirementCriteria: 'Telemetry program cancelled — delete exporter + flag',
  },
};
