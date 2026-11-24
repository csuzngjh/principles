---
"@principles/core": patch
---

Pipeline Spine Phase 0 (PRI-1290): export the existing WAL-safe staged snapshot (`stageWalSnapshot`) as a controlled read-only interface (`stagedDbPath` / `fingerprint` / `capturedAt` / `dispose()`), keep the `ok` discriminant and fail-closed reasons, migrate `pd pain recall` cleanup to `dispose()`, and add the read-only `scripts/dev/pipeline-funnel-snapshot.mjs` funnel baseline with its admission record. No behavior change for existing consumers.
