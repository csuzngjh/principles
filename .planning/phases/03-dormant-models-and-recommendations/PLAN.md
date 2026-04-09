# PLAN: Phase 3 — 休眠模型与推荐标签

**Milestone:** v1.10
**Phase:** 3
**Goal:** 展示休眠模型列表、推荐标签色彩编码、按类型过滤
**Requirements:** DORM-01, DORM-02, REC-01, REC-02, REC-03

## Context

**Data available:**
- `data.dormantModels`: Array of `{ modelId, name, description }`
- `data.topModels[].recommendation`: "reinforce" | "rework" | "archive"
- `data.summary.effectiveModels`: count

**Current limitation:** Dormant models are never shown. Recommendation badges are plain text.

## Approach

### 1. Collapsible Dormant Models Section (DORM-01, DORM-02)

Add a `CollapsiblePanel` below the model list:
```tsx
<CollapsiblePanel
  title={t('thinkingModels.dormantModels')}
  badge={`${dormantModels.length}`}
  defaultCollapsed
>
  {dormantModels.map(model => (
    <div key={model.modelId} style={{ padding: '6px 8px', fontSize: '0.75rem' }}>
      <strong>{model.name}</strong>
      <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>
        {model.description}
      </span>
    </div>
  ))}
</CollapsiblePanel>
```

### 2. Color-Coded Recommendation Badges (REC-01)

Replace plain text with `StatusBadge`:
```typescript
const recBadgeMap: Record<string, { variant: BadgeVariant; label: string }> = {
  reinforce: { variant: 'success', label: t('thinkingModels.reinforce') },
  rework: { variant: 'warning', label: t('thinkingModels.rework') },
  archive: { variant: 'neutral', label: t('thinkingModels.archive') },
};
```

### 3. Filter by Recommendation (REC-02)

Add filter buttons above the model list:
```tsx
const [recFilter, setRecFilter] = useState<string>('all');
const filteredModels = recFilter === 'all'
  ? topModels
  : topModels.filter(m => m.recommendation === recFilter);
```

### 4. Effective Model Highlighting (REC-03)

Add a green left-border or icon to models with "reinforce" recommendation.

## i18n Keys

| Key | zh | en |
|-----|----|----|
| `thinkingModels.dormantModels` | 休眠模型 | Dormant Models |
| `thinkingModels.reinforce` | 保持 | Reinforce |
| `thinkingModels.rework` | 重构 | Rework |
| `thinkingModels.archive` | 归档 | Archive |
| `thinkingModels.filterByRec` | 按推荐过滤 | Filter by Recommendation |

## Files to Modify

| File | Changes |
|------|---------|
| `ui/src/pages/ThinkingModelsPage.tsx` | Dormant section, colored badges, filter, effective highlight |
| `ui/src/i18n/ui.ts` | Add 5 i18n keys |

## UAT Criteria

- [ ] Dormant models shown in collapsible panel
- [ ] Recommendation badges are color-coded
- [ ] Filter buttons work
- [ ] Effective models visually distinguished
