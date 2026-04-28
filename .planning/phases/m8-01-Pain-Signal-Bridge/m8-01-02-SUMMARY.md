---
phase: m8-01
plan: 02
subsystem: legacy-cleanup
tags:
  - m8
  - legacy-deletion
key-files:
  created: []
  modified:
    - packages/openclaw-plugin/src/service/evolution-worker.ts
    - packages/openclaw-plugin/src/hooks/prompt.ts
metrics:
  lines_deleted: 609
  files_modified: 2
---

## Plan m8-01-02 Complete: Remove legacy diagnostician block

### What Was Built / Done

**evolution-worker.ts** (609 lines removed):
- Removed import of `addDiagnosticianTask`, `completeDiagnosticianTask`, `requeueDiagnosticianTask`
- Removed `pain_diagnosis` in_progress completion polling (marker file detection)
- Removed `pain_diagnosis` pending task heartbeat enqueueing (HEARTBEAT.md writes, diagnostician_tasks.json writes, heartbeat injection)
- Removed pipeline observability logs for pain_diagnosis tasks
- Preserved: sleep_reflection, keyword_optimization, queue I/O

**prompt.ts** (88 lines removed):
- Removed `getPendingDiagnosticianTasks` import
- Removed `PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED` guard
- Removed `<diagnostician_task>` XML injection block
- Removed `heartbeat_diagnosis` event recording

### Commits

| Task | Commit |
|------|--------|
| evolution-worker cleanup | 4d0f740 `refactor(m8): remove legacy diagnostician block from evolution-worker` |
| prompt.ts cleanup | acec6f5 `refactor(m8): remove legacy diagnostician block from prompt.ts` |

### Deviations

None.

### Self-Check

PASSED — build succeeds, no references to legacy diagnostician path in source.
