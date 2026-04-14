# Pitfalls Research: KeywordLearningEngine

**Domain:** Dynamic keyword learning with false positive rate (FPR) tracking and LLM-driven optimization
**Researched:** 2026-04-14
**Confidence:** HIGH

## Executive Summary

KeywordLearningEngine replaces 15 hardcoded correction-cue keywords with a learnable store that tracks FPR and uses an LLM optimizer. Seven pitfall categories were identified from the existing empathy-keyword-matcher implementation and general keyword-learning system patterns. Most critical: FPR calculation assumes verified labels (which the system does not collect), and the learning loop can reinforce false positives rather than reduce them.

---

## Critical Pitfalls

### Pitfall 1: FPR Calculation Assumes Verified Labels

**What goes wrong:**
`falsePositiveRate` in `EmpathyKeywordEntry` is never actually calculated from labeled data. The optimizer subagent guesses FPR values based on message analysis, but no ground-truth verification occurs. Over time, FPR drifts from reality -- high-FP keywords remain in the store because the LLM underestimates their false positive rate.

**Why it happens:**
The system lacks a feedback mechanism to confirm whether a keyword match was actually a true positive or a false positive. The `EmpathyKeywordStats.totalFalsePositives` counter is never incremented anywhere in the codebase. The FPR field is set on `add`/`update` actions from the LLM but never validated against real outcomes.

**How to avoid:**
- Add an explicit "was this match correct?" verification step after each keyword match triggers a penalty
- Track `truePositiveCount` and `falsePositiveCount` separately; calculate FPR as `fp / (tp + fp)`
- Require minimum sample size (e.g., 10 matches) before adjusting FPR based on LLM guesses
- Store a rolling window of recent match outcomes, not cumulative counts

**Warning signs:**
- FPR values all clustering around 0.1-0.2 (LLM default guesses)
- `stats.totalFalsePositives` stays at 0 despite thousands of matches
- High-FPR terms never get removed even after 50+ turns with no true positives

**Phase to address:**
Phase 1 (Foundation) -- the FPR tracking infrastructure must be built before Phase 2 (Optimization) can work correctly.

---

### Pitfall 2: Learning Loop Reinforces False Positives

**What goes wrong:**
When a keyword incorrectly triggers (false positive), the system records it as a "hit" via `entry.hitCount++` in `matchEmpathyKeywords`. This increments the keyword's apparent effectiveness. If the LLM optimizer sees a keyword with high hitCount but does not know most were false positives, it may increase or preserve the keyword's weight instead of removing it.

**Why it happens:**
The feedback loop is closed only on matches (hit), not on match outcomes (true vs false). The `hitCount` field conflates true positives with false positives. The optimizer sees "100 hits" and assumes the keyword is valuable, when 90 of those hits were noise.

**How to avoid:**
- Distinguish `hitCount` (all matches) from `truePositiveCount` (verified correct matches)
- Only count toward "successful keyword" metrics if verification confirms true positive
- Lower weight automatically when a match is confirmed false positive
- Consider adding a "confidence decay" -- if a keyword matches but verification shows no actual pain signal, slightly decrease effective weight

**Warning signs:**
- Empathy trigger rate increases over time without corresponding increase in actual user frustration
- Users report "it keeps thinking I'm angry when I'm not"
- High hitCount keywords are also high FPR (>0.3) -- a red flag

**Phase to address:**
Phase 2 (Learning Loop) -- requires verification mechanism from Phase 1.

---

### Pitfall 3: Per-Message Keyword Matching Causes Latency at Scale

**What goes wrong:**
`matchEmpathyKeywords` iterates over ALL keywords in the store with `Object.entries(store.terms)`. With 200+ discovered terms, this O(n) scan runs on every user message. At high message volume, this adds measurable latency to the prompt hook.

**Why it happens:**
The current implementation does a naive substring match for every term. There is no indexing, trie, or bloom filter. Each new keyword discovered and kept increases the per-message cost linearly.

**How to avoid:**
- Implement a trie (prefix tree) for substring matching -- common in autocomplete systems
- Use a Bloom filter as a quick negative check before doing full matching
- Set a hard cap on total keywords (e.g., 200) and prune aggressively beyond that
- Cache compiled regex patterns if regex-based matching is needed

**Warning signs:**
- `handleBeforePromptBuild` latency increases after 100 turns (keyword store growth)
- CPU profile shows `matchEmpathyKeywords` consuming >5ms per call
- `optimizationIntervalTurns` fires frequently but matching is slow

**Phase to address:**
Phase 1 (Foundation) -- performance guardrails must be in place before the optimization loop can run safely.

---

### Pitfall 4: State File Corruption from Unsafe Writes

**What goes wrong:**
`saveKeywordStore` uses `fs.writeFileSync` directly. If the process crashes mid-write, the JSON file is truncated or partially written. On next load, `JSON.parse` throws, the catch block creates a new default store, and all hitCount / FPR / weight data is lost.

**Why it happens:**
No write safety mechanism (no temp-file-then-rename, no write-ahead log). The file is overwritten in place. Node.js `writeFileSync` does not atomic-write.

**How to avoid:**
- Write to a temp file first, then `fs.rename` to the target (atomic on POSIX)
- Example:
  ```typescript
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(store), 'utf8');
  fs.renameSync(tmpPath, filePath);
  ```
- Keep a backup: `filePath + '.bak'` of the previous known-good state
- Validate JSON structure after load; if invalid, attempt to load `.bak`

**Warning signs:**
- `Failed to load keyword store: SyntaxError` in logs
- Keyword store reset to seed keywords after restart
- `stats.optimizationCount` resets to 0 unexpectedly

**Phase to address:**
Phase 1 (Foundation) -- persistence safety is prerequisite to all learning.

---

### Pitfall 5: Unbounded Keyword Store Growth

**What goes wrong:**
`applyKeywordUpdates` can add unlimited keywords. The `add` case in the loop has no guard. Over time, the LLM optimizer discovers new terms on every run. Without removal pressure, the store grows indefinitely. At 1000 keywords, substring matching becomes slow; at 10000, it is unusable.

**Why it happens:**
The removal logic requires both `hitCount === 0` AND `falsePositiveRate > 0.3`. If a keyword has any accidental hits (even false positives), it never reaches 0 hits and is never removed. The optimizer can also add faster than it removes.

**How to avoid:**
- Enforce a maximum store size (e.g., 200 terms total)
- When at capacity, require removal before add (1-for-1 swap)
- Add a minimum hitCount threshold for discovered keywords to persist (e.g., 5 hits before considering a new term valid)
- Prune keywords that have not matched in N turns regardless of hitCount
- Track `discoveredTerms` count and alert if it exceeds threshold

**Warning signs:**
- `getKeywordStoreSummary` shows `discoveredTerms` growing monotonically
- Store file size grows > 10KB
- Memory usage of keyword store increases over time

**Phase to address:**
Phase 1 (Foundation) -- store size limits and pruning must be built in from the start.

---

### Pitfall 6: LLM Optimization Frequency and Cost Abuse

**What goes wrong:**
`shouldTriggerOptimization` fires based on `optimizationIntervalTurns` (50 turns) OR `optimizationIntervalMs` (6 hours). Each trigger spawns a subagent with `EmpathyObserverWorkflowManager`. At high message volume, this could mean a subagent call every few minutes. This generates significant LLM cost and can interfere with normal agent operation.

**Why it happens:**
The trigger conditions are too permissive. A busy conversation can hit 50 turns in 10 minutes. The subagent call is async (fire-and-forget via `.catch`), so cost is not immediately visible. But the LLM usage accumulates.

**How to avoid:**
- Make optimization interval time-based primarily, not turn-based (turns reset on plugin reload)
- Add a minimum time between optimizations (e.g., at least 1 hour apart)
- Add a global budget: max N optimizations per day
- Make optimization calls synchronous during low-traffic windows (heartbeat)
- Add cost tracking: log optimization subagent call frequency

**Warning signs:**
- Optimization subagent spawning multiple times per hour
- LLM token usage spikes correlated with empathy optimization
- `EmpathyObserverWorkflowManager` instances accumulating

**Phase to address:**
Phase 2 (Optimization) -- but throttle logic should be in Phase 1 to prevent runaway costs.

---

### Pitfall 7: Module-Level Cache Causes Stale State Across Reloads

**What goes wrong:**
`_empathyKeywordCache` at module level in `prompt.ts` caches the keyword store in memory. This cache is never invalidated when the file on disk changes (e.g., optimization subagent updates the store). The in-memory cache reflects stale data until the process restarts.

**Why it happens:**
The cache is keyed only by language. When `saveKeywordStore` writes to disk, the module-level `_empathyKeywordCache` is not updated. Subsequent calls use the stale cached store, lose the optimization updates, and may overwrite them on next save.

**Specific scenario:**
1. Optimization subagent runs, updates and saves store to disk
2. Plugin hook fires again -- cache still holds old store
3. `matchEmpathyKeywords` runs on old store, calls `saveKeywordStore` again
4. Overwrites the optimized store with stale data (data loss)

**How to avoid:**
- Invalidate cache after `saveKeywordStore` is called
- Or: always reload from disk before matching, only cache for the duration of a single hook call
- Or: use a version/timestamp check -- if disk store is newer than cache, reload

**Warning signs:**
- Optimization updates appear to have no effect
- Keyword weights revert to previous values after optimization
- Logs show "Keyword store saved after match" but stored values never change

**Phase to address:**
Phase 1 (Foundation) -- cache invalidation is a simple fix but critical for learning to work.

---

## Moderate Pitfalls

### Pitfall 8: Concurrent Writes from Multiple Plugin Instances

**What goes wrong:**
If multiple OpenClaw instances share the same `stateDir` (same workspace), concurrent prompt hook executions could call `saveKeywordStore` simultaneously. The second write could corrupt or partially overwrite the first.

**Why it happens:**
`fs.writeFileSync` is not process-safe. File locking is not used. The JSON file has no write serialization.

**How to avoid:**
- Use a file lock (e.g., `proper-lockfile` or `flock` via child_process)
- Or: serialize writes through a single writer actor
- Or: use an in-memory store with periodic batched writes, accepting some data loss on crash

**Phase to address:**
Phase 1 (Foundation) if multi-instance deployment is possible.

---

### Pitfall 9: Mutable Store Object Creates Aliasing Hazards

**What goes wrong:**
`loadKeywordStore` returns the parsed JSON object directly. Mutations to that object (e.g., `entry.hitCount++` in `matchEmpathyKeywords`) mutate the in-memory representation. If the same object is cached and also written back after mutation, this works by accident. But the interaction between cache invalidation and the shared mutable store object is subtle and error-prone.

**Why it happens:**
No copy-on-read discipline. The store object is both the working copy and the persistence representation. If cache invalidation causes a reload from disk while mutations are pending, state can be lost or duplicated.

**How to avoid:**
- Treat the store as immutable from the caller's perspective; always copy on load
- Or: document the mutable semantics clearly and add a version field to detect staleness
- Use a copy-on-read pattern: `JSON.parse(JSON.stringify(store))` before mutating

**Phase to address:**
Phase 1 (Foundation) -- removes subtle aliasing bugs.

---

## Minor Pitfalls

### Pitfall 10: `detectCorrectionCue` vs `matchEmpathyKeywords` Redundancy

**What goes wrong:**
`prompt.ts` has `detectCorrectionCue` (lines 87-111) which hardcodes 15 correction cues. Then `matchEmpathyKeywords` also matches keywords from the store (which includes the same 15 terms as seed keywords). This creates double-processing: the hardcoded list runs separately from the learnable store.

**Why it happens:**
Historical: `detectCorrectionCue` was the original hardcoded approach. The empathy keyword system was added later. The two systems run independently without deduplication.

**How to avoid:**
- Remove `detectCorrectionCue` and route all correction detection through `matchEmpathyKeywords`
- Ensure seed keywords fully cover what `detectCorrectionCue` matched
- Or: keep both but add a dedup pass so hardcoded matches do not double-count toward severity

**Phase to address:**
Phase 1 (Foundation) -- removes redundant code and ensures single source of truth.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Skip FPR verification | Faster to ship | FPR values are fictional, learning degrades | Never in production |
| No cache invalidation | Simpler code | Optimization updates lost, learning broken | Only in spike/prototype |
| Write directly to JSON file | No extra code | Corruption on crash = data loss | Never in production |
| No store size limit | Unrestricted learning | Performance death spiral | Never |
| Async fire-and-forget optimizer | No latency impact | Unbounded LLM cost | Only with explicit cost budget |
| Module-level mutable cache | Avoids passing state | Stale reads, aliasing bugs | Never |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| OpenClaw prompt hook | Blocking the hook with synchronous subagent call | Always spawn optimization subagent async, never await in hook |
| Keyword store file | Assuming file is always valid JSON | Validate on load, fall back to seed, back up before write |
| EmpathyObserverWorkflowManager | Creating new manager without cleanup | Reuse single manager instance per session, not per call |
| Session trajectory | Not recording keyword match outcomes | Add `empathyKeywordMatch` event to trajectory for future analysis |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Linear keyword scan | >5ms per match with 200+ terms | Trie or Bloom filter; cap store at 200 terms | At ~200 terms, every user message pays O(n) cost |
| Unbounded optimization calls | LLM cost spike, agent slowdown | Time-based throttle, max 4 optimizations/day | With active users sending >100 messages/hour |
| Growing store file | Disk I/O slows, memory rises | Hard cap at 200 terms, aggressive pruning | After 6 months of use, store could have 1000+ terms |

---

## "Looks Done But Isn't" Checklist

- [ ] **FPR Tracking:** `stats.totalFalsePositives` is incremented somewhere -- verify it is not always 0
- [ ] **FPR Calculation:** FPR is computed from labeled data, not just LLM guess -- verify with a test case
- [ ] **Cache Invalidation:** After `saveKeywordStore`, `_empathyKeywordCache` is cleared or updated -- verify with integration test
- [ ] **Atomic Write:** Save uses temp-file-then-rename -- verify by killing process mid-save
- [ ] **Store Size Limit:** There is a hard cap on `Object.keys(store.terms).length` -- verify it is enforced
- [ ] **Optimization Throttle:** Maximum N optimization calls per hour is enforced -- verify with load test
- [ ] **Concurrent Write Safety:** Multiple simultaneous hook calls do not corrupt the store file -- verify with concurrency test
- [ ] **Double Detection:** `detectCorrectionCue` and `matchEmpathyKeywords` are not both running independently -- verify coverage

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| FPR drift | MEDIUM | Reset all FPR values to defaults, add verification pipeline, re-learn from scratch |
| Store corruption | LOW | Load from `.bak`, or regenerate from seed if backup also corrupt |
| Cache stale reads | LOW | Clear cache, restart plugin, verify optimization writes persist |
| Unbounded growth | MEDIUM | Prune all `llm_discovered` terms with < 10 hits, enforce size cap going forward |
| Optimization cost spike | MEDIUM | Add daily budget flag, disable auto-optimization, manually review store |
| Concurrent write corruption | HIGH | Implement file locking, validate JSON on load, add write verification |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| FPR calculation assumes labels | Phase 1: FPR verification infrastructure | Add test: verify FPR changes after confirmed FP matches |
| Learning loop reinforces FP | Phase 2: Feedback collection | Add test: simulate 10 FP matches, verify weight decreases |
| Per-message latency | Phase 1: Performance baseline | Benchmark matching with 50/100/200 terms |
| State file corruption | Phase 1: Atomic writes + backup | Kill process mid-save, verify recoverable |
| Unbounded store growth | Phase 1: Size limits + pruning | Add test: attempt to add 500 terms, verify capped |
| LLM optimization abuse | Phase 1: Throttle + budget | Log all optimization calls, verify < N per hour |
| Stale cache reads | Phase 1: Cache invalidation | Integration test: update store on disk, verify cache reflects change |
| Concurrent writes | Phase 1: File locking | Concurrent hook calls, verify no corruption |
| Double detection | Phase 1: Remove detectCorrectionCue | Verify seed keywords cover all 15 hardcoded terms |
| No FPR verification pipeline | Phase 1: Add verification step | Verify confirmed FP reduces keyword weight |

---

## Sources

- Code analysis of `packages/openclaw-plugin/src/hooks/prompt.ts` (lines 1-1087)
- Code analysis of `packages/openclaw-plugin/src/core/empathy-keyword-matcher.ts` (lines 1-336)
- Code analysis of `packages/openclaw-plugin/src/core/empathy-types.ts` (lines 1-230)

---

*Pitfalls research for: KeywordLearningEngine*
*Researched: 2026-04-14*
