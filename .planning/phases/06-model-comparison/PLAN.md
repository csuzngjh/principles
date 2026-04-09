# PLAN: Phase 6 — 模型对比模式

**Milestone:** v1.10
**Phase:** 6
**Goal:** 支持选择 2+ 模型进行并排比较
**Requirements:** CMP-01, CMP-02, CMP-03

## Context

**Data available:** All model summaries in `topModels` + per-model `usageTrend`.

**Current:** Single selection only — click a model to see its detail.

## Approach

### 1. Multi-selection mode

Add checkbox to each model list item. When ≥2 selected, show "Compare" button.

### 2. Comparison view

Grid layout with side-by-side panels:
```
[Model A]  [Model B]  [Model C]
hits       hits       hits
success%   success%   success%
failure%   failure%   failure%
pain%      pain%      pain%
```

### 3. Overlayed trends

Render `Sparkline` or `MiniBarChart` for each model's `usageTrend` with overlaid trend lines.

## Files to Modify

| File | Changes |
|------|---------|
| `ui/src/pages/ThinkingModelsPage.tsx` | Multi-select, comparison view, overlayed trends |

## UAT Criteria

- [ ] Can select 2+ models for comparison
- [ ] Comparison shows metrics side by side
- [ ] Usage trends overlaid
