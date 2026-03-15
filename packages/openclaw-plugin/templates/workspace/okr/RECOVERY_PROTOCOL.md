# 🔄 Recovery Protocol - Read After Session Restart

> **永久存在文件** — 会话重启后必读，不要删除此文件。

---

## Step 1: Read Current State

1. Read `memory/okr/WEEK_TASKS.json` → Current task list
2. Read `memory/okr/TASK_CHANGES.jsonl` → Recent changes (last 10 lines)
3. Read `memory/okr/WEEK_STATE.json` → Week progress

## Step 2: Verify In-Progress Tasks

For each `in_progress` or `done` task:
- PR merged? → `git log --oneline | grep "Merge"`
- Document exists? → `ls -la <path>`
- Tests passing? → `npm test | grep "passed"`

## Step 3: Resume Execution

| Situation | Action |
|-----------|--------|
| Has pending tasks | Continue execution |
| Task queue empty | Execute autonomous derivation (see below) |
| OKR complete | Notify user for new direction |

---

## Autonomous Derivation Flow

When task queue is empty:

1. Read `memory/STRATEGY.md` → Project vision and strategy
2. Read `memory/okr/CURRENT_FOCUS.md` → Current milestones
3. Identify incomplete milestones → Derive 3-5 concrete tasks
4. Write to `WEEK_TASKS.json`
5. Notify user: "I have planned tasks for this week, please confirm"

**Important**: Do NOT invent new goals without user confirmation. Only derive tasks from existing OKRs and strategy.

---

## Files to Check

| File | Purpose | Update Frequency |
|------|---------|-----------------|
| `WEEK_TASKS.json` | Structured task list | On task changes |
| `TASK_CHANGES.jsonl` | Append-only change log | On every change |
| `WEEK_STATE.json` | Week progress metrics | Weekly governance |
| `WEEK_EVENTS.jsonl` | System events | On events |
| `CURRENT_FOCUS.md` | Human-readable summary | Weekly governance |

---

*Last updated: 2026-03-15*
