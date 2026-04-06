# AI Sprint Orchestration Reference

## Package layout

- `scripts/run.mjs`: package-local orchestrator entrypoint
- `scripts/lib/`: decision, contract validation, state store, spec loading, archive helpers
- `references/specs/`: built-in validation specs
- `references/agent-registry.json`: package-local agent/model registry
- `references/workflow-v1-acceptance-checklist.md`: handoff checklist
- `runtime/`: default location for run artifacts

## Runtime layout

Default runtime root:

- `skills/ai-sprint-orchestration/runtime`

Subdirectories:

- `runs/<run-id>/`
- `archive/<run-id>/`
- `tmp/sprint-agent/<run-id>/...`

Override with either:

- `--runtime-root <path>`
- `AI_SPRINT_RUNTIME_ROOT=<path>`

## Self check

Run this first in a newly installed environment:

- `node scripts/run.mjs --self-check`

It verifies:

- package-local references exist
- built-in specs load
- `agent-registry.json` exists
- `acpx` is callable
- runtime root is writable

## Built-in specs

- `workflow-validation-minimal`
- `workflow-validation-minimal-verify`
- `bugfix-complex-template` (copy and fill before use)
- `feature-complex-template` (copy and fill before use)

These built-in specs are package self-checks. They validate the workflow package itself, not product features.

## Key artifacts

For each run, inspect:

- `sprint.json`
- `timeline.md`
- `latest-summary.md`
- `decision.md`
- `scorecard.json`

Important persisted fields:

- `outputQuality`
- `qualityReasons`
- `validation`
- `nextRunRecommendation`
- `failureClassification`
- `failureSource`
- `recommendedNextAction`

Per-stage carry-forward artifact:

- `checkpoint-summary.md`

The next round should prefer `checkpoint-summary.md` as carry-forward context before falling back to a full prior `decision.md` or `handoff.json`.

## Failure classification

Use exactly one:

- `workflow bug`: orchestration logic, artifact layout, CLI, validation, persistence
- `agent behavior issue`: output quality or format drift despite correct workflow prompts/contracts
- `environment issue`: missing binaries, permissions, filesystem, PATH, runtime access
- `sample-spec issue`: the spec itself, or sample-side/product-side gaps that should not be fixed in this workflow milestone

## Minimum task contract for complex work

Complex bugfix and feature specs must explicitly provide:

- `Goal`
- `In scope`
- `Out of scope`
- `Validation commands`
- `Expected artifacts`

If any of these are missing or left as placeholders, the packaged skill refuses to start the sprint.

## Execution scope limits

Complex specs may define:

- `maxFiles`
- `maxChecks`
- `maxDeliverables`

The producer should declare `PLANNED_FILES`, `PLANNED_CHECKS`, and `DELIVERABLES` in the worklog before editing code. If one round would exceed scope, narrow the round or continue in a later round instead of forcing a large change through one execution.

## Synchronization rule

Source of truth remains:

- the source repository copy of `scripts/ai-sprint-orchestrator`

Sync the packaged copy only when the change affects:

- package-local CLI behavior
- validation behavior
- artifact layout
- package-local references or runtime assumptions

Do not blindly mirror every upstream orchestrator edit into this package.

## Next architecture direction

This package currently resets context at stage/round/role boundaries. The next planned upgrade is a finer-grained `work-unit/tasklet` layer with forced context reload between bounded units:

- `workUnitId`
- `workUnitGoal`
- `allowedFiles`
- `unitChecks`
- `unitDeliverables`
- `unitSummary`
- `carryForwardSummary`

That architecture is not implemented in v1.3. The current package focuses on internal usability first.
