# Sleep-Mode Reflection System Executable Architecture

> Status: Ready for implementation planning
> Date: 2026-03-27
> Scope: Principles Disciple + OpenClaw local small-model worker integration

## 1. Decision Summary

This system will not try to replace the main agent with a local small model.

Instead, the system will use a layered architecture:

1. The main agent remains the orchestrator.
2. Local small-model agents become constrained execution workers.
3. Nocturnal reflection generates decision-point training pairs for those workers.
4. Model behavior, task routing, and safety remain code-governed outside the model.

This is the only architecture that is currently stable enough to ship.

## 2. Product Goal

Distill a subset of Principles Disciple behavior into local small models so that OpenClaw can delegate bounded execution tasks to local worker agents with lower cost and lower latency, while preserving quality through external routing, validation, and rollback.

## 3. Non-Goals

Do not attempt these in Phase 1:

- Replacing the main orchestrator with a local small model
- Allowing the worker model to self-grade or self-promote
- Training one dataset for all model families at once
- Using free-form ideal trajectories as the primary training unit
- Mixing pain diagnosis tasks and nocturnal reflection tasks in one runtime path

## 4. Core Design Corrections

### 4.1 Two Different Loops

The current design must split two loops that are currently entangled:

1. Online pain diagnosis loop
   - Triggered by pain, failure, gate, or user correction
   - Produces principles and immediate mitigations
   - User-visible when needed

2. Offline nocturnal distillation loop
   - Triggered only when workspace is idle and quotas allow
   - Produces training pairs and reflection summaries
   - Never hijacks the live user conversation

These loops may share storage, but they must not share queue semantics.

### 4.2 Four Distinct Truths

The design must separate these states:

1. `sample_generated`
   - A reflection pair was produced and passed Arbiter.

2. `sample_included_in_train_run`
   - A training run consumed the sample.

3. `checkpoint_deployed`
   - A resulting adapter/checkpoint is routable in OpenClaw.

4. `behavior_internalized`
   - The deployed worker improves on holdout evaluation with reduced prompt assistance.

Without this separation, the system will confuse "we generated data" with "the model learned."

### 4.3 Principle Evaluability

Only principles that can be checked mechanically may enter the automatic training loop.

There are two classes:

1. `T-xx` thinking models
   - Evaluated via deterministic detectors, heuristics, or tool-sequence checks

2. `P_xxx` evolution principles
   - Must carry structured detector metadata before they can enter automatic distillation

If a `P_xxx` principle has only natural-language trigger/action text, it stays prompt-only and review-only.

## 5. Revised Runtime Architecture

## 5.1 Main Agent

Responsibilities:

- Understand the user task
- Decide whether to delegate
- Choose worker profile / lane
- Define bounded acceptance criteria
- Review worker output
- Decide retry, escalate, or rollback

The main agent is the only agent allowed to make high-entropy planning decisions in Phase 1.

## 5.2 Local Worker Agents

Responsibilities:

- Execute bounded code-reading or code-editing tasks
- Follow strong execution prompts
- Return structured output
- Never self-authorize unsafe actions

Suitable task types:

- focused code reading
- constrained edits
- run-and-summarize
- checklist verification
- localized repair

Unsuitable task types:

- broad architecture design
- ambiguous debugging across multiple subsystems
- self-directed refactor discovery
- high-risk change planning

## 5.3 Nocturnal Reflection Service

Responsibilities:

- select one target principle and one violating session
- extract a structured trajectory snapshot
- produce decision-point contrastive samples
- run deterministic validation
- enqueue approved samples into the training dataset
- write short-term reflection memory separately from training data

## 5.4 Training Pipeline

Responsibilities:

- consume only approved samples for one target model family
- train adapters for local worker profiles
- record dataset lineage and training lineage
- publish a deployable checkpoint artifact

## 5.5 Deployment Registry

Responsibilities:

- map worker profile -> model family -> checkpoint -> routing policy
- expose which local model a worker lane uses
- preserve rollback to previous known-good checkpoint

This registry must exist before automatic promotion is allowed.

## 6. Required Pre-Implementation Refactors

These are prerequisites, not optional enhancements.

### 6.1 Queue V2

Create a queue schema that supports multiple task kinds.

Required fields:

```ts
interface RuntimeTask {
  taskId: string;
  taskKind: 'pain_diagnosis' | 'sleep_reflection' | 'model_eval';
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';
  priority: 'high' | 'medium' | 'low';
  source: string;
  traceId: string;
  sessionId?: string;
  targetPrincipleId?: string;
  targetModelFamily?: string;
  retryCount: number;
  maxRetries: number;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
  resultRef?: string;
}
```

Rules:

- `pain_diagnosis` remains user-adjacent
- `sleep_reflection` remains background-only
- prompt injection reads only `pain_diagnosis`
- HEARTBEAT flow remains only for `pain_diagnosis`

### 6.2 Idle Source of Truth

Do not introduce a parallel `.last_active.json` as the primary runtime truth.

Use existing session tracking first:

- `SessionState.lastActivityAt`
- `listSessions(workspaceDir)`
- trajectory timestamps as secondary validation only

Recommended implementation:

- add a small `nocturnal-runtime.json` for cooldown and quota bookkeeping
- compute idleness from active session states
- use trajectory timestamps only as a guardrail, not the primary source

### 6.3 Reflection Output Split

Split reflection outputs into separate channels:

1. `memory/reflection-log.md`
   - short, operator-facing lessons
   - injected into prompt

2. `.state/nocturnal/samples/*.json`
   - structured reflection artifacts
   - not injected into prompt

3. `.state/exports/orpo/*.jsonl`
   - approved training pairs
   - immutable once exported

Do not mix `deep_reflect` output and nocturnal training summaries in the same logical feed.

### 6.4 Internalization Tracking V2

Replace the current "trainingSamples implies progress" assumption with explicit training lineage.

Required fields:

```ts
interface PrincipleTrainingState {
  principleId: string;
  evaluability: 'deterministic' | 'weak_heuristic' | 'manual_only';
  applicableOpportunityCount: number;
  observedViolationCount: number;
  complianceRate: number;
  violationTrend: number;
  generatedSampleCount: number;
  approvedSampleCount: number;
  includedTrainRunIds: string[];
  deployedCheckpointIds: string[];
  lastEvalScore?: number;
  internalizationStatus:
    | 'prompt_only'
    | 'needs_training'
    | 'in_training'
    | 'deployed_pending_eval'
    | 'internalized'
    | 'regressed';
}
```

### 6.5 Structured Principle Metadata for `P_xxx`

Extend diagnostician-created principles with machine-checkable metadata.

Required metadata:

```ts
interface PrincipleDetectorSpec {
  applicabilityTags: string[];
  positiveSignals: string[];
  negativeSignals: string[];
  toolSequenceHints: string[][];
  confidence: 'high' | 'medium' | 'low';
}
```

If a generated principle lacks this metadata, it may not enter automatic nocturnal targeting.

### 6.6 Dataset and Model Lineage

Every approved sample must record:

- source session
- target principle
- target model family
- generator model/profile
- artifact fingerprint
- review status

Every training run must record:

- base model family
- dataset fingerprint
- sample count
- config fingerprint
- output checkpoint id
- evaluation result

Without lineage, rollback and blame assignment are impossible.

## 7. Revised Data and Evaluation Strategy

## 7.1 Training Unit

Use decision-point samples as the default training unit.

Each sample should answer one bounded question:

- "Given this situation and missing evidence, what should the next step be?"
- "Given this failure signal, what should happen before retry?"
- "Given this planned edit, what must be checked first?"

Do not use whole-session "perfect trajectories" as the main dataset in Phase 1.

## 7.2 Evaluation Hierarchy

Use three levels of evaluation:

1. Sample-level validation
   - schema valid
   - executable references valid
   - target principle actually addressed

2. Checkpoint-level offline eval
   - holdout decision set
   - prompt-assisted and reduced-prompt conditions

3. Runtime shadow eval
   - worker output reviewed by main agent
   - no auto-promotion without success window

## 7.3 Opportunity-Based Compliance

Compliance must be computed over applicable opportunities, not all recent sessions.

Examples:

- `T-01` applies to most non-trivial edit tasks
- `T-05` applies only to risky operations
- `T-09` applies only above a complexity threshold

This is mandatory, otherwise low-frequency high-severity principles will be incorrectly deprioritized.

## 8. OpenClaw Routing Model

## 8.1 Routing Contract

PD does not dynamically choose a model per call in code.

PD chooses:

- worker role
- lane/profile
- task constraints

OpenClaw configuration chooses:

- local model family for that worker role
- adapter/checkpoint used by that role

Therefore the development contract is:

1. train a model for a named worker profile
2. register that checkpoint in the deployment registry
3. bind an OpenClaw worker lane/profile to that checkpoint
4. let the main agent delegate only compatible tasks

## 8.2 First Supported Worker Profiles

Phase 1 should support only two profiles:

1. `local-reader`
   - code reading
   - evidence gathering
   - small summaries

2. `local-editor`
   - bounded file edits
   - deterministic checklists
   - small repair loops

Do not add a `local-architect` profile in the first implementation.

## 9. Anti-Drift Execution Rules for Coding Agents

All implementation work should follow these controls:

1. One phase per branch or tightly grouped PR series.
2. One task should change one subsystem unless explicitly marked integration.
3. No task may modify routing, training, and evaluation in one shot.
4. Every task must list:
   - exact files
   - out-of-scope items
   - acceptance checks
   - rollback plan
5. No auto-promotion of checkpoints in Phase 1.
6. Human or orchestrator review remains mandatory at all integration gates.

## 10. Development Readiness Gate

The design may enter implementation only when these are accepted as scope:

- Queue V2 instead of reusing the pain-only queue semantics
- opportunity-based compliance instead of session-average compliance
- prompt memory separated from training artifacts
- structured detector metadata for auto-trainable `P_xxx`
- explicit train/deploy/eval lineage
- main-agent orchestrator remains in place
- local worker model scope limited to bounded execution tasks

If any of the above is deferred, the project should not begin with Trinity or LoRA training.

## 11. Recommended Phase Order

1. Runtime substrate hardening
2. Nocturnal sample generation MVP
3. Offline evaluation harness
4. Local worker routing integration
5. First local-model training cycle
6. Deployment registry and gated rollout

This order minimizes false confidence and prevents dataset pollution before the runtime is ready.
