# Phase 21 Validation

## Validation Focus

This phase is complete only if the remaining production path assumptions are turned into explicit contracts with end-to-end proof.

## Required Checks

### Runtime Contract Checks

- `RT-01`: runtime capability detection does not rely on `constructor.name === 'AsyncFunction'`
- `RT-02`: runtime-unavailable and downstream-workflow-failed produce different observable states
- `RT-03`: manual trigger paths use the same runtime/workspace contract semantics as the worker path

### End-to-End Checks

- `E2E-01`: a valid pain signal preserves `session_id` from write to queue to nocturnal input
- `E2E-02`: hook/command writes stay under the active workspace `.state`
- `E2E-03`: bounded session selection prevents future-session drift

### Commands

- `cd packages/openclaw-plugin && npx tsc --noEmit`
- `cd packages/openclaw-plugin && npx vitest run tests/service/*.test.ts tests/hooks/*.test.ts tests/commands/*.test.ts`
- `rg -n "constructor\\.name === 'AsyncFunction'|constructor\\.name===\\\"AsyncFunction\\\"" packages/openclaw-plugin/src`

## Execution Evidence

- `2026-04-11`: `cd packages/openclaw-plugin && npx tsc --noEmit`
- `2026-04-11`: `cd packages/openclaw-plugin && npx vitest run tests/utils/subagent-probe.test.ts tests/service/evolution-worker.nocturnal.test.ts tests/service/nocturnal-target-selector.test.ts tests/service/nocturnal-runtime-hardening.test.ts tests/hooks/pain.test.ts tests/core/workspace-dir-validation.test.ts tests/core/workspace-dir-service.test.ts tests/commands/pd-reflect.test.ts tests/integration/tool-hooks-workspace-dir.e2e.test.ts`
- `2026-04-11`: `rg -n "constructor\\.name === 'AsyncFunction'|run\\.constructor\\.name|isAsyncFunction" packages/openclaw-plugin/src` returned no source matches
- Result: 9 test files, 61 tests passed

## Outcome Summary

- `RT-01` closed by removing `AsyncFunction`-based runtime detection and switching to explicit callable-shape checks
- `RT-02` closed by separating `runtime_unavailable` from generic downstream workflow failures in sleep-reflection task resolution
- `RT-03` validated by running shared workspace/manual-trigger tests (`pd-reflect`, workspace-dir service, workspace-dir integration)
- `E2E-01` validated by preserved `session_id` flow from `.pain_flag` into sleep-reflection context and nocturnal snapshot selection
- `E2E-02` validated by workspace-dir unit/integration coverage and manual trigger tests
- `E2E-03` closed by bounding fallback nocturnal session selection to the triggering task timestamp

## Reviewer Notes

Do not accept "we log it now" as completion. The phase is only done if the wrong behavior is impossible or caught by deterministic tests.
