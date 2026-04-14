# Project Research Summary

**Project:** KeywordLearningEngine for Correction Cues (v1.14)
**Domain:** Dynamic keyword learning for AI agent correction signal detection
**Researched:** 2026-04-14
**Confidence:** HIGH

## Executive Summary

The KeywordLearningEngine replaces 15 hardcoded static correction-cue keywords with a learnable store that tracks false positive rate (FPR) and uses an LLM optimizer for continuous improvement. The existing codebase already contains a production-validated pattern in `empathy-keyword-matcher.ts` -- the correction cue system reuses this exact architecture with different seed keywords and a separate store file. No new dependencies are required.

The core insight from research: the empathy keyword system proves the pattern works with existing infrastructure (Node.js fs, OpenClaw subagent workflows). The KeywordLearningEngine for correction cues simply mirrors this pattern. However, seven pitfall categories were identified -- most critically, FPR calculation assumes verified labels that the system does not currently collect, and the learning loop can reinforce false positives rather than reduce them if FPR verification is not built into Phase 1.

## Key Findings

### From STACK.md: Technology Stack

| Technology | Decision | Rationale |
|------------|----------|-----------|
| TypeScript ^6.0.2 | Use existing | Already in plugin, no change needed |
| Node.js fs module | Use existing | empathy-keyword-matcher.ts already uses this pattern |
| OpenClaw Subagent Workflow | Reuse existing | Same pattern as empathy optimizer |
| JSON file storage | Use existing | `correction_keywords.json` parallel to `empathy_keywords.json` |
| No new dependencies | Confirmed | Empathy pattern proves this works without new packages |

**Seed keywords** (15 terms migrated from detectCorrectionCue):
- High-specificity: '搞错了', '理解错了', '你理解错了' (weight 0.7-0.8, FPR 0.1-0.15)
- Medium-specificity: '不是这个', '不对', '错了', '重新来', 'you are wrong', 'redo' (weight 0.5-0.6, FPR 0.2-0.25)
- High-genericity: 'again', 'not this' (weight 0.3-0.4, FPR 0.35-0.4)

### From FEATURES.md: Feature Landscape

**Table stakes (must-have for v1):**
- Static keyword store with seed keywords migrated from detectCorrectionCue
- Basic keyword matching replacing detectCorrectionCue()
- Correction store persistence to `correction_keywords.json`
- In-memory cache parallel to `_empathyKeywordCache`

**Differentiators (add after validation):**
- Subagent optimization trigger (every 50 turns or 6 hours)
- FPR feedback integration with trajectory recording
- LLM-discovered new correction expressions

**Anti-features (avoid):**
- Real-time FPR updates (too noisy; batch via subagent instead)
- Fuzzy/approximate matching (increases false positives dramatically)
- Keyword auto-removal (premature removal risk; LLM should decide)
- Per-user keyword stores (complexity explosion; defer to v2)

**Priority:**
- P1: Seed store + basic matching + persistence + cache
- P2: Subagent optimization + FPR feedback + LLM discovery

### From ARCHITECTURE.md: System Design

**Location:** `packages/openclaw-plugin/src/core/` alongside existing empathy modules

**Two-layer design:**
```
KeywordLearner (base)
├── match(), load(), save(), shouldOptimize(), applyUpdates()
└── CorrectionCueLearner (subclass)
    ├── seed keywords (15 terms)
    └── binary detection (no severity mapping)
```

**Proposed new files:**
| File | Purpose |
|------|---------|
| `core/keyword-types.ts` | Generic types extractable from empathy-types.ts |
| `core/keyword-learner.ts` | Base class ported from empathy pattern |
| `core/correction-cue-matcher.ts` | Correction-specific learner with seed keywords |

**Integration:** In `prompt.ts`:
- Replace `detectCorrectionCue()` with `CorrectionCueLearner.match()`
- Module-level cache: `_correctionCueCache`
- Trigger optimization via existing `EmpathyObserverWorkflowManager` pattern

**Build order:** types -> base class -> subclass -> prompt.ts integration -> optimization trigger -> testing

### From PITFALLS.md: Critical Risks

**Top 5 pitfalls requiring prevention:**

| Pitfall | Severity | Prevention |
|---------|----------|------------|
| FPR calculation assumes verified labels (never actually calculated from labeled data) | CRITICAL | Add explicit verification step; track truePositiveCount vs falsePositiveCount separately |
| Learning loop reinforces false positives (hitCount conflates TP and FP) | CRITICAL | Distinguish hitCount from truePositiveCount; lower weight on confirmed FP |
| Per-message keyword matching causes latency at scale (O(n) scan over all terms) | CRITICAL | Trie or Bloom filter; cap store at 200 terms |
| State file corruption from unsafe writes (writeFileSync crash = JSON parse failure) | CRITICAL | Temp-file-then-rename atomic write pattern |
| Module-level cache causes stale state across reloads (cache not invalidated on disk update) | CRITICAL | Invalidate cache after saveKeywordStore |

**Phase mapping (critical items must be in Phase 1):**
- Phase 1: FPR verification infrastructure, atomic writes, cache invalidation, store size limits, performance baseline
- Phase 2: Feedback collection, throttle logic (depends on Phase 1 infrastructure)

## Implications for Roadmap

### Suggested Phase Structure

**Phase 1: Foundation -- Seed Store and Safe Persistence**
*Rationale:* Before any learning can work, the infrastructure must be correct. FPR tracking, atomic writes, cache invalidation, and store size limits are all prerequisite to learning. Cannot skip to optimization without this.

**Delivers:**
- `correction-keyword-matcher.ts` with seed keywords migrated from detectCorrectionCue
- Atomic write (temp-file-then-rename) for correction_keywords.json
- Cache invalidation after save
- Store size limit (200 terms hard cap)
- Performance baseline benchmark (matching latency with 50/100/200 terms)
- Remove redundant detectCorrectionCue (ensure seed coverage of all 15 terms)

**Avoids:** Pitfall 4 (state file corruption), Pitfall 7 (stale cache), Pitfall 5 (unbounded growth), Pitfall 3 (latency at scale)

**Research flag:** None needed -- existing empathy-keyword-matcher.ts provides exact pattern to follow.

---

**Phase 2: Learning Loop -- FPR Feedback and Optimization Trigger**
*Rationale:* Once persistence infrastructure exists, implement the feedback loop. FPR must be calculated from verified labels, not LLM guesses. This phase requires Phase 1's atomic writes and cache invalidation.

**Delivers:**
- FPR verification infrastructure (truePositiveCount / falsePositiveCount tracking)
- Subagent validation step (confirm when keyword match was actually a correction)
- shouldTriggerOptimization() with time-based throttle (not turn-based)
- Correction-specific optimization prompt builder
- Optimization call throttling (max N per day)

**Avoids:** Pitfall 1 (FPR drift from unverified labels), Pitfall 2 (learning reinforces FP), Pitfall 6 (optimization cost abuse)

**Research flag:** Phase 2 needs validation of exact verification mechanism -- how does subagent confirm whether a keyword match was actually a correction vs a false positive?

---

**Phase 3: LLM Discovery and Full Integration**
*Rationale:* After feedback loop works, add LLM-based keyword discovery. The subagent analyzes recent messages and proposes add/update/remove actions. This completes the learning loop.

**Delivers:**
- buildCorrectionOptimizationPrompt() function
- applyCorrectionUpdates() with add/update/remove rules
- LLM-discovered keywords added to store
- Integration test with trajectory recording (correctionDetected flag feeds back)

**Avoids:** Remaining feature gaps from FEATURES.md differentiators

**Research flag:** None needed -- empathyObserverWorkflowSpec pattern is well-established.

---

**Phase 4: Testing and Validation**
*Rationale:* Complete validation before v1.14 ships. Integration tests verify all pipeline components work together.

**Delivers:**
- Integration tests: matching + optimization + persistence cycle
- FPR verification test: confirm FP match reduces keyword weight
- Atomic write recovery test: kill process mid-save, verify recoverable
- Store size limit test: attempt to exceed cap, verify enforcement

**Research flag:** None.

### Phase Ordering Rationale

1. **Phase 1 before Phase 2:** FPR verification infrastructure requires atomic writes and cache invalidation. Learning loop cannot work without safe persistence.
2. **Phase 2 before Phase 3:** Optimization depends on feedback collection. LLM discovery without verified FPR values produces the same drift problem.
3. **Phase 3 before Phase 4:** Full integration must exist before testing.
4. **No separate dependency phase:** All technologies already exist in plugin. No new packages to resolve.

### Research Flags

**Needs research during planning:**
- **Phase 2:** Exact FPR verification mechanism -- how does the system confirm whether a match was a true positive or false positive? Current empathy system does not actually do this verification (stats.totalFalsePositives is always 0). This needs a product decision.

**Phases with standard patterns (skip research):**
- **Phase 1:** File persistence, cache invalidation, store size limits -- all follow existing empathy-keyword-matcher.ts patterns exactly.
- **Phase 3:** LLM optimization workflow -- follows existing EmpathyObserverWorkflowManager pattern exactly.
- **Phase 4:** Testing patterns -- existing test files in plugin.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | No new dependencies; empathy-keyword-matcher.ts proves pattern works with existing infrastructure |
| Features | HIGH | Based on existing empathy integration analysis and PROJECT.md v1.14 milestone |
| Architecture | HIGH | Clear two-layer design; build order is logical and non-cyclic; existing pattern to follow |
| Pitfalls | HIGH | Based on code analysis of empathy-keyword-matcher.ts, empathy-types.ts, prompt.ts |

**Overall confidence:** HIGH

### Gaps to Address

| Gap | Impact | Resolution |
|-----|--------|------------|
| FPR verification mechanism not implemented in empathy system | HIGH -- FPR values are currently LLM guesses, not calculated from data | Phase 2 must design and implement explicit verification step |
| Keyword count discrepancy (15 in PROJECT.md vs 16 counted from code) | LOW -- minor seed keyword count issue | Verify exact seed list during Phase 1 implementation |
| Per-user keyword adaptation deferred to v2 | MEDIUM -- some users may have different correction styles | Document as v2 feature; design should not preclude it |

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/core/empathy-keyword-matcher.ts` -- existing learning pattern (335 lines)
- `packages/openclaw-plugin/src/core/empathy-types.ts` -- data model template
- `packages/openclaw-plugin/src/hooks/prompt.ts:87-111` -- current detectCorrectionCue with hardcoded keywords
- `packages/openclaw-plugin/src/hooks/prompt.ts:461-604` -- empathy keyword integration pattern
- `packages/openclaw-plugin/src/service/subagent-workflow/` -- optimization workflow

### Secondary (HIGH confidence)
- `.planning/PROJECT.md` -- v1.14 milestone definition
- `packages/openclaw-plugin/package.json` -- current dependencies and versions

---

*Research completed: 2026-04-14*
*Ready for roadmap: yes*
