# Feature Research: KeywordLearningEngine for Correction Cues

**Domain:** Dynamic keyword learning for AI agent correction signal detection
**Researched:** 2026-04-14
**Confidence:** HIGH (based on existing empathy implementation analysis)

## Executive Summary

The KeywordLearningEngine extends the existing `empathy-keyword-matcher.ts` pattern to correction cue detection. The existing codebase already has a production-ready implementation for empathy keywords with FPR tracking, LLM-based optimization, and persistent storage. The correction cue system reuses this exact pattern but with different seed keywords and a separate store file.

The current `detectCorrectionCue()` in `prompt.ts:87-111` uses 15 hardcoded static keywords. The KeywordLearningEngine replaces this with the dynamic keyword store pattern, enabling:
1. Learning from false positives (user said "not this" but was not frustrated)
2. Weight adjustment based on actual hit frequency
3. LLM-discovered new correction expressions
4. Separate `correction_keywords.json` store

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels broken.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Keyword matching | Users expect the system to detect when they are correcting the agent | LOW | Simple substring match (existing pattern: `text.includes(term)`) |
| FPR tracking | Overly aggressive detection creates user annoyance | MEDIUM | Track when keywords fire but user was not actually correcting |
| Persistence across restarts | Keyword store must survive plugin reload | LOW | JSON file in stateDir |
| Basic severity mapping | Not all corrections are equal | LOW | Score thresholds already exist in empathy-types.ts |

### Differentiators (Competitive Advantage)

Features that set the product apart. Not required, but valuable.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| LLM-based keyword discovery | System learns new correction expressions from actual user language | MEDIUM | Subagent workflow triggers optimization every 50 turns or 6 hours |
| Adaptive weight adjustment | Frequently matched keywords become more sensitive; rarely matched become less | MEDIUM | Weight * (1 - FPR) formula in matchEmpathyKeywords |
| Feedback loop integration | Trajectory recording with correctionDetected flag feeds back into keyword learning | MEDIUM | Requires subagent validation to mark false positives |
| Multi-language support | Both Chinese and English correction cues | LOW | Language-filtered seed keywords in createDefaultKeywordStore |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Real-time FPR updates after every message | "Immediate feedback" seems good | Too noisy; single messages cannot establish reliable FPR | Batch updates every N turns via subagent |
| Fuzzy/approximate matching | "What if user types 'thsi' instead of 'this'?" | Dramatically increases false positives, performance cost | Accept exact match with LLM discovery of typos |
| Keyword auto-removal | "Let the system clean itself up" | May remove important keywords prematurely | LLM subagent makes deliberate removal decisions with reasoning |
| Per-user keyword stores | "Each user has different expressions" | Complexity explosion, cold-start problem | Global store with per-user feedback weighting (defer to v2) |

## Feature Dependencies

```
[Match Keywords] ──requires──> [Load Keyword Store]
[LLM Optimization] ──requires──> [Match Keywords]
[LLM Optimization] ──requires──> [Trajectory Feedback]
[FPR Tracking] ──requires──> [Subagent Validation]
[FPR Tracking] ──enhances──> [Match Keywords]
[Save Keyword Store] ──requires──> [Match Keywords]

[correction_keywords.json] (new) ──mirrors──> [empathy_keywords.json] (existing)
```

### Dependency Notes

- **Match Keywords requires Load Keyword Store:** The `matchEmpathyKeywords` function requires a loaded `EmpathyKeywordStore`. This store is cached in module-level `_empathyKeywordCache` in prompt.ts.
- **LLM Optimization requires Trajectory Feedback:** The optimization subagent prompt uses recent messages to identify new patterns. The trajectory system records whether each user turn had a correction detected.
- **FPR Tracking enhances Match Keywords:** FPR directly adjusts the effective weight via `adjustedWeight = entry.weight * (1 - entry.falsePositiveRate)`. Higher FPR = lower effective weight.
- **correction_keywords.json mirrors empathy_keywords.json:** The correction store reuses the exact same `EmpathyKeywordStore` interface and `empathy-keyword-matcher.ts` functions, just with different seed keywords.

## MVP Definition

### Launch With (v1)

Minimum viable product -- what is needed to validate the concept.

- [ ] **Static keyword store with seed keywords** -- Copy the 15 hardcoded keywords from `detectCorrectionCue()` into `EMPATHY_SEED_KEYWORDS`-style seed list. Reuse existing `EmpathyKeywordStore` interface.
- [ ] **Basic keyword matching** -- Replace `detectCorrectionCue()` with `matchEmpathyKeywords()` call against the correction store. `matched: true` = correction detected.
- [ ] **Correction store persistence** -- Save to `correction_keywords.json` (separate from empathy store). Use existing `loadKeywordStore`/`saveKeywordStore` functions.
- [ ] **In-memory cache** -- Cache correction keyword store in `_correctionKeywordCache` (parallel to `_empathyKeywordCache`).

### Add After Validation (v1.x)

Features to add once core is working.

- [ ] **Subagent optimization trigger** -- Implement `shouldTriggerOptimization()` for correction store. Trigger every 50 turns or 6 hours. Reuse `EmpathyObserverWorkflowManager` pattern.
- [ ] **FPR feedback integration** -- When trajectory shows `correctionDetected: true` but user was not actually correcting (via subagent validation), update the keyword's FPR upward.
- [ ] **LLM-discovered keywords** -- Add new correction expressions discovered by the optimization subagent to the store.

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] **Per-user keyword adaptation** -- Different users may have different correction styles. Requires user identification and per-user stores.
- [ ] **Multi-word pattern matching** -- Support phrases like "that is not what I asked for" as a single keyword entry.
- [ ] **Stemming/lemmatization** -- Reduce keywords needed by matching word roots. Adds complexity, test burden.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Static keyword store with seeds | HIGH | LOW | P1 |
| Basic keyword matching replacement | HIGH | LOW | P1 |
| Correction store persistence | HIGH | LOW | P1 |
| In-memory cache | MEDIUM | LOW | P1 |
| Subagent optimization trigger | MEDIUM | MEDIUM | P2 |
| FPR feedback integration | MEDIUM | MEDIUM | P2 |
| LLM-discovered keywords | MEDIUM | MEDIUM | P2 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

## Technical Implementation Details (from existing codebase)

### Matching Algorithm (from empathy-keyword-matcher.ts:139-201)

```typescript
// Simple substring match with FPR-adjusted weight
const lowerText = text.toLowerCase();
for (const [term, entry] of Object.entries(store.terms)) {
  if (lowerText.includes(term.toLowerCase())) {
    const adjustedWeight = entry.weight * (1 - entry.falsePositiveRate);
    totalScore += adjustedWeight;
    matchedTerms.push(term);
  }
}
const cappedScore = Math.min(1, totalScore);
const isMatched = cappedScore >= config.matchThreshold && matchedTerms.length > 0;
```

**Key characteristics:**
- Case-insensitive via `toLowerCase()`
- No stemming or fuzzy matching
- FPR-adjusted weight: higher FPR = lower effective weight
- Score capped at 1.0
- Match threshold default: 0.3

### Seed Keywords (from current detectCorrectionCue vs empathy pattern)

Current hardcoded correction cues (15):
```
'不是这个', '不对', '错了', '搞错了', '理解错了', '你理解错了',
'重新来', '再试一次', 'you are wrong', 'wrong file', 'not this',
'redo', 'try again', 'again', 'please redo', 'please try again'
```

Note: The current list has 16 entries (I count 16), but PROJECT.md says "15 hardcoded keywords". The discrepancy should be verified during implementation.

### FPR Tracking (from empathy-types.ts)

```typescript
interface EmpathyKeywordEntry {
  weight: number;                    // 0-1, contribution when matched
  source: 'seed' | 'llm_discovered' | 'user_reported';
  hitCount: number;                  // Total times matched
  lastHitAt?: string;               // Last match timestamp
  falsePositiveRate: number;        // 0-1, from subagent validation
  examples?: string[];              // Example contexts
  discoveredAt?: string;             // When LLM discovered this
}
```

**FPR update mechanism:**
- FPR is NOT updated in real-time
- FPR is updated by the LLM optimization subagent after analyzing recent messages
- FPR affects weight: `adjustedWeight = weight * (1 - FPR)`
- Range: 0.05 (specific anger signals) to 0.5 (generic negation)

### LLM Optimization (from prompt.ts:269-299)

```typescript
// Triggered every 50 turns OR 6 hours
const optimizationPrompt = buildOptimizationPrompt(keywordStore, recentMessages);
// Subagent returns JSON: {"updates": {"TERM": {"action": "add|update|remove", ...}}}
// Applied via applyKeywordUpdates()
```

**Optimization rules:**
- ADD: If a message contains correction signals not in current terms
- UPDATE: If a term's weight should change (high hits -> increase, low hits -> decrease)
- REMOVE: If a term has 0 hits after many turns AND high FPR (>0.3)

### Persistence (from empathy-keyword-matcher.ts:77-127)

```typescript
const KEYWORD_STORE_FILE = 'empathy_keywords.json';
// For correction: 'correction_keywords.json'

export function loadKeywordStore(stateDir: string, lang?: 'zh' | 'en'): EmpathyKeywordStore
export function saveKeywordStore(stateDir: string, store: EmpathyKeywordStore): void
```

**File format:** JSON with `version`, `lastUpdated`, `lastOptimizedAt`, `terms`, `stats`.

### Learning Loop (from prompt.ts:461-604)

The empathy system uses a hybrid approach:
1. **Every turn:** Fast keyword matching (sub-millisecond)
2. **10% sampling:** Subagent called for verification on boundary cases
3. **5% random:** Subagent called randomly to discover new patterns
4. **Every 50 turns / 6 hours:** Optimization subagent updates weights and discovers new terms

For correction cues, the loop would be similar but simpler (correction detection is binary, not severity-scored).

## Competitor Feature Analysis

| Feature | GitHub Copilot | Cursor | Claude Code | Our Approach |
|---------|---------------|---------|-------------|--------------|
| Error correction detection | Implicit via feedback loops | Implicit via teacher mode | Explicit "redo" commands | Dynamic keyword learning with FPR |
| False positive handling | Unknown | Unknown | Unknown | FPR tracking + LLM optimization |
| User expression learning | No public evidence | No public evidence | No public evidence | LLM subagent discovers new expressions |
| Persistence | Unknown | Unknown | Unknown | JSON file per workspace |

No direct competitor publicly describes their correction cue detection mechanism in detail.

## Sources

- Existing implementation: `packages/openclaw-plugin/src/core/empathy-keyword-matcher.ts`
- Existing types: `packages/openclaw-plugin/src/core/empathy-types.ts`
- Existing integration: `packages/openclaw-plugin/src/hooks/prompt.ts:87-111` (detectCorrectionCue) and :461-604 (empathy keyword integration)
- Existing tests: `packages/openclaw-plugin/tests/core/empathy-keyword-matcher.test.ts`
- Project context: `.planning/PROJECT.md` (v1.14 milestone definition)

---
*Feature research for: KeywordLearningEngine for correction cues*
*Researched: 2026-04-14*
