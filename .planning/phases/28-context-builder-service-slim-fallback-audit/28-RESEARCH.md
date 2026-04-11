# Phase 28: Context Builder + Service Slim + Fallback Audit - Research

**Researched:** 2026-04-11
**Domain:** Worker decomposition, context lifecycle management, fallback classification
**Confidence:** HIGH — all findings verified by code inspection of source files

## Summary

Phase 28 extracts context building into `TaskContextBuilder` and session lifecycle into `SessionTracker`, reducing `evolution-worker.ts` to pure lifecycle orchestration (start/stop/runCycle). The phase also comprehensively audits all 16 silent fallback points, classifying each as fail-fast (boundary entry, reject invalid state) or fail-visible (pipeline middle, emit structured events for diagnostics).

The key insight is that "context building" is not one function but a set of concerns scattered across runCycle: idle/cooldown state (via `checkWorkspaceIdle`/`checkCooldown`), pain context extraction (`PainFlagDetector.extractRecentPainContext`), and trajectory snapshot building (inside `_dispatchSleepReflection`). These must all move into `TaskContextBuilder` with proper entry validation. `SessionTracker` wraps the existing `session-tracker.ts` module-level functions into a class with lifecycle methods.

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Session lifecycle extracted into a **separate SessionTracker class** (not folded into TaskContextBuilder)
- **D-02:** TaskContextBuilder follows Phase 24/26 class pattern: `new TaskContextBuilder(workspaceDir)`, async entry methods
- **D-03:** Fail-visible skip/drop events reuse `EventLog.recordRuleMatch()` pattern — no new event type needed
- **D-04:** Comprehensive audit — all 16 silent fallback points identified and classified
- **D-05:** Worker reduced to pure lifecycle orchestration only: start/stop/runCycle
- **D-06:** Permissive validation at extracted module entry points (CONTRACT-03 satisfied)

### Claude's Discretion
- Internal method names and private helper organization within TaskContextBuilder and SessionTracker
- Exact placement of session lifecycle calls (which module initializes/flushes)
- How "snapshot building" handles missing/unavailable services (graceful degradation approach)
- Which of the 16 fallback points are fail-fast vs fail-visible (planner determines based on code inspection)

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DECOMP-05 | Context extraction, fallback snapshot building, and session filtering extracted into TaskContextBuilder | Section 4 (TaskContextBuilder scope), Section 6 (Snapshot building) |
| DECOMP-06 | evolution-worker.ts reduced to lifecycle orchestration only (start/stop/runCycle) | Section 3 (Worker Slim pattern) |
| CONTRACT-03 | Every extracted module has input validation at entry points following v1.13 factory/validator pattern | Section 5 (Validation Pattern) |
| CONTRACT-04 | All 16 silent fallback points audited and classified as fail-fast or fail-visible | Section 6 (Fallback Audit — all 16 enumerated) |
| CONTRACT-05 | Fail-visible points emit structured skip/drop events consumable by downstream diagnostics | Section 7 (Fail-visible event structure) |

## Standard Stack

No new libraries needed — this is a pure extraction/refactoring phase. The existing extraction modules set the pattern:

| Pattern | Source | Purpose |
|---------|--------|---------|
| Class-based module | `evolution-queue-store.ts` L239-597 | Constructor takes `workspaceDir`, methods return structured results |
| Permissive validation | `evolution-queue-store.ts` L156-179 | Required fields only, ignore unknowns |
| Structured result types | `pain-flag-detector.ts` L30-37 | `{exists, score, source, enqueued, skipped_reason, error?}` |
| Errors in result, not thrown | `workflow-orchestrator.ts` L65-76 | `errors: string[]` field in result objects |

**Installation:** None — all dependencies already in project.

## Architecture Patterns

### Recommended Project Structure

```
packages/openclaw-plugin/src/service/
├── task-context-builder.ts    # NEW: Phase 28 — context extraction + snapshot building
├── session-tracker.ts         # NEW: Phase 28 — wraps session-tracker.js module functions
├── evolution-worker.ts        # MODIFIED — removes all context/session logic, keeps only lifecycle
```

### Pattern 1: TaskContextBuilder

**What:** Centralized context building for each runCycle execution.

**Responsibilities (extracted from runCycle):**
1. `checkWorkspaceIdle` + `checkCooldown` — idle determination at cycle start
2. `extractRecentPainContext` — delegates to PainFlagDetector (already extracted, Phase 25)
3. Trajectory snapshot building — currently inside `_dispatchSleepReflection`, moves here
4. Pain-context fallback snapshot — same

**Entry points (CONTRACT-03 validation):**
- `buildCycleContext(wctx, logger)` → `CycleContextResult` with idle/cooldown/pain/activeSessions
- `extractRecentPainContext(wctx)` → `RecentPainContext` (delegates to PainFlagDetector)
- `buildFallbackSnapshot(sleepTask)` → `NocturnalSessionSnapshot | null`

**Source:** evolution-worker.ts runCycle (L226-385), evolution-task-dispatcher.ts `_dispatchSleepReflection` (L749-1003)

### Pattern 2: SessionTracker

**What:** Class wrapper around existing module-level functions in `session-tracker.ts`.

**Lifecycle methods:**
- `init(stateDir)` → calls `initPersistence(stateDir)` (called once in `worker.start()`)
- `flush()` → calls `flushAllSessions()` (called in `worker.stop()` and end of each `runCycle`)

**Wrapper methods for tracking (delegates to module functions):**
- `trackToolRead(sessionId, filePath, workspaceDir?)`
- `trackLlmOutput(sessionId, usage, config?, workspaceDir?, sessionKey?, trigger?)`
- `trackFriction(sessionId, deltaF, hash, workspaceDir?, options?)`
- `resetFriction(sessionId, workspaceDir?, options?)`
- `getSession(sessionId)`
- `listSessions(workspaceDir?)`

**Source:** `session-tracker.ts` (module functions, L79-181)

### Pattern 3: Worker Slim

**What:** `evolution-worker.ts` reduced to pure lifecycle orchestration.

**Before (current state):**
```
start() {
  wctx = WorkspaceContext.fromHookContext(...)
  initPersistence(wctx.stateDir)
  setTimeout(runCycle, initialDelay)
}

runCycle() {
  idleResult = checkWorkspaceIdle(...)
  cooldownResult = checkCooldown(...)
  painResult = PainFlagDetector.detect(...)
  store.load() / store.save()
  processEvolutionQueue()
  processDetectionQueue()
  WorkflowOrchestrator.sweepExpired()
  WorkflowOrchestrator.runWatchdog()
  wctx.dictionary.flush()
  flushAllSessions()
}

stop() {
  flushAllSessions()
}
```

**After (target state):**
```
start() {
  wctx = WorkspaceContext.fromHookContext(...)
  sessionTracker.init(wctx.stateDir)
  new PainFlagDetector(wctx.workspaceDir).detect(logger)  // startup cycle
  setTimeout(runCycle, initialDelay)
}

runCycle() {
  cycleCtx = taskContextBuilder.buildCycleContext(wctx, logger)
  painResult = new PainFlagDetector(wctx.workspaceDir).detect(logger)
  store.load() / store.save()
  dispatcher.dispatchQueue(wctx, logger, eventLog, api)
  orchestrator.sweepExpired(wctx, api, logger)
  orchestrator.runWatchdog(wctx, api, logger)
  sessionTracker.flush()
}

stop() {
  sessionTracker.flush()
}
```

**Key invariant:** `wctx` is still built by `WorkspaceContext.fromHookContext` (not extracted — this is correct, it's a framework integration point). Only the *consumption* of `wctx` services is reorganized.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Session lifecycle management | Inline `initPersistence`/`flushAllSessions` calls scattered in worker | SessionTracker class | Lifecycle should be encapsulated; Phase 28 explicitly extracts this |
| Context building for cycle | Inline `checkWorkspaceIdle`/`checkCooldown`/pain context calls in runCycle | TaskContextBuilder.buildCycleContext() | Multiple extraction points need coordinating module |
| Fallback snapshot for sleep reflection | Inline `_buildFallbackNocturnalSnapshot` in dispatcher | TaskContextBuilder.buildFallbackSnapshot() | Consistency with primary snapshot building path |
| Error swallowing | Empty catch blocks that silently continue | Structured skip/drop events via EventLog | CONTRACT-05 requires diagnostics-consumable events |

**Key insight:** The 16 silent fallback points are evidence of business logic that should be centralized, not spread across lifecycle code.

## Runtime State Inventory

> Not applicable — Phase 28 is a pure extraction/refactoring phase. No rename, rebrand, or string replacement. No databases or datastores are queried for runtime state.

**Verification:** Phase 28 extracts code from `evolution-worker.ts` into new modules. The runtime state inventory categories (stored data, live service config, OS-registered state, secrets/env vars, build artifacts) are not applicable because no identifiers are being changed — only code is being relocated.

## Common Pitfalls

### Pitfall 1: Misclassifying fail-fast vs fail-visible

**What goes wrong:** Fail-fast at pipeline middle creates brittleness (one bad session blocks entire queue). Fail-visible at boundary entry creates silent corruption (invalid state propagates silently).

**How to avoid:** Use the rule — "boundary entry" operations (workspace resolution, persistence init, queue write) are fail-fast. "Pipeline middle" operations (detection, snapshot building, dispatch) are fail-visible.

**Warning signs:** A fallback that returns a "safe" default but doesn't log an event — that default is silently corrupting pipeline state.

### Pitfall 2: Moving context building to TaskContextBuilder but not actually calling it in runCycle

**What goes wrong:** Old inline calls remain in runCycle, new module is dead code.

**How to avoid:** For each context operation in runCycle, create a corresponding TaskContextBuilder method AND remove the old call. Verify no `wctx.` service calls remain in runCycle except `wctx.dictionary.flush()` (can be moved to SessionTracker or kept as-is since it's non-critical cleanup).

### Pitfall 3: Breaking backward compatibility for exported worker functions

**What goes wrong:** `evolution-worker.ts` re-exports many types/functions for backward compatibility (L21-28). Extracting modules must maintain these re-exports.

**How to avoid:** Verify re-exports are updated to point to new module locations. Check existing test imports.

### Pitfall 4: Per-cycle SessionTracker instantiation

**What goes wrong:** Creating a new SessionTracker instance per cycle loses the in-memory session state accumulated across cycles.

**How to avoid:** SessionTracker must be instantiated once per worker lifetime (same pattern as PainFlagDetector and EvolutionQueueStore). The worker's `start()` creates the instance, and it persists for the lifetime of the service.

## Code Examples

### TaskContextBuilder Entry Pattern (CONTRACT-03)

Following the Phase 24 permissive validation pattern:

```typescript
// Source: evolution-queue-store.ts L253-261 (pattern), evolution-task-dispatcher.ts L61-68 (pattern)
export interface CycleContextResult {
    idle: IdleCheckResult;
    cooldown: CooldownCheckResult;
    recentPain: RecentPainContext;
    activeSessions: SessionState[];
    errors: string[];
}

export class TaskContextBuilder {
    constructor(private readonly workspaceDir: string) {}

    async buildCycleContext(
        wctx: WorkspaceContext,
        logger?: PluginLogger,
    ): Promise<CycleContextResult> {
        // Permissive validation: wctx must be non-null object
        if (!wctx || typeof wctx !== 'object') {
            return {
                idle: { isIdle: false, mostRecentActivityAt: 0, idleForMs: 0, userActiveSessions: 0, abandonedSessionIds: [], trajectoryGuardrailConfirmsIdle: false, reason: 'invalid_wctx' },
                cooldown: { globalCooldownActive: false, globalCooldownUntil: null, globalCooldownRemainingMs: 0, principleCooldownActive: false, principleCooldownUntil: null, principleCooldownRemainingMs: 0, quotaExhausted: false, runsRemaining: 0 },
                recentPain: { mostRecent: null, recentPainCount: 0, recentMaxPainScore: 0 },
                activeSessions: [],
                errors: ['Invalid workspace context'],
            };
        }

        const errors: string[] = [];

        // checkWorkspaceIdle
        const idle = checkWorkspaceIdle(wctx.workspaceDir, {});

        // checkCooldown
        const cooldown = checkCooldown(wctx.stateDir);

        // extractRecentPainContext (delegates to PainFlagDetector)
        const recentPain = new PainFlagDetector(this.workspaceDir).extractRecentPainContext();

        // list active sessions
        const activeSessions = listSessions(wctx.workspaceDir).filter(s => !isSystemSession(s));

        return { idle, cooldown, recentPain, activeSessions, errors };
    }
}
```

### SessionTracker Lifecycle Pattern

```typescript
// Source: session-tracker.ts L79-88 (initPersistence pattern), L173-181 (flushAllSessions pattern)
export class SessionTracker {
    private readonly workspaceDir: string;

    constructor(workspaceDir: string) {
        this.workspaceDir = workspaceDir;
    }

    init(stateDir: string): void {
        initPersistence(stateDir);
    }

    flush(): void {
        flushAllSessions();
    }

    // Delegating methods for session tracking...
    trackToolRead(sessionId: string, filePath: string, workspaceDir?: string): SessionState {
        return trackToolRead(sessionId, filePath, workspaceDir);
    }

    getSession(sessionId: string): SessionState | undefined {
        return getSession(sessionId);
    }
}
```

### Fail-visible Skip Event (CONTRACT-05)

Reusing existing EventLog.recordRuleMatch pattern:

```typescript
// Source: event-log.ts L61-63 (recordRuleMatch pattern)
// Fail-visible classification for detection queue with no L3 match:
// (inside processDetectionQueue, relocated to TaskContextBuilder)
if (searchResults.length === 0) {
    eventLog.recordRuleMatch(undefined, {
        ruleId: 'l3_semantic',
        layer: 'L3',
        severity: 0,
        textPreview: text.substring(0, 100),
        // Fail-visible payload
        skipReason: 'no_l3_semantic_hit',
        fallbackUsed: 'none',
    } as RuleMatchEventData & { skipReason: string; fallbackUsed: string });
}
```

**Note:** `EventLog.recordRuleMatch()` does not have a `skipReason` field in its type. Two options:
1. Extend `RuleMatchEventData` to include optional `skipReason`/`fallbackUsed` fields
2. Use `eventLog.recordError()` with structured payload for skip/drop events
3. Add dedicated `recordSkip()` / `recordDrop()` methods to EventLog

Decision needed: Option 3 is cleanest but requires EventLog modification. Option 2 reuses existing infrastructure. Planner should decide based on whether EventLog modification is in scope.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|-------------|------------------|--------------|--------|
| All context building inline in runCycle | Context building extracted to TaskContextBuilder | Phase 28 | Cleaner separation, each module has single responsibility |
| Silent fallback with no event | Classified fallback with EventLog skip/drop events | Phase 28 | Diagnostics can now observe fallback behavior |
| Session lifecycle as module functions | Session lifecycle encapsulated in SessionTracker class | Phase 28 | Consistent with other extracted modules (Phase 24-27 pattern) |
| Worker as 2133-line monolith | Worker as lifecycle orchestrator | Phases 24-28 | Each extraction reduces complexity; Phase 29 verifies |

**Deprecated/outdated:**
- Inline `checkWorkspaceIdle`/`checkCooldown` calls in runCycle — replaced by TaskContextBuilder.buildCycleContext()
- Inline `_buildFallbackNocturnalSnapshot` in EvolutionTaskDispatcher — moved to TaskContextBuilder
- Direct module function calls for session lifecycle in worker — replaced by SessionTracker class

## Assumptions Log

> List all claims tagged [ASSUMED] in this research. The planner and discuss-phase use this section to identify decisions that need user confirmation before execution.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | EventLog needs new `recordSkip()`/`recordDrop()` methods for fail-visible events (Option 3) | Code Examples | If EventLog modification is out of scope, Option 2 (recordError) must be used instead |
| A2 | TaskContextBuilder holds `buildCycleContext()` as the primary per-cycle entry | Architecture Patterns | If session filtering should be a separate method, additional refactoring needed |
| A3 | Pain-flag-detector.ts already has extractRecentPainContext as a public method that TaskContextBuilder delegates to | Architecture Patterns | Confirmed by code inspection — PainFlagDetector.extractRecentPainContext() exists and is public |

**If this table is empty:** All claims in this research were verified or cited — no user confirmation needed.

## Open Questions

1. **EventLog recordSkip/recordDrop methods**
   - What we know: `EventLog` has `recordRuleMatch()`, `recordError()`, `recordWarn()` but no dedicated skip/drop method
   - What's unclear: Whether EventLog modification is in scope for Phase 28 or deferred to Phase 29
   - Recommendation: Add `recordSkip()` and `recordDrop()` methods to EventLog as part of Phase 28 (CONTRACT-05 requires it)

2. **SessionTracker placement in worker lifecycle**
   - What we know: `initPersistence` is called once at start, `flushAllSessions` called at end of each cycle AND at stop
   - What's unclear: Whether SessionTracker should be a module-level singleton (like EventLogService) or instantiated per-call
   - Recommendation: Use module-level singleton pattern (consistent with EventLogService) — `SessionTracker.getInstance(workspaceDir)`

3. **Trajectory snapshot building location**
   - What we know: Trajectory snapshot is currently built inside `_dispatchSleepReflection` in EvolutionTaskDispatcher
   - What's unclear: Whether to move ALL snapshot building to TaskContextBuilder, or keep primary snapshot in dispatcher and only fallback in TaskContextBuilder
   - Recommendation: Move to TaskContextBuilder as `buildNocturnalSnapshot(sleepTask)` — consistent with single responsibility

4. **which of the 16 fallback points are fail-fast vs fail-visible**
   - What we know: Classification framework (boundary entry = fail-fast, pipeline middle = fail-visible)
   - What's unclear: Exact classification for each of 16 points
   - Recommendation: See Section 6 (Fallback Audit) for detailed classification

## Environment Availability

Step 2.6: SKIPPED — no external dependencies identified. Phase 28 is a pure extraction/refactoring phase. All code being extracted already exists in the project. No new tools, services, runtimes, or package manager dependencies required.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Likely Vitest (project standard) |
| Config file | packages/openclaw-plugin/vitest.config.ts (or similar) |
| Quick run command | `cd packages/openclaw-plugin && npx vitest run --reporter=dot 2>&1 | tail -20` |
| Full suite command | `cd packages/openclaw-plugin && npx vitest run 2>&1 | tail -20` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| DECOMP-05 | TaskContextBuilder handles all context building | unit | `vitest run src/service/task-context-builder.ts` | TBD (new file) |
| DECOMP-06 | evolution-worker.ts has no context/session logic | unit | `vitest run src/service/evolution-worker.ts` | existing — check no wctx.service calls remain inline |
| CONTRACT-03 | TaskContextBuilder entry validation rejects invalid wctx | unit | `vitest run src/service/task-context-builder.ts --grep "validation"` | TBD |
| CONTRACT-04 | All 16 fallbacks are classified | unit | `vitest run src/service/evolution-worker.ts --grep "fallback"` | existing tests |
| CONTRACT-05 | Fail-visible points emit EventLog events | unit | `vitest run src/service/task-context-builder.ts --grep "EventLog"` | TBD |

### Wave 0 Gaps
- [ ] `src/service/task-context-builder.ts` — Phase 28 TaskContextBuilder class
- [ ] `src/service/session-tracker.ts` — Phase 28 SessionTracker class (wrapper around session-tracker.ts module)
- [ ] `tests/service/task-context-builder.test.ts` — unit tests for context building
- [ ] `tests/service/session-tracker.test.ts` — unit tests for session lifecycle wrapper

*(If no gaps: "None — existing test infrastructure covers all phase requirements")*

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | CONTRACT-03: permissive validation at TaskContextBuilder/WorkflowOrchestrator entry points |
| V4 Access Control | no | No access control changes in Phase 28 |
| V3 Session Management | yes | SessionTracker encapsulates session lifecycle; initPersistence/flushAllSessions must not expose session data |

### Known Threat Patterns for this Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Invalid workspaceDir propagates through entire pipeline | Spoofing | Fail-fast at WorkspaceContext.fromHookContext boundary — throw if workspaceDir cannot be resolved |
| Silent queue corruption causes wrong task execution | Tampering | CONTRACT-02: EvolutionQueueStore.load() returns corrupted status — already handled in Phase 24 |
| Session data loss on worker crash | Denial | flushAllSessions() called at end of every runCycle — SessionTracker encapsulates this |

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — 393 lines, source file to extract from
- `packages/openclaw-plugin/src/core/session-tracker.ts` — Session lifecycle functions (initPersistence, flushAllSessions, L79-181)
- `packages/openclaw-plugin/src/core/workspace-context.ts` — WorkspaceContext class (L36-256), fromHookContext at L177-211
- `packages/openclaw-plugin/src/service/workflow-orchestrator.ts` — Phase 27 pattern reference (class + permissive validation, L44-275)
- `packages/openclaw-plugin/src/service/evolution-queue-store.ts` — Phase 24 pattern reference (class + structured results + permissive validation, L239-597)
- `packages/openclaw-plugin/src/service/pain-flag-detector.ts` — Phase 25 pattern reference (extractRecentPainContext public method at L115-140)
- `packages/openclaw-plugin/src/core/event-log.ts` — EventLog interface (recordRuleMatch pattern at L61-63)
- `packages/openclaw-plugin/src/service/evolution-task-dispatcher.ts` — Snapshot building inside `_dispatchSleepReflection` (L800-867), `_buildFallbackNocturnalSnapshot` at L1035-1067

### Secondary (MEDIUM confidence)
- `packages/openclaw-plugin/src/service/nocturnal-runtime.ts` — checkWorkspaceIdle (L258-330), checkCooldown (L344-412) — verified by code inspection

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — follows Phase 24-27 extraction pattern exactly
- Architecture: HIGH — all patterns verified in source files
- Pitfalls: HIGH — identified from Phase 27 lessons and source code analysis
- Fallback audit: HIGH — all 16 points identified by code inspection

**Research date:** 2026-04-11
**Valid until:** 2026-05-11 (30 days — extraction patterns are stable, Phase 28 scope is well-bounded)

---

## Annex: The 16 Silent Fallback Points — Full Audit

Below is the definitive enumeration of all 16 silent fallback points in `evolution-worker.ts`, with classification and recommended treatment.

### 1. `WorkspaceContext.fromHookContext` — missing `workspaceDir`
- **Location:** L182-187 (inside `fromHookContext`, called at L213 in `start()`)
- **What happens:** Uses `PathResolver.getWorkspaceDir()` as fallback instead of throwing
- **Silent:** Warning log at L185, then continues with default
- **Classification:** **fail-fast** (CONTRACT-04)
- **Treatment:** Return error result from `TaskContextBuilder.buildCycleContext()` when `wctx` cannot be built. Fail at boundary, not mid-pipeline.

### 2. `WorkspaceContext.fromHookContext` — missing `stateDir`
- **Location:** L199-203
- **What happens:** Computes `stateDir` as `resolvePdPath(workspaceDir, 'STATE_DIR')` silently
- **Silent:** Warning log at L202, then continues with computed value
- **Classification:** **fail-fast** (CONTRACT-04)
- **Treatment:** Same as #1 — TaskContextBuilder returns error in result.

### 3. `initPersistence(wctx.stateDir)` — persistence init failure
- **Location:** L216 in `start()`
- **What happens:** `initPersistence` calls `logSessionTrackerWarning` on failure (L127), continues
- **Silent:** `logSessionTrackerWarning` writes to console.warn, worker continues with in-memory sessions only
- **Classification:** **fail-fast** (CONTRACT-04)
- **Treatment:** SessionTracker.init() should return structured result with errors array. Worker start() should fail-fast if session persistence cannot be initialized.

### 4. `checkWorkspaceIdle(wctx.workspaceDir, {})` — idle detection failure
- **Location:** L252 in `runCycle()`
- **What happens:** Returns `{isIdle: false, ...}` default when function throws (no try-catch at call site)
- **Silent:** No error returned — function either works or worker gets false isIdle (which means no sleep_reflection, conservative but wrong)
- **Classification:** **fail-fast** (boundary entry — determines if cycle should proceed with nocturnal pipeline)
- **Treatment:** Wrap in try-catch in TaskContextBuilder.buildCycleContext(), return error in result.

### 5. `checkCooldown(wctx.stateDir)` — cooldown check failure
- **Location:** L256 in `runCycle()`
- **What happens:** Returns all-clear result when function throws (no try-catch at call site)
- **Silent:** Same as #4 — worker proceeds as if no cooldown
- **Classification:** **fail-fast**
- **Treatment:** Wrap in try-catch in TaskContextBuilder.buildCycleContext(), return error in result.

### 6. `PainFlagDetector.detect()` — detection error
- **Location:** L266 in `runCycle()`
- **What happens:** Returns `{exists: false, score: null, ...}` default result on error (try-catch at L104, returns result at L106)
- **Silent:** `skipped_reason: "error: ..."` set but no EventLog event emitted
- **Classification:** **fail-visible** (CONTRACT-05)
- **Treatment:** Emit `eventLog.recordError()` with structured error payload at L106.

### 7. `EvolutionQueueStore.load()` — queue read error or corruption
- **Location:** L271 in `runCycle()`
- **What happens:** Returns `{status: 'corrupted', reasons: [...], queue: []}` with backup on corruption (L281-293 in queue-store). Returns empty queue on file-not-found (L273-275).
- **Silent:** `store.save()` called at L274 only if queue.length > 0. Corruption is logged but processing continues with empty queue.
- **Classification:** **fail-fast** for corruption (CONTRACT-02 says migration/corruption detected before processing), **fail-visible** for empty queue (legitimate state)
- **Treatment:** Corruption status from loadResult should be checked in runCycle before proceeding. Already handled in EvolutionTaskDispatcher (L149-152), but worker-level handling needed.

### 8. Immediate heartbeat trigger — `runHeartbeatOnce` unavailable
- **Location:** L291-308 in `runCycle()`
- **What happens:** `canTrigger = !!api?.runtime?.system?.runHeartbeatOnce` is false → logs warning at L307, continues
- **Silent:** Warning log only, diagnostician starts on next regular cycle
- **Classification:** **fail-visible** (diagnostician delay is a degraded but acceptable state)
- **Treatment:** Emit structured event indicating heartbeat trigger skipped.

### 9. `processDetectionQueue` — entire function failure
- **Location:** L312 in `runCycle()`, wrapped in try-catch at L130-132
- **What happens:** Warns at L131, continues with rest of cycle
- **Silent:** All detection funnel processing skipped
- **Classification:** **fail-visible**
- **Treatment:** Emit event for detection queue processing failure.

### 10. `processDetectionQueue` — L3 trajectory search with no results
- **Location:** L109-125 inside `processDetectionQueue` (L84-133)
- **What happens:** `searchResults.length === 0` → `continue` at L125, no event emitted
- **Silent:** No record that L3 search was attempted and returned empty
- **Classification:** **fail-visible** (CONTRACT-05)
- **Treatment:** Emit `recordRuleMatch` event with `skipReason: 'no_l3_semantic_hit'`.

### 11. `processDetectionQueue` — `wctx.trajectory` unavailable
- **Location:** L108 inside `processDetectionQueue`
- **What happens:** `if (wctx.trajectory)` guard — trajectory search skipped silently
- **Silent:** No event emitted for trajectory unavailability
- **Classification:** **fail-visible** (CONTRACT-05)
- **Treatment:** Emit event for trajectory unavailability.

### 12. `processDetectionQueue` — pain candidate tracking removed (D-05)
- **Location:** L127 inside `processDetectionQueue`
- **What happens:** `// L3 semantic search via trajectory database FTS5 (MEM-04)` followed by no-op comment
- **Silent:** Intentional removal — not a fallback but a removed feature
- **Classification:** N/A — not a fallback, documented removal
- **Treatment:** No action needed.

### 13. `wctx.dictionary.flush()` — dictionary flush failure
- **Location:** L341 in `runCycle()` (finally block)
- **What happens:** Empty catch at L131 (processDetectionQueue) and silent at L341 (dictionary flush)
- **Silent:** Dictionary flush failure is non-critical but silently ignored
- **Classification:** **fail-visible**
- **Treatment:** Emit event for dictionary flush failure.

### 14. `flushAllSessions()` — session persistence failure
- **Location:** L342 in `runCycle()` (finally block)
- **What happens:** Empty catch block (implicit at end of try-finally)
- **Silent:** Session persistence failure silently ignored
- **Classification:** **fail-visible** (CONTRACT-05)
- **Treatment:** SessionTracker.flush() should catch errors and return them in structured result.

### 15. `writeWorkerStatus()` — non-critical status write failure
- **Location:** L189-196
- **What happens:** Empty catch block at L193, non-critical monitoring file
- **Silent:** Status file write failure silently ignored
- **Classification:** **fail-visible** (acceptable — non-critical monitoring)
- **Treatment:** Emit event for status write failure.

### 16. `WorkflowOrchestrator.sweepExpired` — `subagentRuntime` unavailable
- **Location:** workflow-orchestrator.ts L250-266
- **What happens:** Falls back to WorkflowStore direct operations when subagentRuntime unavailable
- **Silent:** Warning logs at L260 but session cleanup is skipped
- **Classification:** **fail-visible** (CONTRACT-05)
- **Treatment:** Emit event for session cleanup skipped due to runtime unavailability.
