# 🔄 Session Recovery Protocol

> This file is permanent. Do not delete. Used when session restarts or task queue is empty.

---

## When to Use This Protocol

1. **Session Restart**: After context window reset or new session
2. **Empty Task Queue**: `WEEK_TASKS.json` has no `in_progress` tasks
3. **Lost Context**: Cannot recall what you were working on
4. **Post-Evolution**: After completing an evolution task

---

## Recovery Steps

### Step 1: Read State Files

Read these files in order:

```
1. .state/evolution_directive.json  → Active evolution directive?
2. okr/WEEK_TASKS.json              → Structured task list
3. okr/TASK_CHANGES.jsonl           → Recent task changes
4. CURRENT_FOCUS.md                 → Current focus (if exists)
5. memory/logs/SYSTEM.log           → Recent activity (last 50 lines)
```

### Step 2: Validate Task Status

For each task in `WEEK_TASKS.json`:

- **pending**: Ready to start
- **in_progress**: Check `startedAt` timestamp
  - If > 2 hours old without update → May be stalled
  - Verify with user if should continue
- **completed**: Skip (already done)

### Step 3: Resume or Derive

**If tasks found:**

1. Resume highest priority `pending` or stalled `in_progress` task
2. Update `TASK_CHANGES.jsonl` with recovery action:

```json
{"ts":"ISO-timestamp","action":"resume","taskId":"T001","reason":"session recovery"}
```

**If no valid tasks:**

1. Check `evolution_directive.json` for pending evolution
2. Check `.state/.pain_flag` for unprocessed pain signals
3. Ask user: "I don't have any active tasks. What should I work on?"

### Step 4: Self-Derivation (Empty Queue)

When task queue is empty AND no evolution directive:

1. **Check Pain Dictionary**: `.state/pain_dictionary.json` for known issues
2. **Review Recent Logs**: Look for patterns or recurring problems
3. **Suggest Actions**:
   - "I noticed [X] from the logs. Should I investigate?"
   - "No active tasks. Should I run a system health check?"
   - "The last evolution was [topic]. Should I follow up?"

---

## Task Status Definitions

| Status | Meaning | Action |
|--------|---------|--------|
| `pending` | Not started | Can be picked up |
| `in_progress` | Currently working | Resume or verify |
| `blocked` | Waiting for something | Check blocker, notify user |
| `completed` | Done | Archive, move to evidence |
| `cancelled` | Abandoned | Log reason, remove from queue |

---

## Priority Levels

| Priority | Description | Response Time |
|----------|-------------|---------------|
| `critical` | System down, data loss risk | Immediate |
| `high` | Important, time-sensitive | Within session |
| `medium` | Normal priority | Current week |
| `low` | Nice to have | Backlog |

---

## Change Log Format (TASK_CHANGES.jsonl)

Each line is a JSON object:

```json
{"ts":"2026-01-01T12:00:00Z","action":"add","taskId":"T001","desc":"New task","addedBy":"user"}
{"ts":"2026-01-01T12:30:00Z","action":"start","taskId":"T001","reason":"starting work"}
{"ts":"2026-01-01T14:00:00Z","action":"complete","taskId":"T001","evidence":["fixed bug X"]}
```

---

## Recovery Checklist

- [ ] Read `WEEK_TASKS.json`
- [ ] Check `evolution_directive.json`
- [ ] Check `.state/.pain_flag`
- [ ] Review recent `SYSTEM.log`
- [ ] Resume or derive next task
- [ ] Log recovery action to `TASK_CHANGES.jsonl`

---

*This protocol ensures continuity across sessions. Always follow it when context is lost.*
