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

## Reviewer Notes

Do not accept "we log it now" as completion. The phase is only done if the wrong behavior is impossible or caught by deterministic tests.
