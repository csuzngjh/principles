# Phase 11: Evolution Tasks CLI - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-20
**Phase:** 11-evolution-tasks-cli
**Areas discussed:** Task fields displayed, Default filters, Task identity

---

## Task fields displayed

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal | taskId, status, source — clean single-line summary | |
| Standard (+ timing + kind) | Adds enqueuedAt and task_kind for timing/classification context | ✓ |
| Verbose (all fields) | Full record — everything including retry counts and error details | |

**User's choice:** Standard (+ timing + kind)
**Notes:** Selected for good balance — enough context without overwhelming. Fields shown: taskId, status, source, score, enqueuedAt, taskKind.

---

## Default filters

| Option | Description | Selected |
|--------|-------------|----------|
| No filter (show all) | Show all tasks regardless of status — good for debugging/history | ✓ |
| pending tasks only | Most actionable: tasks that need attention | |
| Active only | Show in_progress + pending combined | |

**User's choice:** No filter (show all)
**Notes:** Mirrors Phase 10's `pd samples list` flexibility. User can always filter with `--status`.

---

## Task identity

| Option | Description | Selected |
|--------|-------------|----------|
| Numeric id | Simpler for CLI — `pd evolution tasks show 123` | |
| String taskId | More descriptive. `pd evolution tasks show task_042` | |
| Both | Both supported — id for quick access, taskId when you need to cross-reference | ✓ |

**User's choice:** Both
**Notes:** Accept either format for flexibility. Both numeric id and string taskId work with `show` subcommand.

---

## Additional Subcommand

**Question:** Should `pd evolution tasks` support a `show <id>` subcommand to view full task details?

**Options presented:**
- Yes — show subcommand: Include a `pd evolution tasks show <id>` subcommand for full task details
- No — list only: List view is sufficient for Phase 11

**User's choice:** Yes — show subcommand

---

## Claude's Discretion

No areas deferred to Claude — all decisions made by user.

## Deferred Ideas

None mentioned during discussion.

