---
'@principles/core': major
'@principles/host-runtime': major
'@principles/codex-adapter': minor
'@principles/workbuddy-adapter': minor
'principles-disciple': minor
'create-principles-disciple': patch
---

**BREAKING CHANGE** — Pain Phase A: Legacy Retirement (SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3, Phase A).

A technical tool failure is now trajectory and health evidence only. It can no longer become an Owner behavioral-deviation Pain on its own; the only automatic admission left is Phase B shared correction detection, and explicit Owner manual Pain is unchanged.

Retired automatic Pain entry points:

- OpenClaw legacy `after_tool_call` admission/emit (`handleAfterToolCall` Stage 5/6, `evaluatePainAdmissionForToolCall`, `emitPainIfAdmitted`) and the shared-host `onAfterToolResult` / `handleSharedPainEvidenceResult` path.
- Shared Production Pain Evidence tool-failure Pain writing and diagnosis admission; the writer now records verified `tool_calls` (outcome, exit code, raw trajectory) only.
- Codex live/transcript tool-call admission (`buildLiveToolCandidate` and the `tool_call` branch of `buildTranscriptCandidates`).
- Repeated-failure escalation (`REPEATED_FAILURE_THRESHOLD` / `consecutiveErrors >= 4` upgrade rules). No replacement error-count escalation was introduced; host error counters stay untouched.
- RuleHost block automatic Pain (`gate-block-helper.ts` Step 5). The block itself, `gate_blocks`, EventLog, blocked-attempt health counting and the Owner correction entry are unchanged.
- WorkBuddy `admitBareHostPains` sweep, its worker call, its `admission` report field and the bare-pain `painEnrichmentProvider` sourceRef synthesis. WorkBuddy automatic correction stays fail-closed/observation_only; no `pain_event:<canonicalPainId>` synthetic evidence, no PainIngress bypass, no restored compensation.

Removed public exports:

- `@principles/core/runtime-v2`: `RISKY_HIGH_SCORE_THRESHOLD`, `REPEATED_FAILURE_THRESHOLD` (the upgrade rules they gated are gone; descriptor evaluation is terminal).
- `@principles/host-runtime`: `admitBareHostPains`, `AdmitBareHostPainsInput`, `AdmitBareHostPainsResult`, `GovernanceToolFailureCandidate` (and the tool-failure variant of `GovernanceSignalCandidate`), `PRODUCTION_WRITE_TOOLS`, `PainEvidenceEntry`, `ProductionToolEventFields`, `DerivedToolPainIdentity`, `deriveProductionToolPainIdentity`, `resetProductionPainCooldownForTest`, `productionPainCooldownEntryCountForTest`.

Retained on purpose: Owner manual `/pd-pain` and the explicit Pain tool (`buildManualPainObservation` → `evaluateEvidenceTriage` → `evaluateTriggerController`), `TriggerController`, `admission-gate.ts`, canonical Pain identity, idempotency/cooldown semantics, `correctionEvidence`/lineage, Diagnostician task creation, and the whole Phase C GFI surface (`hooks/llm.ts` health branch, `/pd-pain` GFI line, Console GFI health, `pd runtime gfi`, `tool_calls.gfi_before/gfi_after`, Session Tracker and receipt chain). No new tables, migrations, feature flags, workers or queues; historical `pain_events` rows remain readable.
