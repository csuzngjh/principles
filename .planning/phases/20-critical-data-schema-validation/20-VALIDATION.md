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

## Execution Evidence

- `2026-04-11`: `cd packages/openclaw-plugin && npx tsc --noEmit`
- `2026-04-11`: `cd packages/openclaw-plugin && npx vitest run tests/core/pain.test.ts tests/core/pain-integration.test.ts tests/core/pain-auto-repair.test.ts tests/core/nocturnal-snapshot-contract.test.ts tests/service/evolution-worker.nocturnal.test.ts tests/service/nocturnal-runtime-hardening.test.ts tests/service/nocturnal-service-code-candidate.test.ts`
- Result: 7 test files, 53 tests passed

## Outcome Summary

- `SCHEMA-01` closed with `readPainFlagContract()` and worker-side malformed `.pain_flag` rejection
- `SCHEMA-02` closed with `validateNocturnalSnapshotIngress()` shared by worker, workflow manager, and nocturnal service
- `SCHEMA-03` closed by replacing pseudo-snapshots and empty fallback objects with explicit failure reasons

## Reviewer Notes

Do not accept "best effort" parsing here. The whole point of the phase is to stop trusting malformed boundary data.
