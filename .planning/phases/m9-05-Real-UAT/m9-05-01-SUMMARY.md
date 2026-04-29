# m9-05 Real UAT — Complete

## Result: PASS

All 8 UAT requirements satisfied with real xiaomi-coding/mimo-v2.5-pro runtime.

## What Was Done

1. **Fixed `abstractedPrinciple` length validation** (40 → 200 chars)
   - `default-validator.ts`: Added `MAX_ABSTRACTED_PRINCIPLE_CHARS = 200` constant, replaced hardcoded 40
   - `diagnostician-output.ts`: Updated JSDoc + @see reference
   - `diagnostician-prompt-builder.ts`: Updated prompt instruction and JSON example (40 → 200)
   - `default-validator.test.ts`: Added boundary tests (200 pass, 201 fail, 41 pass)

2. **Fixed `CandidateIntakeService` recommendation source priority**
   - Now reads `candidate.sourceRecommendationJson` FIRST (canonical, from `source_recommendation_json` column)
   - Falls back to `artifact.contentJson` only if `sourceRecommendationJson` is empty/invalid
   - Prevents incorrect parsing when artifact stores raw DiagnosticianOutputV1 root object

3. **Real UAT execution** — all 8 steps PASS:
   - UAT-01: XIAOMI_KEY valid
   - UAT-02: `pd runtime probe` healthy
   - UAT-03: `pd pain record` → status=succeeded, candidateIds=[...], ledgerEntryIds=[...]
   - UAT-04: artifactId exists, candidateIds.length > 0
   - UAT-05: Ledger entry with triggerPattern, action, derivedFromPainIds = [candidateId]
   - UAT-06: Idempotency verified — no duplicate ledger entries
   - UAT-07: No legacy diagnostician_tasks.json created
   - UAT-08: Results documented in m9-05-CONTEXT.md

## Test Results
- `npx vitest run default-validator.test.ts m9-adapter-integration.test.ts m9-e2e.test.ts pi-ai-runtime-adapter.test.ts` — 103/103 PASS
- Real UAT-03: status=succeeded, candidateIds.length=1, ledgerEntryIds.length=1
- Real UAT-06: second run creates new candidate+ledger, no duplicates

## Files Changed
- `packages/principles-core/src/runtime-v2/runner/default-validator.ts` — MAX_ABSTRACTED_PRINCIPLE_CHARS
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — JSDoc update
- `packages/principles-core/src/runtime-v2/diagnostician-prompt-builder.ts` — 40 → 200 in protocol + example
- `packages/principles-core/src/runtime-v2/candidate-intake-service.ts` — sourceRecommendationJson priority
- `packages/principles-core/src/runtime-v2/runner/__tests__/default-validator.test.ts` — boundary tests
- `packages/principles-core/src/runtime-v2/runner/__tests__/m9-adapter-integration.test.ts` — TS non-null fix
- `packages/principles-core/src/runtime-v2/runner/__tests__/m9-e2e.test.ts` — TS non-null fix
- `.planning/phases/m9-05-Real-UAT/m9-05-CONTEXT.md` — UAT results documentation