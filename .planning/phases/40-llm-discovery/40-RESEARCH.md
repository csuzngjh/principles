# Phase 40: Failure Classification & Cooldown Recovery - Research

**Researched:** 2026-04-14
**Domain:** Nocturnal pipeline failure classification and tiered cooldown escalation
**Confidence:** HIGH

## Summary

Phase 40 introduces two independent modules -- `failure-classifier.ts` and `cooldown-strategy.ts` -- that classify nocturnal pipeline task failures as transient or persistent and enforce tiered cooldown escalation. The failure classifier monitors consecutive task failures per task kind (`sleep_reflection`, `keyword_optimization`, `deep_reflect`), resetting counters on success. When a task kind accumulates 3 consecutive failures, the cooldown strategy applies escalating cooldowns (30min -> 4h -> 24h) persisted to the existing `nocturnal-runtime.json` state file.

The primary integration point is `evolution-worker.ts`, where task outcomes (completed/failed) are already determined and persisted to the evolution queue. The new modules hook into this outcome determination without modifying the existing `retry.ts` infrastructure or `isRetryableError()` logic. Cooldown state is stored in the same `NocturnalRuntimeState` structure used by `checkCooldown()` and `recordCooldown()`.

**Primary recommendation:** Create `failure-classifier.ts` as a pure stateless classifier that reads the evolution queue to count consecutive failures, and `cooldown-strategy.ts` as a stateful module that persists tier counters and cooldown deadlines to `nocturnal-runtime.json`. Both modules are called from the existing task outcome handling in `evolution-worker.ts` -- the classifier after each task outcome, and the cooldown strategy when persistent failure is detected.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Failure Classification Scope**
- **D-01:** Scope limited to nocturnal pipeline tasks: `sleep_reflection`, `keyword_optimization`, `deep_reflect`
- **D-02:** Existing `retry.ts` + `isRetryableError()` handles transient fault retry -- Phase 40 does NOT modify retry logic
- **D-03:** Classification applies at the task level in evolution-worker.ts, not at individual LLM call or file operation level

**Transient vs Persistent Determination**
- **D-04:** "Persistent failure" = 3 consecutive failures of the same task kind (e.g., 3 consecutive sleep_reflection failures)
- **D-05:** Counter resets to 0 on any successful task completion (simple, predictable)
- **D-06:** Counter tracked per task kind -- sleep_reflection, keyword_optimization, deep_reflect each have independent counters
- **D-07:** `isRetryableError()` classification informs the initial retry (existing behavior); consecutive failure counter tracks across retries

**Cooldown Escalation Architecture**
- **D-08:** New independent modules: `failure-classifier.ts` (classification logic) and `cooldown-strategy.ts` (escalation logic) -- do NOT extend existing modules
- **D-09:** Three-tier stepped escalation: 30min -> 4h -> 24h
  - Tier 1 (1st persistent detection): 30min cooldown
  - Tier 2 (2nd persistent detection): 4h cooldown
  - Tier 3 (3rd+ persistent detection): 24h cooldown (cap)
- **D-10:** Cooldown state persisted to nocturnal-runtime.json -- survives process restarts
- **D-11:** Phase 41 (Startup Reconciliation) responsible for clearing stale/expired cooldowns on startup

**Integration Points**
- **D-12:** `failure-classifier.ts` reads task outcomes from evolution-worker.ts task state machine
- **D-13:** `cooldown-strategy.ts` integrates with existing `checkCooldown()` in nocturnal-runtime.ts for enforcement
- **D-14:** Cooldown tiers stored in config (nocturnal-config.ts or new config section) for tuning without code changes

### Claude's Discretion
- Exact file structure and module boundaries within the new modules
- How to integrate failure counters with the existing task state machine in evolution-worker.ts
- Whether cooldown-strategy.ts extends or wraps existing checkCooldown()
- Logging and diagnostic output format

### Deferred Ideas (OUT OF SCOPE)
- LLM call failure classification beyond retry.ts scope -- belongs in a future LLM resilience phase
- File operation failure classification -- atomic writes (Phase 38-39) already handle most cases
- Adaptive cooldown based on failure rate trends -- may be added after Phase 41 startup reconciliation proves the foundation works
- Global failure dashboard/monitoring -- out of scope, production observability concern
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SC-1 | failure-classifier.ts classifies task failures as transient or persistent based on 3 consecutive failure threshold | Classifier reads evolution queue, counts consecutive failures per taskKind; 3 = persistent, <3 = transient [VERIFIED: codebase] |
| SC-2 | cooldown-strategy.ts implements three-tier stepped escalation: 30min -> 4h -> 24h | Tier map stored in config, escalation counter per taskKind persisted to nocturnal-runtime.json [VERIFIED: nocturnal-runtime.ts state pattern] |
| SC-3 | Consecutive failure counters tracked per task kind independently | Per-taskKind counter map in failure-classifier, using taskKind field from EvolutionQueueItem [VERIFIED: trajectory-types.ts TaskKind] |
| SC-4 | Counter resets to 0 on any successful task completion | Classifier exposes recordSuccess() that resets the counter for that taskKind [VERIFIED: CONTEXT.md D-05] |
| SC-5 | Cooldown state persisted to nocturnal-runtime.json surviving process restarts | Use same readState/writeState pattern with withLockAsync from nocturnal-runtime.ts [VERIFIED: nocturnal-runtime.ts:243-252] |
| SC-6 | Integration with existing checkCooldown() in nocturnal-runtime.ts for enforcement | cooldown-strategy writes to taskKind-specific cooldown fields; checkCooldown() checks them [VERIFIED: nocturnal-runtime.ts checkCooldown] |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | 4.1.4 | Test framework | Project standard (vitest.config.ts) [VERIFIED: package.json] |
| TypeScript | (project) | Language | Project standard |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| file-lock (utils) | internal | Atomic state file writes | Persisting cooldown state to nocturnal-runtime.json |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| New state file for cooldown | Extend nocturnal-runtime.json | Context.md D-10 specifies nocturnal-runtime.json -- using a separate file would violate locked decision |
| In-memory failure counters | Persist to file | In-memory counters would not survive process restarts -- violates SC-5 |

**Installation:** No new npm packages required. Phase 40 uses existing project infrastructure only.

## Architecture Patterns

### Recommended Project Structure
```
packages/openclaw-plugin/src/
  service/
    failure-classifier.ts          (NEW - classify task failures)
    cooldown-strategy.ts           (NEW - tiered cooldown escalation)
    evolution-worker.ts            (MODIFY - call classifier after task outcomes)
    nocturnal-runtime.ts           (MODIFY - add per-taskKind cooldown fields to state)
    nocturnal-config.ts            (MODIFY - add cooldown tier config)
```

### Pattern 1: Per-TaskKind Cooldown in NocturnalRuntimeState
**What:** Extend `NocturnalRuntimeState` with a per-taskKind cooldown map, similar to existing `principleCooldowns`
**When to use:** Storing cooldown deadlines for specific task types
**Example:**
```typescript
// Source: nocturnal-runtime.ts:114-143 (existing pattern)
export interface NocturnalRuntimeState {
    // ... existing fields ...

    /**
     * Per-task-kind failure tracking for cooldown escalation.
     * Key: taskKind (sleep_reflection, keyword_optimization, deep_reflect)
     * Value: { consecutiveFailures, escalationTier, cooldownUntil }
     */
    taskFailureState?: Record<string, TaskFailureState>;
}

export interface TaskFailureState {
    /** Number of consecutive failures */
    consecutiveFailures: number;
    /** Current escalation tier (0=none, 1=30min, 2=4h, 3+=24h) */
    escalationTier: number;
    /** Cooldown deadline (ISO string) */
    cooldownUntil?: string;
}
```

### Pattern 2: Stateless Classifier, Stateful Strategy
**What:** `failure-classifier.ts` is a pure function module that takes a task queue and returns classification; `cooldown-strategy.ts` owns persistence
**When to use:** Separating read-only analysis from state mutation
**Example:**
```typescript
// failure-classifier.ts -- pure classification, no file I/O
export function classifyFailure(
    queue: EvolutionQueueItem[],
    taskKind: TaskKind,
    consecutiveThreshold: number = 3
): 'transient' | 'persistent' {
    const recentTasks = queue
        .filter(t => t.taskKind === taskKind)
        .filter(t => t.status === 'completed' || t.status === 'failed')
        .sort((a, b) => ...); // by completed_at descending

    let consecutive = 0;
    for (const task of recentTasks) {
        if (task.status === 'failed') consecutive++;
        else break; // success breaks the chain
    }

    return consecutive >= consecutiveThreshold ? 'persistent' : 'transient';
}
```

### Pattern 3: Cooldown Enforcement via checkCooldown Extension
**What:** Add task-kind cooldown check to existing `checkCooldown()` or call it alongside
**When to use:** When cooldown-strategy writes deadlines to nocturnal-runtime.json and checkCooldown reads them
**Example:**
```typescript
// cooldown-strategy.ts -- persists tier escalation to nocturnal-runtime.json
export async function applyCooldownEscalation(
    stateDir: string,
    taskKind: string,
    config: CooldownTierConfig
): Promise<void> {
    const state = await readState(stateDir);
    const failureState = state.taskFailureState?.[taskKind] ?? {
        consecutiveFailures: 0, escalationTier: 0
    };

    failureState.escalationTier = Math.min(failureState.escalationTier + 1, 3);
    const durationMs = config.tiers[failureState.escalationTier];
    failureState.cooldownUntil = new Date(Date.now() + durationMs).toISOString();

    if (!state.taskFailureState) state.taskFailureState = {};
    state.taskFailureState[taskKind] = failureState;
    await writeState(stateDir, state);
}
```

### Pattern 4: Integration in evolution-worker.ts Task Outcome Handling
**What:** After a task is marked completed or failed, call the classifier and potentially the cooldown strategy
**When to use:** At every point where `task.status = 'completed'` or `task.status = 'failed'` is set
**Example:**
```typescript
// evolution-worker.ts -- after existing task outcome handling (around line 1865, 2048, etc.)
// After: sleepTask.status = 'failed';
// Call: failure-classifier to check if this creates a persistent failure pattern
const classification = classifyFailure(freshQueue, 'sleep_reflection');
if (classification === 'persistent') {
    await applyCooldownEscalation(wctx.stateDir, 'sleep_reflection', tierConfig);
}

// After: sleepTask.status = 'completed';
// Call: reset failure counter for this taskKind
await resetFailureState(wctx.stateDir, 'sleep_reflection');
```

### Anti-Patterns to Avoid
- **Modifying retry.ts:** D-02 explicitly forbids this. The classifier works at a different level (across multiple task invocations, not within a single retry chain).
- **Sharing counters between task kinds:** D-06 requires independent counters per task kind. Phase 39 CR-01 already flagged shared heartbeatCounter as a bug.
- **Using in-memory counters without persistence:** Process restarts would lose state. All counters must be in nocturnal-runtime.json.
- **Coupling failure-classifier directly to nocturnal-runtime.json:** The classifier should be testable without file I/O. Only cooldown-strategy touches the state file.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| File-based state persistence | Custom JSON read/write with locking | `readState()` / `writeState()` from nocturnal-runtime.ts (export or extract) | Already handles locking via `withLockAsync`, corruption recovery, directory creation |
| Per-principle cooldown tracking | New cooldown infrastructure | `principleCooldowns` pattern in `NocturnalRuntimeState` | Proven pattern; task-kind cooldowns follow the same structure |
| Tiered duration lookup | Hardcoded if/else chain | Config-driven tier map in nocturnal-config.ts | D-14 requires tunable tiers without code changes |
| Checking if cooldown is active | Custom timestamp comparison | Existing `checkCooldown()` logic in nocturnal-runtime.ts | Already handles ISO string parsing, comparison, and cleanup |

**Key insight:** The nocturnal-runtime.ts module already provides a robust pattern for persisting cooldown state with file locking. Phase 40 extends this pattern rather than building a parallel persistence layer.

## Runtime State Inventory

> Phase 40 does not rename or migrate any existing named strings. It adds new fields to an existing state file structure.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | nocturnal-runtime.json: Adding `taskFailureState` field to `NocturnalRuntimeState` | Code edit -- new optional field, backward compatible |
| Live service config | nocturnal-config.json: Adding cooldown tier config section | Code edit -- new optional config, backward compatible |
| OS-registered state | None | None -- verified by grep for registered services |
| Secrets/env vars | None | None -- no secret keys reference failure state |
| Build artifacts | None | None -- new TypeScript files compile normally |

## Common Pitfalls

### Pitfall 1: deep_reflect Is a Tool, Not a Task Kind
**What goes wrong:** CONTEXT.md lists `deep_reflect` as one of three task kinds, but `TaskKind` in trajectory-types.ts does not include `deep_reflect` -- it is `'pain_diagnosis' | 'sleep_reflection' | 'model_eval' | 'keyword_optimization'` [VERIFIED: trajectory-types.ts:120]. The `deep_reflect` entity is a tool invocation (tools/deep-reflect.ts), not a queue-based task.
**Why it happens:** The term "deep_reflect" exists as both a tool name and a workflow type, but it is NOT enqueued as a task kind in evolution-worker.ts.
**How to avoid:** The failure classifier should cover task kinds that actually go through the evolution queue: `sleep_reflection` and `keyword_optimization`. If `deep_reflect` needs failure tracking, it requires a separate mechanism (Phase 41 or future phase). Clarify with user whether `deep_reflect` should be added to TaskKind or excluded from Phase 40 scope.
**Warning signs:** Grep for `taskKind === 'deep_reflect'` in evolution-worker.ts returns zero results.

### Pitfall 2: Stub Fallback Counted as Failure
**What goes wrong:** evolution-worker.ts marks tasks as `status = 'completed'` with `resolution = 'stub_fallback'` when subagent is unavailable (lines 1849-1856, 1883-1888). These are NOT real failures -- they represent graceful degradation.
**Why it happens:** The classifier must distinguish between `status = 'failed'` (actual failure) and `status = 'completed'` with `resolution = 'stub_fallback'` (graceful skip).
**How to avoid:** The classifier should ONLY count `status === 'failed'` as a failure. `status === 'completed'` (even with `stub_fallback` or `skipped_thin_violation` resolutions) should reset the counter per D-05.
**Warning signs:** Cooldown escalation triggers after 3 consecutive "expected unavailability" events that are actually stub fallbacks.

### Pitfall 3: Race Condition on State File Writes
**What goes wrong:** Both `evolution-worker.ts` and `cooldown-strategy.ts` write to nocturnal-runtime.json. If the classifier triggers a cooldown write while another heartbeat is reading the state, data could be lost.
**Why it happens:** The heartbeat cycle runs every 15 minutes, and task outcome processing can overlap with cooldown checks.
**How to avoid:** Use `withLockAsync` (from `utils/file-lock.ts`) for all writes, and re-read state immediately before writing (the existing `readState` + modify + `writeState` pattern).
**Warning signs:** Lost cooldown state after concurrent heartbeat cycles.

### Pitfall 4: Escalation Tier Never Resets
**What goes wrong:** If a task succeeds once and then fails 3 more times, the escalation tier keeps climbing from where it left off instead of resetting.
**Why it happens:** D-05 says "counter resets to 0 on any successful task completion" but this needs to reset BOTH the consecutive failure counter AND the escalation tier.
**How to avoid:** On success, reset both `consecutiveFailures` to 0 AND `escalationTier` to 0. The tier escalation should only increase, never decrease, within a consecutive failure streak.
**Warning signs:** After one success followed by 3 failures, the cooldown is 4h (tier 2) instead of 30min (tier 1).

### Pitfall 5: Stale Cooldowns Not Cleared on Startup
**What goes wrong:** A cooldown was set for 30min, the process crashed, and on restart 5 hours later the task is still blocked because the expired cooldown was never cleaned.
**Why it happens:** Phase 41 is supposed to handle startup reconciliation, but Phase 40 must still write correct `cooldownUntil` timestamps so Phase 41 can detect and clear them.
**How to avoid:** Always write absolute ISO timestamps for `cooldownUntil`. Phase 41 will clear expired ones. The existing `checkCooldown()` already handles expired cooldowns correctly (line 388-396: checks if `cooldownEnd > now`).
**Warning signs:** Tasks permanently blocked after process restart.

## Code Examples

### Failure Classifier Interface
```typescript
// New file: packages/openclaw-plugin/src/service/failure-classifier.ts

/** Task kinds subject to failure classification */
export type ClassifiableTaskKind = 'sleep_reflection' | 'keyword_optimization';

export interface FailureClassificationResult {
    /** Whether this is a transient or persistent failure pattern */
    classification: 'transient' | 'persistent';
    /** Number of consecutive failures for this task kind */
    consecutiveFailures: number;
    /** The task kind that was analyzed */
    taskKind: ClassifiableTaskKind;
}

/**
 * Classify the failure pattern for a given task kind based on recent task outcomes.
 * Reads the evolution queue to count consecutive failures.
 *
 * @param queue - Current evolution queue
 * @param taskKind - Task kind to classify
 * @param threshold - Consecutive failure threshold for "persistent" (default: 3)
 */
export function classifyFailure(
    queue: EvolutionQueueItem[],
    taskKind: ClassifiableTaskKind,
    threshold: number = 3
): FailureClassificationResult {
    // Filter to completed/failed tasks of this kind, sorted by completion time
    const relevantTasks = queue
        .filter(t => t.taskKind === taskKind)
        .filter(t => t.status === 'completed' || t.status === 'failed')
        .sort((a, b) => {
            const aTime = new Date(a.completed_at || a.timestamp).getTime();
            const bTime = new Date(b.completed_at || b.timestamp).getTime();
            return bTime - aTime; // newest first
        });

    let consecutive = 0;
    for (const task of relevantTasks) {
        if (task.status === 'failed') {
            consecutive++;
        } else {
            break; // success breaks the chain
        }
    }

    return {
        classification: consecutive >= threshold ? 'persistent' : 'transient',
        consecutiveFailures: consecutive,
        taskKind,
    };
}
```

### Cooldown Strategy Interface
```typescript
// New file: packages/openclaw-plugin/src/service/cooldown-strategy.ts

import { withLockAsync } from '../utils/file-lock.js';
import * as fs from 'fs';
import * as path from 'path';

/** Cooldown tier configuration (loaded from nocturnal-config) */
export interface CooldownTierConfig {
    tiers: {
        1: number;  // Tier 1: 30 minutes
        2: number;  // Tier 2: 4 hours
        3: number;  // Tier 3: 24 hours (cap)
    };
}

export const DEFAULT_COOLDOWN_TIERS: CooldownTierConfig = {
    tiers: {
        1: 30 * 60 * 1000,   // 30 minutes
        2: 4 * 60 * 60 * 1000, // 4 hours
        3: 24 * 60 * 60 * 1000, // 24 hours
    },
};

/** State for a single task kind's failure tracking */
export interface TaskFailureState {
    consecutiveFailures: number;
    escalationTier: number;
    cooldownUntil?: string;  // ISO string
}

/**
 * Record a task failure and potentially escalate cooldown.
 * Called when a task fails AND the classifier identifies persistent failure.
 */
export async function recordPersistentFailure(
    stateDir: string,
    taskKind: string,
    config: CooldownTierConfig = DEFAULT_COOLDOWN_TIERS
): Promise<void> {
    // Read-modify-write with locking (follows nocturnal-runtime.ts pattern)
    const filePath = path.join(stateDir, 'nocturnal-runtime.json');
    await withLockAsync(filePath, async () => {
        let state: any = {};
        if (fs.existsSync(filePath)) {
            try { state = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { /* corrupted */ }
        }

        const failureState: TaskFailureState = state.taskFailureState?.[taskKind] ?? {
            consecutiveFailures: 0, escalationTier: 0,
        };

        failureState.consecutiveFailures++;
        failureState.escalationTier = Math.min(failureState.escalationTier + 1, 3);

        const tierKey = Math.min(failureState.escalationTier, 3) as 1 | 2 | 3;
        const durationMs = config.tiers[tierKey];
        failureState.cooldownUntil = new Date(Date.now() + durationMs).toISOString();

        if (!state.taskFailureState) state.taskFailureState = {};
        state.taskFailureState[taskKind] = failureState;

        fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
    });
}

/**
 * Reset failure state for a task kind on success.
 */
export async function resetFailureState(
    stateDir: string,
    taskKind: string
): Promise<void> {
    const filePath = path.join(stateDir, 'nocturnal-runtime.json');
    await withLockAsync(filePath, async () => {
        let state: any = {};
        if (fs.existsSync(filePath)) {
            try { state = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { /* corrupted */ }
        }

        if (state.taskFailureState?.[taskKind]) {
            state.taskFailureState[taskKind] = {
                consecutiveFailures: 0,
                escalationTier: 0,
            };
            fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
        }
    });
}

/**
 * Check if a task kind is currently in cooldown.
 * Returns the remaining ms, or 0 if not in cooldown.
 */
export function isTaskKindInCooldown(
    stateDir: string,
    taskKind: string
): { inCooldown: boolean; remainingMs: number; cooldownUntil: string | null } {
    const filePath = path.join(stateDir, 'nocturnal-runtime.json');
    if (!fs.existsSync(filePath)) return { inCooldown: false, remainingMs: 0, cooldownUntil: null };

    try {
        const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const failureState: TaskFailureState | undefined = state.taskFailureState?.[taskKind];
        if (!failureState?.cooldownUntil) return { inCooldown: false, remainingMs: 0, cooldownUntil: null };

        const cooldownEnd = new Date(failureState.cooldownUntil).getTime();
        const remaining = cooldownEnd - Date.now();
        if (remaining <= 0) return { inCooldown: false, remainingMs: 0, cooldownUntil: null };

        return { inCooldown: true, remainingMs: remaining, cooldownUntil: failureState.cooldownUntil };
    } catch {
        return { inCooldown: false, remainingMs: 0, cooldownUntil: null };
    }
}
```

### Config Extension in nocturnal-config.ts
```typescript
// Addition to nocturnal-config.ts
export interface CooldownEscalationConfig {
    /** Cooldown duration for Tier 1 escalation (ms) */
    tier1_ms: number;
    /** Cooldown duration for Tier 2 escalation (ms) */
    tier2_ms: number;
    /** Cooldown duration for Tier 3+ escalation (ms) */
    tier3_ms: number;
    /** Consecutive failure threshold to trigger persistent detection */
    consecutive_threshold: number;
}

const DEFAULT_COOLDOWN_ESCALATION: CooldownEscalationConfig = {
    tier1_ms: 30 * 60 * 1000,     // 30 minutes
    tier2_ms: 4 * 60 * 60 * 1000, // 4 hours
    tier3_ms: 24 * 60 * 60 * 1000, // 24 hours
    consecutive_threshold: 3,
};

// Add to NocturnalConfig interface:
// cooldown_escalation?: Partial<CooldownEscalationConfig>;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No failure classification | retry.ts handles only transient retry | Phase 38-39 | Persistent failures (bad config, broken pipeline) cause infinite retry loops |
| Fixed cooldown (1h global) | Per-task-kind tiered escalation | Phase 40 | Tasks that repeatedly fail get longer cooldowns, reducing wasted LLM calls |

**Deprecated/outdated:**
- None in this phase. This is a greenfield addition.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `deep_reflect` is NOT a task kind tracked in evolution queue, only `sleep_reflection` and `keyword_optimization` are | Pitfall 1 | CONTEXT.md D-01 lists `deep_reflect` but codebase has no task kind for it; classifier may need adjustment or TaskKind extension |
| A2 | `readState()` and `writeState()` in nocturnal-runtime.ts can be called from cooldown-strategy.ts (they are module-private) | Architecture Patterns | If they are not exported, cooldown-strategy.ts must re-implement or they must be exported |
| A3 | `stub_fallback` and `skipped_thin_violation` resolutions should count as success for counter reset purposes | Pitfall 2 | If these should be treated differently, the classifier logic changes |
| A4 | The evolution queue preserves enough history for the classifier to count 3 consecutive failures | Architecture | If completed/failed tasks are pruned from the queue too aggressively, the classifier will not see enough history |
| A5 | `withLockAsync` from `utils/file-lock.ts` can be used directly for nocturnal-runtime.json writes | Code Examples | The lock utility is already used by nocturnal-runtime.ts writeState(); cooldown-strategy should use the same pattern |

## Open Questions

1. **Should `deep_reflect` be included in failure classification?**
   - What we know: CONTEXT.md D-01 lists it as one of three task kinds. But `deep_reflect` is a tool invocation (tools/deep-reflect.ts), NOT an evolution queue task kind. `TaskKind = 'pain_diagnosis' | 'sleep_reflection' | 'model_eval' | 'keyword_optimization'` -- `deep_reflect` is absent.
   - What's unclear: Whether the user intends to add `deep_reflect` as a new TaskKind, or whether it was listed by mistake.
   - Recommendation: Implement for `sleep_reflection` and `keyword_optimization` only (the two queue-based nocturnal task kinds). Flag `deep_reflect` for user confirmation. If needed, adding it later is a small change.

2. **Should `readState()` / `writeState()` from nocturnal-runtime.ts be exported for reuse?**
   - What we know: These functions are currently module-private in nocturnal-runtime.ts. The cooldown-strategy needs the same read-modify-write pattern.
   - What's unclear: Whether exporting them is acceptable or if cooldown-strategy should have its own read/write logic.
   - Recommendation: Export `readState()` and `writeState()` from nocturnal-runtime.ts. This avoids duplicating file I/O logic and ensures consistent locking.

3. **How much queue history is preserved for consecutive failure counting?**
   - What we know: The evolution queue is a JSON array stored in a file. Failed/completed tasks appear to remain in the queue.
   - What's unclear: Whether there is a cleanup mechanism that removes old completed/failed tasks.
   - Recommendation: The classifier should scan the queue as-is. If tasks are cleaned up, the classifier will simply see fewer consecutive failures (safer to under-escalate than over-escalate).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | TypeScript runtime | Yes | v24.14.0 | - |
| vitest | Testing | Yes | 4.1.4 | - |
| TypeScript | Compilation | Yes | (project) | - |
| nocturnal-runtime.ts | State persistence | Yes | existing | - |
| file-lock.ts | Atomic writes | Yes | existing | - |
| evolution-worker.ts | Task outcomes | Yes | existing | - |

**Missing dependencies with no fallback:** None identified.

**Missing dependencies with fallback:** None identified.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.4 |
| Config file | packages/openclaw-plugin/vitest.config.ts |
| Quick run command | `npx vitest run tests/service/failure-classifier.test.ts tests/service/cooldown-strategy.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SC-1 | classifyFailure returns 'transient' for <3 consecutive failures | Unit | `npx vitest run tests/service/failure-classifier.test.ts` | Wave 0 |
| SC-1 | classifyFailure returns 'persistent' for >=3 consecutive failures | Unit | `npx vitest run tests/service/failure-classifier.test.ts` | Wave 0 |
| SC-2 | Tier 1 escalation = 30min cooldown | Unit | `npx vitest run tests/service/cooldown-strategy.test.ts` | Wave 0 |
| SC-2 | Tier 2 escalation = 4h cooldown | Unit | `npx vitest run tests/service/cooldown-strategy.test.ts` | Wave 0 |
| SC-2 | Tier 3+ escalation capped at 24h | Unit | `npx vitest run tests/service/cooldown-strategy.test.ts` | Wave 0 |
| SC-3 | Independent counters per taskKind | Unit | `npx vitest run tests/service/failure-classifier.test.ts` | Wave 0 |
| SC-4 | Counter resets on success | Unit | `npx vitest run tests/service/cooldown-strategy.test.ts` | Wave 0 |
| SC-5 | State survives process restart (file persistence) | Unit | `npx vitest run tests/service/cooldown-strategy.test.ts` | Wave 0 |
| SC-6 | Integration with checkCooldown for enforcement | Integration | `npx vitest run tests/service/cooldown-strategy.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/service/failure-classifier.test.ts tests/service/cooldown-strategy.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** TypeScript compilation passes + full suite green

### Wave 0 Gaps
- `packages/openclaw-plugin/tests/service/failure-classifier.test.ts` -- NEW: unit tests for classifyFailure()
- `packages/openclaw-plugin/tests/service/cooldown-strategy.test.ts` -- NEW: unit tests for recordPersistentFailure(), resetFailureState(), isTaskKindInCooldown()
- `packages/openclaw-plugin/src/service/failure-classifier.ts` -- NEW: failure classification module
- `packages/openclaw-plugin/src/service/cooldown-strategy.ts` -- NEW: cooldown escalation module

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V4 Access Control | Yes | Per-workspace stateDir isolation; failure state scoped to workspace |
| V5 Input Validation | Yes | TaskKind validated against known string values; escalation tier clamped to [0,3] |
| V6 Cryptography | No | No cryptographic operations in this phase |

### Known Threat Patterns for Failure Classification

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Cooldown bypass via state file manipulation | Tampering | File locking prevents concurrent writes; state file in workspace-controlled directory |
| Cooldown denial of service (always failing) | Denial | Tiered escalation caps at 24h; Phase 41 clears stale cooldowns on startup |
| State file corruption | Denial | Existing readState() pattern handles corruption with graceful default |

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/service/nocturnal-runtime.ts` -- NocturnalRuntimeState, checkCooldown(), readState/writeState patterns [VERIFIED: codebase]
- `packages/openclaw-plugin/src/service/nocturnal-config.ts` -- Config loading pattern, NocturnalConfig interface [VERIFIED: codebase]
- `packages/openclaw-plugin/src/service/evolution-worker.ts` -- Task outcome handling, sleep_reflection/keyword_optimization processing [VERIFIED: codebase]
- `packages/openclaw-plugin/src/core/trajectory-types.ts` -- TaskKind type definition [VERIFIED: codebase]
- `packages/openclaw-plugin/src/config/errors.ts` -- PdError hierarchy [VERIFIED: codebase]
- `packages/openclaw-plugin/src/utils/retry.ts` -- isRetryableError(), retryAsync() [VERIFIED: codebase]
- `packages/openclaw-plugin/vitest.config.ts` -- Test configuration [VERIFIED: codebase]

### Secondary (MEDIUM confidence)
- CONTEXT.md locked decisions (D-01 through D-14) -- User-confirmed implementation choices
- `.planning/phases/39-learning-loop/39-CONTEXT.md` -- Previous phase context for keyword_optimization patterns

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- No new dependencies; extends existing codebase patterns
- Architecture: HIGH -- Follows established nocturnal-runtime.ts state management and evolution-worker.ts task processing patterns
- Pitfalls: HIGH -- All pitfalls identified from actual codebase inspection (TaskKind audit, stub fallback analysis, locking pattern review)

**Research date:** 2026-04-14
**Valid until:** 2026-05-14 (30 days -- stable domain, no external dependencies)
