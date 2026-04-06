---
name: ai-sprint-orchestration
description: Run long-form coding work through the packaged AI sprint orchestrator with baseline checks, validation runs, failure classification, and workflow-only iteration discipline.
---

# AI Sprint Orchestration

Use this skill when a task is large, multi-stage, or likely to need repeated review and continuation. The skill packages a local copy of the orchestrator so an agent can start from this skill directory instead of hunting through repo internals.

## Use this skill for

- Complex bug fixes that need investigation, implementation, and review
- Feature work that benefits from explicit producer/reviewer decision gates
- Workflow self-validation using the built-in validation specs
- Long-running tasks where artifact persistence and resumability matter

## Do not use this skill for

- Tiny single-file edits or trivial docs fixes
- Product-side sample gaps in `packages/openclaw-plugin`
- Changes that require editing `D:/Code/openclaw`
- Dashboard, stageGraph, self-optimizing sprint, or parallel orchestrator expansion

## Quick start

Run these commands from the skill package root:

1. Package smoke check:
   `node scripts/run.mjs --self-check`
   `node scripts/run.mjs --help`
2. Package-local validation:
   `node scripts/run.mjs --task workflow-validation-minimal`
   `node scripts/run.mjs --task workflow-validation-minimal-verify`
3. Inspect artifacts under:
   `runtime/`

Internal smoke standard:

- `node scripts/run.mjs --self-check` passes
- `workflow-validation-minimal` reaches producer completion and produces a structured decision or classified halt
- `workflow-validation-minimal-verify` reaches producer completion and any reviewer failure is classified, not left opaque

If you also have the source repository available, you may additionally run the source baseline tests from `packages/openclaw-plugin/templates/langs/zh/skills/ai-sprint-orchestration/test/`.

## Execution rules

- Treat `packages/openclaw-plugin/templates/langs/zh/skills/ai-sprint-orchestration` as the canonical code source.
- Treat this English package as a mirrored delivery copy of that canonical implementation.
- If a run fails, classify it as exactly one of:
  - `workflow bug`
  - `agent behavior issue`
  - `environment issue`
  - `sample-spec issue`
- If the failure is product-side or sample-side, stop after classification. Do not continue into product closure work.
- Only fix one workflow-only issue per iteration, then rerun baseline and validation.
- Always run `node scripts/run.mjs --self-check` before the first validation run in a new environment.
- For complex bugfix or feature work, start from a copied template spec and fill the minimum task contract before launching the sprint.

## Output expectation

Each iteration should report only:

- what changed
- what ran
- what failed
- failure classification
- the single next recommended iteration
