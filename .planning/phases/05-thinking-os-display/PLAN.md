# PLAN: Phase 5 — THINKING_OS.md 内容展示

**Milestone:** v1.10
**Phase:** 5
**Goal:** 在详情页展示 trigger、antiPattern、workspace 路径
**Requirements:** TOS-01, TOS-02, TOS-03

## Context

**Data needed:** Currently `modelDefinitions` in `thinkingSummary` only has `{ modelId, name, description }`. Need to add `trigger` and `antiPattern`.

**Backend change needed:** `getThinkingModelDefinitions()` in `thinking-models.ts` returns these fields but they're stripped from the API response type.

## Approach

### 1. Extend modelDefinitions API response

In `control-ui-query-service.ts`, include `trigger` and `antiPattern` in the `modelDefinitions` field.

### 2. Detail page display

Add sections in the detail panel:
- **Trigger Conditions**: Show the trigger text
- **Anti-Patterns**: Show forbidden behaviors

### 3. Workspace path display

Show `THINKING_OS.md` source path in the page header.

## Files to Modify

| File | Changes |
|------|---------|
| `ui/src/types.ts` | Add `trigger?` and `antiPattern?` to model definition type |
| `ui/src/pages/ThinkingModelsPage.tsx` | Display trigger, antiPattern, workspace path |

## UAT Criteria

- [ ] Trigger conditions visible in detail view
- [ ] Anti-patterns (forbidden) visible in detail view
- [ ] THINKING_OS.md source path shown in header
