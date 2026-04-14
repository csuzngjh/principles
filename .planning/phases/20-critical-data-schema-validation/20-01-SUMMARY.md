---
phase: 20-critical-data-schema-validation
plan: 01
subsystem: pain-parsing, schema-validation
tags: [schema-01, schema-03, pain-flag, validation]
key-files:
  modified:
    - packages/openclaw-plugin/src/core/pain.ts
    - packages/openclaw-plugin/src/core/pain-context-extractor.ts
    - packages/openclaw-plugin/src/core/pain-flag*.ts
    - packages/openclaw-plugin/tests/core/pain*.test.ts
metrics:
  files_changed: 4
  lines_added: N/A
  lines_removed: N/A
requirements-completed: [SCHEMA-01, SCHEMA-03]
---

# Phase 20 Plan 01: Centralized Pain Flag Parser Contract

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1-3 | d671e55 | Local execution — pain flag parser centralization |

## Deviations

None — all changes implemented as planned.

## Self-Check: PASSED

- `npx tsc --noEmit` passes
- `vitest run tests/core/pain.test.ts tests/core/pain-integration.test.ts tests/core/pain-auto-repair.test.ts` passes
- `readPainFlagContract()` used by all `.pain_flag` readers
- Malformed pain data rejected with explicit failure reasons
