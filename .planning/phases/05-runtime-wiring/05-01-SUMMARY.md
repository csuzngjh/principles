# Summary: Phase 5 — Runtime Wiring

## What was shipped

PR #376 — `feat(evolution-status): wire workflows.yaml funnel stages into status display`

### Changes

**`runtime-summary-service.ts`:**
- Added `WorkflowFunnelStageOutput` and `WorkflowFunnelOutput` interfaces
- Added `resolveStatsField()` helper — traverses dot-path segments (e.g. `evolution.nocturnalDreamerCompleted`) through dailyStats object
- Updated `getSummary()` signature to accept optional `options.funnels: Map<string, WorkflowStage[]>`
- When `funnels` provided: builds `workflowFunnels` array with funnelKey/funnelLabel/stages structure
- Zero-count stages generate `statsField not resolvable: ${stage.statsField}` warnings
- Conditionally spreads `workflowFunnels` into return object only when funnels param is provided — backward compatible

**`evolution-status.ts`:**
- Now passes `funnels: loader.getAllFunnels()` to `RuntimeSummaryService.getSummary()`
- YAML funnel/stage definitions now genuinely drive summary output

### Verification

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | Clean (0 errors) |
| `vitest run tests/service/runtime-summary-service.test.ts` | 34 passed |
| `npm run test:unit` | 1 unrelated failure (`event-log.test.ts` deepReflection field — pre-existing) |

### Success Criteria — all met

1. `getSummary()` accepts optional `funnels: Map<string, WorkflowStage[]>` parameter — DONE
2. Returned summary includes `workflowFunnels: WorkflowFunnelOutput[]` when funnels provided — DONE
3. Each stage count resolved via statsField dot-path from dailyStats — DONE (`resolveStatsField()`)
4. Missing statsField → count=0 + visible warning — DONE
5. When funnels not provided, getSummary() returns without workflowFunnels field — DONE (conditional spread)

## Remaining work in v1.21.2

- **Phase 6 (Display Wiring):** `workflowFunnels` data now exists in summary output but `buildEnglishOutput`/`buildChineseOutput` don't yet render it. Need to add YAML-driven funnel display block.
- **Phase 7 (Integration Testing):** End-to-end tests for YAML-driven funnel flow

## Files modified

- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` (+67/-2 lines)
- `packages/openclaw-plugin/src/commands/evolution-status.ts` (+2/-1 lines)

## Git

- Branch: `feat/v1.21.2-workflow-funnel-runtime-wiring`
- Commit: `32fb5a3e` (pushed)
- PR: https://github.com/csuzngjh/principles/pull/376
