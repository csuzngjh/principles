# Phase 11: Critical Safety Fixes - Context

**Gathered:** 2026-04-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix two critical safety issues in the codebase:
1. Dangerous naming collision: `normalizePath` exists in both `utils/io.ts` and `nocturnal-compliance.ts` with DIFFERENT signatures
2. Broken legacy path: PAIN_CANDIDATES system is completely disconnected from evolution-reducer — must be single unified pain→principle path

</domain>

<decisions>
## Implementation Decisions

### CLEAN-01: normalizePath Rename
- **D-01:** Rename `normalizePath` in `nocturnal-compliance.ts` to `normalizePathPosix` — accurately describes POSIX forward-slash normalization
- **D-02:** `utils/io.ts` `normalizePath` remains unchanged — it handles WSL/Windows cross-OS path conversion with project-relative output
- **D-03:** Update ALL internal callers within `nocturnal-compliance.ts` to use `normalizePathPosix` (not `normalizePath`)
- **D-04:** Verify no external callers import `normalizePath` from `nocturnal-compliance.ts` — if found, update them too

### CLEAN-02: PAIN_CANDIDATES Path — DELETE
- **D-05:** DELETE `trackPainCandidate()` function entirely — it writes to `PAIN_CANDIDATES` file as a fallback when L2 dictionary and L3 semantic search both miss
- **D-06:** DELETE `processPromotion()` function entirely — it reads from `PAIN_CANDIDATES` and tries to promote candidates to principles
- **D-07:** DELETE `PAIN_CANDIDATES` file handling: lock suffix, `shouldTrackPainCandidate()`, `createPainCandidateFingerprint()`, `summarizePainCandidateSample()`, `PainCandidateEntry` type, and related constants
- **D-08:** Evolution queue (`processEvolutionQueue`) is the SINGLE active pain→principle path — no replacement needed for PAIN_CANDIDATES functionality
- **D-09:** Remove `processDetectionQueue` call to `trackPainCandidate` at evolution-worker.ts line 1366 — the fallback path is removed
- **D-10:** Remove `processPromotion` calls at evolution-worker.ts lines 1687 and 1771 — this promotion path is deleted

### Safety Verification
- **D-11:** No `normalizePath` ambiguity after rename — `utils/io.ts` and `nocturnal-compliance.ts` now have distinct names
- **D-12:** No broken references after PAIN_CANDIDATES deletion — verify all `trackPainCandidate`/`processPromotion` calls are removed from codebase

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### normalizePath Collision
- `packages/openclaw-plugin/src/utils/io.ts` — original `normalizePath(filePath, projectDir)` with WSL/Windows conversion
- `packages/openclaw-plugin/src/core/nocturnal-compliance.ts` — `normalizePath(filePath)` at line 203 (to be renamed to `normalizePathPosix`)

### PAIN_CANDIDATES System (being deleted)
- `packages/openclaw-plugin/src/service/evolution-worker.ts`:
  - Lines 1366: `await trackPainCandidate(text, wctx)` — call site to delete
  - Lines 1374-1412: `trackPainCandidate()` function definition — to delete
  - Lines 1414-1440+: `processPromotion()` function definition — to delete
  - Lines 1687, 1771: `await processPromotion(wctx, logger, eventLog)` calls — to delete
  - Line 193: `PAIN_CANDIDATES_LOCK_SUFFIX` — to delete
  - `PainCandidateEntry` type usage — to delete
- `packages/openclaw-plugin/src/core/path-resolver.ts` line 316: `PAIN_CANDIDATES` path definition — may be needed for migration or can be removed if file is deleted
- `packages/openclaw-plugin/src/core/migration.ts` line 33: `PAIN_CANDIDATES` in legacy state migration — note for migration planning

</canonical_refs>

<codebase>
## Existing Code Insights

### normalizePath Collision Evidence
- `utils/io.ts` `normalizePath(filePath, projectDir)` — 2 params, returns project-relative path, handles WSL conversion
- `nocturnal-compliance.ts` `normalizePath(filePath)` — 1 param, returns POSIX-style path (just replaces `\` with `/`)
- These are COMPLETELY DIFFERENT functions doing DIFFERENT things — rename is required, not refactor

### PAIN_CANDIDATES Is Dead Code
- Called ONLY from within `evolution-worker.ts` itself
- `trackPainCandidate` is a fallback when L2 dictionary AND L3 semantic search BOTH miss
- `processPromotion` runs on a timer — but evolution queue handles the primary pain→principle pipeline
- Two systems are "parallel disconnected" per bloat report — not integrated

### Impact of DELETE
- Deleting PAIN_CANDIDATES path simplifies the pain detection funnel
- L2 (dictionary) + L3 (semantic FTS5) remain as the two-tier detection system
- No functional change expected — PAIN_CANDIDATES was a legacy fallback that never integrated with the main pipeline

</codebase>

<specifics>
## Specific Ideas

- The PAIN_CANDIDATES system was likely an early attempt at a fallback promotion path — but it never got wired into the main evolution-reducer
- The rename is surgical: just change the function name and update internal references in the same file

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>
