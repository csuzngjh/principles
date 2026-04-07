# Sleep-Mode Reflection System Implementation Checklist

> Purpose: execution checklist for coding agents
> Date: 2026-03-27
> Mode: phased delivery with strict scope control

## Controller Rules

All coding agents implementing this work must follow these rules:

1. Finish one task completely before starting the next.
2. Do not merge architecture changes and training changes in one task.
3. Do not expand scope beyond the listed files without review.
4. If a task exposes a design contradiction, stop and write it down instead of improvising a new subsystem.
5. Every task must end with code-level verification, not prose-only claims.

## Phase 0: Architecture Hardening

Goal: create a stable substrate so nocturnal reflection does not corrupt the live evolution loop.

### Task 0.1: Queue V2 schema

Files:
- Modify: `packages/openclaw-plugin/src/service/evolution-worker.ts`
- Modify: `packages/openclaw-plugin/src/hooks/prompt.ts`
- Modify: `packages/openclaw-plugin/src/hooks/subagent.ts`
- Modify: `packages/openclaw-plugin/src/core/trajectory.ts`

Deliverables:
- add `taskKind`, `priority`, `retryCount`, `maxRetries`, `lastError`
- support `failed` status
- preserve compatibility for old queue items through migration logic

Acceptance:
- pain diagnosis still works
- prompt injection only reacts to `pain_diagnosis`
- `sleep_reflection` tasks remain invisible to user-facing prompt flow

Out of scope:
- no nocturnal execution yet

### Task 0.2: Idle detection source of truth

Files:
- Modify: `packages/openclaw-plugin/src/core/session-tracker.ts`
- Add: `packages/openclaw-plugin/src/service/nocturnal-runtime.ts`
- Modify: `packages/openclaw-plugin/src/service/evolution-worker.ts`

Deliverables:
- helper to list active sessions for current workspace
- idle calculation from `lastActivityAt`
- cooldown and quota bookkeeping in `nocturnal-runtime.json`

Acceptance:
- no primary dependency on `.last_active.json`
- unit tests cover idle, cooldown, and abandoned-session cases

Out of scope:
- no reflection execution

### Task 0.3: Artifact separation

Files:
- Add: `packages/openclaw-plugin/src/core/nocturnal-paths.ts`
- Modify: `packages/openclaw-plugin/src/tools/deep-reflect.ts`
- Modify: `packages/openclaw-plugin/src/hooks/prompt.ts`
- Modify: `packages/openclaw-plugin/src/core/paths.ts`

Deliverables:
- separate operator-facing reflection log from nocturnal sample artifacts
- keep prompt injection reading only the operator-facing log

Acceptance:
- `deep_reflect` still works
- nocturnal outputs have their own state directory
- no mixed-format log injection

Out of scope:
- no training export yet

## Phase 1: Principle Evaluability and Tracking

Goal: make target selection measurable and safe.

### Task 1.1: Internalization state store

Files:
- Add: `packages/openclaw-plugin/src/core/principle-training-state.ts`
- Add: `packages/openclaw-plugin/tests/core/principle-training-state.test.ts`

Deliverables:
- load/save state
- schema validation
- migration-safe defaults

Acceptance:
- supports `generatedSampleCount`, `includedTrainRunIds`, `deployedCheckpointIds`
- distinguishes `prompt_only` from `internalized`

Out of scope:
- no runtime selection yet

### Task 1.2: Opportunity-based compliance engine

Files:
- Add: `packages/openclaw-plugin/src/core/nocturnal-compliance.ts`
- Modify: `packages/openclaw-plugin/src/core/thinking-models.ts` only if needed for helpers
- Add: `packages/openclaw-plugin/tests/core/nocturnal-compliance.test.ts`

Deliverables:
- compute applicable opportunities per principle
- compute compliance and trend over opportunities
- support `T-xx` principles first

Acceptance:
- low-frequency high-severity principles are not diluted by unrelated sessions
- tests include `T-01`, `T-05`, `T-09` scenarios

Out of scope:
- no `P_xxx` automation without detector metadata

### Task 1.3: Structured detector metadata for `P_xxx`

Files:
- Modify: `packages/openclaw-plugin/src/core/evolution-types.ts`
- Modify: `packages/openclaw-plugin/src/core/evolution-reducer.ts`
- Modify: `packages/openclaw-plugin/src/hooks/subagent.ts`
- Add: `packages/openclaw-plugin/tests/core/evolution-reducer.detector-metadata.test.ts`

Deliverables:
- `P_xxx` principles may carry detector metadata
- missing metadata forces `manual_only` evaluability

Acceptance:
- newly created principles can be classified as auto-trainable or prompt-only

Out of scope:
- no complex detector DSL yet

## Phase 2: Nocturnal Reflection MVP

Goal: generate approved decision-point samples without live-user interference.

### Task 2.1: Trajectory extraction API

Files:
- Add: `packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts`
- Modify: `packages/openclaw-plugin/src/core/trajectory.ts`
- Add: `packages/openclaw-plugin/tests/core/nocturnal-trajectory-extractor.test.ts`

Deliverables:
- structured session snapshot
- recent session listing
- helper queries required by nocturnal selection

Acceptance:
- uses sanitized text only
- exposes only the queries actually needed by nocturnal flow

Out of scope:
- no snapshot database cloning

### Task 2.2: Target selection

Files:
- Add: `packages/openclaw-plugin/src/service/nocturnal-target-selector.ts`
- Add: `packages/openclaw-plugin/tests/service/nocturnal-target-selector.test.ts`

Deliverables:
- choose one target principle
- choose one violating session
- enforce cooldown and quotas
- skip unevaluable principles

Acceptance:
- can return no-op cleanly
- always records reason for skip

Out of scope:
- no Trinity

### Task 2.3: Single-reflector MVP

Files:
- Add: `packages/openclaw-plugin/src/service/nocturnal-service.ts`
- Add: `packages/openclaw-plugin/src/core/nocturnal-arbiter.ts`
- Add: `packages/openclaw-plugin/src/core/nocturnal-executability.ts`
- Add: `packages/openclaw-plugin/src/agents/nocturnal-reflector.md` or equivalent prompt asset
- Add: tests for arbiter and executability

Deliverables:
- one structured reflector prompt
- decision-point sample generation
- deterministic validation
- approved artifact persistence

Acceptance:
- output is structured JSON
- invalid outputs fail closed
- only approved samples become export candidates

Out of scope:
- no Dreamer/Philosopher/Scribe chain yet

### Task 2.4: Worker integration

Files:
- Modify: `packages/openclaw-plugin/src/service/evolution-worker.ts`
- Modify: `packages/openclaw-plugin/src/index.ts` if service registration changes are required

Deliverables:
- enqueue `sleep_reflection`
- execute nocturnal tasks in background
- keep pain diagnosis flow unchanged

Acceptance:
- normal user interactions do not receive nocturnal prompts
- nocturnal task failure is persisted with retry metadata

Out of scope:
- no automatic retraining

## Phase 3: Dataset, Lineage, and Review

Goal: make training data trustworthy before any model training starts.

### Task 3.1: Sample lineage store

Files:
- Add: `packages/openclaw-plugin/src/core/nocturnal-dataset.ts`
- Add: `packages/openclaw-plugin/tests/core/nocturnal-dataset.test.ts`

Deliverables:
- sample fingerprint
- dataset metadata
- review status
- target model family binding

Acceptance:
- duplicate samples are rejected or linked
- one sample can be traced back to session and principle

### Task 3.2: ORPO export path

Files:
- Modify: `packages/openclaw-plugin/src/core/trajectory.ts` or keep export logic in new nocturnal module
- Modify: `packages/openclaw-plugin/src/commands/export.ts`
- Add tests

Deliverables:
- export approved decision-point JSONL
- separate export path from legacy correction export

Acceptance:
- exported JSONL is parseable
- export contains metadata needed for training lineage

Out of scope:
- no trainer implementation inside plugin

### Task 3.3: Human review queue

Files:
- Modify: existing samples/export commands or add new nocturnal review command
- Add tests

Deliverables:
- review pending approved samples before training
- approve/reject with reason

Acceptance:
- training export can filter to human-approved only

## Phase 4: Offline Evaluation Harness

Goal: prove the data and checkpoint produce better worker behavior before rollout.

### Task 4.1: Holdout decision benchmark

Files:
- Add: `docs/spec/nocturnal-eval-benchmark.md`
- Add: `scripts/nocturnal/` benchmark utilities if this repo already accepts scripts there
- Add minimal plugin-side metadata support if needed

Deliverables:
- benchmark definition
- task buckets for reader/editor workers
- reduced-prompt and prompt-assisted eval modes

Acceptance:
- benchmark can compare baseline vs candidate checkpoint

### Task 4.2: Training run lineage

Files:
- Add: `packages/openclaw-plugin/src/core/model-training-registry.ts`
- Add tests

Deliverables:
- register train runs
- register checkpoints
- attach eval summaries

Acceptance:
- no checkpoint can be marked deployable without an eval record

## Phase 5: Local Worker Routing

Goal: connect trained local models to real OpenClaw worker lanes safely.

### Task 5.1: Deployment registry

Files:
- Add: `packages/openclaw-plugin/src/core/model-deployment-registry.ts`
- Add tests

Deliverables:
- map worker profile to checkpoint
- rollback target
- enable/disable routing flag

Acceptance:
- registry supports `local-reader` and `local-editor`

### Task 5.2: Routing policy

Files:
- Add: `packages/openclaw-plugin/src/core/local-worker-routing.ts`
- Modify relevant delegation entry points if the plugin currently owns any

Deliverables:
- classify tasks eligible for local workers
- deny high-entropy work to local workers

Acceptance:
- unsupported task types remain on main agent
- routing decision is explainable and testable

Out of scope:
- no autonomous route learning

## Phase 6: Trinity and Optimization

Goal: improve sample quality only after the MVP loop is stable.

### Task 6.1: Trinity chain

Files:
- Add Dreamer, Philosopher, Scribe assets
- Extend nocturnal service and arbiter
- Add chain tests

Acceptance:
- still produces structured artifacts
- still fails closed
- quality beats single-reflector baseline on a reviewed subset

### Task 6.2: Adaptive thresholds and tournament selection

Files:
- Add adaptive-threshold module
- Add candidate scoring module
- Add tests

Acceptance:
- thresholds change only within bounded ranges
- selection remains reproducible

## Phase 7: Training and Controlled Rollout

Goal: complete the first end-to-end training cycle and deploy only to bounded local workers.

Phase 7 must be executed with these additional locked constraints:

- ORPO-first training path
- backend-pluggable external trainer
- `PEFT + TRL` as the stable semantic contract
- `Unsloth` as a compatible acceleration backend, not the only backend
- `hf-mount` only as optional trainer/evaluator infrastructure
- no main-agent training
- CPU-only is experimental, not a guaranteed production-training tier
- first rollout only targets bounded local workers

Authoritative Phase 7 specs:

- `docs/spec/nocturnal-research-program.md`
- `docs/spec/nocturnal-training-contract.md`
- `docs/spec/nocturnal-promotion-policy.md`
- `docs/spec/nocturnal-phase7-task-pack.md`

### Task 7.1: Research program alignment

Files:
- Add: `docs/spec/nocturnal-research-program.md`
- Add: `docs/spec/nocturnal-training-contract.md`
- Add: `docs/spec/nocturnal-promotion-policy.md`
- Add: `docs/spec/nocturnal-phase7-task-pack.md`
- Add scripts/config outside plugin as needed

Deliverables:
- one model family target
- hardware tier policy
- dataset contract
- checkpoint naming and registration contract
- explicit search-space policy

### Task 7.2: Plugin-side training contract

Files:
- add external training contract and registry integration modules
- add tests

Deliverables:
- normalized experiment spec/result contract
- backend enum for `peft-trl-orpo`, `unsloth-orpo`, `dry-run`
- lineage recording for dataset/config/code hash

### Task 7.3: External trainer backends

Files:
- add trainer scripts/config outside plugin
- add smoke tests or fixture-based contract tests

Deliverables:
- PEFT/TRT ORPO backend
- Unsloth ORPO backend
- dry-run backend

### Task 7.4: Shadow deployment and promotion gate

Files:
- deployment registry updates
- runtime metrics hooks if needed

Acceptance:
- new checkpoint runs only on selected bounded local worker profile
- orchestrator review remains mandatory
- rollback path tested
- promotion is gated by benchmark and runtime evidence, not just training success

## Done Definition for the Entire Initiative

The initiative is ready for broader use only when all of these are true:

- live pain diagnosis and nocturnal reflection no longer interfere
- decision-point samples are traceable and reviewable
- automatic targeting ignores unevaluable principles
- one local worker profile shows measurable holdout improvement
- checkpoint routing is reversible
- main-agent orchestration remains the safety boundary

## Recommended Execution Order for Coding Agents

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Pause for review
6. Phase 4
7. Phase 5
8. Pause for review
9. Phase 6
10. Phase 7

Do not start Phase 4 or later until the earlier phase acceptance checks are actually passing.
