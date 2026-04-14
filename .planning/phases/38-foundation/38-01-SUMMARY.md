---
phase: "38"
plan: "01"
type: execute
subsystem: correction-cue-learner
tags:
  - keyword-learning
  - correction-cue
  - persistence
  - v1.14
dependency_graph:
  requires: []
  provides:
    - CorrectionCueLearner class (correction-cue-learner.ts)
    - CorrectionKeyword types (correction-types.ts)
    - 29 unit tests (correction-cue-learner.test.ts)
  affects:
    - packages/openclaw-plugin/src/hooks/prompt.ts (integration target, plan 38-02)
tech_stack:
  added:
    - TypeScript interfaces: CorrectionKeyword, CorrectionKeywordStore, CorrectionMatchResult
    - CorrectionCueLearner class with load/save/match/add/flush API
    - Atomic persistence via temp-file-then-rename (fs.renameSync)
    - Module-level cache with invalidation on write
    - 16 CORRECTION_SEED_KEYWORDS (8 Chinese + 8 English)
    - MAX_CORRECTION_KEYWORDS = 200 constant
    - 29 vitest unit tests covering CORR-01/03/04/05/11
  patterns:
    - Singleton factory (CorrectionCueLearner.get)
    - First-match keyword detection
    - Cache-through-load pattern
key_files:
  created:
    - packages/openclaw-plugin/src/core/correction-types.ts
    - packages/openclaw-plugin/src/core/correction-cue-learner.ts
    - packages/openclaw-plugin/tests/core/correction-cue-learner.test.ts
  modified: []
decisions:
  - id: D-01
    decision: "Seed store created and persisted on first load when file absent or corrupt"
    rationale: "Ensures 16 seed keywords are always available immediately"
  - id: D-03
    decision: "Atomic write using temp-file-then-rename"
    rationale: "T-38-02: Guarantees disk state is always valid JSON or previous valid state"
  - id: D-04
    decision: "Module-level _correctionCueCache, null when not loaded"
    rationale: "D-04: Avoids per-call I/O; single read per stateDir per process lifetime (until write)"
  - id: D-05
    decision: "Cache set to null after every saveCorrectionKeywordStore call"
    rationale: "D-05: Ensures next load() re-reads from disk to pick up latest state"
  - id: D-06
    decision: "200-term hard cap enforced before any write"
    rationale: "T-38-01 / CORR-05: Prevents unbounded growth; add() throws at limit"
  - id: D-07
    decision: "add() stamps addedAt to current ISO timestamp"
    rationale: "Provides audit trail for when each keyword was learned"
  - id: D-08
    decision: "CORRECTION_SEED_KEYWORDS mirrors detectCorrectionCue() exactly"
    rationale: "Drop-in replacement must detect identical terms with identical normalization"
  - id: D-09
    decision: "Seed keywords have source='seed'"
    rationale: "Distinguishes initial keywords from llm-discovered or user-reported additions"
  - id: D-11
    decision: "match() uses first-match semantics (Array.find)"
    rationale: "Equivalent to original detectCorrectionCue which returns first match only"
metrics:
  duration_minutes: ~15
  completed_date: "2026-04-14"
  tasks_completed: 3
  files_created: 3
  test_count: 29
  test_passed: 29
  ts_errors: 0
---

# Phase 38 Plan 01: CorrectionCueLearner Foundation - Summary

**CorrectionCueLearner keyword store with atomic persistence, in-memory cache, 200-term limit, and 16 seed keywords.**

## What Was Built

### correction-types.ts
- `CorrectionKeyword` interface: `{ term, weight, source, addedAt }`
- `CorrectionKeywordStore` interface: `{ keywords[], version }`
- `CorrectionMatchResult` interface: `{ matched, matchedTerms[], score }`
- `CORRECTION_SEED_KEYWORDS`: 16 terms (8 Chinese + 8 English) mirroring detectCorrectionCue
- `MAX_CORRECTION_KEYWORDS = 200`

### correction-cue-learner.ts
- `loadCorrectionKeywordStore(stateDir)`: reads from `correction_keywords.json`, seeds default on first load
- `saveCorrectionKeywordStore(stateDir, store)`: **atomic write** via temp-file-then-rename, cache invalidated after
- `CorrectionCueLearner` class: `match(text)`, `add(keyword)`, `getStore()`, `flush()`
- `CorrectionCueLearner.get(stateDir)`: singleton factory
- `match()` normalization: `trim → lowercase → strip /[.,!?;:，。！？；：]/` — equivalent to detectCorrectionCue
- `add()`: throws `Error('Correction keyword store limit reached (200 terms)')` when at capacity, before any write

### correction-cue-learner.test.ts
- **29 tests** covering all 5 requirements:
  - CORR-01: seed keywords (3 tests)
  - CORR-03: atomic write (3 tests)
  - CORR-04: cache invalidation (1 test)
  - CORR-05: 200-term limit (3 tests)
  - CORR-11: equivalence to detectCorrectionCue (19 tests)

## Commits

| Hash | Message |
|------|---------|
| `77771ca9` | feat(38-01): add CorrectionKeyword types and 16 seed keywords |
| `d63da307` | feat(38-01): implement CorrectionCueLearner with atomic persistence and cache |
| `945a2214` | feat(38-01): add correction-cue-learner unit tests |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `_resetCorrectionCueCache()` and `_resetCorrectionCueLearnerInstance()` exports**
- **Found during:** Task 3 (test implementation)
- **Issue:** Module-level `_correctionCueCache` and singleton `_instance` persist across test cases, causing test pollution (CORR-05 tests saw wrong store lengths because prior test's loaded cache was reused)
- **Fix:** Added test-only reset functions exported from correction-cue-learner.ts, called in `beforeEach`
- **Files modified:** `packages/openclaw-plugin/src/core/correction-cue-learner.ts`
- **Commit:** `945a2214`

**2. [Rule 1 - Bug] Fixed CORR-11 test expected terms to match first-match semantics**
- **Found during:** Task 3 (test implementation)
- **Issue:** Tests used wrong expected terms for multi-keyword matches (e.g., "我搞错了" → expected "搞错了" but find() returns "错了" first since it appears earlier in the seed array)
- **Fix:** Updated all CORR-11 test cases to use correct first-match expected values with explanatory comments
- **Files modified:** `packages/openclaw-plugin/tests/core/correction-cue-learner.test.ts`
- **Commit:** `945a2214`

**3. [Rule 3 - Blocking] Fixed ESM mocking approach**
- **Found during:** Task 3 (test implementation)
- **Issue:** `vi.spyOn(fs, 'existsSync')` fails in ESM with "Module namespace is not configurable"
- **Fix:** Switched to `vi.mock('fs', () => ...)` hoisted mock pattern with `vi.mocked()` for assertions, matching empathy-keyword-matcher.test.ts
- **Files modified:** `packages/openclaw-plugin/tests/core/correction-cue-learner.test.ts`
- **Commit:** `945a2214`

## Threat Surface

No new threats introduced beyond those already registered in the plan's threat model:

| Flag | File | Description |
|------|------|-------------|
| threat_flag: None | - | No new network endpoints, auth paths, or trust boundary changes |

## Known Stubs

None.

## Verification

- TypeScript: `tsc --noEmit` passes with 0 errors
- Unit tests: 29/29 pass
- All success criteria met
