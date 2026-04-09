# PLAN: Phase 2 — 模型详情可视化

**Milestone:** v1.10
**Phase:** 2
**Goal:** 为选中的模型添加使用趋势图
**Requirements:** VIZ-02

## Context

**Current state:** `getThinkingModelDetail(modelId)` returns `usageTrend: Array<{ day: string; hits: number }>`. This data is fetched but never rendered.

**Dependency:** Phase 1 charts are already integrated (LineChart, EmptyState).

## Approach

Add a `LineChart` in the model detail panel showing daily `hits` for the selected model.

**Location:** Between the detail header and the outcome stats article.

**Data transformation:**
```typescript
const trendChartData = detail.usageTrend.map(d => ({
  label: d.day.slice(5), // "04-09"
  value: d.hits,
}));
```

**Empty state:** If `detail.usageTrend.length === 0`, show `EmptyState` with "暂无使用趋势记录"。

## Files to Modify

| File | Changes |
|------|---------|
| `ui/src/pages/ThinkingModelsPage.tsx` | Add usage trend chart in detail panel |

## UAT Criteria

- [ ] Switching models updates the trend chart
- [ ] Chart shows correct daily hit counts
- [ ] Empty state shown when no trend data
