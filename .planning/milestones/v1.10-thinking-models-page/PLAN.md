# PLAN: Phase 1 — 基础可视化

**Milestone:** v1.10 Thinking Models 页面优化
**Phase:** 1
**Goal:** 添加覆盖率趋势图、场景热力图、优化空状态
**Requirements:** VIZ-01, VIZ-03, VIZ-04

## Context

### Current State

`ThinkingModelsPage.tsx` is a two-column layout:
- **Left panel**: Model list (`topModels`) with hits, success rate, recommendation
- **Right panel**: Detail for selected model (outcome stats, scenario distribution, recent events)

**Data already fetched but NEVER rendered:**
- `coverageTrend`: `{ day, assistantTurns: number; thinkingTurns: number; coverageRate: number }[]` — daily time series
- `scenarioMatrix`: `{ modelId: string; model: string; scenario: string; hits: number }[]` — model × scenario cross-tab
- `dormantModels`: `{ modelId: string; name: string; description: string }[]` — zero-hit models

**Existing chart components (charts.tsx):**
- `Sparkline` — mini trend line (60×24)
- `LineChart` — full-size line chart with grid, dots, area fill (default 560×180)
- `MiniBarChart` — mini bar chart (100×40)
- `EmptyState` — empty state placeholder with title, description, action
- `CollapsiblePanel` — collapsible section panel with title, badge, children

**API response type:**
```typescript
interface ThinkingOverviewResponse {
  summary: { activeModels: number; dormantModels: number; effectiveModels: number; };
  topModels: Array<{ modelId: string; name: string; hits: number; successRate: number; failureRate: number; recommendation: string; commonScenarios: string[]; }>;
  dormantModels: Array<{ modelId: string; name: string; description: string; }>;
  scenarioMatrix: Array<{ modelId: string; model: string; scenario: string; hits: number; }>;
  coverageTrend: Array<{ day: string; assistantTurns: number; thinkingTurns: number; coverageRate: number; }>;
}
```

### Constraints

- **No backend changes needed** — all data already available
- **Reuse existing chart components** from `charts.tsx`
- **Desktop-only** admin tool
- **i18n** — use `t()` for all text

## Approach

### 1. Coverage Trend Chart (VIZ-01)

Add a `LineChart` at the top of the page showing daily `coverageRate` trend.

**Location:** Between the page header and the two-column grid.

**Data transformation:**
```typescript
const coverageChartData = coverageTrend.map(d => ({
  label: d.day.slice(5), // "04-09" from "2026-04-09"
  value: Math.round(d.coverageRate * 100), // convert 0-1 ratio to 0-100
}));
```

**Component:**
```tsx
<LineChart
  data={coverageChartData}
  width={Math.min(600, containerWidth)} // responsive within panel
  height={160}
  color="var(--accent)"
  showGrid
  showDots
  showArea
/>
```

**Empty state:**
- If `coverageTrend.length === 0`: show `EmptyState` with `thinkingModels.emptyCoverageTrend`
- If `coverageTrend.length === 1`: still show the single point (LineChart handles it)

### 2. Scenario Heatmap (VIZ-03)

Create a heatmap-style table showing model × scenario hit counts.

**Location:** New `CollapsiblePanel` below the two-column grid.

**Data structure:**
```typescript
// 1. Collect all unique scenarios (sorted alphabetically)
const allScenarios = [...new Set(scenarioMatrix.map(m => m.scenario))].sort();

// 2. Collect all models (from topModels, sorted by hits desc)
const models = [...topModels].sort((a, b) => b.hits - a.hits);

// 3. Build 2D lookup: modelId × scenario → hits
const hitMap = new Map<string, number>();
for (const entry of scenarioMatrix) {
  hitMap.set(`${entry.modelId}::${entry.scenario}`, entry.hits);
}

// 4. Find max hits for color scaling
const maxHits = Math.max(...scenarioMatrix.map(m => m.hits), 1);
```

**Color intensity thresholds** (based on percentage of maxHits):
| Level | Threshold | Background |
|-------|-----------|------------|
| Zero | `hits === 0` | `var(--bg-sunken)` |
| Low | `0 < hits <= maxHits * 0.33` | `rgba(91, 139, 160, 0.15)` (--info tint) |
| Medium | `maxHits * 0.33 < hits <= maxHits * 0.66` | `rgba(91, 139, 160, 0.35)` |
| High | `hits > maxHits * 0.66` | `rgba(91, 139, 160, 0.55)` |

**Layout:** CSS Grid table with horizontal scroll if needed:
```tsx
<div style={{ overflowX: 'auto' }}>
  <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
    <thead>
      <tr>
        <th style={{ position: 'sticky', left: 0, background: 'var(--bg-panel)', zIndex: 1, minWidth: 100 }}>
          Model
        </th>
        {allScenarios.map(sc => (
          <th key={sc} style={{ textAlign: 'center', fontSize: '0.65rem', padding: '4px 6px', writingMode: 'vertical-lr', transform: 'rotate(180deg)', height: 80 }}>
            {sc}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {models.map(model => (
        <tr key={model.modelId}>
          <td style={{ position: 'sticky', left: 0, background: 'var(--bg-panel)', fontWeight: 500, fontSize: '0.75rem' }}>
            {model.name}
          </td>
          {allScenarios.map(sc => {
            const hits = hitMap.get(`${model.modelId}::${sc}`) ?? 0;
            const intensity = hits === 0 ? 0 : hits / maxHits;
            const bgColor = hits === 0
              ? 'var(--bg-sunken)'
              : `rgba(91, 139, 160, ${Math.max(0.15, intensity * 0.55).toFixed(2)})`;
            return (
              <td key={sc} style={{ textAlign: 'center', backgroundColor: bgColor, padding: '4px 6px', fontSize: '0.7rem', fontWeight: hits > 0 ? 600 : 400 }}>
                {hits}
              </td>
            );
          })}
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

**Sparse matrix handling:** If a model has no hits for a scenario, `hitMap.get()` returns `undefined` → use `?? 0` to render as zero-hit cell (gray background).

**Empty state:** If `scenarioMatrix.length === 0`, show `EmptyState` with `thinkingModels.emptyScenarioMatrix`.

### 3. Empty State Optimization (VIZ-04)

Replace generic empty states with contextual messages using `EmptyState` component:

| Condition | Title (zh) | Description (zh) |
|-----------|-----------|-------------------|
| No models at all | 暂无思维模型数据 | AI 开始使用后，这里会显示思维模型的使用情况。 |
| No coverage trend | 今日暂无覆盖率记录 | 当 AI 开始执行任务后，覆盖率会自动记录。 |
| No scenario matrix | 暂无场景数据 | 模型触发场景后会在此显示。 |
| No dormant models | 所有模型都在使用中 | 没有休眠模型。 |

## New i18n Keys

Add to `ui/src/i18n/ui.ts`:

| Key | zh | en |
|-----|----|----|
| `thinkingModels.coverageTrend` | 覆盖率趋势 | Coverage Trend |
| `thinkingModels.scenarioHeatmap` | 场景热力图 | Scenario Heatmap |
| `thinkingModels.emptyCoverageTrend` | 今日暂无覆盖率记录 | No coverage data yet |
| `thinkingModels.emptyCoverageTrendDesc` | 当 AI 开始执行任务后，覆盖率会自动记录。 | Coverage is tracked automatically once AI starts working. |
| `thinkingModels.emptyScenarioMatrix` | 暂无场景数据 | No scenario data yet |
| `thinkingModels.emptyScenarioMatrixDesc` | 模型触发场景后会在此显示。 | Scenarios will appear here when models are triggered. |
| `thinkingModels.emptyAllActive` | 所有模型都在使用中 | All models are active |
| `thinkingModels.emptyAllActiveDesc` | 没有休眠模型。 | No dormant models. |
| `thinkingModels.noModelsYet` | 暂无思维模型数据 | No thinking model data yet |
| `thinkingModels.noModelsYetDesc` | AI 开始使用后，这里会显示思维模型的使用情况。 | Thinking model usage will appear here once AI starts working. |

## Files to Modify

| File | Changes |
|------|---------|
| `ui/src/pages/ThinkingModelsPage.tsx` | Add coverage trend chart, scenario heatmap, improve empty states |
| `ui/src/i18n/ui.ts` | Add 10 new i18n keys |

## Implementation Steps

1. **Add i18n keys** to `ui/src/i18n/ui.ts` (10 keys)
2. **Add coverage trend chart** — `LineChart` between header and two-column grid
3. **Add scenario heatmap** — new `CollapsiblePanel` with heatmap table below grid
4. **Improve empty states** — replace generic `EmptyState` with contextual messages
5. **Verify TypeScript** — `npx tsc --noEmit`
6. **Build and test** — `cd packages/openclaw-plugin && npm run build:ui`

## UAT Criteria

- [ ] **VIZ-01**: Coverage trend chart displays daily data as percentage (0-100%)
- [ ] **VIZ-03**: Scenario heatmap shows model × scenario cross-tab with color-coded intensity
- [ ] **VIZ-03**: Heatmap shows zero-hit cells (gray background) for model-scenario combinations with no data
- [ ] **VIZ-04**: Empty states show contextual messages (not generic placeholders)
- [ ] Page loads without errors when all data is present
- [ ] Page shows appropriate empty states when data is missing
- [ ] No TypeScript compilation errors
- [ ] Chart components fit within panel width without horizontal overflow

## Rollback Plan

- Git revert — no database or API changes
- Charts are additive (no existing functionality removed)

## Dependencies

- None (all data already returned by existing API)
