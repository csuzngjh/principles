# RUNTIME_GUARDRAILS

> Purpose: keep the internal team stable under context compression, session resets, and runtime failures

## Startup Rules

Each long-lived role should reload its stable context at session start:

- role identity files
- role tool rules
- shared governance state

Minimum shared files to reload:

- `TEAM_CURRENT_FOCUS.md`
- `WORK_QUEUE.md`
- `AUTONOMY_RULES.md`

## Memory Rules

- transient chat context is not durable truth
- any work that spans more than one turn must be externalized
- active work should be reflected in queue or report artifacts

## Scheduling Rules

Use `heartbeat` for:

- lightweight patrol
- health checks
- quiet keep-alive behavior

Use `cron` for:

- meetings
- triage sweeps
- proposal reviews
- verification passes
- weekly governance

## Communication Rules

- peer roles coordinate through explicit `sessions_send`
- subagents are temporary workers only
- shared governance files remain the fallback truth layer when messages fail

## Exception Rules

### Context compression

- rebuild from files, not from memory

### Fresh session after cron rollover

- treat the run as stateless
- re-read current shared governance files before acting

### Missing participant

- mark absent
- continue with available evidence
- create a follow-up queue item

### Subagent failure

- convert failure into a new structured artifact
- do not allow the parent role to silently absorb all responsibilities

### Verification failure

- return work to queue
- do not mark the item done

## Autonomy Boundary

The system is semi-autonomous by default.

Allowed:

- observe
- draft
- route
- bounded repair
- bounded verification

Not allowed without human approval:

- protected-branch merge
- production deploy
- wide-scope refactor
- upstream OpenClaw changes
