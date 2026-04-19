# Phase 03 Plan 01: Workflow Funnel Runtime Integration — Wave 1 Summary

**Phase:** 03-manual-remediation
**Plan:** 03-01
**Plan Type:** execute / wave 1
**Status:** Complete
**Duration:** 97 seconds
**Completed:** 2026-04-19

## Objective

Fix workflow-funnel-loader.ts bugs and add WORKFLOWS_YAML to paths.ts. Wave 1 foundation — all changes self-contained to these two files with no downstream consumers.

## One-Liner

WORKFLOWS_YAML registered in PD_FILES; WorkflowFunnelLoader gains re-entry guard, Windows-compatible rename handling, and deep-clone getAllFunnels().

---

## Tasks Executed

| # | Task | Name | Commit | Files |
|---|------|------|--------|-------|
| 1 | auto | Add WORKFLOWS_YAML to PD_FILES | `4f8bbd16` | paths.ts |
| 2 | auto | Fix workflow-funnel-loader.ts three bugs | `05d06c89` | workflow-funnel-loader.ts |

---

## Changes Made

### Task 1: `4f8bbd16` — Add WORKFLOWS_YAML to PD_FILES

**File:** `packages/openclaw-plugin/src/core/paths.ts`

Added `WORKFLOWS_YAML: posixJoin(PD_DIRS.STATE, 'workflows.yaml')` to the `PD_FILES` object, placed near other STATE-directory entries (DICTIONARY, PRINCIPLE_BLACKLIST).

### Task 2: `05d06c89` — Fix workflow-funnel-loader.ts three bugs

**File:** `packages/openclaw-plugin/src/core/workflow-funnel-loader.ts`

| Bug | Fix | Location |
|-----|-----|----------|
| WATCHER-01 / re-entry guard | `if (this.watchHandle) return;` at top of `watch()` | line 130 |
| PLAT-01 / rename handling | `if (eventType !== 'change' && eventType !== 'rename') return;` | line 135 |
| WATCHER-03 / shallow copy | Deep-clone: `result.set(k, v.map(stage => ({ ...stage })))` | lines 167-168 |
| dispose() | Already correct: sets `watchHandle = undefined` after `close()` | lines 147-149 |

---

## Success Criteria — All Met

| Criterion | Status |
|-----------|--------|
| WORKFLOWS_YAML is in PD_FILES | PASS — `WORKFLOWS_YAML: posixJoin(PD_DIRS.STATE, 'workflows.yaml')` at line 65 |
| watch() twice: no FSWatcher leak | PASS — re-entry guard returns early on second call |
| getAllFunnels() deep-clones inner arrays | PASS — `v.map(stage => ({ ...stage }))` creates new array and new stage objects |
| fs.watch fires on both 'change' and 'rename' | PASS — eventType filter accepts both |
| dispose() closes watcher and clears handle | PASS — `close()` then `watchHandle = undefined` |

---

## Deviations from Plan

None. Plan executed exactly as written.

---

## Verification Commands

```bash
# WORKFLOWS_YAML entry
grep -n "WORKFLOWS_YAML" packages/openclaw-plugin/src/core/paths.ts
# Expected: line with WORKFLOWS_YAML: posixJoin(PD_DIRS.STATE, 'workflows.yaml'),

# Re-entry guard
grep -n "if (this.watchHandle) return" packages/openclaw-plugin/src/core/workflow-funnel-loader.ts

# Rename + change handling
grep -n "eventType !== 'change' && eventType !== 'rename'" packages/openclaw-plugin/src/core/workflow-funnel-loader.ts

# Deep-clone getAllFunnels
grep -n "result.set.*v.map" packages/openclaw-plugin/src/core/workflow-funnel-loader.ts
```

---

## Commits

- `4f8bbd16` feat(core): add WORKFLOWS_YAML to PD_FILES
- `05d06c89` fix(core): workflow-funnel-loader.ts three bug fixes

---

## Self-Check: PASSED

- `4f8bbd16` found in git log
- `05d06c89` found in git log
- Both modified files exist at correct paths
- Lint passed on both commits
