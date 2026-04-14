---
phase: 19
slug: unified-workspace-resolution-contract
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-11
updated: 2026-04-11
---

# Phase 19 - Validation Strategy

## Validation Goal

Prove that production code no longer guesses workspace directories and that missing context fails fast or skips safely instead of writing under HOME.

## Test Infrastructure

| Property | Value |
|----------|-------|
| Framework | vitest |
| Type check | `npx tsc --noEmit` |
| Repo search guard | `rg` |

## Sampling Rate

- After Plan 01: run targeted resolver + command tests
- After Plan 02: run targeted hook + route + regression tests
- Before verification: run both plan verification sets and grep-based fallback guard

## Per-Plan Verification

### Plan 01
- `cd packages/openclaw-plugin && npx tsc --noEmit`
- `cd packages/openclaw-plugin && npx vitest run tests/**/workspace* tests/**/pd-reflect*`
- `rg -n "api\\.resolvePath\\('\\.'\\)|api\\.resolvePath\\(\"\\.\"\\)" packages/openclaw-plugin/src/index.ts packages/openclaw-plugin/src/commands/pd-reflect.ts packages/openclaw-plugin/src/core`

### Plan 02
- `cd packages/openclaw-plugin && npx tsc --noEmit`
- `cd packages/openclaw-plugin && npx vitest run tests/hooks/pain.test.ts tests/http/principles-console-route.test.ts tests/service/evolution-worker.nocturnal.test.ts`
- `rg -n "api\\.resolvePath\\('\\.'\\)|api\\.resolvePath\\(\"\\.\"\\)" packages/openclaw-plugin/src`

## Manual Checks

- Confirm `/pd-reflect` targets the active workspace rather than a hardcoded `'main'`
- Confirm route/service queries cannot silently bind to HOME when no workspace is present

## Sign-off Conditions

- All BC requirements mapped by tests or grep-based source guards
- No remaining banned fallback in production source
- Failure semantics are explicit at entry points
