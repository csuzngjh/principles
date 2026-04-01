# Claude Handoff: Empathy Fix + AI Sprint Orchestrator

Date: 2026-03-31
Branch: `codex/ai-sprint-orchestrator`
Primary repo: `D:/Code/principles`
Do not modify: `D:/Code/openclaw`

## Mission

Continue two connected workstreams:

1. Stabilize the local AI sprint orchestrator so local coding AIs can run long bugfix/review loops with less Codex involvement.
2. Use that improved workflow to finish the real empathy observer production investigation and then implement the PD-only fix.

This handoff assumes the next agent is `Claude Code` running `GLM-5.1`, and should conserve Codex/OpenAI quota by doing the long investigation and implementation work locally.

## Hard Constraints

- Work only in `D:/Code/principles`
- Do not modify `D:/Code/openclaw`
- Do not push directly to `main`
- Prefer local AI execution and repo-local artifacts over long chat reasoning
- Keep scope focused on empathy observer production failure and orchestrator governance

## Current State

### Branch / commits

Current branch:

- `codex/ai-sprint-orchestrator`

Recent relevant commits on this branch:

- `c85603f` `feat: add ai sprint orchestrator phase a`
- `b7166d6` `feat: add ai sprint checkpoint persistence`
- `4944077` `feat: add measurable sprint stage criteria`
- `449a594` `feat: harden ai sprint artifact capture`
- `32951e9` `feat: tighten ai sprint governance`

Working tree status when this handoff was written:

- clean

### Orchestrator files

Primary files:

- `D:/Code/principles/scripts/ai-sprint-orchestrator/run.mjs`
- `D:/Code/principles/scripts/ai-sprint-orchestrator/lib/task-specs.mjs`
- `D:/Code/principles/scripts/ai-sprint-orchestrator/lib/decision.mjs`
- `D:/Code/principles/scripts/ai-sprint-orchestrator/test/decision.test.mjs`
- `D:/Code/principles/docs/design/2026-03-31-ai-sprint-orchestrator-design.md`
- `D:/Code/principles/docs/ops/ai-sprint-orchestrator-runbook.md`

### Current orchestrator capabilities

Already implemented:

- stage loop: `investigate -> fix-plan -> implement -> verify`
- roles: `producer`, `reviewer_a`, `reviewer_b`
- file-based truth source under `ops/ai-sprints/<run-id>/`
- role worklogs and role state files
- `scorecard.json`
- protected artifact detection
- strict reviewer verdict parsing
- stale run reconciliation on `--status`
- investigate-stage `HYPOTHESIS_MATRIX` requirement

### Current run state

Newest empathy run:

- `D:/Code/principles/ops/ai-sprints/2026-03-31T12-25-53-994Z-empathy-runtime-fix`

Older relevant run:

- `D:/Code/principles/ops/ai-sprints/2026-03-31T11-30-06-007Z-empathy-runtime-fix`

The older run was useful because it exposed orchestrator weaknesses:

- producer could still bias `latest-summary.md`
- stale run state could remain `running`
- reviewers could fail to complete and leave no decision
- agents converged around a weak root-cause hypothesis without a structured hypothesis matrix

Those governance gaps are now partially fixed in the orchestrator.

## What Codex already concluded about empathy

Do not assume older reports are correct. Re-check latest code.

The most important standing hypothesis set is:

1. `prompt_contamination_from_prompt_ts`
2. `wait_for_run_timeout_or_error_causes_non_persistence`
3. `subagent_ended_fallback_is_not_reliable_enough`
4. `workspace_dir_or_wrong_workspace_write`
5. `lock_or_ttl_path_causes_observer_inactivity_or_data_loss`

### Codex current confidence

Most plausible current priorities:

1. `prompt.ts` still likely allows evolution-task injection before proper minimal/observer exclusion.
2. `empathy-observer-manager.ts` timeout/error path still relies too heavily on fallback.
3. `workspaceDir` may be fragile, but prior agents over-converged on it without enough proof that this is the production root cause.

Meaning:

- treat `workspace_dir_or_wrong_workspace_write` as a serious hypothesis
- but do not accept it as the root cause without stronger evidence than previous local agents provided

## Model / tool routing

Use these defaults:

- `opencode` -> `minimax-cn-coding-plan/MiniMax-M2.7`
- `iflow` -> `glm-5`
- `claude` -> `GLM-5.1`

Use `claude(GLM-5.1)` sparingly for:

- arbitration
- synthesis
- final fix plan
- final code review

Use `opencode` and `iflow` more aggressively for:

- investigation
- patch generation
- repeated review passes

## Immediate Tasks

### Task 1: Inspect the newest empathy sprint run

Read:

- `D:/Code/principles/ops/ai-sprints/2026-03-31T12-25-53-994Z-empathy-runtime-fix/sprint.json`
- the stage files under `.../stages/01-investigate/`

Determine:

- did producer finish
- did both reviewers finish
- was `decision.md` generated
- did protected-file enforcement trigger
- did the new `HYPOTHESIS_MATRIX` actually improve output quality

If the run is stale or low-quality, halt it and restart cleanly.

### Task 2: Re-run empathy investigation if needed

If the newest run is not strong enough, launch a fresh run with the improved orchestrator.

Required outcome of the investigate stage:

- all five required hypotheses explicitly classified
- reviewers must not invent verdict values
- producer and reviewers must cite concrete files and lines
- decision must not advance unless both reviewers explicitly approve

### Task 3: Produce a human-trustworthy empathy fix plan

Before implementation, produce a short fix plan that:

- states the winning root-cause chain
- lists the smallest PD-only file changes
- defines exact tests to add/update
- defines what evidence would falsify the chosen root cause

Only after that, move to implementation.

## Orchestrator improvement backlog

These are the next likely improvements after the newest run is inspected.

### High priority

1. Add heartbeat updates during long role execution if possible
2. Add explicit stage-timeout / role-timeout handling with structured halt reason
3. Add a check that role reports did not leave required sections empty
4. Add stronger machine checks for `HYPOTHESIS_MATRIX`

### Medium priority

1. Add a `scorecard` test
2. Add a protected-file modification test
3. Add resume/reconcile behavior tests
4. Add role-specific reviewer specializations
   - reviewer A: root cause / correctness
   - reviewer B: scope / regression / testing

### Nice to have

1. Make reviewers parallel rather than serial
2. Add Claude arbitration when two reviewers disagree across multiple rounds
3. Add a stricter structured output schema than Markdown sections

## Recommended Working Style

1. Use local AI agents for long loops.
2. Keep all intermediate work on disk.
3. Prefer short Claude interactions only at:
   - stage boundary decisions
   - conflicting root-cause claims
   - final review of the patch
4. Do not trust a single agent’s explanation without either:
   - code citation plus direct verification
   - or an opposing reviewer explicitly failing to refute it

## Commands

Run orchestrator status:

```bash
npm run ai-sprint -- --status <run-id>
```

Pause:

```bash
npm run ai-sprint -- --pause <run-id>
```

Abort:

```bash
npm run ai-sprint -- --abort <run-id>
```

Start fresh empathy run:

```bash
npm run ai-sprint -- --task empathy-runtime-fix
```

Run orchestrator tests:

```bash
npm run ai-sprint:test
```

## Definition of Success

This handoff is complete only when:

1. empathy production root cause is narrowed to a defensible PD-only fix
2. the fix is implemented in `principles`, not `openclaw`
3. tests cover the selected root cause and prevent obvious regression
4. orchestrator can run a full producer + two-reviewer cycle without silently stalling
5. the resulting branch is ready for a clean review / PR flow

