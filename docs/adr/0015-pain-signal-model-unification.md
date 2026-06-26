# ADR-0015: Pain Evidence Ingestion and Admission Model

> **Status**: Proposed
> **Date**: 2026-05-30
> **Related**: ADR-0010 (GAP, deferred by ADR-0014), ADR-0014 (MVP Pivot), docs/product/PRODUCT_IDENTITY.md, DOMAIN_MODEL.md, Series 03 (Biological Forward Pass)

## 1. Context

PD's value depends on a steady stream of owner-relevant behavioral evidence entering the internalization pipeline:

```text
behavior evidence -> diagnosis -> principle proposal -> owner review
-> reversible activation -> observable later behavior
```

The current pain mechanism proves that the pipeline can be triggered, but it does not yet make the signal sources durable enough for post-MVP use:

- `painType` compresses several different sources into `tool_failure | subagent_error | user_frustration`.
- Hook code mixes raw event capture, scoring, observability writes, gate checks, and diagnostic task creation.
- Low-value technical friction and high-value owner feedback are both represented as a single `score`.
- Multiple weak observations cannot reliably aggregate into one behavior-pattern signal.
- There is no first-class admission decision explaining why an observation was rejected, stored as evidence only, or allowed to trigger diagnosis.
- There is no quality feedback loop showing which signal sources produce approved principles versus noise.

The design goal is not simply to add more `PainSignalKind` values. It is to make pain intake a governed evidence system: diverse inputs should flow in, but only validated, explainable, owner-relevant evidence should become diagnostic work.

### 1.1 Scope Boundary

This ADR does **not** implement ADR-0010 GAP expansion. `GAPSignalGenerator`, Objective/KeyResult/Mission tables, and goal-driven Layer 1 generation remain post-MVP conditional work under ADR-0014.

This ADR may still use the words "goal", "owner relevance", and "behavioral scope" as classification dimensions for current evidence. Those dimensions must not require an OKR subsystem or MissionScheduler.

### 1.2 Relevant Error Handbook Entries

- **ERR-001 / ERR-005 / ERR-009**: Raw observations, parsed JSON, LLM output, and artifact metadata must enter as `unknown` and be validated field-by-field. Malformed required fields fail loud.
- **ERR-002**: Admission rejection and graceful degradation must carry structured reasons. Silent fallback is a bug.
- **ERR-024 / ERR-025 / ERR-048**: Tests must exercise the production intake and consumption path, not only isolated helpers.
- **ERR-014 / ERR-017**: Evidence previews must be bounded and safely serialized.

## 2. Decision

Introduce a four-stage evidence model:

```text
RawObservation
  -> PainEvidence
  -> PainSignal
  -> PainEpisode
```

The existing `PainToPrincipleService.recordPain()` remains the public service entry point for current callers, but internally it becomes an intake orchestrator rather than a monolithic scorer/writer. The service records structured admission decisions and delegates validation, assessment, correlation, persistence, and triggering to smaller units.

Pain evidence is the input fact layer for the full PD loop. It is not merely a trigger for Diagnostician:

```text
PainEvidence / PainEpisode
  -> Diagnostician explains the behavior pattern
  -> Dreamer/Scribe/Artificer form a candidate principle
  -> owner reviews the evidence-backed candidate
  -> activation changes prompt / RuleHost / defer_archive state
  -> later observations produce outcome verdicts
  -> verdicts calibrate source quality and trigger policy
```

This ADR therefore optimizes pain intake for three system-level jobs:

1. **Fact capture**: preserve enough validated context to explain what happened.
2. **Lineage anchor**: connect evidence to diagnosis, candidate, approval, activation, and later observation.
3. **Source calibration**: learn which sources produce useful owner-approved behavior changes and which produce noise.

## 3. Domain Model

### 3.1 RawObservation

`RawObservation` is an untrusted event from a source adapter. It may come from a hook, CLI command, review integration, RuleHost event, owner message, or agent self-report.

```typescript
interface RawObservation {
  sourceKind: RawObservationSourceKind;
  observedAt: string;
  workspaceId?: string;
  sessionId?: string;
  traceId?: string;
  payload: unknown;
}
```

Rules:

- `payload` is always `unknown`.
- Source adapters validate only enough to identify the source and capture bounded context.
- No raw observation directly creates a diagnostic task.

### 3.2 PainEvidence

`PainEvidence` is a validated, sanitized, bounded evidence record. It can be stored without triggering diagnosis.

```typescript
interface PainEvidence {
  evidenceId: string;
  sourceKind: PainEvidenceSourceKind;
  provenance: PainProvenance;
  sourceClass: PainSourceClass;
  behavioralScope: BehavioralScope;
  pdResponsibility: PdResponsibility;
  summary: string;
  detailsPreview?: string;
  subjectRef?: string;
  errorHash?: string;
  ownerQuoteRef?: string;
  lineageRefs: PainLineageRefs;
  observedAt: string;
  validationNotes: string[];
}
```

`detailsPreview` must use safe bounded serialization. Full raw payloads are not stored by default.

### 3.3 PainSignal

`PainSignal` is admitted evidence that is strong enough to enter the diagnosis candidate set directly or as part of an episode.

```typescript
interface PainSignal {
  painId: string;
  kind: ActivePainSignalKind;
  assessment: PainAssessment;
  evidenceIds: string[];
  admission: AdmissionDecision;
  lineageRefs: PainLineageRefs;
  createdAt: string;
}
```

`PainSignal.kind` contains only active, processable values. Deferred GAP kinds are not part of the production schema until their restart conditions are met.

### 3.4 PainEpisode

`PainEpisode` groups related evidence and signals into one behavior-pattern instance.

```typescript
interface PainEpisode {
  episodeId: string;
  episodeKind: PainEpisodeKind;
  evidenceIds: string[];
  signalIds: string[];
  assessment: PainAssessment;
  triggerDecision: TriggerDecision;
  lineageRefs: PainLineageRefs;
  createdAt: string;
  updatedAt: string;
}
```

Episodes are the preferred bridge from low-level friction to PD's core value: identifying repeated, owner-relevant behavior patterns rather than reacting to every isolated failure.

### 3.5 Lineage References

Pain records must be usable as the stable anchor for the whole PD data pipeline:

```typescript
interface PainLineageRefs {
  sessionId?: string;
  traceId?: string;
  toolCallId?: string;
  reviewCommentId?: string;
  gateDecisionId?: string;
  diagnosticTaskId?: string;
  candidateId?: string;
  principleId?: string;
  activationId?: string;
  laterObservationIds?: string[];
}
```

Lineage fields are optional because not every source has every reference. When present, each field must come from the same source context as the evidence, not from a later inferred substitute.

## 4. Classification Dimensions

### 4.1 Source Class

```typescript
type PainSourceClass =
  | 'owner_reported'
  | 'review_observed'
  | 'system_observed'
  | 'agent_self_reported';
```

This answers "who or what observed the problem?"

### 4.2 Provenance

```typescript
type PainProvenance =
  | 'owner_explicit_cli'
  | 'owner_explicit_chat'
  | 'agent_recorded_on_owner_request'
  | 'reviewer_reported'
  | 'rulehost_observed'
  | 'hook_observed'
  | 'llm_inferred';
```

This answers "how trustworthy and context-bound is the observation?" Manual entry points may share a signal kind, but they must preserve provenance.

### 4.3 Behavioral Scope

```typescript
type BehavioralScope =
  | 'single_event'
  | 'repeated_pattern'
  | 'workflow_breakdown'
  | 'owner_alignment';
```

This answers "does this describe a one-off failure or a behavior pattern worth internalizing?"

### 4.4 PD Responsibility

```typescript
type PdResponsibility =
  | 'owner_alignment'
  | 'behavior_internalization'
  | 'tool_repair_noise'
  | 'unclear';
```

This answers "why is this PD's job?" Technical severity alone is insufficient. Evidence classified as `tool_repair_noise` may still be stored for context, but it should not drive principle generation without additional owner-relevant evidence.

### 4.5 Assessment

A single score is retained only as a derived value. Internal admission uses explicit components:

```typescript
interface PainAssessment {
  impact: number;         // 0-100
  confidence: number;     // 0-100
  recurrence: number;     // 0-100
  ownerRelevance: number; // 0-100
  finalScore: number;     // derived, used for sorting and thresholds
  reasons: string[];
}
```

`ownerRelevance` is first-class because PD does not own general tool repair. A severe technical error with no owner-relevant behavior pattern may remain evidence-only.

## 5. Active Signal Kinds

The active schema should prioritize behavior evidence that can plausibly become an owner-reviewed principle:

| Kind | Typical source | Default trigger posture |
|------|----------------|-------------------------|
| `owner_reported` | explicit owner complaint or correction | direct |
| `review_finding` | PR/code review finding about agent behavior | direct |
| `repeated_intervention` | owner repeatedly interrupts or redirects same behavior | aggregate |
| `ignored_instruction` | agent ignores explicit project/user constraint | aggregate or direct |
| `scope_drift` | agent expands work beyond request | aggregate |
| `unsafe_action_attempt` | attempted irreversible/high-risk action without proper confirmation | direct |
| `near_miss_blocked` | RuleHost or gate prevented a risky action | evidence or aggregate |
| `stale_context_use` | agent relies on outdated context after fresher context exists | aggregate |
| `tool_failure` | command/tool failure | evidence or aggregate |
| `dispatch_error` | runner/subagent dispatch failure | evidence or aggregate |
| `subagent_error` | subagent workflow failure | aggregate unless owner-visible |
| `empathy_inferred` | inferred frustration from language model or keyword observer | owner confirmation or aggregate |

Deferred GAP kinds such as `goal_drift` and `mission_stalled` remain documented in ADR-0010 and the post-MVP roadmap, not in the active runtime schema.

## 6. Descriptor Registry

Replace a pure `scoreStrategy` registry with an admission descriptor registry:

```typescript
interface PainEvidenceDescriptor {
  kind: ActivePainSignalKind;
  sourceClass: PainSourceClass;
  acceptedProvenance: PainProvenance[];
  behavioralScope: BehavioralScope;
  evidenceSchema: EvidenceSchema;
  assessmentPolicy: AssessmentPolicy;
  admissionPolicy: AdmissionPolicy;
  triggerPolicy: TriggerPolicy;
  description: string;
}
```

Descriptor invariants:

- Every active signal kind has exactly one descriptor.
- Descriptors are declarative policy, not hidden business logic.
- Production schema accepts only active kinds with descriptors.
- Unknown or malformed source observations return a structured rejection reason.

## 7. Admission and Trigger Policies

### 7.1 AdmissionDecision

```typescript
type AdmissionDecision =
  | { action: 'reject'; reason: string; nextAction?: string }
  | { action: 'store_evidence_only'; reason: string }
  | { action: 'store_signal'; reason: string }
  | { action: 'aggregate_into_episode'; reason: string; episodeKey: string };
```

Admission is separate from triggering. A valid observation can be valuable evidence without deserving immediate diagnosis.

### 7.2 TriggerPolicy

```typescript
type TriggerPolicy =
  | { mode: 'direct' }
  | { mode: 'aggregate_only'; window: string; threshold: number }
  | { mode: 'evidence_only' }
  | { mode: 'owner_confirmation_required' };
```

Examples:

- `owner_reported`: `direct`
- `review_finding`: `direct`
- `tool_failure`: `aggregate_only`
- `near_miss_blocked`: `evidence_only` or `aggregate_only`
- `empathy_inferred`: `owner_confirmation_required` or `aggregate_only`

This replaces a coarse `canTriggerDiagnostic` boolean.

## 8. Intake Pipeline

```text
1. Capture RawObservation from hook, CLI, review, RuleHost, or observer.
2. Validate and sanitize into PainEvidence.
3. Classify PD responsibility and behavioral scope.
4. Assess impact, confidence, recurrence, and owner relevance.
5. Deduplicate and correlate against recent evidence.
6. Apply AdmissionPolicy.
7. Persist admission decision, evidence, and optional signal.
8. Apply TriggerPolicy.
9. Create or update PainEpisode when weak signals accumulate.
10. Create diagnostic task only when policy allows.
11. Carry evidence lineage into candidate, owner review, and activation records.
12. Later record outcome verdict for source calibration.
```

`PainToPrincipleService.recordPain()` remains the stable facade for existing callers, but the internal flow should be decomposed into testable units:

- `ObservationNormalizer`
- `EvidenceValidator`
- `PainAssessor`
- `EvidenceCorrelator`
- `AdmissionController`
- `PainEvidenceStore`
- `TriggerController`
- `PainSourceCalibrator`

The facade must return enough structured information for operators and tests to distinguish rejected, evidence-only, signal-created, episode-updated, and diagnosis-created outcomes.

## 9. Downstream Lineage Contract

Pain evidence must remain visible beyond intake. Each downstream stage has a minimum contract:

| Stage | Required relationship to pain evidence |
|-------|----------------------------------------|
| Diagnostician | Reads admitted signals or episodes, not raw observations |
| Candidate formation | Records source `evidenceIds` / `episodeId` in candidate lineage |
| Owner review | Presents the evidence summary and why PD cares |
| Activation | Preserves source candidate/principle linkage |
| Later observation | Can reference the principle or activation being evaluated |
| Calibration | Uses owner verdict and later outcomes to score source quality |

This prevents the pipeline from becoming "pain triggered a task" followed by detached artifacts. A principle should be explainable from its source evidence, and a source should be evaluable from the principle's eventual outcome.

## 10. Source Calibration

Every signal or episode should eventually receive a verdict:

```typescript
type PainSignalVerdict =
  | 'led_to_approved_principle'
  | 'led_to_rejected_candidate'
  | 'led_to_activated_principle'
  | 'later_behavior_improved'
  | 'later_behavior_unchanged'
  | 'dismissed_noise'
  | 'duplicate'
  | 'false_positive'
  | 'deferred_insufficient_evidence';
```

Track source quality by kind and provenance:

- admitted observations
- rejected observations
- evidence-only rate
- diagnostic trigger rate
- candidate creation rate
- owner approval rate
- duplicate rate
- false-positive rate

These metrics let PD tune signal sources after MVP without guessing which observers are valuable.

## 11. Manual Entry Semantics

Manual entry points may converge on the same service path, but they must not lose provenance:

- `owner_explicit_cli`: owner ran `pd pain record`.
- `owner_explicit_chat`: owner directly expressed correction/frustration in chat.
- `agent_recorded_on_owner_request`: agent recorded a pain signal because the owner asked.

These are all owner-adjacent, but their confidence and context differ. The admission model should preserve that difference even if they share the `owner_reported` kind.

This ADR does not require deleting existing manual entry points. Removing an entry point is a product behavior change and must be decided separately.

## 12. Observability and Data Safety

- Every rejected or degraded path records a structured reason.
- Evidence previews are bounded and safe to serialize.
- Unknown payload fields are not copied wholesale into durable records.
- PII-sensitive evidence must pass the existing sanitization boundary before durable storage.
- Diagnostic tasks must reference evidence IDs, not unbounded raw payloads.
- Owner review surfaces should show why the evidence is considered PD-relevant, not only the raw reason text.

## 13. Invariants

- `PEA-1`: Raw observations never directly create diagnostic tasks.
- `PEA-2`: Active runtime schemas accept only active signal kinds with registered descriptors.
- `PEA-3`: Admission and triggering are separate decisions.
- `PEA-4`: Every rejection, evidence-only admission, and degraded path has a structured reason.
- `PEA-5`: Low-level friction may accumulate into an episode, but isolated technical friction does not automatically imply a principle-worthy behavior defect.
- `PEA-6`: Owner-relevance is explicit in assessment and cannot be inferred from technical severity alone.
- `PEA-7`: Deferred GAP concepts do not enter production kind unions until ADR-0014 restart conditions are met.
- `PEA-8`: Every diagnostic task, candidate, approval, and activation derived from pain evidence preserves evidence lineage.
- `PEA-9`: Source calibration uses downstream owner and activation outcomes, not admission-time confidence alone.

## 14. Consequences

### Positive

- Supports stable, diverse signal intake without flooding Diagnostician.
- Keeps PD focused on owner-reviewed behavior internalization rather than generic tool repair.
- Makes weak-signal aggregation explicit through episodes.
- Preserves provenance differences across manual, hook, review, RuleHost, and inferred sources.
- Provides a calibration loop so post-MVP signal quality can improve from real outcomes.
- Makes pain evidence the traceable anchor from observation to activation outcome.
- Avoids making ADR-0010/GAP a hidden dependency.

### Negative / Costs

- More model concepts than a single `PainSignal` schema.
- Requires careful UI/CLI/operator wording so "evidence only" is not mistaken for failure.
- Needs migration discipline to avoid duplicating old pain writes while adding evidence records.
- Source calibration only becomes useful after enough real owner verdicts exist.

### Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Evidence model becomes over-abstract | Keep descriptors limited to active sources and require production tests for every descriptor |
| Weak signals still flood storage | Apply dedupe, bounded previews, retention policy, and episode correlation |
| High-value owner feedback is delayed by aggregation | Use `direct` trigger policy for explicit owner/report review signals |
| Inferred empathy creates false positives | Default to confirmation or aggregate-only, track false-positive verdicts |
| Existing callers depend on `recordPain()` behavior | Preserve facade shape while expanding returned structured outcome |
| Evidence lineage becomes inconsistent across stages | Require same-source lineage fields and add chain-integrity tests |

## 15. Relationship to ADR-0010

ADR-0010 remains deferred except for already-existing pain capture used by the MVP. This ADR does not add goal-driven signal generation, mission tables, OKR models, or Layer 1 GAP kinds to runtime schemas.

If ADR-0010 restart conditions are later met, GAP can add new source adapters and descriptors to this evidence model. It should not require changing the core admission principle that raw observations first become validated evidence before triggering diagnosis.
