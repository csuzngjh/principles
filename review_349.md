## PR #349 Comprehensive Review Report

### 1. Critical Architectural & Data Integrity Issues

#### 1.1 Lack of Atomicity in Initialization (`packages/openclaw-plugin/src/core/init.ts`)
The `ensureCorePrinciples` function writes to the Training Store and Ledger Tree sequentially without a transactional rollback or reconciliation logic.
- **Risk:** If a write to the Ledger Tree fails (e.g., disk full, lock contention), the workspace remains in a "semi-initialized" state where the Training Store has the principles but the Ledger Tree is empty. Subsequent starts will skip initialization because `existingIds.length > 0`, persisting the exact failure state this PR aims to fix.
- **Recommendation:** Implement a per-principle reconciliation check. Instead of skipping if any principles exist, verify that each core principle exists in *both* stores and backfill only the missing side.

#### 1.2 Logic Regression: Stale Ledger Object (`packages/openclaw-plugin/src/core/bootstrap-rules.ts`)
The `ledger` object loaded at the start of `bootstrapRules` is a stale disk snapshot.
- **Risk:** The migration loop calls `addPrincipleToLedger`, which updates the disk but *not* the local `ledger` variable. When `selectPrinciplesForBootstrap` returns a migrated ID (e.g., 'T-01'), the subsequent lookup `ledger.tree.principles[principleId]` returns `undefined`, triggering a "Principle not found" error immediately after migration.
- **Recommendation:** Explicitly refresh the `ledger` variable by calling `loadLedger(stateDir)` immediately after the migration loop.

#### 1.3 False-Positive Telemetry in Hallucination Path (`packages/openclaw-plugin/src/core/nocturnal-trinity.ts`)
In both `runTrinity` and `runTrinityWithStubs`, `telemetry.scribePassed` is set to `true` before hallucination detection.
- **Risk:** If a hallucination is detected, the function returns `success: false`, but the telemetry object still marks Scribe as passed. This misleads monitoring systems and hides the true hallucination rate in production.
- **Recommendation:** In the hallucination failure branch, revert `telemetry.scribePassed` to `false` and clear winner-related fields (e.g., `selectedCandidateIndex`, `winnerAggregateScore`).

### 2. Design & Maintainability Issues

#### 2.1 Duplicated Serialization Logic (`packages/openclaw-plugin/src/core/file-storage-adapter.ts`)
`serializeStore` in the file adapter is a copy-paste of the unexported `serializeLedger` from `principle-tree-ledger.ts`.
- **Risk:** If the canonical disk format changes (e.g., new metadata fields or namespace changes), the adapter will continue writing the old format, leading to silent data corruption or incompatibility.
- **Recommendation:** Export the canonical serializer from `principle-tree-ledger.ts` and reuse it in the adapter to maintain a Single Source of Truth.

#### 2.2 Duplicated Constants (`packages/openclaw-plugin/src/core/bootstrap-rules.ts`)
`CORE_THINKING_MODELS` is duplicated to avoid circular dependencies.
- **Risk:** High maintenance overhead. Any updates to core principle descriptions or IDs must be manually synced across files, increasing the risk of drift.
- **Recommendation:** Extract `CORE_THINKING_MODELS` into a dedicated leaf module (e.g., `src/core/constants.ts`) imported by both `init.ts` and `bootstrap-rules.ts`.

### 3. Quality & Observability Gaps

#### 3.1 Inaccurate Observability Metric (`packages/openclaw-plugin/src/core/observability.ts`)
`internalizationRate` is calculated using a numerator from the Training Store and a denominator from the Ledger Tree.
- **Risk:** If orphaned training entries exist (from deleted principles), the rate can exceed 100% or drift inaccurately.
- **Recommendation:** Filter `trainingEntries` to only include those whose `principleId` exists in the current `tree.principles` before calculating the rate.

#### 3.2 Weak Validation (`packages/openclaw-plugin/src/core/pain-signal.ts` & `evolution-worker.ts`)
- `PainSignalSchema` allows empty strings for `sessionId`, `agentId`, and `traceId`.
- `evolution-worker.ts` queue filter does not validate `status` and `taskKind` against allowed enums, nor does it check if `score` is a finite number.
- **Recommendation:** Tighten the schema with `minLength: 1` and add explicit enum/number checks in the worker's queue validator.

#### 3.3 Conformance Test Hardcoding (`packages/openclaw-plugin/tests/core/storage-conformance.test.ts`)
The "universal" conformance suite hard-codes `principle_training_state.json`.
- **Risk:** Prevents the suite from being reused for other adapters (e.g., SQLite/Remote) that don't use that specific file layout.
- **Recommendation:** Update the factory to provide corruption/truncation hooks or move implementation-specific tests to `file-storage-adapter.test.ts`.

### 4. Documentation Issues
- **`00a-VERIFICATION.md`:** Table formatting error (MD056). Several rows have 3 columns instead of 4, breaking the Markdown table syntax.

---
**Verdict:** Request Changes. Please address the atomicity and stale state issues as they represent high risks for data integrity and system stability.
