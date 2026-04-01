# AI Sprint Orchestrator Runbook

## Purpose

This runbook describes how to use the local AI sprint orchestrator introduced for the Principles repository.

It is intentionally scoped to this repo and local environment.

## Commands

From the repo root:

```bash
npm run ai-sprint -- --task empathy-runtime-fix
npm run ai-sprint -- --resume <run-id>
npm run ai-sprint -- --status <run-id>
npm run ai-sprint -- --pause <run-id>
npm run ai-sprint -- --abort <run-id>
npm run ai-sprint:test
```

## Spec Fields

### `branch` — required for merge gate

The `branch` field in the task spec identifies the **real PR branch on remote**. This is the branch the merge gate compares against.

```json
{
  "branch": "feat/ai-sprint-orchestrator-workflow-optimization"
}
```

- Must be the branch that has been pushed to `origin`
- Used by merge gate: compares `local HEAD SHA` vs `remote/<branch> SHA`
- **Never** uses `state.worktree.branchName` (internal sprint branch like `sprint/<runId>/<stage>`)
- If omitted, merge gate defaults to comparing against `main`

### `stageRoleTimeouts` — per-role per-stage timeouts

```json
{
  "stageRoleTimeouts": {
    "investigate": { "producer": 720, "reviewer_a": 600, "reviewer_b": 600 },
    "patch-plan": { "producer": 600, "reviewer_a": 480, "reviewer_b": 480 },
    "implement-pass-1": { "producer": 900, "reviewer_a": 600, "reviewer_b": 600 },
    "implement-pass-2": { "producer": 600, "reviewer_a": 480, "reviewer_b": 480 },
    "verify": { "producer": 720, "reviewer_a": 480, "reviewer_b": 480 }
  }
}
```

## Where State Lives

Each run creates a directory under:

```text
ops/ai-sprints/<run-id>/
```

Important files:

- `sprint.json`: source of truth for run state
- `timeline.md`: append-only execution timeline
- `latest-summary.md`: latest operator-facing summary
- `stages/<nn-stage>/brief.md`: stage brief
- `stages/<nn-stage>/producer.md`: producer output
- `stages/<nn-stage>/producer-worklog.md`: producer checkpoint log
- `stages/<nn-stage>/producer-state.json`: producer resumable state
- `stages/<nn-stage>/reviewer-a.md`: reviewer A output
- `stages/<nn-stage>/reviewer-a-worklog.md`: reviewer A checkpoint log
- `stages/<nn-stage>/reviewer-a-state.json`: reviewer A resumable state
- `stages/<nn-stage>/reviewer-b.md`: reviewer B output
- `stages/<nn-stage>/reviewer-b-worklog.md`: reviewer B checkpoint log
- `stages/<nn-stage>/reviewer-b-state.json`: reviewer B resumable state
- `stages/<nn-stage>/decision.md`: stage decision
- `stages/<nn-stage>/git-status.json`: git status snapshot (mutating stages only)
- `stages/<nn-stage>/merge-gate.json`: merge gate result (final stage only)

## Worktree Lifecycle (Mutating Stages)

`implement-pass-1` and `implement-pass-2` run the producer inside an isolated git worktree.

### How it works

- Orchestrator creates: `git worktree add -b sprint/<runId>/<stageName> <worktreePath> <baseRef>`
- `<baseRef>` = `spec.branch ?? 'main'` (a real git ref, not a path)
- Worktree path: `<runDir>/worktrees/<stageName>/`
- Producer's workspace: the worktree directory

### Viewing the worktree

```bash
git worktree list
```

### When the sprint halts

On `halted` status, orchestrator calls `git worktree remove --force <worktreePath>` using `baseWorkspace` as cwd (not the worktree's parent directory).

## Merge Gate

Merge gate runs automatically before the final stage (`verify`) can complete.

### What it checks

```
local HEAD SHA == remote/<spec.branch> SHA
```

Where `spec.branch` is the PR's real branch (e.g. `feat/my-feature`), **not**:

- `origin/HEAD` (remote default branch — wrong target)
- `sprint/<runId>/<stageName>` (internal worktree branch — never on remote)

### Merge gate failure types

**Branch not on remote** (`haltReason.type = 'merge_gate_branch_not_on_remote'`):
```
Remote branch '<branch>' not found. Run: git push -u origin <branch>
```
Action: push the branch first, then resume.

**SHA mismatch** (`haltReason.type = 'merge_gate_sha_mismatch'`):
```
local SHA != remote/<branch> SHA. Push or rebase before completing.
```
Action: push or rebase, then resume.

### When merge gate runs

It runs inside `advanceState` when `decision.outcome === 'advance'` and `currentStageIndex` is the final stage. It writes to `stages/<nn-stage>/merge-gate.json`.

## Reviewer Parallelization

Both `reviewer_a` and `reviewer_b` run **in parallel** (Phase 2 of each stage).

### How to read parallel results

Since they run simultaneously, you may see results appear at different times. Both `reviewer-a.md` and `reviewer-b.md` are written independently. The `decision.md` aggregates both.

### Partial failure handling

| Scenario | Behavior |
|----------|----------|
| reviewer_a times out, reviewer_b succeeds | Continue with reviewer_b verdict |
| reviewer_b times out, reviewer_a succeeds | Continue with reviewer_a verdict |
| Both timeout | `outcome: 'error'` |
| One throws non-timeout error | Other continues; error recorded in timeline |

## Stale / Interrupted / Halt / Revise

### Stale (orchestrator process died mid-stage)

1. Check `sprint.json` — if `status === 'running'`, the run was interrupted
2. Check stage directory for `producer-worklog.md` / `reviewer-a-worklog.md`
3. Run `npm run ai-sprint -- --resume <run-id>` to restart from last known state
4. If worklogs exist, orchestrator will attempt to resume from where it left off

### Interrupted (operator Ctrl-C mid-run)

- Timeline is append-only; progress before interruption is preserved
- Run `npm run ai-sprint -- --resume <run-id>` to continue

### Halted run

Set by orchestrator when merge gate fails, max rounds exceeded, or manual intervention:

```json
{
  "type": "merge_gate_sha_mismatch",
  "stage": "verify",
  "round": 1,
  "targetBranch": "feat/my-feature",
  "details": "local SHA != remote/feat/my-feature SHA. Push or rebase before completing.",
  "blockers": ["Local SHA does not match remote branch head."]
}
```

Action: fix the blocker (e.g. push), then `npm run ai-sprint -- --resume <run-id>`.

### Revise

When `decision.outcome === 'revise'` and current stage is `implement-pass-1`, orchestrator **automatically routes** to `implement-pass-2` (without requiring a new sprint start). `currentRound` resets to 1.

## State Contract

`sprint.json` 中的 `haltReason` 使用结构化对象：

```json
{
  "type": "operator_pause",
  "stage": "investigate",
  "round": 2,
  "details": "Paused by operator",
  "blockers": []
}
```

## Operator Controls

### Check progress

```bash
npm run ai-sprint -- --status <run-id>
```

This prints structured JSON with current state and latest summary.

The latest stage `decision.md` also contains machine-readable metrics:

- `approvalCount`
- `blockerCount`
- `producerSectionChecks`
- `reviewerSectionChecks`
- `producerChecks`
- `reviewerAChecks`
- `reviewerBChecks`
- `dimensionScores` (if scoring enabled)

### Pause a run

```bash
npm run ai-sprint -- --pause <run-id>
```

This marks the run as paused. The orchestrator stops on the next control check.

### Resume a run

```bash
npm run ai-sprint -- --resume <run-id>
```

### Abort a run

```bash
npm run ai-sprint -- --abort <run-id>
```

This marks the run as aborted and stops further progression.

## Defaults

Current role defaults:

- producer: `opencode` + `minimax-cn-coding-plan/MiniMax-M2.7`
- reviewer_a: `iflow` + `glm-5`
- reviewer_b: `iflow` + `glm-5`

`claude` is reserved for future escalation paths (global_reviewer role in architecture-cut and verify stages).

## Notes

- The orchestrator uses files as the source of truth.
- AI session memory is treated as disposable.
- The first implementation is intentionally narrow and task-template-driven.
- Role worklogs and role state files exist specifically to reduce context-loss and drift during long-running agent work.
- Producer and reviewer prompts now require a `CHECKS:` line so the orchestrator can make earlier, less ambiguous stage decisions.
- The 6-stage model (investigate → architecture-cut → patch-plan → implement-pass-1 → implement-pass-2 → verify) is designed for refactoring tasks. Bugfix sprints may skip architecture-cut if scope is clearly local.
