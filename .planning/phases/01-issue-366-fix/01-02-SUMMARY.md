# Phase 01 Plan 02 Summary: Event-Log Stats Aggregation

**Phase:** 01-issue-366-fix
**Plan:** 02
**Status:** COMPLETE
**Date:** 2026-04-18
**Duration:** ~5 min

---

## Objective

Update `recordDiagnosticianReport` to handle three-state category and `updateStats` to increment new stats counters for Issue #366 (diagnostician_report category 三態擴展).

---

## Tasks Completed

| # | Task | Status | Commit |
|---|------|--------|--------|
| 1 | Update recordDiagnosticianReport to handle three-state category | DONE | 949a961a |
| 2 | Update updateStats to increment new counters | DONE | 949a961a |

---

## Changes Made

### File: packages/openclaw-plugin/src/core/event-log.ts

**Task 1 — recordDiagnosticianReport (lines 199-207)**

Replaced boolean-based category mapping with a three-state category map:

```typescript
recordDiagnosticianReport(data: DiagnosticianReportEventData): void {
  const categoryMap: Record<DiagnosticianReportEventData['category'], EventCategory> = {
    success: 'completed',
    missing_json: 'failure',
    incomplete_fields: 'failure',
  };
  this.record('diagnostician_report', categoryMap[data.category], undefined, data);
}
```

**Task 2 — updateStats diagnostician_report handler (lines 358-378)**

Added new counters with backward compat for old `success: boolean` events:

```typescript
} else if (entry.type === 'diagnostician_report') {
  const data = entry.data as unknown as DiagnosticianReportEventData;
  if ('category' in data) {
    if (data.category === 'success' || data.category === 'incomplete_fields') {
      stats.evolution.diagnosticianReportsWritten++;
    }
    if (data.category === 'missing_json') {
      stats.evolution.reportsMissingJson++;
    }
    if (data.category === 'incomplete_fields') {
      stats.evolution.reportsIncompleteFields++;
    }
  } else if ('success' in data) {
    if (data.success) {
      stats.evolution.diagnosticianReportsWritten++;
    }
  }
}
```

---

## Verification

```
npx vitest run tests/core/event-log.test.ts
  13 tests passed
npm run lint
  lint passed
```

---

## Success Criteria

- [x] recordDiagnosticianReport maps three-state category to EventCategory
- [x] updateStats increments diagnosticianReportsWritten for 'success' and 'incomplete_fields'
- [x] updateStats increments reportsMissingJson for 'missing_json'
- [x] updateStats increments reportsIncompleteFields for 'incomplete_fields'
- [x] Backward compat handles old events with success: boolean
- [x] Event-log tests pass (13/13)

---

## Decisions Made

1. **Backward compat strategy**: Old events persisted with `success: boolean` are handled via `'success' in data` check, ensuring existing event logs continue to aggregate correctly.
2. **Category mapping**: Both `missing_json` and `incomplete_fields` map to `failure` in EventCategory (event display tier), but are tracked separately in stats for funnel analysis.

---

## Deviation from Plan

None — plan executed exactly as written.

---

## Commit

- **949a961a** — feat(event-log): 三態 category 聚合統計 (PD-FUNNEL-1.2)
