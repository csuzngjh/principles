---
name: plan-script
description: Create a step-by-step movie-script style execution plan. Includes target files, verification metrics, and rollback strategy.
disable-model-invocation: true
---

# Plan Script

**Goal**: Produce a "foolproof" executable plan to ensure controlled execution.

Please generate plan in the following structure:

## 1. Target Files (Authorization List)
- List file paths **uniquely authorized** for modification in this plan.
- Format: `- path/to/file`

## 2. Steps (Execution Steps)
1. Operations specific to filenames and tool calls.
2. Each step includes expected intermediate state.

## 3. Metrics (Verification Metrics)
- How to quantitatively prove this plan succeeded? (e.g., tests pass, command returns 0, specific string appears in logs).

## 4. Active Mental Models
- Select exactly **2** meta-cognitive models from `docs/THINKING_OS.md` that are most relevant to the current task.
- Format: `- [T-0X] Model Name: Why is it needed for this specific task?`

## 5. Rollback (Rollback Strategy)
- If step 2 fails, how to one-click restore to safe state?

---
**Action**: Update above content to `docs/PLAN.md` and set `STATUS: READY`.
