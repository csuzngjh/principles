# Phase 20 Validation

## Validation Focus

This phase is complete only if malformed data is rejected at the boundary instead of being transformed into misleading defaults.

## Required Checks

### Contract Checks

- `SCHEMA-01`: `.pain_flag` readers use a shared parser contract
- `SCHEMA-02`: snapshot ingress is schema-checked before worker/workflow use
- `SCHEMA-03`: missing required fields surface as explicit failures or skips

### Regression Checks

- valid production-format pain data still parses
- malformed pain data does not produce usable fake context
- malformed snapshot ingress does not launch a real nocturnal workflow

### Commands

- `cd packages/openclaw-plugin && npx tsc --noEmit`
- `cd packages/openclaw-plugin && npx vitest run tests/core/pain*.test.ts tests/service/evolution-worker*.test.ts tests/service/nocturnal-*.test.ts`

## Reviewer Notes

Do not accept "best effort" parsing here. The whole point of the phase is to stop trusting malformed boundary data.
