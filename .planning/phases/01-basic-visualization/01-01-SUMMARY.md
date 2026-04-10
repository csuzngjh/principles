---
phase: "01"
plan: "01-01"
subsystem: "basic-visualization"
tags: ["ui", "bugfix", "i18n"]
key-files:
  created:
    - "packages/openclaw-plugin/ui/src/charts.tsx"
    - "packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx"
metrics:
  tasks: 3
  commits: 1
---

# Plan 01-01: Fix 2 UI bugs + UAT verification — Summary

## Commits

| Commit | Task | Description |
|--------|------|-------------|
| `170b217` | 1, 2 | Fix LineChart i18n + coverage EmptyState |

## Deviations

None — all tasks completed as planned.

## Self-Check

**Status:** PASSED ✓

- [x] LineChart has `emptyText?: string` prop
- [x] Hardcoded "暂无数据" removed, replaced with prop
- [x] All 3 LineChart usages pass `emptyText={t('common.noData')}`
- [x] Coverage trend section renders EmptyState when `data.coverageTrend.length === 0`
- [x] Human verification approved — UAT criteria passed

## What Was Built

1. **LineChart i18n fix** (`charts.tsx`):
   - Added `emptyText?: string` prop to `LineChartProps` interface
   - Replaced hardcoded `"暂无数据"` fallback (L879) with conditional render
   - When `emptyText` is empty: returns `null` (no empty box)
   - When `emptyText` is provided: renders `span` with the message

2. **Coverage trend EmptyState** (`ThinkingModelsPage.tsx`):
   - Wrapped coverage trend section in `EmptyState` component
   - When `data.coverageTrend.length === 0`: shows friendly i18n message
   - Uses `emptyCoverageTrend` i18n keys for title/description
   - Previously silently rendered nothing when no data

3. **UAT verification** (approved by human):
   - Coverage trend chart displays daily data correctly
   - Scenario heatmap shows model×scenario cross-tab
   - Empty states show friendly i18n messages (no hardcoded text)

## Next Steps

Phase 1 complete → proceed to verification

---
*Generated: 2026-04-10*
