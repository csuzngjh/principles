# Phase 38: Foundation - Research

**Researched:** 2026-04-14
**Domain:** Correction keyword store with atomic persistence, in-memory cache, and prompt.ts integration
**Confidence:** HIGH

## Summary

Phase 38 Foundation implements the persistence and integration layer for the Keyword Learning Engine. It creates a `CorrectionCueLearner` class (mirroring `empathy-keyword-matcher.ts`) that manages 16 seed correction keywords, persists them to `correction_keywords.json` using atomic temp-file-then-rename writes, maintains an in-memory cache that is invalidated on every disk write, enforces a hard 200-term cap, and replaces the hardcoded `detectCorrectionCue()` function in `prompt.ts` with `CorrectionCueLearner.match()`.

The existing `empathy-keyword-matcher.ts` (335 lines) provides the complete reference pattern -- no new dependencies are needed. The only meaningful design decision is whether to subclass a shared base or build the correction system as a standalone module; the standalone approach is preferred here to avoid coupling with the empathy engine which has different semantics (severity mapping vs binary detection).

## User Constraints (from Phase Input)

> No CONTEXT.md existed at `.planning/phases/38-foundation/38-CONTEXT.md` at research time. All constraints below are derived from the phase description provided by the orchestrator.

### Locked Decisions
- Keywords stored as objects: `{ term, weight, source: 'seed'|'llm'|'user', addedAt: ISO timestamp }`
- Store schema: `{ keywords: CorrectionKeyword[], version: number }`
- Atomic write: only `correction_keywords.json`, temp-file-then-rename
- Cache is source of truth between writes, `flush()` updates in-memory state
- Fail-fast: `add()` throws if store reaches 200 terms
- All 16 keywords seeded with `source='seed'`
- `CorrectionCueLearner.match()` replaces `detectCorrectionCue()` in `prompt.ts`

### Out of Scope (Deferred Ideas)
- LLM-based keyword optimization (deferred to Phase 39)
- FPR feedback collection (deferred to Phase 39)
- Empathy engine refactoring (separate concern)

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CORR-01 | Seed correction keywords (16 terms: 8 Chinese + 8 English) | `prompt.ts:92-109` contains exactly 16 hardcoded keywords to migrate; `empathy-keyword-matcher.ts` `createDefaultKeywordStore()` pattern for seeding |
| CORR-03 | Atomic write to correction_keywords.json (temp-file-then-rename) | `PITFALLS.md Pitfall 4` documents crash-corruption risk of direct `writeFileSync`; Node.js `fs.rename` is atomic on POSIX; PainDictionary `flush()` uses unsafe write (anti-pattern to follow) |
| CORR-04 | In-memory cache with invalidation on disk write | `prompt.ts:24-25` `_empathyKeywordCache` module-level cache pattern; `PITFALLS.md Pitfall 7` documents stale-cache data loss scenario; cache must be invalidated after every `flush()` |
| CORR-05 | 200-term limit enforcement (fail-fast) | `PITFALLS.md Pitfall 5` documents unbounded growth risk; `add()` must throw `Error` when `store.keywords.length >= 200` before any write |
| CORR-11 | Replace `detectCorrectionCue()` with `CorrectionCueLearner.match()` in prompt.ts | `prompt.ts:87-111` current `detectCorrectionCue()` to replace; `prompt.ts:334` calls `detectCorrectionCue()` and uses result for trajectory recording |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | ^6.0.2 | Language | Already in plugin (package.json); no change needed |
| Node.js `fs` | built-in | Atomic JSON persistence | `empathy-keyword-matcher.ts` already uses this; `fs.rename` is atomic on POSIX |
| vitest | ^4.1.0 | Testing | Already in plugin; `empathy-keyword-matcher.test.ts` is the reference pattern |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@sinclair/typebox` | ^0.34.49 | JSON schema validation | Only if runtime type validation is needed beyond TypeScript static types |
| `better-sqlite3` | ^12.9.0 | Not needed | Only if store exceeds 10K terms with complex queries; JSON file sufficient for 200-term cap |

**Installation:** No new packages needed.

## Architecture Patterns

### Recommended Project Structure

```
packages/openclaw-plugin/src/core/
├── empathy-keyword-matcher.ts   ← EXISTING: Empathy learning pattern
├── empathy-types.ts             ← EXISTING: Type definitions
├── correction-cue-learner.ts   ← NEW: CorrectionCueLearner class
└── correction-types.ts         ← NEW: Correction-specific types

packages/openclaw-plugin/src/hooks/
└── prompt.ts                    ← MODIFY: Replace detectCorrectionCue() with CorrectionCueLearner.match()
```

### Pattern 1: Keyword Learning Store (from empathy-keyword-matcher.ts)

**What:** A class that owns an in-memory keyword store, loads/saves to a JSON file, and exposes `match()` for text analysis.

**When to use:** When keyword-based detection needs to persist learned weights between process restarts.

**Example (from empathy-keyword-matcher.ts:39-71, adapted):**
```typescript
// Source: packages/openclaw-plugin/src/core/empathy-keyword-matcher.ts:39-71
export function createDefaultKeywordStore(language: 'zh' | 'en' = 'zh'): EmpathyKeywordStore {
  const now = new Date().toISOString();
  const terms: Record<string, EmpathyKeywordEntry> = {};
  for (const seed of EMPATHY_SEED_KEYWORDS) {
    const isChinese = /[\u4e00-\u9fa5]/.test(seed.term);
    if (language === 'zh' || !isChinese) {
      terms[seed.term] = {
        weight: seed.weight,
        source: 'seed',
        hitCount: 0,
        falsePositiveRate: seed.initialFalsePositiveRate ?? 0.15,
      };
    }
  }
  return { version: 1, lastUpdated: now, lastOptimizedAt: now, terms, stats: { totalHits: 0, totalFalsePositives: 0, optimizationCount: 0 } };
}
```

**Correction-specific adaptation:**
- Use `correction_keywords.json` filename instead of `empathy_keywords.json`
- Use 16 correction seed keywords instead of empathy seed keywords
- Binary match result (matched/not) instead of severity mapping

### Pattern 2: Atomic Write (temp-file-then-rename)

**What:** Write JSON to a temp file first, then atomically rename it to the target path. Prevents corruption if the process crashes mid-write.

**Source:** `PITFALLS.md Pitfall 4` documents the risk and mitigation.

**Example:**
```typescript
// Source: PITFALLS.md (prescribed pattern)
const tmpPath = filePath + '.tmp';
fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8');
fs.renameSync(tmpPath, filePath);  // atomic on POSIX
```

**Why this over direct write:** If process crashes after `writeFileSync` begins but before it completes, the target file is truncated or partially written. `JSON.parse` then fails, and the catch block resets to seed -- all learned data is lost. The temp-file-then-rename pattern guarantees the target file is either the old complete state or the new complete state, never partial.

### Pattern 3: Module-Level Cache with Invalidation

**What:** Cache the loaded keyword store in a module-level variable to avoid per-turn I/O. Invalidate (reload) the cache whenever the store is written to disk.

**Source:** `prompt.ts:24-25` `_empathyKeywordCache` pattern; `PITFALLS.md Pitfall 7` documents the stale-read hazard.

**Example:**
```typescript
// Source: prompt.ts:24-25 (cache pattern)
let _correctionCueCache: { store: CorrectionKeywordStore; lang: string } | null = null;

// After saveKeywordStore() is called:
function saveCorrectionKeywordStore(stateDir: string, store: CorrectionKeywordStore): void {
  // ... write to disk with atomic rename ...
  // CRITICAL: invalidate cache so next call reloads fresh data
  _correctionCueCache = null;
}
```

### Pattern 4: Singleton Access Pattern

**What:** A module-level singleton that lazily initializes and caches the keyword store instance keyed by `stateDir`.

**Source:** `dictionary-service.ts` -- the `DictionaryService.get()` pattern.

**Example:**
```typescript
// Source: packages/openclaw-plugin/src/core/dictionary-service.ts
let dictionary: PainDictionary | null = null;
let lastStateDir: string | null = null;

export const DictionaryService = {
    get(stateDir: string): PainDictionary {
        if (!dictionary || lastStateDir !== stateDir) {
            dictionary = new PainDictionary(stateDir);
            dictionary.load();
            lastStateDir = stateDir;
        }
        return dictionary;
    },
    reset(): void {
        dictionary = null;
    }
};
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON file persistence | Raw `fs.writeFileSync` directly to target | Temp-file-then-rename via `fs.rename` | Crash mid-write corrupts JSON; rename is atomic on POSIX |
| Keyword matching loop | Custom O(n) scan for each request | Follow `matchEmpathyKeywords` pattern (same O(n) but already proven) | With 200-term cap, O(n) is acceptable; micro-optimization not needed yet |
| Cache management | Assume cache is always valid | Module-level cache + explicit invalidation on `flush()` | Without invalidation, optimization updates get overwritten with stale data |

## Common Pitfalls

### Pitfall 1: Direct writeFileSync causes data loss on crash
**What goes wrong:** If the process crashes after `writeFileSync` opens the file but before data is flushed, the target file is empty or truncated. Next load fails `JSON.parse`, catch block resets to seed keywords, all learned data lost.
**Why it happens:** `fs.writeFileSync` is not atomic. Node.js writes data to a kernel buffer first.
**How to avoid:** Always use temp-file-then-rename: `writeFileSync(tmpPath, data)` then `renameSync(tmpPath, target)`.
**Verification:** Kill the process during a `saveKeywordStore` call; verify the target file is either the old valid state or the new complete state.

### Pitfall 2: Module-level cache not invalidated after disk write
**What goes wrong:** Optimization subagent saves updated store to disk; cache still holds old store; next `match()` call uses stale cache; another `saveKeywordStore` call overwrites the optimized store with stale data.
**Why it happens:** `_correctionCueCache` is only keyed by language, not by disk state. `saveKeywordStore` does not clear or update the cache.
**How to avoid:** Set `_correctionCueCache = null` inside `saveCorrectionKeywordStore()` after the write succeeds.
**Verification:** Call `saveCorrectionKeywordStore()` with a modified store; verify `_correctionCueCache === null`.

### Pitfall 3: add() without size check causes unbounded growth
**What goes wrong:** `applyKeywordUpdates` can add unlimited keywords; with LLM optimization in future phases, the store grows past 200 terms; O(n) matching degrades to >5ms per call.
**Why it happens:** No guard on `Object.keys(store.keywords).length` in `add()` path.
**How to avoid:** `add()` must throw `Error('Correction keyword store limit reached (200 terms)')` when `store.keywords.length >= 200` before any write is attempted.
**Verification:** Call `add()` when store has 200 entries; verify `Error` is thrown and store is unchanged.

### Pitfall 4: Normalization inconsistency between seed matching and new keyword matching
**What goes wrong:** `detectCorrectionCue` normalizes by lowercasing and removing punctuation; if `CorrectionCueLearner.match()` uses different normalization, seed keywords behave differently than future learned keywords.
**Why it happens:** Normalization logic is duplicated or diverges between the two systems.
**How to avoid:** Use a single shared normalization function for all keyword matching.
**Verification:** Confirm the normalization in `match()` produces the same result as the removed `detectCorrectionCue()` for all 16 seed terms.

## Code Examples

### Existing: detectCorrectionCue (to be replaced)
```typescript
// Source: packages/openclaw-plugin/src/hooks/prompt.ts:87-111
function detectCorrectionCue(text: string): string | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:，。！？；：]/g, '');
  const cues = [
    '不是这个', '不对', '错了', '搞错了', '理解错了', '你理解错了',
    '重新来', '再试一次', 'you are wrong', 'wrong file', 'not this',
    'redo', 'try again', 'again', 'please redo', 'please try again',
  ];
  return cues.find((cue) => normalized.includes(cue)) ?? null;
}
```

### Existing: empathy-keyword-matcher saveKeywordStore (broken -- no atomic write)
```typescript
// Source: packages/openclaw-plugin/src/core/empathy-keyword-matcher.ts:117-127
// PROBLEM: This does NOT use atomic write -- it directly writes to the target file
export function saveKeywordStore(stateDir: string, store: EmpathyKeywordStore): void {
  const filePath = path.join(stateDir, KEYWORD_STORE_FILE);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  store.lastUpdated = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf8');  // NOT ATOMIC
}
```

### Existing: PainDictionary flush (broken -- no atomic write, no directory creation)
```typescript
// Source: packages/openclaw-plugin/src/core/dictionary.ts:152-161
// PROBLEM: No atomic write AND no directory creation (assumes dir exists)
flush(): void {
  try {
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');  // NOT ATOMIC
  } catch (e) {
    console.error('[PD] Failed to flush pain_dictionary.json:', e);
  }
}
```

### Prescribed: Atomic write pattern (from PITFALLS.md)
```typescript
// Prescribed pattern for correction-cue-learner.ts
const tmpPath = filePath + '.tmp';
const bakPath = filePath + '.bak';

// 1. Write to temp file
fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8');

// 2. Backup previous (optional but recommended)
if (fs.existsSync(filePath)) {
  fs.copyFileSync(filePath, bakPath);
}

// 3. Atomic rename
fs.renameSync(tmpPath, filePath);
```

## 16 Seed Keywords (from detectCorrectionCue)

**Chinese (8):**
| Term | Weight | FPR | Rationale |
|------|--------|-----|-----------|
| `不是这个` | 0.6 | 0.15 | Medium specificity |
| `不对` | 0.5 | 0.25 | Medium, common false positive |
| `错了` | 0.5 | 0.25 | Medium, common false positive |
| `搞错了` | 0.7 | 0.15 | High specificity |
| `理解错了` | 0.7 | 0.15 | High specificity, explicit misunderstanding |
| `你理解错了` | 0.8 | 0.1 | Highest specificity, explicit accusation |
| `重新来` | 0.6 | 0.15 | Medium specificity |
| `再试一次` | 0.4 | 0.2 | Lower, common in non-correction contexts |

**English (8):**
| Term | Weight | FPR | Rationale |
|------|--------|-----|-----------|
| `you are wrong` | 0.7 | 0.15 | High specificity |
| `wrong file` | 0.6 | 0.2 | Context-dependent |
| `not this` | 0.4 | 0.3 | High-genericity, common false positive |
| `redo` | 0.6 | 0.15 | Medium specificity |
| `try again` | 0.4 | 0.2 | Lower, common in non-correction contexts |
| `again` | 0.3 | 0.35 | Highest FPR, common false positive |
| `please redo` | 0.6 | 0.15 | Polite form, medium specificity |
| `please try again` | 0.5 | 0.2 | Polite form |

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hardcoded `detectCorrectionCue()` in prompt.ts | `CorrectionCueLearner.match()` with persisted store | Phase 38 | Enables learning; separates detection from trajectory recording |
| No atomic write (both empathy and pain dictionary) | Temp-file-then-rename atomic writes | Phase 38 | Prevents crash data loss; all future reads/writes are safe |
| No cache invalidation | Explicit cache = null on `flush()` | Phase 38 | Prevents optimization updates being overwritten by stale cache |
| Unbounded keyword store | 200-term hard cap with fail-fast | Phase 38 | Performance guarantee; O(n) matching stays under 5ms |

**Deprecated/outdated:**
- `detectCorrectionCue()` function: replaced by `CorrectionCueLearner.match()` -- remove after migration verified

## Assumptions Log

> List all claims tagged `[ASSUMED]` in this research. Planner and discuss-phase use this to identify decisions needing user confirmation.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The 16 seed keywords listed in this research match exactly the 16 cues in `detectCorrectionCue()` | 16 Seed Keywords | If any term differs, seed coverage is incomplete and some correction cues would stop being detected |
| A2 | `CorrectionCueLearner` is a standalone class, not extending a shared base with empathy | Architecture Patterns | If coupling with empathy is preferred, the file structure and class hierarchy would change |
| A3 | Cache invalidation is done by setting `_correctionCueCache = null` in `saveCorrectionKeywordStore()` | Common Pitfalls | If the intended pattern uses a different invalidation mechanism, implementation would diverge |

**If this table is empty:** All claims in this research were verified or cited -- no user confirmation needed.

## Open Questions

1. **Should `CorrectionCueLearner` extend a shared `KeywordLearner` base class or be fully standalone?**
   - What we know: empathy-keyword-matcher.ts is 335 lines, self-contained. ARCHITECTURE.md suggests a base class.
   - What's unclear: The phase description specifies only `CorrectionCueLearner`, not a base class. Building a base class adds complexity that may not be needed yet.
   - Recommendation: Build standalone `CorrectionCueLearner` for Phase 38; defer base-class extraction to post-Phase 38 if empathy engine also needs it.

2. **Should `correction_keywords.json` use the same top-level `{ keywords, version }` schema as empathy's `{ terms, version }` or the phase-specified `{ keywords, version }`?**
   - What we know: Phase description specifies `{ keywords: CorrectionKeyword[], version: number }`. empathy uses `{ terms: EmpathyKeywordEntry, version }`.
   - What's unclear: Whether the schema difference is intentional or a typo.
   - Recommendation: Follow phase description exactly (`keywords` field); use a different field name from empathy intentionally.

3. **Where should `CorrectionCueLearner` be instantiated for prompt.ts integration?**
   - What we know: `prompt.ts` has `_empathyKeywordCache` at module level. A similar `_correctionCueCache` would be needed.
   - What's unclear: Whether the learner should be a true singleton (like DictionaryService) or a per-stateDir instance.
   - Recommendation: Use module-level cache pattern identical to `_empathyKeywordCache` -- same instantiation strategy.

## Environment Availability

> Step 2.6: SKIPPED (no external dependencies identified). This phase involves only in-memory TypeScript code changes and new source files -- no external tools, services, runtimes, or package manager additions are required beyond what is already in the plugin.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.1.0 |
| Config file | `vitest.config.ts` (exists in plugin root) |
| Quick run command | `npm test -- tests/core/correction-cue-learner.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CORR-01 | Seed store contains exactly 16 keywords (8 zh + 8 en) with source='seed' | unit | `npm test -- tests/core/correction-cue-learner.test.ts -t "seed"` | Wave 0 needed |
| CORR-03 | saveKeywordStore uses temp-file-then-rename | unit | `npm test -- tests/core/correction-cue-learner.test.ts -t "atomic"` | Wave 0 needed |
| CORR-04 | Cache is null after saveKeywordStore | unit | `npm test -- tests/core/correction-cue-learner.test.ts -t "cache"` | Wave 0 needed |
| CORR-05 | add() throws when store has 200 terms | unit | `npm test -- tests/core/correction-cue-learner.test.ts -t "limit"` | Wave 0 needed |
| CORR-11 | match() returns same result as detectCorrectionCue() for all 16 seeds | unit | `npm test -- tests/core/correction-cue-learner.test.ts -t "equivalence"` | Wave 0 needed |

### Sampling Rate
- **Per task commit:** `npm test -- tests/core/correction-cue-learner.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/core/correction-cue-learner.test.ts` -- covers CORR-01, CORR-03, CORR-04, CORR-05, CORR-11
- [ ] `tests/core/correction-types.test.ts` -- unit tests for correction type definitions (optional, can be included in main test file)
- Framework install: Already installed (vitest ^4.1.0 in package.json)

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | Normalize text before keyword matching; `detectCorrectionCue` already strips punctuation; ensure `match()` does same |
| V4 Access Control | no | Keyword store is workspace-local, not a shared resource |
| V2 Authentication | no | No auth involved |
| V3 Session Management | no | No session state in keyword store |

### Known Threat Patterns for Keyword Store

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| JSON injection via keyword term | Tampering | Keyword terms are treated as literal substrings, not evaluated; JSON.stringify protects against injection |
| State file corruption from concurrent writes | Denial of Service | Single-instance OpenClaw assumption; atomic write prevents corruption; if multi-instance, file locking would be needed |
| Unbounded storage via 200-term limit bypass | Denial of Service | CORR-05 enforces fail-fast; `add()` throws before any write when limit reached |

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/hooks/prompt.ts:87-111` -- current `detectCorrectionCue()` with 16 hardcoded keywords
- `packages/openclaw-plugin/src/core/empathy-keyword-matcher.ts` -- learning pattern (335 lines), `createDefaultKeywordStore`, `loadKeywordStore`, `saveKeywordStore`, `matchEmpathyKeywords`
- `packages/openclaw-plugin/src/core/empathy-types.ts` -- data model template for keyword stores
- `packages/openclaw-plugin/src/core/dictionary.ts` -- PainDictionary reference pattern (non-atomic flush anti-pattern to avoid)
- `packages/openclaw-plugin/src/core/dictionary-service.ts` -- DictionaryService singleton pattern
- `.planning/research/SUMMARY.md` -- project-level summary for v1.14 KeywordLearningEngine
- `.planning/research/ARCHITECTURE.md` -- system design, file structure, integration approach
- `.planning/research/STACK.md` -- confirmed no new dependencies needed
- `.planning/research/PITFALLS.md` -- 7 pitfall categories with prevention strategies

### Secondary (MEDIUM confidence)
- `packages/openclaw-plugin/tests/core/empathy-keyword-matcher.test.ts` -- test pattern (vitest with `vi.mock('fs')`)

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already in plugin, no new dependencies
- Architecture: HIGH -- existing empathy-keyword-matcher.ts provides exact pattern to follow
- Pitfalls: HIGH -- all pitfalls documented with code-level evidence from existing implementation

**Research date:** 2026-04-14
**Valid until:** 2026-05-14 (30 days -- patterns are stable, no fast-moving ecosystem changes expected)
