# Correction Keyword Learning Spec

## Overview

Replace hardcoded correction keyword detection with a dynamic, learnable keyword store that supports weighted matching, false positive rate tracking, and LLM-based optimization.

## Type Definitions

```typescript
// src/core/correction-types.ts

export interface CorrectionKeyword {
  keyword: string;           // e.g., "不对", "that's wrong"
  weight: number;            // 1.0-10.0, higher = more confident
  falsePositiveRate: number; // 0.0-1.0, estimated FPR from recent history
  lastUsed: number;          // Unix timestamp
  matchCount: number;        // Total matches observed
  falsePositiveCount: number;// False positives observed
  enabled: boolean;          // Can be disabled if FPR too high
}

export interface CorrectionKeywordStore {
  keywords: Map<string, CorrectionKeyword>;
  lastOptimization: number;  // Unix timestamp of last LLM optimization
  version: string;
}

export interface CorrectionMatchResult {
  matched: boolean;
  keyword: string | null;
  confidence: number;        // weight * (1 - fpr)
  isLikelyFalsePositive: boolean;
}
```

## Seed Keywords

25 initial keywords with weights and FPR:

| Keyword | Weight | FPR |
|---------|--------|-----|
| 不对 | 8.0 | 0.05 |
| 错了 | 7.5 | 0.08 |
| that's wrong | 7.0 | 0.10 |
| 重新来 | 6.5 | 0.12 |
| not right | 6.0 | 0.15 |
| 不对不对 | 9.0 | 0.03 |
| 等等 | 3.0 | 0.30 |
| wait | 2.5 | 0.35 |
| 等等等等 | 4.0 | 0.25 |
| 等等不对 | 5.0 | 0.20 |
| 好像不对 | 5.5 | 0.18 |
| I think it's wrong | 5.0 | 0.20 |
| 不准确 | 6.0 | 0.15 |
| inaccurate | 5.5 | 0.18 |
| 再想想 | 4.5 | 0.22 |
| think again | 4.0 | 0.25 |
| 重做 | 7.0 | 0.10 |
| redo | 6.5 | 0.12 |
| 不用这个 | 5.0 | 0.20 |
| don't use this | 4.5 | 0.22 |
| 换一种 | 4.0 | 0.25 |
| different approach | 3.5 | 0.30 |
| 更好 | 2.0 | 0.40 |
| better | 1.5 | 0.45 |
| 不太对 | 6.0 | 0.15 |

## Core Functions

### correction-keyword-matcher.ts

```typescript
export function createCorrectionKeywordMatcher(store: CorrectionKeywordStore) {
  return {
    matchCorrectionKeywords(text: string): CorrectionMatchResult;

    applyKeywordUpdates(
      feedback: 'positive' | 'negative',
      matchedKeyword: string | null
    ): void;

    shouldTriggerOptimization(): boolean;

    getKeywordsForOptimization(): CorrectionKeyword[];
  };
}

export function loadKeywordStore(stateDir: string): CorrectionKeywordStore;
export function saveKeywordStore(stateDir: string, store: CorrectionKeywordStore): void;
```

### Matching Algorithm

1. Check each enabled keyword for presence in text (case-insensitive)
2. Calculate confidence = weight * (1 - falsePositiveRate)
3. If confidence >= 4.0, return match with highest confidence
4. Track match for FPR updates

### False Positive Tracking

- After LLM response, if user provides positive feedback without correction keywords → keyword was likely false positive
- Decay FPR slowly: `fpr = fpr * 0.95 + 0.05 * newObservation`
- Disable keywords with FPR > 0.4

## prompt.ts Integration

Replace hardcoded `detectCorrectionCue()` with:

```typescript
import { createCorrectionKeywordMatcher } from '../core/correction-keyword-matcher';

const matcher = createCorrectionKeywordMatcher(
  loadKeywordStore(stateDir)
);

function detectCorrectionCue(text: string): boolean {
  const result = matcher.matchCorrectionKeywords(text);
  return result.matched && !result.isLikelyFalsePositive;
}
```

## LLM Optimization

### Trigger Conditions

- After 50 new matches without optimization
- Or 24 hours since last optimization
- Only if match count > 10

### Prompt Template

```
Analyze these correction keywords and their performance:
[Keyword stats: match count, false positive rate, weight]

Suggest:
1. New keywords to add (with expected weight and FPR)
2. Keywords to remove or disable
3. Weight adjustments

Respond in JSON format.
```

## Runtime State

State file: `<stateDir>/correction_keywords.json`

```json
{
  "version": "1.0",
  "keywords": [...],
  "lastOptimization": 1712000000
}
```

## Test Cases

See `tests/core/correction-keyword-matcher.test.ts`

## Acceptance Criteria

### Functional
- [ ] Seed keywords load correctly on startup
- [ ] Keywords persist across restarts
- [ ] Matching is case-insensitive
- [ ] FPR updates based on feedback
- [ ] Disabled keywords don't match

### Integration
- [ ] Replaces hardcoded detection in prompt.ts
- [ ] State file created in correct location
- [ ] Graceful handling of missing/corrupt state file

### Performance
- [ ] Matching completes < 1ms per call
- [ ] No memory leaks from keyword store
- [ ] State file writes debounced (max 1/5 seconds)
