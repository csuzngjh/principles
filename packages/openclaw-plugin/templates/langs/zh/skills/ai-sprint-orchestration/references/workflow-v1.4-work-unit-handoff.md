# Workflow v1.4 Work-Unit Upgrade Handoff

## Goal

Use the packaged `ai-sprint-orchestration` skill to implement the next architecture upgrade of the workflow itself.

This upgrade is **not** about product-side closure. It is about making the orchestrator better at long-running, high-value coding tasks by introducing a finer-grained execution model.

The target direction is:

- move from `stage -> producer/reviewer`
- toward `stage -> work units -> producer/reviewer/decision`

The key design goal is:

- smaller execution units
- explicit checkpointing
- forced context reload between units
- less long-context drift

## Current confirmed state

The packaged skill is already usable as an internal tool:

- package path:
  - `D:/Code/principles/packages/openclaw-plugin/templates/langs/zh/skills/ai-sprint-orchestration`
- installed path:
  - `C:/Users/Administrator/.agents/skills/ai-sprint-orchestration`
- self-check works
- package-local validation runs work
- failure classification is persisted to:
  - `latest-summary.md`
  - `scorecard.json`
- complex task templates and minimum task contract already exist

Remaining instability is mostly:

- `agent behavior issue`

It is **not** primarily:

- pathing
- packaging
- runtime-root layout
- missing acceptance artifacts

## Why v1.4 is needed

The current workflow already externalizes state and can resume from artifacts, but its granularity is still too coarse for very complex tasks.

Today it mainly refreshes context at:

- stage level
- role level
- round level

That is useful, but not yet enough for difficult long-running work where one producer pass can still become too large, too noisy, or too drift-prone.

The next upgrade should add a smaller unit below stage:

- `workUnitId`
- `workUnitGoal`
- `allowedFiles`
- `unitChecks`
- `unitDeliverables`
- `unitSummary`
- `carryForwardSummary`

## Scope

### In scope

- `packages/openclaw-plugin/templates/langs/zh/skills/ai-sprint-orchestration`
- `packages/openclaw-plugin/templates/langs/en/skills/ai-sprint-orchestration`
- workflow docs, specs, prompts, state shape, and summary artifacts
- package-local validation and workflow-only tests

### Out of scope

- `packages/openclaw-plugin`
- `D:/Code/openclaw`
- product-side/sample-side closure
- dashboard
- stageGraph
- self-optimizing sprint
- parallel orchestrator expansion

If validation or implementation exposes product-side or sample-side issues, classify them and stop. Do not drift back into product closure work.

## Architectural hypothesis

The most valuable next step is **not** a full rewrite.

The most valuable next step is to implement a high-value foundation slice:

1. define the work-unit contract
2. define how a stage declares work units
3. add package-local templates and docs for work-unit-aware tasks
4. add checkpoint/carry-forward artifacts that are short enough to be reused safely
5. update prompts so each unit starts from minimal context, not long historical text

This means the first v1.4 sprint should prioritize:

- work-unit interfaces
- unit-level artifacts
- unit-level carry-forward
- validation of the new context-reload behavior

It should **not** try to finish every future v1.4 feature in one pass.

## Recommended implementation order

### Phase 1: foundation interfaces

Define and document the unit contract in specs and references:

- `workUnitId`
- `workUnitGoal`
- `allowedFiles`
- `unitChecks`
- `unitDeliverables`
- `unitSummary`
- `carryForwardSummary`

Add minimal schema/contract validation for these fields where appropriate.

### Phase 2: unit-scoped prompt inputs

Update producer/reviewer prompt construction so a unit run receives:

- current unit goal
- allowed files
- expected checks
- expected deliverables
- prior carry-forward summary

Prefer short checkpoint summaries over replaying long decision history.

### Phase 3: checkpoint and continuation tightening

Standardize the artifact that one unit leaves behind for the next:

- accomplished
- blockers
- next focus
- verified files

Make continuation/revise paths prefer this short artifact.

### Phase 4: validation

Add or update validation specs and tests so the workflow can prove:

- missing task contract is rejected
- work-unit metadata is loaded correctly
- continuation reads compact carry-forward context
- failures still classify cleanly

## Success criteria

The first v1.4 slice is successful if all of these are true:

1. The workflow can express work-unit metadata in package-local specs or templates.
2. Prompts clearly scope a run to a smaller work unit, not a broad stage-only brief.
3. Continuation uses compact carry-forward summaries by default.
4. Baseline tests pass.
5. Package-local self-check still passes.
6. Validation runs either pass, or fail with explicit classification that is not a workflow-plumbing ambiguity.

## Guardrails

- Do not rewrite the orchestrator from scratch.
- Do not introduce a second orchestration system.
- Do not move back into product/sample closure.
- Do not increase scope to unrelated features.
- Prefer one workflow-only architectural improvement per iteration.
- Preserve the packaged skill as the primary operator entry point.

## Suggested starting point for the next thread

In the next thread, the first sprint should focus on:

- implementing the work-unit contract and carry-forward foundation
- not the entire future v1.4 roadmap

Treat this as a bounded architecture slice:

- high value
- low drift
- directly useful for future complex coding tasks
