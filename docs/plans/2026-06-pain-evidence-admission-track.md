# Pain Evidence Admission Track

> Status: Draft for owner review.
>
> This document is the design and implementation control plane for the next pain-signal iteration. OpenClaw may collect evidence and implement approved slices, but this feature line must not be merged into `main` or installed into the owner's production OpenClaw environment until its release gate is explicitly satisfied.

## Goal

Make PD's pain-signal pipeline useful in real dogfood work without turning PD into a generic monitoring, memory, tool-repair, or autonomous value-decision system.

The target behavior is:

1. PD can collect bounded, privacy-preserving evidence from real agent work.
2. PD can distinguish raw friction from owner-relevant pain.
3. PD can admit only qualified pain into the principle-internalization pipeline.
4. PD can aggregate weak/repeated evidence into episodes without creating noisy diagnostic tasks.
5. The owner can inspect why a signal was accepted, deferred, rejected, or grouped.

## Product Boundary

PD owns:

- Behavior evidence that explains agent failure, owner intervention, repeated correction, risky action, or workflow breakdown.
- Owner-reviewed, reversible behavior internalization.
- Explicit provenance from evidence to candidate principle to approval to activation.

PD does not own:

- General task execution.
- General memory.
- Generic tool retry or provider failover.
- Autonomous value judgments without owner review.
- GAP / OKR / mission scoring during MVP-First.
- Broad attribution, probation, training, or model-evaluation systems.

## Why This Track Exists

The MVP implementation proved the main chain can work:

```text
manual pain / hook evidence
  -> candidate principle
  -> owner review
  -> activation
  -> prompt / RuleHost / defer_archive behavior surface
```

The weak point is signal quality. In real use, manual pain recording works, but automatic capture is too noisy or too weak:

- Tool failures are often infrastructure noise, not behavior pain.
- Empathy-style language detection is valuable but unsafe as an automatic diagnosis trigger.
- RuleHost blocks are evidence, but not necessarily new pain.
- Missing behavior, such as "agent did not pause to clarify", is hard to observe from single events.
- Historical smoke/demo data has polluted production workspaces before.

The next iteration should therefore introduce an admission layer before diagnosis. The layer decides whether evidence becomes a diagnostic task, stays as evidence, joins an episode, or needs owner confirmation.

## Relation To ADR-0015

ADR-0015 proposes:

```text
RawObservation -> PainEvidence -> PainSignal -> PainEpisode
```

This track adopts that model with one MVP restriction: GAP-aligned objectives and task-mission scoring remain out of scope until post-MVP restart conditions are met.

ADR-0010 / GAP concepts must not be implemented in this track. If a design or issue starts introducing objectives, missions, OKR fit, BALM, PRRR, or training channels, stop and get owner approval.

## Safety Policy

### Branch And Install Policy

This feature line is experimental and must be isolated.

- Implement on a dedicated feature branch, not directly on `main`.
- Do not install the feature branch into the owner's production OpenClaw environment by default.
- Use a disposable or explicitly designated dogfood workspace for feature validation.
- Only install into the production OpenClaw environment after the release gate in this document passes.
- Do not write synthetic/demo/smoke data into `D:\.openclaw\workspace`.

### Emergency Hotfix Policy

Small independent bugs discovered during dogfood may be fixed on `main` only if all are true:

- The bug affects the currently installed PD environment or a merged MVP feature.
- The fix is small, isolated, and reversible.
- The fix does not depend on the pain evidence admission feature branch.
- The bug is reproducible and has a concrete verification command or live check.

Eligible examples:

- Plugin fails to load.
- Console crashes on a normal page.
- Runtime V2 chain corrupts data.
- Feedback draft API cannot write local drafts.
- A security/privacy boundary leaks secrets or raw prompt/chat/trajectory.

Not eligible as emergency hotfixes:

- New pain source kinds.
- Admission policy tuning.
- UI polish.
- Observer prompt improvements.
- Episode aggregation.
- Any behavior that changes diagnosis trigger policy.

## Core Terms

### RawObservation

An untrusted event from a source adapter. It may come from OpenClaw hooks, CLI commands, manual owner actions, feedback drafts, RuleHost, empathy observer, correction observer, or future connectors.

Raw observations are never sent directly to the Diagnostician.

### PainEvidence

A validated, sanitized, bounded record derived from a raw observation.

Evidence must include:

- `evidenceId`
- `sourceKind`
- `observedAt`
- `workspaceRef`
- bounded summary
- privacy classification
- source-specific normalized fields
- unavailable/degraded reasons if enrichment failed

Evidence must not include:

- raw prompt
- raw chat
- raw trajectory
- full local paths
- file contents
- env vars
- tokens or API keys
- unbounded stack traces

### PainSignal

An admitted pain item that is eligible to trigger diagnosis or owner review.

Signals are created only after admission policy approves the evidence or episode.

### PainEpisode

A bounded aggregation of related evidence and signals. Episodes are for patterns that require recurrence before diagnosis, such as repeated owner correction or repeated ignored instructions.

### AdmissionDecision

The output of the admission controller:

- `reject`
- `store_evidence_only`
- `store_signal`
- `aggregate_into_episode`
- `owner_confirmation_required`

Every decision must include `reason`, `nextAction`, and bounded evidence references.

### TriggerDecision

The output of the trigger controller:

- `no_diagnosis`
- `create_diagnostic_task`
- `update_episode`
- `request_owner_confirmation`

The trigger controller is the only component allowed to create diagnostic tasks.

## Source Classification

| Source | Default admission | Diagnosis trigger | Notes |
| --- | --- | --- | --- |
| Owner explicit manual record | `store_signal` | yes | Highest-confidence MVP path. |
| Owner explicit console feedback | `store_signal` or `owner_confirmation_required` | yes after owner intent is clear | Feedback text is owner-authored but still privacy-bounded. |
| Agent records pain at owner's request | `store_signal` | yes | Must preserve that owner asked for the record. |
| Code review finding | `store_signal` | yes | If tied to behavior/quality failure, useful for dogfood. |
| Repeated owner intervention | `aggregate_into_episode` | yes only after recurrence threshold | Good candidate for non-manual discovery. |
| Ignored explicit instruction | `aggregate_into_episode` or `store_signal` | depends on explicitness | Single events are risky; repeated pattern is stronger. |
| Scope drift | `aggregate_into_episode` | only after recurrence | Avoid noisy one-off diagnosis. |
| Unsafe action attempt | `store_signal` | yes for high confidence | RuleHost/security blocks can be direct when risk is clear. |
| RuleHost block / near miss | `store_evidence_only` or `aggregate_into_episode` | no by default | Blocks are evidence unless owner pain is clear. |
| Tool failure | `store_evidence_only` or `aggregate_into_episode` | no by default | Most tool failures are infra noise. |
| Provider/rate-limit failure | `store_evidence_only` | no by default | Should inform health/config UX, not principle generation. |
| Subagent dispatch failure | `store_evidence_only` or `aggregate_into_episode` | no by default | Not a principle unless repeated behavior failure emerges. |
| Empathy inferred frustration | `owner_confirmation_required` or `aggregate_into_episode` | no direct trigger | Useful, but never silently creates principles. |
| Correction observer output | `store_evidence_only` | no direct trigger | It tunes source quality; it is not user pain by itself. |

## Architecture Target

Keep the stable external facade where practical, but split the internals:

```mermaid
flowchart TD
  A["OpenClaw hook / CLI / Console / Feedback / Observer"] --> B["RawObservation adapter"]
  B --> C["Evidence validator and sanitizer"]
  C --> D["PainEvidence"]
  D --> E["Pain assessor"]
  E --> F["Admission controller"]
  F --> G["Evidence ledger"]
  F --> H["Episode correlator"]
  H --> G
  F --> I["Trigger controller"]
  I --> J["Diagnostician task"]
  I --> K["Owner confirmation queue"]
  G --> L["Console evidence view"]
```

### Proposed Modules

The exact file names may change after code exploration, but responsibilities should remain stable.

| Module | Responsibility |
| --- | --- |
| `pain-evidence-types` | Type definitions for RawObservation, PainEvidence, PainSignal, PainEpisode, AdmissionDecision, TriggerDecision. |
| `pain-source-descriptors` | Registry of supported source kinds and their default admission policy. |
| `observation-normalizer` | Converts existing hook/manual payloads into RawObservation. |
| `evidence-validator` | Unknown-first runtime validation, redaction, bounding, and privacy classification. |
| `pain-assessor` | Computes severity, owner relevance, repeatability, and confidence from evidence. |
| `admission-controller` | Decides reject/evidence-only/signal/episode/confirmation. |
| `episode-correlator` | Groups repeated evidence by bounded correlation keys. |
| `trigger-controller` | Decides if and when to create diagnostic tasks. |
| `pain-evidence-read-model` | Console/CLI-safe summary of evidence, signals, episodes, and trigger decisions. |

### Core / Plugin Boundary

Pure policy and validation should live in core-style modules and use unknown-first validation.

OpenClaw-specific I/O remains in the plugin boundary:

- Hook context parsing.
- OpenClaw session references.
- Gateway/provider diagnostics.
- Live event-log writing.

Persistence must use the existing Runtime V2 storage conventions and must be reviewed against architecture-regression tests. Do not add ad hoc side databases or write scripts that pollute `D:\.openclaw\workspace`.

## Implementation Phases

### Phase 0: OpenClaw Read-Only Inventory

Purpose: collect enough real data to design source adapters without coding.

OpenClaw should inspect:

- Current pain signal tables and event logs.
- Current feedback drafts.
- Recent RuleHost events.
- Recent tool failures.
- Recent provider/rate-limit failures.
- Empathy/correction observer state and logs.
- Current console-visible pain/principle data.

Output must be a markdown report only. It must not mutate state.

Required classification:

- Which events are behavior pain?
- Which are infrastructure/config health?
- Which are evidence-only?
- Which should require owner confirmation?
- Which are historical/test pollution?

### Phase 1: Core Contracts And Descriptor Registry

Build types and source descriptors first. No production trigger behavior changes.

Acceptance criteria:

- Every source kind has an explicit default admission policy.
- Unknown inputs are validated without `as` bypasses.
- Tool failure and provider failure default to evidence-only.
- Owner manual reports default to signal.
- Empathy-inferred frustration cannot directly create a diagnostic task.

### Phase 2: Admission And Trigger Policy

Implement pure admission and trigger controllers.

Acceptance criteria:

- Admission returns structured `reason` and `nextAction`.
- Diagnosis can only be created through trigger controller.
- Repeated weak evidence can aggregate into an episode.
- Rejected evidence is observable and bounded.
- No GAP/objective/mission scoring appears in code.

### Phase 3: Existing Facade Integration

Refactor `PainToPrincipleService.recordPain()` and the existing bridge path to use the admission pipeline internally.

Acceptance criteria:

- Manual `/pd-pain` and CLI pain record still work.
- Existing MVP path still creates diagnostic task for owner-explicit pain.
- Tool failures no longer create direct diagnosis unless policy explicitly allows it.
- All degraded paths include reason and next action.
- Existing lineage/evidence references are preserved or explicitly migrated.

### Phase 4: OpenClaw Source Adapters

Split OpenClaw hook capture from admission/trigger.

Acceptance criteria:

- `after_tool_call` captures evidence but does not own diagnosis policy.
- RuleHost blocks become evidence with source kind and bounded action summary.
- Provider/rate-limit failures become health/config evidence, not principle pain.
- Empathy observer output requires confirmation or recurrence before diagnosis.
- No raw prompt/chat/trajectory is stored in evidence.

### Phase 5: Persistence And Console Observability

Expose the pipeline to the owner.

Acceptance criteria:

- Console can show Evidence, Signals, Episodes, and Diagnosis Created as separate states.
- Owner can understand why a piece of evidence did not become a principle.
- Evidence records include source, reason, next action, and privacy notes.
- Historical/test data can be filtered or quarantined from production views.

### Phase 6: Dogfood Release Gate

Before merging to `main` or installing into production OpenClaw:

- Run unit tests for all policy modules.
- Run production-path tests for manual pain, tool failure, RuleHost block, and empathy inferred evidence.
- Run console/read-model tests.
- Run `npm run verify:merge`.
- Install into a disposable OpenClaw workspace and run a live dogfood task.
- Confirm no synthetic/test data is written to `D:\.openclaw\workspace`.
- Confirm no new automatic diagnosis is created from provider/rate-limit/tool failure alone.
- Confirm owner manual pain still creates a valid diagnostic task.

## Test Strategy

Minimum test classes:

- Source descriptor registry tests.
- Unknown-first validator tests.
- Redaction/bounding/privacy tests.
- Admission policy tests.
- Episode correlation tests.
- Trigger controller tests.
- Existing manual pain production-path tests.
- Existing OpenClaw hook production-path tests.
- Console read-model tests.

Required negative tests:

- Raw prompt/chat/trajectory is rejected or redacted.
- Full absolute paths are not surfaced.
- Token-like strings are redacted.
- Tool failure does not directly create diagnosis by default.
- Provider rate-limit does not create principle candidate.
- Empathy-inferred frustration cannot directly create diagnostic task.
- Malformed evidence fails loud with reason and next action.

## Linear Work Breakdown

Create these only after owner accepts this design.

### PEAT-0: Read-only pain source inventory

Owner: OpenClaw.

No code. Produce inventory report and classification table.

### PEAT-1: Pain evidence contracts and source descriptors

Owner: OpenClaw.

Implement core contracts and tests. No production wiring.

### PEAT-2: Admission and trigger controllers

Owner: OpenClaw.

Implement pure policy and tests.

### PEAT-3: PainToPrincipleService integration

Owner: OpenClaw.

Refactor existing facade to call admission/trigger path.

### PEAT-4: OpenClaw source adapters

Owner: OpenClaw.

Move hook-specific source mapping into adapters.

### PEAT-5: Evidence persistence and console read model

Owner: OpenClaw.

Persist evidence/admission/episode state and expose safe owner-facing read model.

### PEAT-6: Dogfood release gate

Owner: OpenClaw plus owner live validation.

Run disposable workspace smoke, then owner decides whether the feature line can merge/install.

## OpenClaw Phase 0 Instruction

Use this exact instruction for the first read-only inventory task:

```text
Task: PEAT-0 — Read-only pain source inventory for PD pain evidence admission redesign

Repository: D:\Code\principles

Do not modify files. Do not write to D:\.openclaw\workspace except temporary files under a clearly named scratch directory, and delete them before finishing. Do not create PR.

Read:
- PRODUCT_IDENTITY.md
- docs/adr/0014-mvp-first-strategy-and-product-pivot.md
- docs/adr/0015-pain-signal-model-unification.md
- docs/adr/0010-goal-aligned-pain-signal.md
- docs/plans/2026-06-pain-evidence-admission-track.md
- docs/ERROR_PATTERN_INDEX.md
- relevant ERR handbook entries for runtime validation, silent fallback, stale state, privacy/preview, and lineage

Inspect current implementation:
- packages/principles-core/src/runtime-v2/types/pain-signal.ts
- packages/principles-core/src/runtime-v2/pain-to-principle-service.ts
- packages/principles-core/src/runtime-v2/pain-signal-bridge.ts
- packages/principles-core/src/runtime-v2/pain-signal-observability.ts
- packages/openclaw-plugin/src/hooks/pain.ts
- packages/openclaw-plugin/src/commands/pain.ts
- packages/principles-core/src/runtime-v2/observer/empathy-observer.ts
- packages/principles-core/src/runtime-v2/observer/correction-observer.ts

Inspect local runtime data read-only:
- D:\.openclaw\workspace\.pd\
- D:\.openclaw\workspace\.state\
- D:\.openclaw\workspace\.principles\
- recent OpenClaw session/event logs if present

Produce a markdown report with:
1. Current automatic and manual pain sources.
2. Which sources created real useful signals.
3. Which sources created noise.
4. Which sources are infrastructure/config health, not principle pain.
5. Which sources should be evidence-only by default.
6. Which sources should require owner confirmation.
7. Which sources are safe to trigger diagnosis directly.
8. Privacy risks observed in current payloads.
9. Suggested source descriptor table for PEAT-1.
10. Any small independent PD bug suitable for emergency hotfix, clearly separated from the feature redesign.

Do not implement fixes unless explicitly asked after the report.
```

## Open Questions

These must be resolved before Phase 3 production wiring:

1. Should evidence persistence be a new table or an extension of existing pain signal state?
2. What is the retention/quarantine policy for evidence-only records?
3. Should Console rename the owner-facing page from "Pain" to "Evidence" or keep both terms?
4. What recurrence threshold should turn weak evidence into an episode?
5. What owner UX should confirm empathy-inferred frustration?
6. Which workspace is the official disposable dogfood workspace for feature validation?

## Explicit Non-Goals

Do not implement in this track:

- GAPSignalGenerator.
- Objective/mission/OKR scoring.
- Attribution pipeline.
- PRRR or source calibration automation beyond recording admission reasons.
- BALM, LRAS, Trainer, model_training, or skill channels.
- New activation channels.
- Hardcoded "confirm-first" or `PLAN.md` gate.
- Automatic upload of logs, prompts, chats, or trajectories.

