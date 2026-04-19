---
name: Phase 6 — Display Wiring Summary
phase: 6
milestone: v1.21.2
wave: 1
status: completed
completed: 2026-04-19
---

## What Was Done

### Task 1: Render workflowFunnels in buildEnglishOutput/buildChineseOutput

**Files modified:** `packages/openclaw-plugin/src/commands/evolution-status.ts`

Added `workflowFunnels` rendering block after the array literal closes in both functions:

- English: `Workflow Funnel: <funnelKey>` with stage lines `  - <stage.label>: <count>`
- Chinese: `Workflow 漏斗: <funnelKey>` with stage lines `  - <stage.label>: <count>`

Stage order matches YAML definition order (not hardcoded). Empty `workflowFunnels` array or undefined is handled gracefully (block skipped).

### Task 2: Degraded status for missing/invalid YAML

**Files modified:** `packages/openclaw-plugin/src/service/runtime-summary-service.ts`

- Added `metadata.status: 'ok' | 'degraded'` to `RuntimeSummary` interface
- Added `loaderWarnings` → warning propagation (each warning → `YAML load warning: <msg>`)
- Added `hasZeroCountStage` tracking when any stage resolves to count=0
- Status is `'degraded'` when `loaderWarnings.length > 0` OR `hasZeroCountStage === true`
- Fixed pre-existing bug: `statsDate` was used before initialization in `workflowFunnelsOutput` block — moved statsDate computation before the funnel building block

### Task 3: Unit tests for funnel display

**Files modified:** `packages/openclaw-plugin/tests/commands/evolution-status.test.ts`

Added 4 new test cases:
1. `workflowFunnels` present with valid YAML → funnel blocks rendered with correct counts
2. `workflowFunnels` empty array → funnel block skipped (no crash)
3. Malformed YAML → degraded status + YAML warning visible
4. Chinese language → Chinese `Workflow 漏斗` label rendered with Chinese stage names

## Verification

```bash
npx vitest run tests/commands/evolution-status.test.ts  # 10 passed
npx tsc --noEmit  # 0 errors in modified files
```

## Files Changed

- `packages/openclaw-plugin/src/commands/evolution-status.ts` — funnel rendering in both language functions
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` — metadata.status, loaderWarnings handling, statsDate initialization order fix
- `packages/openclaw-plugin/tests/commands/evolution-status.test.ts` — 4 new test cases
