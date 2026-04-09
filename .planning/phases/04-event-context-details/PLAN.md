# PLAN: Phase 4 — 事件上下文详情

**Milestone:** v1.10
**Phase:** 4
**Goal:** 在最近事件中展示 toolContext、painContext、principleContext、matchedPattern
**Requirements:** EVT-01, EVT-02, EVT-03, EVT-04

## Context

**Data available in `recentEvents`:**
- `toolContext`: `{ toolName: string; outcome: string; errorType?: string }[]`
- `painContext`: `{ source: string; score: number }[]`
- `principleContext`: `{ principleId: string; eventType: string }[]`
- `matchedPattern`: string — the regex that triggered

**Current:** Only shows `triggerExcerpt` and `scenarios`.

## Approach

Enhance each event card to show context arrays:

```tsx
{event.toolContext?.length > 0 && (
  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
    🛠 {event.toolContext.map(tc => (
      <span key={tc.toolName}>
        {tc.toolName} ({tc.outcome}{tc.errorType ? `: ${tc.errorType}` : ''})
      </span>
    ).join(', ')}
  </div>
)}
{event.painContext?.length > 0 && (
  <div style={{ fontSize: '0.7rem', color: 'var(--error)' }}>
    ⚡ {event.painContext.map(pc => `${pc.source} (${pc.score})`).join(', ')}
  </div>
)}
{event.principleContext?.length > 0 && (
  <div style={{ fontSize: '0.7rem', color: 'var(--info)' }}>
    📋 {event.principleContext.map(pr => `${pr.principleId} ${pr.eventType}`).join(', ')}
  </div>
)}
{event.matchedPattern && (
  <code style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
    /{event.matchedPattern}/
  </code>
)}
```

## Files to Modify

| File | Changes |
|------|---------|
| `ui/src/pages/ThinkingModelsPage.tsx` | Enhance event cards with context arrays |
| `ui/src/types.ts` | Verify recent event types include context fields |

## UAT Criteria

- [ ] toolContext displayed with tool name, outcome, error type
- [ ] painContext displayed when present
- [ ] principleContext displayed when present
- [ ] matchedPattern shown as code
