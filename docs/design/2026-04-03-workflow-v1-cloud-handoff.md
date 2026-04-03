# Workflow v1 Cloud Handoff

## Mission

Your primary task is **not** to finish PR2 product code directly.

Your primary task is to harden `ai-sprint-orchestrator` into a reusable Workflow v1, using PR2 as a real-world sample.

Current strategic boundary:

- Main product: `scripts/ai-sprint-orchestrator`
- Validation sample: PR2 empathy helper migration
- PR2 current label: `shadow-complete`
- Do **not** treat PR2 as `production-ready`
- Do **not** keep extending `packages/openclaw-plugin` product closure unless a future milestone explicitly re-opens that scope
- Do **not** modify the upstream OpenClaw repo unless explicitly instructed

This handoff is written for a Linux cloud environment where paths differ from the original Windows workstation.

## Environment

Canonical paths in the cloud environment:

- Principles repo: `/home/csuzngjh/code/principles`
- OpenClaw repo: `/home/csuzngjh/code/openclaw`
- OpenClaw runtime state: `/home/csuzngjh/.openclaw`

Work from:

- `/home/csuzngjh/code/principles`

Avoid editing:

- `/home/csuzngjh/code/openclaw`

Unless a later milestone explicitly authorizes it.

## What This Repository Is

This repo contains two different but related workstreams:

1. **PR2 empathy helper migration**
   - new helper/workflow code in `packages/openclaw-plugin`
   - current maturity: `shadow-complete`
   - not yet accepted as full product closure

2. **AI sprint workflow system**
   - implementation in `scripts/ai-sprint-orchestrator`
   - this is now the main product
   - the goal is to make it stable, reusable, and capable of driving real refactor work without constant human rescue

## Current Truths

These are the stable conclusions you should assume unless local code proves otherwise:

1. Workflow v1 has already improved materially.
   - contract enforcement exists
   - decision gate supports `outputQuality`
   - next-run recommendation exists
   - dynamic timeout exists
   - worktree logic is significantly better than before

2. PR2 is **not** the primary deliverable right now.
   - PR2 is a sample used to harden the workflow
   - PR2 should remain labeled `shadow-complete` until workflow validation is strong enough to resume product-side finishing work

3. Two merged PRs matter:
   - PR #150: workflow-side hardening in `scripts/ai-sprint-orchestrator`
   - PR #151: empathy runtime enhancements in `packages/openclaw-plugin`

4. There are still known issues:
   - `docs/design/workflow-v1-acceptance-checklist.md` is encoding-damaged and not safe as the workflow acceptance source of truth
   - `packages/openclaw-plugin/src/hooks/subagent.ts` still does not truly route helper fallback lifecycle through `notifyLifecycleEvent()`
   - `packages/openclaw-plugin/src/service/evolution-worker.ts` still expires workflows by store mutation instead of the manager cleanup path

Those last two are **real product closure issues**, but they are **not** the main line for this cloud task right now.

## Current Priority

Your current priority is to prove that Workflow v1 is usable enough to resume PR2 later.

The shortest honest definition of "usable enough":

- two consecutive validation runs complete without halting due to workflow bugs
- invalid reports are rejected structurally
- `outputQuality` is persisted
- `nextRunRecommendation` is persisted
- acceptance criteria are readable and usable by another operator/agent

## Non-Goals

Do not drift into these unless explicitly told to:

- do not continue polishing PR2 helper production closure
- do not continue adding product commands/UI for empathy helper
- do not modify `/home/csuzngjh/code/openclaw`
- do not re-open large feature work in `packages/openclaw-plugin`
- do not treat archive/spec noise as the main deliverable

## Immediate Known Gap

The main workflow-side gap right now is not a core algorithm issue.

It is this:

- the acceptance checklist doc is unreadable due to encoding damage
- validation specs exist
- tests pass
- but the validation system has not yet been exercised end-to-end in the cloud environment as the actual acceptance gate

So the next meaningful work is:

1. restore the acceptance checklist into readable, stable UTF-8 text
2. run the minimal workflow validation sequence
3. inspect real run artifacts
4. classify failures as:
   - workflow bug
   - agent behavior issue
   - environment issue
   - sample-task issue

## Minimal Validation Assets

These files should already exist in the repo:

- `ops/ai-sprints/specs/workflow-validation-minimal.json`
- `ops/ai-sprints/specs/workflow-validation-minimal-verify.json`
- `docs/design/workflow-v1-acceptance-checklist.md`

These are meant to validate workflow infrastructure itself, not product functionality.

## Working Model

Operate in loops.

Each loop should be small, explicit, and end with a classification.

### Loop A: Fix acceptance baseline

Goal:

- make the acceptance checklist readable and reliable

Definition of done:

- document is readable UTF-8
- headings and criteria are clear
- another engineer/agent could execute the checklist without needing chat history

### Loop B: Run minimal validation sprint

Goal:

- run `workflow-validation-minimal`

Definition of done:

- run either completes or fails with a clearly classified cause
- collect:
  - `sprint.json`
  - `timeline.md`
  - `latest-summary.md`
  - stage `decision.md`
  - `scorecard.json`

### Loop C: Run minimal verify sprint

Goal:

- run `workflow-validation-minimal-verify`

Definition of done:

- verify run either completes or fails with a clearly classified cause
- confirm:
  - `outputQuality` exists in persisted artifacts
  - `nextRunRecommendation` exists in persisted artifacts
  - validation summaries are human-readable

### Loop D: Gap classification

After each run, classify every blocker into exactly one bucket:

- workflow bug
- agent quality issue
- environment issue
- sample-spec issue

Do not mix them.

## Execution Order

Follow this order unless a hard blocker forces a change:

1. Read the current workflow code and tests
   - `scripts/ai-sprint-orchestrator/run.mjs`
   - `scripts/ai-sprint-orchestrator/lib/contract-enforcement.mjs`
   - `scripts/ai-sprint-orchestrator/lib/decision.mjs`
   - `scripts/ai-sprint-orchestrator/lib/task-specs.mjs`
   - `scripts/ai-sprint-orchestrator/test/*.test.mjs`

2. Repair `docs/design/workflow-v1-acceptance-checklist.md`

3. Run test baseline:
   - `node --test scripts/ai-sprint-orchestrator/test/contract-enforcement.test.mjs`
   - `node --test scripts/ai-sprint-orchestrator/test/decision.test.mjs`
   - `node --test scripts/ai-sprint-orchestrator/test/run.test.mjs`

4. Run minimal validation sprint:
   - `node scripts/ai-sprint-orchestrator/run.mjs --task workflow-validation-minimal --task-spec ops/ai-sprints/specs/workflow-validation-minimal.json`
   - if CLI shape differs locally, inspect `run.mjs --help` and use the correct equivalent

5. Run minimal verify sprint against the output of the prior run

6. Produce a short report with:
   - what ran
   - what failed
   - which bucket each failure belongs to
   - what single next fix should be attempted

## How To Decide If Workflow v1 Is Ready Enough

Workflow v1 is ready enough to resume PR2 iteration only when all of the following are true:

1. the acceptance checklist is readable and stable
2. minimal validation run does not halt because of workflow infrastructure failure
3. minimal verify run does not halt because of workflow infrastructure failure
4. `decision.md` and `scorecard.json` both contain:
   - `outputQuality`
   - `qualityReasons`
   - `validation`
   - `nextRunRecommendation`
5. any remaining failures are mostly agent behavior or sample-task issues, not workflow plumbing

If these are not true, stay on Workflow v1.

## What To Do If Validation Fails

If a validation run fails:

- do not jump back into PR2 product code
- isolate the smallest workflow-only fix
- implement only that fix
- re-run the same validation

Avoid broad refactors.

## What To Do After Workflow v1 Is Ready Enough

Only after the validation loops are stable:

- reopen PR2 as a follow-up sample
- keep PR2 scoped as:
  - improve from `shadow-complete`
  - do not expand feature scope
  - let workflow drive the process

At that point, the first PR2 follow-up question becomes:

- can workflow reliably push PR2 from `shadow-complete` toward `production-ready` without repeated human rescue?

## Required Reporting Format

For every significant iteration, report only:

1. what you changed
2. what you ran
3. what failed
4. failure classification
5. the single next recommended iteration

Keep reports short and operational.

