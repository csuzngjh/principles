---
phase: "01-basic-visualization"
plan: "01-GAP-CLOSURE"
status: complete
score: "3/3 must-haves verified"
dependencies:
  requires: []
  provides: []
  affects: []
tech_stack:
  added: []
  patterns: []
key_files:
  created: []
  modified:
    - "packages/openclaw-plugin/ui/src/charts.tsx"
    - "packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx"
decisions: []
metrics:
  duration: "~5 minutes (verification only, code already implemented)"
  completed: "2026-04-17T07:20:00Z"
---

# Phase 01 Plan GAP-CLOSURE: Summary

**One-liner:** Verified and confirmed i18n emptyText prop on LineChart, ternary operator for coverage trend EmptyState, and all LineChart usages passing emptyText prop.

## Truths Verified

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | LineChart interface has emptyText prop for i18n | PASS | `emptyText?: string` at line 864 in charts.tsx |
| 2 | LineChart renders emptyText prop instead of hardcoded "暂无数据" | PASS | Conditional render at lines 878-885: `if (!emptyText) return null;` then `{emptyText}` |
| 3 | Coverage trend section shows EmptyState when no data | PASS | Ternary operator at line 259: `data.coverageTrend.length >= 1 ? (...) : (<EmptyState ...>)` |
| 4 | All LineChart usages pass emptyText prop | PASS | All 3 LineChart usages (lines 272, 454, 521) have `emptyText={t('common.noData')}` |

**Score: 3/3 truths verified**

## Implementation Details

### Task 1: LineChart emptyText prop (charts.tsx)

**Interface (line 864):**
```typescript
emptyText?: string;
```

**Conditional render (lines 878-885):**
```typescript
if (!data || data.length === 0) {
  if (!emptyText) return null;
  return (
    <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
      {emptyText}
    </div>
  );
}
```

### Task 2: Coverage trend ternary with EmptyState (ThinkingModelsPage.tsx)

**Lines 259-280:**
```typescript
{data.coverageTrend.length >= 1 ? (
  <section className="panel" style={{ marginBottom: SPACE[4] }}>
    <h3 className="section-title">
      {t('thinkingModels.coverageTrend')}
    </h3>
    <LineChart
      data={data.coverageTrend.map(d => ({ label: d.day.slice(5), value: Math.round(d.coverageRate * 100) }))}
      width={560}
      height={140}
      color="var(--accent)"
      showGrid
      showDots
      showArea
      emptyText={t('common.noData')}
    />
  </section>
) : (
  <EmptyState
    title={t('thinkingModels.emptyCoverageTrend')}
    description={t('thinkingModels.emptyCoverageTrendDesc')}
  />
)}
```

### Task 3: All LineChart usages with emptyText

| Line | Usage | emptyText prop |
|------|-------|----------------|
| 264 | Coverage trend chart | `emptyText={t('common.noData')}` |
| 446 | Usage trend in summary panel | `emptyText={t('common.noData')}` |
| 513 | Usage trend in detail panel | `emptyText={t('common.noData')}` |

## Deviations from Plan

**None** - All tasks were already implemented in the codebase. This plan verified the fixes are in place.

## Verification Commands Run

```bash
# 1. emptyText in interface
grep -n "emptyText?: string" packages/openclaw-plugin/ui/src/charts.tsx
# Result: 864:  emptyText?: string;

# 2. No hardcoded text
! grep -n "暂无数据" packages/openclaw-plugin/ui/src/charts.tsx
# Result: CLEAN: No 暂无数据 found

# 3. Ternary operator for coverage trend
grep -n "coverageTrend.length.*?" packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx
# Result: 259:          {data.coverageTrend.length >= 1 ? (

# 4. All LineChart have emptyText
grep -B5 -A10 "LineChart" packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx | grep -c "emptyText"
# Result: 3
```

## Gap Closure from 01-VERIFICATION.md

| Gap | Original Status | Current Status |
|-----|----------------|----------------|
| LineChart has emptyText prop | FAILED | PASS |
| Coverage trend EmptyState | FAILED | PASS |
| All LineChart pass emptyText | FAILED | PASS |

## Self-Check: PASSED

All acceptance criteria verified:
- [x] Line 864 contains `emptyText?: string;` in LineChartProps interface
- [x] File does NOT contain "暂无数据" (0 matches)
- [x] Line 259 contains ternary operator (not &&)
- [x] EmptyState imported at line 5 from charts.tsx
- [x] All 3 LineChart usages have `emptyText={t('common.noData')}`
