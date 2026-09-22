---
'@principles/core': patch
---

Test Diet 2.2-B3-B: move the split-pipeline cached LLM fixture out of the `__tests__` boundary. `test-double-runtime-adapter.ts` (production) imported it from `internalization/__tests__/__fixtures__/`, which made the runtime-v2 fixture a source of truth consumed across the test boundary; the file now lives next to its two owners as `runtime-v2/adapter/split-pipeline-fixtures.ts`. Data, export names and adapter dispatch behavior are unchanged — the only content edits are three relative type-import depths and the import paths of its five consumers. No behavior change.
