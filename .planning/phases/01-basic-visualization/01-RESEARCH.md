# Phase 1: 基础可视化 - Research (Audit of Committed Work)

**Researched:** 2026-04-10
**Domain:** Frontend audit of committed Phase 1 work (VIZ-01, VIZ-03, VIZ-04)
**Confidence:** HIGH

## Summary

Phase 1 work is committed and largely correct. All three requirements (VIZ-01, VIZ-03, VIZ-04) are implemented in the codebase. The primary finding is a cross-component bug in `LineChart`: its internal empty-state fallback renders hardcoded Chinese text (`暂无数据`) instead of using i18n. This affects coverage trend, usage trend, and any other `LineChart` instance when data is empty. VIZ-01 has no dedicated `EmptyState` wrapper -- the section is silently hidden when no coverage data exists. VIZ-03 and VIZ-04 are fully implemented with correct sorting, intensity coloring, i18n text, and collapsible panel.

**Primary recommendation:** Fix `LineChart` hardcoded fallback text (cross-component bug). Add `EmptyState` wrapper around coverage trend for better UX when data exists but is insufficient for chart rendering.

## User Constraints (from CONTEXT.md)

### Locked Decisions
- VIZ-01: `LineChart` at `data.coverageTrend` with `coverageRate` mapped to percentage via `Math.round(d.coverageRate * 100)`, i18n key `thinkingModels.coverageTrend`
- VIZ-03: HTML table heatmap using `scenarioMatrix`, rows sorted by hits desc, columns alphabetically, `rgba(91, 139, 160, ${intensity})` intensity, `CollapsiblePanel` wrapper, i18n key `thinkingModels.scenarioHeatmap`
- VIZ-04: `EmptyState` with icon, title, description, action slot; used for no models yet, no detail selected, no usage trend, no scenario matrix; all text via i18n keys

### Claude's Discretion
- Coverage trend time window (14 days is backend default; frontend renders whatever arrives)
- Heatmap normalization strategy (maxHits normalization is implemented correctly)
- Empty state action slots (exist but unused in current implementation)

### Deferred Ideas (OUT OF SCOPE)
None -- Phase 1 scope fully delivered.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| VIZ-01 | Coverage Trend Chart | `LineChart` renders `data.coverageTrend` at L258-274 with correct data mapping. [VERIFIED: codebase lines 264-272] |
| VIZ-03 | Scenario Heatmap | HTML table heatmap renders `data.scenarioMatrix` model x scenario cross-tab at L638-680. [VERIFIED: codebase lines 641-680] |
| VIZ-04 | Empty State Optimization | `EmptyState` component used 4 times with consistent i18n. [VERIFIED: codebase lines 367-370, 517-521, 630-633, 683-687] |

## Standard Stack

### Components Used (already in codebase)
| Component | File | Purpose |
|-----------|------|---------|
| `LineChart` | `charts.tsx` L851-952 | Coverage trend and usage trend rendering |
| `CollapsiblePanel` | `charts.tsx` L542-586 | Dormant models and scenario heatmap container |
| `EmptyState` | `charts.tsx` L35-61 | Friendly empty state with icon, title, description |
| `Sparkline` | `charts.tsx` L63-148 | Inline mini trend for stat cards |

## Architecture Patterns

### Verified Implementation Patterns

**Coverage Trend (VIZ-01):**
```
Source: ThinkingModelsPage.tsx L258-274
<LineChart
  data={data.coverageTrend.map(d => ({ label: d.day.slice(5), value: Math.round(d.coverageRate * 100) }))}
  width={560} height={140}
  color="var(--accent)" showGrid showDots showArea
/>
```
- Renders inside `<section className="panel">` with `<h3 className="section-title">` [VERIFIED: L260-263]
- Condition: `data.coverageTrend.length >= 1` [VERIFIED: L259]
- i18n key: `thinkingModels.coverageTrend` [VERIFIED: L262]

**Scenario Heatmap (VIZ-03):**
```
Source: ThinkingModelsPage.tsx L172-182 (heatmapData useMemo)
Source: ThinkingModelsPage.tsx L641-680 (render)
```
- Models sorted by hits descending: `[...data.topModels].sort((a, b) => b.hits - a.hits)` [VERIFIED: L175]
- Scenarios sorted alphabetically: `[...new Set(data.scenarioMatrix.map(m => m.scenario))].sort()` [VERIFIED: L174]
- Intensity: `Math.max(0.15, (hits / maxHits) * 0.55).toFixed(2)` [VERIFIED: L665]
- Background color formula: `rgba(91, 139, 160, ${intensity})` [VERIFIED: L665]
- Zero hits: `var(--bg-sunken)` [VERIFIED: L664]

**Empty States (VIZ-04):**
```
Source: ThinkingModelsPage.tsx L367-370 (filtered list empty)
Source: ThinkingModelsPage.tsx L517-521 (usage trend empty)
Source: ThinkingModelsPage.tsx L630-633 (dormant models empty)
Source: ThinkingModelsPage.tsx L683-687 (scenario heatmap empty)
```
- All use `title` + `description` props [VERIFIED: all 4 locations]
- All text from i18n keys [VERIFIED: all 4 locations use t('thinkingModels.xxx')]

## Common Pitfalls

### Pitfall 1: LineChart Hardcoded Empty-State Text
**What goes wrong:** `LineChart` renders hardcoded Chinese `"暂无数据"` (line 879 of charts.tsx) when data is empty. This is NOT internationalized.
**Why it happens:** The fallback in `LineChart` uses a string literal instead of calling `t()`.
**How to avoid:** Replace line 879 with i18n lookup or pass an i18n key prop to `LineChart`.
**Affected charts:** Coverage trend (L264), Usage trend (L506), Comparison usage trends (L440).

### Pitfall 2: Coverage Trend Has No Dedicated Empty State
**What goes wrong:** When `coverageTrend.length >= 1` the chart renders. When `coverageTrend.length === 0` the entire section is hidden (no panel at all). There is no `EmptyState` component for coverage trend specifically.
**Why it happens:** The condition at L259 only checks `>= 1`. An empty array never enters the section.
**How to avoid:** Wrap the chart in an `EmptyState` or add an `||` branch with `emptyCoverageTrend` i18n text.
**Impact:** User sees a gap in the dashboard when there is no coverage data yet.

## Code Examples

### LineChart Empty Fallback (BUG -- needs i18n fix)
```typescript
// Source: charts.tsx L876-881 (BUG)
if (!data || data.length === 0) {
  return (
    <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
      暂无数据  {/* HARDCODED CHINESE - should use i18n */}
    </div>
  );
}
```

### Coverage Trend Rendering (correct)
```typescript
// Source: ThinkingModelsPage.tsx L264-272
<LineChart
  data={data.coverageTrend.map(d => ({ label: d.day.slice(5), value: Math.round(d.coverageRate * 100) }))}
  width={560}
  height={140}
  color="var(--accent)"
  showGrid
  showDots
  showArea
/>
```

### EmptyState Usage (consistent, i18n-correct)
```typescript
// Source: ThinkingModelsPage.tsx L517-521
<EmptyState
  title={t('thinkingModels.emptyUsageTrend')}
  description={t('thinkingModels.emptyUsageTrendDesc')}
/>
```

## UAT Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| 覆盖率趋势图正确显示每日数据 | PARTIAL | LineChart renders correctly with day labels (MM-DD) and percentage values. **BUG:** hardcoded Chinese fallback in LineChart when data is empty. |
| 场景热力图显示模型x场景交叉数据 | PASS | Table at L641-680 correctly cross-tabs models (sorted by hits) x scenarios (sorted alphabetically). Intensity coloring via maxHits normalization. CollapsiblePanel wrapper. |
| 空数据时显示友好提示 | PASS | 4 EmptyState usages with consistent i18n text. All titles and descriptions use `t('thinkingModels.xxx')` keys. |

## Assumptions Log

> List all claims tagged `[ASSUMED]` in this research. The planner and discuss-phase use this section to identify decisions that need user confirmation before execution.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Coverage trend backend returns 14-day window max | Architecture Patterns | Backend limit; frontend renders whatever data arrives. If backend changes window size, frontend will adapt automatically. |

**If this table is empty:** All claims in this research were verified or cited -- no user confirmation needed.

## Open Questions

1. **LineChart hardcoded "暂无数据" should be i18n**
   - What we know: LineChart has an empty-data fallback at L879 that uses hardcoded Chinese text.
   - What's unclear: Whether this should be a prop (i18n key) passed to LineChart, or whether LineChart should accept an i18n namespace.
   - Recommendation: Add `emptyText?: string` prop to `LineChart` and pass `t('common.noData')` from the page.

2. **Coverage trend should have a dedicated EmptyState**
   - What we know: The coverage trend section is conditionally rendered (`data.coverageTrend.length >= 1`) and silently hidden when empty.
   - What's unclear: Whether this was intentional (coverage trend only shown when data exists) or an oversight.
   - Recommendation: Add `EmptyState` with `emptyCoverageTrend` keys around the LineChart, or add an `else` branch.

## Sources

### Primary (HIGH confidence)
- `ThinkingModelsPage.tsx` -- VIZ-01, VIZ-03, VIZ-04 implementation
- `charts.tsx` -- LineChart, EmptyState, CollapsiblePanel components
- `ui.ts` -- i18n key definitions

### Secondary (MEDIUM confidence)
- ROADMAP.md -- UAT criteria and phase descriptions

## Metadata

**Confidence breakdown:**
- VIZ-01 implementation: HIGH -- verified in codebase lines 258-274
- VIZ-03 implementation: HIGH -- verified in codebase lines 172-182, 638-689
- VIZ-04 implementation: HIGH -- verified in codebase lines 367-370, 517-521, 630-633, 683-687
- LineChart bug: HIGH -- confirmed at charts.tsx L876-881

**Research date:** 2026-04-10
**Valid until:** 2026-05-10 (stable UI component, unlikely to change without explicit refactor)
