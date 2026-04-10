# Phase 1: 基础可视化 - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning (work already committed)

<domain>
## Phase Boundary

添加覆盖率趋势图、场景热力图、优化空状态 — all three are already implemented in the committed codebase.

**Scope (already delivered):**
- Coverage trend: `LineChart` rendering `data.coverageTrend` in a collapsible panel (L258-274)
- Scenario heatmap: `heatmap-table` component rendering `data.scenarioMatrix` model×scenario cross-tab (L638-680)
- Empty state optimization: `EmptyState` component used throughout; friendly messages with i18n

</domain>

<decisions>
## Implementation Decisions

### VIZ-01: Coverage Trend Chart
- **Already implemented:** LineChart at `data.coverageTrend` with daily `coverageRate` values
- Maps `coverageRate` (0-1) to percentage display via `Math.round(d.coverageRate * 100)`
- i18n key: `thinkingModels.coverageTrend`

### VIZ-03: Scenario Heatmap
- **Already implemented:** HTML table heatmap using `scenarioMatrix` data
- Rows = top models sorted by hits, columns = unique scenarios
- Cell intensity via `rgba(91, 139, 160, ${intensity})` with `maxHits` normalization
- Collapsed by default inside `CollapsiblePanel`
- i18n key: `thinkingModels.scenarioHeatmap`

### VIZ-04: Empty State Optimization
- **Already implemented:** `EmptyState` component with icon, title, description, action slot
- Used for: no models yet, no detail selected, no usage trend, no scenario matrix
- All text via i18n: `noDataTitle`, `noDataDesc`, `emptyTitle`, `emptyDesc`

### Prior Phase Decisions (carry forward)
- No new UI work beyond what is committed
- THINKING_OS.md is the single source of truth for thinking model definitions

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `LineChart` from `charts.tsx` — already used for coverageTrend and usageTrend
- `CollapsiblePanel` from `charts.tsx` — used for dormant models and scenario heatmap
- `EmptyState` from `charts.tsx` — reused throughout detail and list views
- `Sparkline` from `charts.tsx` — used in StatCard and model list rows

### Established Patterns
- Charts render inside `<section className="panel">` with `<h3 className="section-title">`
- All text uses `t('thinkingModels.xxx')` i18n keys
- Inline styles use `SPACE` and `TEXT` design token objects
- `formatPercent()` utility for rate display

### Integration Points
- `coverageTrend` from `ThinkingOverviewResponse` — `api.getThinkingOverview()`
- `scenarioMatrix` from `ThinkingOverviewResponse` — same API call
- Both data sources already connected and rendered

</code_context>

<specifics>
## Specific Ideas

- Coverage trend shows 14-day window by default (controlled by `coverageTrend.length`)
- Heatmap is sorted by model hits descending; scenarios alphabetically
- Empty state for no-data shows model definition grid (not a blank page)

</specifics>

<deferred>
## Deferred Ideas

None — Phase 1 scope fully delivered.

</deferred>

---
*Phase: 01-basic-visualization*
*Context gathered: 2026-04-10 (work already committed)*
