---
review_date: 2026-04-15
reviewer: claude-opus-4.6
scope: "Phase 40/41 modules (failure-classifier, cooldown-strategy, startup-reconciler) + integration into evolution-worker.ts"
severity_counts:
  high: 2
  medium: 4
  low: 4
  info: 3
---

# Merge Code Review: Phase 40/41 Failure Classification & Startup Reconciliation

## Summary

Phase 40 introduced a failure classification + cooldown escalation system for
`sleep_reflection` and `keyword_optimization` task kinds. Phase 41 added a
startup reconciler that validates state integrity and cleans expired cooldowns
at pipeline boot. The modules are generally well-structured with good test
coverage at the unit level, but there are two high-severity bugs in the
integration layer, several medium-severity data integrity risks, and a handful
of lower-priority quality issues.

---

## HIGH Severity

### H-1: classifyFailure threshold is hardcoded to 3, ignoring `consecutive_threshold` from config

**Files:**
- `evolution-worker.ts` line 63
- `failure-classifier.ts` line 53

**Description:**
`handleTaskOutcome` calls `classifyFailure(queue, taskKind)` without passing a
threshold. The function defaults to `threshold = 3`. Meanwhile, the config
object is only loaded *after* classification succeeds:

```ts
// evolution-worker.ts line 63-66
const result = classifyFailure(queue, taskKind);        // threshold defaults to 3
if (result.classification === 'persistent') {
    const config = loadCooldownEscalationConfig(wctx.stateDir); // config loaded here
    await recordPersistentFailure(wctx.stateDir, taskKind, config);
}
```

If a user configures `consecutive_threshold: 5` in `nocturnal-config.json`,
the classifier still uses 3, so cooldown escalation fires at 3 failures instead
of 5. The config value `consecutive_threshold` in `CooldownEscalationConfig` is
**completely unused** -- it is loaded and passed to `recordPersistentFailure`,
but `recordPersistentFailure` never reads it either.

**Impact:** Cooldown escalation cannot be tuned via config. Teams wanting a
higher failure tolerance before escalation will get incorrect behavior.

**Fix:** Load the config before classification and pass the threshold:

```ts
const config = loadCooldownEscalationConfig(wctx.stateDir);
const result = classifyFailure(queue, taskKind, config.consecutive_threshold);
if (result.classification === 'persistent') {
    await recordPersistentFailure(wctx.stateDir, taskKind, config);
}
```

---

### H-2: `recordPersistentFailure` increments `consecutiveFailures` independently of the classifier's count, causing double-counting divergence

**Files:**
- `cooldown-strategy.ts` lines 45-46
- `failure-classifier.ts` lines 65-72

**Description:**
`recordPersistentFailure` unconditionally increments `current.consecutiveFailures`
(line 45) every time it is called. But the caller (`handleTaskOutcome`) only
invokes `recordPersistentFailure` when `classifyFailure` returns `'persistent'`
(consecutive >= threshold). The `consecutiveFailures` stored in
`taskFailureState` therefore tracks *escalation event count*, not actual
consecutive failure count.

This creates a semantic mismatch:
- The classifier counts consecutive failures from the queue (ground truth).
- The cooldown strategy counts how many times escalation was triggered.

After 6 consecutive failures: classifier says `consecutiveFailures=6`, but
`taskFailureState.sleep_reflection.consecutiveFailures` will be 4 (escalated
at failure 3, 4, 5, 6). If the state is later inspected for diagnostics or
reset logic, these numbers tell different stories.

More critically: `resetFailureState` resets the stored counter to 0, but the
queue still has historical `failed` items. After reset, the classifier will
re-count from the queue and may immediately re-classify as persistent on the
next call because the queue items still exist. The system can enter a cycle
where: classify-persistent -> escalate -> reset-on-success -> next-cycle
re-classify-persistent-from-stale-queue.

**Impact:** State divergence between queue-based truth and persisted state.
Potential for repeated spurious escalation after resets if old queue items are
not pruned.

**Fix:** Either (a) use the classifier's count as the authoritative source and
write it into state, or (b) have `recordPersistentFailure` accept the actual
consecutive count from the classifier rather than incrementing its own counter.
Option (a) is recommended since the queue is the source of truth:

```ts
// In recordPersistentFailure, accept the count from the caller:
current.consecutiveFailures = classifierCount; // instead of current.consecutiveFailures++
```

---

## MEDIUM Severity

### M-1: `isTaskKindInCooldown` uses `readStateSync` while `recordPersistentFailure` uses `readState` (async) -- race window

**Files:**
- `cooldown-strategy.ts` lines 37, 82
- `evolution-worker.ts` lines 1685, 2020

**Description:**
`isTaskKindInCooldown` reads state synchronously (`readStateSync`), while
`recordPersistentFailure` and `resetFailureState` read state asynchronously
(`readState`). In the evolution worker, the cooldown check happens at line 1685
for sleep_reflection and line 2020 for keyword_optimization. Both are inside
the `processEvolutionQueueWithResult` function which is already async.

If two heartbeat cycles overlap (e.g., the first cycle is still writing results
via `recordPersistentFailure` when the next cycle starts and calls
`isTaskKindInCooldown`), the sync read can observe stale state because
`readStateSync` does not acquire the file lock used by `writeState`.

**Impact:** A task kind may not appear to be in cooldown even though escalation
was just written, allowing one extra cycle of processing before cooldown takes
effect. Low probability in practice due to the 15-minute heartbeat interval, but
a real race condition.

**Fix:** Add an async variant of `isTaskKindInCooldown` that uses `readState`
(with locking) and use it in the evolution worker since it is already in an
async context.

---

### M-2: `startup-reconciler` uses synchronous I/O for state reads/writes mixed with async -- inconsistent locking

**Files:**
- `startup-reconciler.ts` lines 46-61, 78-79

**Description:**
Step 1 of `reconcileStartup` reads the state file with `fs.readFileSync` for
validation, then calls `readStateSync` for the actual state. Step 2 writes with
`writeState` (async, uses file locking). But the initial read in Step 1 is
unlocked -- another process could write the state file between the sync read
and the async write in the catch block (line 56).

Additionally, Step 1's corrupted-state reset (line 55-56) writes a partial
default state `{ principleCooldowns: {}, recentRunTimestamps: [] }` that is
missing the `taskFailureState` field. Step 2 then checks `state.taskFailureState`
which will be undefined on this path, so no expired cooldowns will be cleared
after a corruption reset.

**Impact:** If the state file is corrupted, the reset state will not have
`taskFailureState`, so any stale cooldowns from the pre-corruption state are
lost (acceptable since corruption means data loss anyway). But the partial
default is inconsistent with `createDefaultState()` in nocturnal-runtime.ts,
which also omits `taskFailureState` -- a maintenance hazard if defaults change.

**Fix:** Use `createDefaultState()` from nocturnal-runtime.ts instead of the
inline object literal:

```ts
import { readStateSync, writeState, createDefaultState } from './nocturnal-runtime.js';
// ...
state = createDefaultState();
await writeState(stateDir, state);
```

Note: `createDefaultState` is currently module-private. Either export it or
import `readState` and call it (which returns defaults).

---

### M-3: Cooldown guard skips task processing but does not mark tasks as skipped -- they remain pending indefinitely

**Files:**
- `evolution-worker.ts` lines 1684-1689, 2019-2031

**Description:**
When a task kind is in cooldown, the evolution worker sets
`sleepReflectionTasks = []` (line 1688) or returns early for keyword_optimization
(line 2030). This means pending tasks of that kind sit in the queue untouched.
They are never marked as `skipped` or `canceled` and have no `cooldown_blocked`
resolution.

These pending tasks accumulate across heartbeat cycles until the cooldown
expires, at which point they all get processed at once. If multiple sleep
reflections were queued before cooldown triggered, they could all fire
simultaneously when cooldown lifts.

**Impact:** Pending task accumulation during cooldown; potential task storm when
cooldown expires. No functional data loss, but suboptimal scheduling.

**Fix:** When cooldown is active, mark pending tasks with a `cooldown_blocked`
resolution or filter them to only process the highest-priority one after
cooldown expires.

---

### M-4: `loadCooldownEscalationConfig` is imported twice from `nocturnal-config.js` in evolution-worker.ts

**Files:**
- `evolution-worker.ts` line 20 (first import from nocturnal-config)
- `evolution-worker.ts` line 41 (second, separate import from nocturnal-config)

**Description:**
Line 20 imports `loadNocturnalConfig` and `loadKeywordOptimizationConfig` from
`nocturnal-config.js`. Line 41 separately imports `loadCooldownEscalationConfig`
from the same module. This is a merge artifact -- the Phase 40 code added a new
import line instead of merging into the existing import from the same module.

**Impact:** No functional impact (bundlers deduplicate). Code quality /
maintenance issue that signals the merge was done mechanically.

**Fix:** Merge into the existing import on line 20:

```ts
import { loadNocturnalConfig, loadKeywordOptimizationConfig, loadCooldownEscalationConfig } from './nocturnal-config.js';
```

Remove the import on line 41.

---

## LOW Severity

### L-1: `recordPersistentFailure` escalation tier calculation has a redundant `Math.min`

**File:** `cooldown-strategy.ts` lines 46, 48

```ts
current.escalationTier = Math.min(current.escalationTier + 1, 3); // line 46
const tierKey = Math.min(current.escalationTier, 3) as 1 | 2 | 3;  // line 48
```

Line 46 already caps `escalationTier` at 3. Line 48 applies `Math.min` again,
which is always a no-op after line 46. The second `Math.min` is dead code.

---

### L-2: `cooldown-strategy.ts` imports `readState` aliased as `readStateAsync` -- confusing naming

**File:** `cooldown-strategy.ts` line 15

```ts
import { readState as readStateAsync, readStateSync, writeState } from './nocturnal-runtime.js';
```

The alias `readStateAsync` is misleading because `readState` in
nocturnal-runtime.ts is not truly async (it uses sync `fs.readFileSync` inside).
The "async" label implies it does async I/O, but it returns a Promise only
because it's called in an async context. If `readState` is later refactored to
be truly async, this alias would be fine, but currently it obscures the actual
behavior.

---

### L-3: `startup-reconciler` orphan cleanup uses sync I/O inside an async function

**File:** `startup-reconciler.ts` lines 84-99

`reconcileStartup` is `async` but Step 3 (orphan .tmp cleanup) uses
`fs.readdirSync`, `fs.existsSync`, and `fs.unlinkSync`. This blocks the event
loop during file scanning. For a startup function that runs once, this is
acceptable, but it is inconsistent with the async write in Step 2.

---

### L-4: `failure-classifier` date parsing can produce `NaN` for items without `completed_at` or `timestamp`

**File:** `failure-classifier.ts` lines 60-61

```ts
const aTime = new Date(a.completed_at || a.timestamp).getTime();
```

If both `completed_at` and `timestamp` are undefined, `new Date(undefined)`
produces `Invalid Date`, and `.getTime()` returns `NaN`. The sort comparator
returns `NaN - NaN = NaN`, which causes `sort()` to produce implementation-
defined ordering. While `timestamp` is always set by the queue builder,
defensive coding would handle the edge case.

**Fix:** Add a fallback:

```ts
const aTime = new Date(a.completed_at || a.timestamp || 0).getTime() || 0;
```

---

## INFO

### I-1: Test coverage is unit-level only -- no integration tests for the full cooldown pipeline

The three test files cover each module in isolation with temp directories.
There are no tests that exercise the full pipeline:
queue item -> task failure -> classifyFailure -> recordPersistentFailure ->
isTaskKindInCooldown -> cooldown guard skips task -> cooldown expires ->
task resumes.

This is the highest-risk gap given the H-1 and H-2 bugs above, which only
manifest at the integration level.

---

### I-2: `consecutive_threshold` in `CooldownEscalationConfig` is defined but never consumed

**File:** `nocturnal-config.ts` line 39

The field `consecutive_threshold` is loaded, validated, and has a default (3),
but no module reads it. As described in H-1, `classifyFailure` hardcodes the
default. This dead field suggests the integration was incomplete.

---

### I-3: Startup reconciliation runs on the first `setTimeout` cycle, not at module init

**File:** `evolution-worker.ts` lines 2660-2672

`reconcileStartup` is called inside the initial `setTimeout` callback. If the
worker is initialized and the process crashes before the first timeout fires,
reconciliation never runs. This is acceptable for most cases since
reconciliation is idempotent, but it means the first cycle after a crash may
process tasks with stale cooldown state.

---

## Architectural Observations

1. **Separation of concerns is clean.** `failure-classifier.ts` is pure/stateless,
   `cooldown-strategy.ts` handles stateful escalation, and `startup-reconciler.ts`
   handles boot-time validation. This is well-designed.

2. **Error containment is good.** `handleTaskOutcome` wraps everything in
   try/catch with non-blocking logging. Classification errors cannot cascade
   to block task processing.

3. **The cooldown guard placement is correct.** Checking cooldown *before*
   claiming tasks (line 1684-1689) is the right order -- it prevents claiming
   tasks that will be skipped, which would leave them stuck as `in_progress`.

4. **File locking is used consistently for writes** via `withLockAsync` in
   `writeState`, which prevents write-write corruption. The read-side locking
   gap (M-1) is the remaining concern.

---

## Recommended Fix Priority

| Priority | Issue | Effort |
|----------|-------|--------|
| 1        | H-1: Pass `consecutive_threshold` to `classifyFailure` | S |
| 2        | H-2: Fix double-counting in `recordPersistentFailure` | M |
| 3        | M-2: Use `createDefaultState()` in reconciler | S |
| 4        | M-4: Merge duplicate import | S |
| 5        | M-1: Add async cooldown check | M |
| 6        | M-3: Mark cooldown-blocked tasks | M |
| 7        | L-1 through L-4 | S each |
