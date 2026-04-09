# PLAN: Phase 7 — 搜索与过滤

**Milestone:** v1.10
**Phase:** 7
**Goal:** 模型列表支持搜索和排序
**Requirements:** SRCH-01, SRCH-02

## Approach

### 1. Text search (SRCH-01)

Add input field above model list:
```typescript
const [search, setSearch] = useState('');
const filtered = models.filter(m =>
  m.name.toLowerCase().includes(search.toLowerCase()) ||
  m.commonScenarios.some(s => s.toLowerCase().includes(search.toLowerCase()))
);
```

### 2. Sort toggle (SRCH-02)

Add sort button:
```typescript
const [sortBy, setSortBy] = useState<'hits' | 'successRate' | 'name'>('hits');
const sorted = [...filtered].sort((a, b) => {
  if (sortBy === 'hits') return b.hits - a.hits;
  if (sortBy === 'successRate') return b.successRate - a.successRate;
  return a.name.localeCompare(b.name);
});
```

## Files to Modify

| File | Changes |
|------|---------|
| `ui/src/pages/ThinkingModelsPage.tsx` | Search input, sort toggle |

## UAT Criteria

- [ ] Search filters by name or scenario
- [ ] Sort cycles through hits/successRate/name
- [ ] Search + sort work together
