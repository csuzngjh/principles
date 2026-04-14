# Stack Research: KeywordLearningEngine

**Domain:** Dynamic keyword learning with false positive rate tracking and LLM-based optimization
**Researched:** 2026-04-14
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| TypeScript | ^6.0.2 | Language | Already in plugin (package.json); no change needed |
| Node.js fs module | built-in | JSON persistence | empathy-keyword-matcher.ts already uses this pattern; no new dependencies |
| OpenClaw Subagent Workflow | existing | LLM-based optimization | Same pattern as empathy optimizer (EmpathyObserverWorkflowManager); no new infrastructure |

**No new dependencies required.** The empathy keyword matcher provides the complete learning engine pattern using only existing infrastructure.

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @sinclair/typebox | ^0.34.48 | JSON schema validation | Only if runtime schema validation needed beyond TypeScript types |
| micromatch | ^4.0.8 | Pattern matching | Only if keyword terms need glob-style wildcards (not needed for 15 hardcoded keywords) |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| TypeScript (existing) | Type checking | Already configured in plugin |
| vitest (existing) | Testing | Already configured in plugin |
| eslint (existing) | Linting | Already configured in plugin |

## Existing Pattern to Reuse

The `empathy-keyword-matcher.ts` (335 lines) provides the complete learning engine pattern. The KeywordLearningEngine for correction cues should follow this same architecture:

```
src/core/correction-keyword-matcher.ts
├── createDefaultCorrectionStore()      // Initialize with 15 seed keywords
├── loadCorrectionStore()              // Load from stateDir/correction_keywords.json
├── saveCorrectionStore()              // Persist to disk
├── matchCorrectionKeywords()           // Fast keyword matching (replaces detectCorrectionCue)
├── shouldTriggerOptimization()         // Decide when to optimize via subagent
├── applyCorrectionUpdates()            // Apply LLM-generated updates
└── getCorrectionStoreSummary()         // Debug/monitoring helper
```

**Data model (reuse/extend empathy-types.ts):**
```typescript
interface CorrectionKeywordStore {
  version: number;
  lastUpdated: string;
  lastOptimizedAt: string;
  terms: Record<string, CorrectionKeywordEntry>;
  stats: CorrectionKeywordStats;
}

interface CorrectionKeywordEntry {
  weight: number;           // 0-1, contribution to correction detection
  source: 'seed' | 'llm_discovered' | 'user_reported';
  hitCount: number;
  lastHitAt?: string;
  falsePositiveRate: number; // 0-1, validated via subagent
  examples?: string[];
  discoveredAt?: string;
}
```

## Seed Keywords (from detectCorrectionCue)

These 15 hardcoded keywords should become seed entries with differentiated weights and false positive rates:

```typescript
// High-specificity (low FPR)
'搞错了'     // weight: 0.7, FPR: 0.15
'理解错了'   // weight: 0.7, FPR: 0.15
'你理解错了' // weight: 0.8, FPR: 0.1

// Medium-specificity (medium FPR)
'不是这个'   // weight: 0.6, FPR: 0.2
'不对'       // weight: 0.5, FPR: 0.25
'错了'       // weight: 0.5, FPR: 0.25
'重新来'     // weight: 0.6, FPR: 0.2
'再试一次'   // weight: 0.5, FPR: 0.2
'you are wrong'  // weight: 0.7, FPR: 0.15
'wrong file'     // weight: 0.7, FPR: 0.15
'redo'           // weight: 0.6, FPR: 0.2
'try again'      // weight: 0.5, FPR: 0.2

// High-genericity (higher FPR)
'not this'       // weight: 0.4, FPR: 0.35
'again'          // weight: 0.3, FPR: 0.4
'please redo'    // weight: 0.5, FPR: 0.25
'please try again' // weight: 0.5, FPR: 0.25
```

## Installation

**No new packages needed.**

```bash
# No dependency changes required
# Just add new source files:
src/core/correction-keyword-matcher.ts  # Main engine
src/core/correction-types.ts           # Or extend empathy-types.ts
```

## Integration Points

| Component | Integration Method | Notes |
|-----------|-------------------|-------|
| hooks/prompt.ts | Replace `detectCorrectionCue()` call with `matchCorrectionKeywords()` | Returns rich result (score, matchedTerms, severity) instead of just cue string |
| OpenClaw subagent | Reuse EmpathyObserverWorkflowManager or create CorrectionOptimizationWorkflowManager | Empathy pattern already spawns optimization subagent; same pattern |
| State storage | `stateDir/correction_keywords.json` | Parallel to `stateDir/empathy_keywords.json` |
| Config | Add `correction_engine.enabled` similar to `empathy_engine.enabled` | Separate concern from empathy |

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| JSON file storage | SQLite/better-sqlite3 | Only if store grows to 10K+ terms with complex queries. Currently 15 seed terms, JSON is sufficient |
| Subagent optimization | Direct LLM API calls | Subagent workflow already handles rate limiting, retries, context management |
| Extend empathy-types.ts | Separate correction-types.ts | Extend empathy-types.ts to reuse shared interfaces and reduce duplication |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| External ML libraries (tensorflow, transformers) | Overkill for keyword matching; 15-50 terms max; adds large dependency | Simple weighted scoring with false positive rate adjustment |
| Separate database | Unnecessary complexity for this scale | JSON file in stateDir (same as empathy keywords) |
| Real-time streaming to LLM | Cost, latency, rate limits | Periodic subagent batch optimization (same as empathy engine) |
| Separate correction_types.ts | Duplication of empathy-types interfaces | Extend empathy-types.ts with correction-specific additions |

## Stack Patterns by Variant

**If adding new keyword categories beyond correction cues:**
- Extend empathy-types.ts with shared interfaces
- One keyword store per category (correction_keywords.json, empathy_keywords.json)

**If keyword store exceeds 1000 terms:**
- Consider better-sqlite3 (already in dependencies) for query performance
- Current correction store has 15 seed terms, no migration needed soon

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| TypeScript ^6.0.2 | Existing plugin | No changes |
| @sinclair/typebox ^0.34.48 | Existing plugin | Only needed if adding runtime validation |
| micromatch ^4.0.8 | Existing plugin | Only needed if glob patterns required for keywords |

## Sources

- `packages/openclaw-plugin/src/core/empathy-keyword-matcher.ts` — HIGH confidence, existing pattern to replicate for correction keywords
- `packages/openclaw-plugin/src/core/empathy-types.ts` — HIGH confidence, data model template
- `packages/openclaw-plugin/src/hooks/prompt.ts` (line 87-111) — HIGH confidence, current detectCorrectionCue with 15 hardcoded keywords
- `packages/openclaw-plugin/package.json` — HIGH confidence, current dependencies and versions

## Comparison with Empathy Keyword Engine

| Aspect | Empathy Engine | Correction Engine (planned) |
|--------|--------------|----------------------------|
| Seed keywords | ~50 terms across 4 categories | 15 terms (Chinese + English) |
| State file | empathy_keywords.json | correction_keywords.json |
| Workflow | EmpathyObserverWorkflowManager | CorrectionOptimizationWorkflowManager (reuse pattern) |
| Trigger | 30% boundary / 5% random sampling | Likely similar to empathy (periodic + threshold) |
| Config | empathy_engine.enabled | correction_engine.enabled (new) |

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| No new dependencies | HIGH | empathy-keyword-matcher proves pattern works with existing infrastructure |
| Reuse architecture | HIGH | Exact pattern exists and is production-validated |
| Integration approach | HIGH | Same hook integration point (prompt.ts), just replace detectCorrectionCue call |
| Learning algorithm | MEDIUM | Empathy pattern is proven; correction may need tuning of thresholds and FPR calibration |

---
*Stack research for: KeywordLearningEngine*
*Researched: 2026-04-14*
