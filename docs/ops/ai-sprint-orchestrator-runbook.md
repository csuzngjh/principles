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

## Current Task Templates

- `empathy-runtime-fix`

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

Use:

```bash
npm run ai-sprint -- --status <run-id>
```

This prints structured JSON with current state and latest summary.

### Pause a run

Use:

```bash
npm run ai-sprint -- --pause <run-id>
```

This marks the run as paused. The orchestrator stops on the next control check.

### Resume a run

Use:

```bash
npm run ai-sprint -- --resume <run-id>
```

### Abort a run

Use:

```bash
npm run ai-sprint -- --abort <run-id>
```

This marks the run as aborted and stops further progression.

## Defaults

Current role defaults:

- producer: `opencode` + `minimax-cn-coding-plan/MiniMax-M2.7`
- reviewer_a: `iflow` + `glm-5`
- reviewer_b: `iflow` + `glm-5`

`claude` is intentionally not on the default loop in v1 to preserve quota. It is reserved for future escalation paths.

## Notes

- The orchestrator uses files as the source of truth.
- AI session memory is treated as disposable.
- The first implementation is intentionally narrow and task-template-driven.
- Role worklogs and role state files exist specifically to reduce context-loss and drift during long-running agent work.
