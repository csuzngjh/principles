---
'@principles/core': major
'@principles/pd-cli': patch
'principles-disciple': patch
'create-principles-disciple': patch
---

**BREAKING CHANGE** — Pain Phase 0 safe cleanup (SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3 §6/§9, Phase 0). `@principles/core/runtime-v2` is a published subpath of the public npm package `@principles/core` (declared in `packages/principles-core/package.json` `exports`), and the following 13 symbols that were exported from it at baseline `9a2bd5efb` are **removed**. Any external consumer importing them must migrate; import sites inside this monorepo are zero (grep-verified) and none are re-added as deprecated stubs.

Removed public exports:

- Types: `AdmissionDecisionEvent`, `DiagnosisTaskCreatedEvent`, `EvidenceOnlyRecordedEvent`, `SkippedRefusedEvent`, `AdmissionEvent`
- Functions: `createAdmissionDecisionEvent`, `createDiagnosisTaskCreatedEvent`, `createEvidenceOnlyRecordedEvent`, `createSkippedRefusedEvent`, `serializeAdmissionEvent`, `validateEventPrivacy`
- Builders: `buildLlmDetectionObservation`, `buildEmpathyObservation`

(All 13 were verified present in the `runtime-v2` barrel at the pre-change baseline; they had zero production consumers across the monorepo and no deprecated aliases are provided.)

Behavioral retirement (same release): error is not Pain — the legacy Semantic Confusion detection execution path (llm.ts DetectionService funnel + detection-service.ts + detection-funnel.ts) and the LLM Paralysis trigger (stuckLoops branch) no longer create Pain events; the shared event-log/trajectory write points are now fed exclusively by the GFI branch, which is untouched (bounded retirement is Phase C; GFI differential behavior pinned by new tests). Fatal Intercept (before_compaction) no longer fabricates a tool_failure Pain with score 100 bypassing Evidence Triage/TriggerController; the safety interception and informational operational notes remain. Correction Sample Reject no longer produces host Pain from either writer (plugin TrajectoryDatabase + core trajectory-store mirror + the /pd-samples direct emit) — approve/reject, reason and sample_reviews audit rows are unchanged. The retired `thresholds.stuck_loops_trigger` and `scores.paralysis` pain_settings keys are removed from defaults (old files containing them still load — unknown keys are ignored). Historical pain_events rows (`llm_*`, `llm_paralysis`, `intercept_extraction`, `correction_rejected`) remain readable; no schema change, no new flags, no new abstractions. Net code deletion across 4 deleted modules; integrations unaffected beyond the removed imports.
