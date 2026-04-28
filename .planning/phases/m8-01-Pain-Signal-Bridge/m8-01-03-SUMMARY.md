---
phase: m8-01
plan: 03
subsystem: runtime-v2
tags:
  - m8
  - runtime-summary
key-files:
  created: []
  modified:
    - packages/openclaw-plugin/src/service/runtime-summary-service.ts
    - packages/openclaw-plugin/src/commands/evolution-status.ts
metrics:
  lines_added: 35
  lines_deleted: 24
---

## Plan m8-01-03 Complete: Update runtime-summary + event-types

### What Was Built / Done

**runtime-summary-service.ts:**
- Removed `getPendingDiagnosticianTasks` import (diagnostician-task-store)
- Added `better-sqlite3` import
- Replaced `heartbeatDiagnosis` section with `runtimeDiagnosis`
- Now queries `task-store.db` SQLite directly: `SELECT COUNT(*) FROM tasks WHERE task_kind = 'diagnostician' AND status = 'pending'`
- Path: `{stateDir}/.principles/db/task-store.db`

**evolution-status.ts:**
- Updated all `heartbeatDiagnosis` field references to `runtimeDiagnosis`

### Commits

| Task | Commit |
|------|--------|
| runtime-summary update | b89f896 `refactor(m8): replace heartbeatDiagnosis with runtimeDiagnosis (runtime-v2)` |

### Deviations

None.

### Self-Check

PASSED — build succeeds.
