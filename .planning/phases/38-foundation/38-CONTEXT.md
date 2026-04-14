# Phase 38: Foundation - Context

**Gathered:** 2026-04-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Keyword store persists to disk with atomic writes, seed keywords load on startup, cache stays consistent, and CorrectionCueLearner replaces detectCorrectionCue in prompt.ts.

</domain>

<decisions>
## Implementation Decisions

### Keyword Data Structure
- **D-01:** Keywords stored as objects with metadata: `{ term: string, weight: number, source: 'seed'|'llm'|'user', addedAt: ISO timestamp }`
- **D-02:** Store schema: `{ keywords: CorrectionKeyword[], version: number }`
- Ready for future LLM optimizer to modify weights/FPR without schema migration

### Atomic Write Boundary
- **D-03:** Only `correction_keywords.json` is written atomically (temp-file-then-rename)
- **D-04:** In-memory cache is the source of truth between writes
- **D-05:** Cache invalidation confirmed after every disk write (flush() updates in-memory state)

### 200-Term Limit Enforcement
- **D-06:** Fail-fast: `add()` throws error if store reaches 200 terms
- **D-07:** Store constructor or `add()` method enforces the limit — no silent failures

### Seed Keywords
- **D-08:** All 16 keywords from detectCorrectionCue are seeded (not pared to 15):
  - Chinese: 不是这个, 不对, 错了, 搞错了, 理解错了, 你理解错了, 重新来, 再试一次
  - English: you are wrong, wrong file, not this, redo, try again, again, please redo, please try again
- **D-09:** Source field marked as `'seed'` for all initial keywords

### Integration
- **D-10:** `CorrectionCueLearner.match()` replaces `detectCorrectionCue()` in prompt.ts
- **D-11:** Match behavior must be equivalent to original (includes normalized matching, same punctuation stripping)

### Cache Consistency
- **D-12:** In-memory cache fully populated on `load()` from disk
- **D-13:** Every `flush()` (disk write) updates the in-memory cache to match disk state

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Keyword Learning
- `packages/openclaw-plugin/src/core/dictionary.ts` — PainDictionary reference pattern for singleton + disk persistence
- `packages/openclaw-plugin/src/core/dictionary-service.ts` — DictionaryService singleton pattern
- `packages/openclaw-plugin/src/hooks/prompt.ts` §87-111 — Current detectCorrectionCue implementation (16 seed keywords)

### Requirements
- `.planning/REQUIREMENTS.md` — CORR-01, CORR-03, CORR-04, CORR-05, CORR-11 definitions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `PainDictionary` class: Use as reference for disk persistence pattern (load/flush lifecycle)
- `DictionaryService`: Use as reference for singleton pattern with stateDir parameter

### Established Patterns
- Singleton service pattern: `Service.get(stateDir)` returns cached instance
- Disk persistence: `load()` on startup, `flush()` on write
- File path: `path.join(stateDir, 'correction_keywords.json')`

### Integration Points
- `prompt.ts:334`: Replace `detectCorrectionCue(userText)` with `CorrectionCueLearner.get(stateDir).match(userText)`
- `evolution-worker.ts`: Uses same stateDir pattern, can provide stateDir to KeywordLearningEngine

</code_context>

<specifics>
## Specific Ideas

- Atomic write: temp file at `correction_keywords.json.tmp` then `fs.rename()` to target
- Match equivalence: same normalization (toLowerCase, strip punctuation) as original detectCorrectionCue

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within Phase 38 scope

</deferred>

---

*Phase: 38-foundation*
*Context gathered: 2026-04-14*
