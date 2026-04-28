---
phase: m8-01
plan: 01
subsystem: legacy-cleanup
tags:
  - m8
  - legacy-deletion
key-files:
  created: []
  modified: []
metrics:
  files_deleted: 1
  lines_deleted: 192
  imports_removed: 3
---

## Plan m8-01-01 Complete: Delete diagnostician-task-store.ts

### What Was Built / Done

- **diagnostician-task-store.ts deleted** (192 lines)
  - `addDiagnosticianTask`, `completeDiagnosticianTask`, `requeueDiagnosticianTask`, `getPendingDiagnosticianTasks`, `hasPendingDiagnosticianTasks` — all gone
- **All imports removed** from:
  - `evolution-worker.ts` — removed import + all usages (addDiagnosticianTask, completeDiagnosticianTask, requeueDiagnosticianTask)
  - `prompt.ts` — removed import + legacy diagnostician block (~88 lines)
  - `runtime-summary-service.ts` — replaced with SQLite query

### Commits

| Task | Commit |
|------|--------|
| Delete source | 67d022dd `refactor(m8): delete diagnostician-task-store.ts` |
| evolution-worker cleanup | 4d0f740 `refactor(m8): remove legacy diagnostician block from evolution-worker` |
| prompt.ts cleanup | acec6f5 `refactor(m8): remove legacy diagnostician block from prompt.ts` |
| runtime-summary-service update | b89f896 `refactor(m8): replace heartbeatDiagnosis with runtimeDiagnosis (runtime-v2)` |

### Deviations

None — plan followed exactly.

### Self-Check

PASSED — build succeeds, no remaining imports of diagnostician-task-store.ts in source files.
