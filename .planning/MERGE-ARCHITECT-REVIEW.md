# Merge Architect Review: v1.17 + v1.18 Post-Merge Integrity

**Date**: 2026-04-15
**Branch**: feature/correction-keyword-learning-v2
**Reviewer**: System Architect (automated review)
**Scope**: v1.17 (Keyword Learning Engine) + v1.18 (Nocturnal State Safety) merge

---

## Executive Summary

The merge of v1.17 (CorrectionCueLearner, keyword_optimization workflow) into v1.18 (failure-classifier, cooldown-strategy, startup-reconciler) has introduced several integrity issues. The most critical finding is the **loss of atomic writes** in the evolution queue path, combined with a crash-safety inconsistency across the pipeline's three persistence layers. There are also duplicate modules from an incomplete file-move and a divergent interface between the two copies.

**Risk assessment**: The queue file is the most frequently-written state file in the system (10+ writes per heartbeat cycle). A crash during any of the 11+ `fs.writeFileSync` calls in evolution-worker.ts can produce a zero-length or partially-written queue file, which causes all in-flight tasks to be lost and re-created from scratch on restart. This is not theoretical -- it is the exact scenario that motivated the original atomic-write-util module.

---

## Findings

### [CRITICAL] F-01: Evolution queue uses bare `fs.writeFileSync` -- no crash safety

**Location**: `evolution-worker.ts` (11 occurrences of `fs.writeFileSync(queuePath, ...)`)

The merge lost the `atomic-write-util.ts` module (confirmed: glob for `**/atomic-write*` returns zero results). Every queue write now uses bare `fs.writeFileSync`, which provides no protection against:

1. **Partial writes**: A crash mid-write produces a truncated JSON file. On restart, `JSON.parse` fails and the queue is silently reset to `[]`, losing all in-progress tasks.
2. **Zero-length files**: On Windows (the deployment platform), `fs.writeFileSync` truncates the file before writing. A crash between truncate and write produces a 0-byte file.
3. **Inconsistent state**: The file-lock mechanism (`acquireQueueLock`) only prevents concurrent access between PD processes, not against OS-level crashes or power loss.

**Contrast with the rest of the system**:
- `nocturnal-service.ts` line 110-114: Has its own local `atomicWriteFileSync` (write-to-tmp + rename) for artifact persistence.
- `correction-cue-learner.ts` line 112-116: Has `saveCorrectionKeywordStore` using tmp+rename for keyword store persistence.
- `nocturnal-runtime.ts` line 268-270: Uses `withLockAsync` + `fs.writeFileSync` for runtime state (protected by lock but not crash-safe).
- `evolution-worker.ts`: 11 bare `fs.writeFileSync` calls with **no** tmp+rename pattern.

**Impact**: Queue corruption on crash causes: (a) duplicate task creation, (b) lost in-progress state, (c) potential duplicate workflow dispatch. The startup-reconciler (Phase 41) does NOT validate or recover the evolution queue -- it only handles `nocturnal-runtime.json`.

**Recommendation**: Extract a shared `atomicWriteFileSync` utility (the pattern already exists in two places). Apply it to all 11 queue writes. The function is 3 lines:
```typescript
function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, data, 'utf8');
  fs.renameSync(tmpPath, filePath);
}
```
Consider adding `fs.fsyncSync` on the tmp file before rename for full durability on Linux (optional on Windows where rename is already atomic within a volume).

---

### [CRITICAL] F-02: Duplicate `correction-observer-types.ts` with divergent interfaces

**Locations**:
- `packages/openclaw-plugin/src/service/correction-observer-types.ts` (2027 bytes)
- `packages/openclaw-plugin/src/service/subagent-workflow/correction-observer-types.ts` (1933 bytes)

These are **not identical copies**. The diff reveals a meaningful interface divergence:

| Field | `service/` copy | `subagent-workflow/` copy |
|-------|----------------|--------------------------|
| `CorrectionObserverResult.updates` | `updates?:` (optional) | `updates:` (required) |
| Import path for `SubagentWorkflowSpec` | `./subagent-workflow/types.js` | `./types.js` |
| Unused imports | `WorkflowPersistContext`, `WorkflowResultContext` | none |

The `updates` field optionality is a **real contract difference**. The `subagent-workflow/` copy declares `updates` as required, meaning consumers using that type must always provide it. The `service/` copy makes it optional (`updates?`), which is the correct semantics -- when `updated === false`, there are no updates to apply.

**Current import consumers**:
- `evolution-worker.ts` imports from `./subagent-workflow/correction-observer-types.js` (required `updates`)
- `keyword-optimization-service.ts` imports from `./subagent-workflow/correction-observer-types.js` (required `updates`)
- `correction-observer-workflow-manager.ts` (both copies) imports from its co-located types file
- `subagent-workflow/index.ts` imports from BOTH locations (lines 44-50 and 73-79), creating duplicate exports

The `service/` copy (old location) has **no active importers** for its types. But `index.ts` re-exports from it (line 50: `from '../correction-observer-types.js'`), which means both type variants are available to external consumers.

**Recommendation**: Delete the `service/correction-observer-types.ts` and `service/correction-observer-workflow-manager.ts` files (the old-location copies). Fix the `subagent-workflow/correction-observer-types.ts` to use `updates?` (optional) to match the runtime semantics. Remove the duplicate re-exports from `subagent-workflow/index.ts` (lines 39-50 duplicate lines 68-79).

---

### [WARNING] F-03: `nocturnal-runtime.ts` writeState is locked but not crash-safe

**Location**: `nocturnal-runtime.ts` line 262-271

```typescript
export async function writeState(stateDir: string, state: NocturnalRuntimeState): Promise<void> {
    const filePath = path.join(stateDir, NOCTURNAL_RUNTIME_FILE);
    await withLockAsync(filePath, async () => {
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
    });
}
```

The `withLockAsync` prevents concurrent PD processes from corrupting each other, but it does NOT protect against OS-level crashes during the write. If the process is killed between `fs.writeFileSync` starting and completing, `nocturnal-runtime.json` will be truncated.

This matters because `nocturnal-runtime.json` now stores `taskFailureState` (the cooldown escalation state from Phase 40). If this file is corrupted:
1. The startup-reconciler will detect corruption and reset it to defaults (good).
2. But this silently **loses all escalation state** -- tasks that were in Tier 3 (24h cooldown) will be retried immediately after restart.

The artifact persistence in `nocturnal-service.ts` and the keyword store in `correction-cue-learner.ts` both use tmp+rename. The runtime state file should use the same pattern.

**Recommendation**: Add the tmp+rename pattern inside `writeState`'s lock callback:
```typescript
await withLockAsync(filePath, async () => {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
});
```

---

### [WARNING] F-04: `prompt.ts` has a hardcoded correction cue list parallel to CorrectionCueLearner

**Location**: `packages/openclaw-plugin/src/hooks/prompt.ts` lines 88-112

The `detectCorrectionCue()` function in `prompt.ts` uses a hardcoded array of 16 cue strings. Meanwhile, `prompt.ts` also imports `CorrectionCueLearner` (line 22) which has a learnable, persistent keyword store with FPR-weighted scoring.

These two systems are **not connected**. The `detectCorrectionCue()` function is never replaced or augmented by the `CorrectionCueLearner` in the prompt hook. The learner's `match()` method, which provides weighted scoring and handles the full learnable keyword store, is not called anywhere in `prompt.ts`.

This means the v1.17 keyword learning engine's corrections are detected by the old hardcoded list in `prompt.ts`, not by the learner. The learner only affects the `keyword_optimization` workflow's periodic optimization cycle.

**Impact**: The learner accumulates TP/FP counts from the keyword_optimization workflow, but the actual correction detection in user prompts is unaffected by any learning. The two systems are effectively decoupled.

**Recommendation**: Replace the hardcoded `detectCorrectionCue()` call in `prompt.ts` with `CorrectionCueLearner.get(stateDir).match(text)`. This wires the learnable keyword store into the actual detection path. Requires passing `stateDir` to the prompt hook context, which is already available via `WorkspaceContext`.

---

### [WARNING] F-05: `subagent-workflow/index.ts` has duplicate re-exports

**Location**: `packages/openclaw-plugin/src/service/subagent-workflow/index.ts` lines 39-50 and 68-79

The `CorrectionObserverWorkflowManager`, `createCorrectionObserverWorkflowManager`, `correctionObserverWorkflowSpec`, `CorrectionObserverWorkflowOptions`, `CorrectionObserverPayload`, `CorrectionObserverResult`, and `CorrectionObserverWorkflowSpec` are all exported **twice** -- once from the old `service/` path (lines 39-50) and once from the new `subagent-workflow/` path (lines 68-79).

TypeScript module resolution will use the **last** export as the binding, so the `subagent-workflow/` versions win. But having duplicate exports is confusing and makes it unclear which is canonical. It also creates a false sense that both locations are maintained.

**Recommendation**: Remove the first block (lines 39-50, importing from `../correction-observer-*.js`) and keep only the block importing from `./correction-observer-*.js` (the subagent-workflow-local copies).

---

### [WARNING] F-06: startup-reconciler does not cover evolution queue or keyword store

**Location**: `packages/openclaw-plugin/src/service/startup-reconciler.ts`

The startup-reconciler handles three things:
1. Validate `nocturnal-runtime.json` integrity (reset if corrupted)
2. Clear expired cooldowns from `taskFailureState`
3. Remove orphan `.tmp` files from the state directory

However, it does **not** cover:
- The evolution queue file (`evolution-queue.json`): If corrupted, tasks are silently lost. No validation, no backup, no recovery.
- The keyword store file (`correction_keywords.json`): If corrupted, `correction-cue-learner.ts` falls back to defaults (acceptable, but no reconciliation logging).

Given that the queue file is written 11 times per cycle with bare `fs.writeFileSync` (F-01), it is the most crash-vulnerable file in the system. The startup-reconciler should at minimum validate its JSON integrity.

**Recommendation**: Add evolution queue validation to the startup-reconciler:
```typescript
// Step 4: Validate evolution queue integrity
const queuePath = path.join(stateDir, 'evolution-queue.json');
if (fs.existsSync(queuePath)) {
    try {
        const raw = fs.readFileSync(queuePath, 'utf8');
        JSON.parse(raw); // Validate JSON
    } catch {
        // Queue corrupted -- back up and reset
        const backupPath = queuePath + '.corrupted.' + Date.now();
        fs.renameSync(queuePath, backupPath);
        result.queueReset = true;
    }
}
```

---

### [INFO] F-07: Over-engineering assessment -- 3-tier cooldown escalation

**Location**: `packages/openclaw-plugin/src/service/cooldown-strategy.ts`, `packages/openclaw-plugin/src/service/failure-classifier.ts`

The failure classification and cooldown escalation system consists of:
- `failure-classifier.ts`: 79 lines, pure function, no I/O -- well-scoped.
- `cooldown-strategy.ts`: 97 lines, 3 exported functions -- well-scoped.
- `nocturnal-config.ts` additions: `CooldownEscalationConfig` with 4 configurable fields.
- State in `nocturnal-runtime.ts`: `TaskFailureState` with escalation tracking.

The escalation tiers (30min, 4h, 24h) are configurable via `nocturnal-config.json`. The `consecutive_threshold` default of 3 is reasonable. The state is persisted to the existing `nocturnal-runtime.json` rather than introducing a new file.

**Assessment**: This is **proportionally engineered**. The total addition is ~180 lines across 2 new files plus minor additions to 2 existing files. The config-driven approach allows tuning without code changes. The pure-function classifier is independently testable. The cooldown-strategy correctly delegates persistence to the existing `readState/writeState` pipeline.

**One concern**: The `recordPersistentFailure` function increments `consecutiveFailures` independently of the classifier's count. If the classifier says "3 consecutive failures" and then `recordPersistentFailure` is called, it increments its own counter from the stored state. These two counts can diverge if a task fails between cycles (the classifier counts from queue, the strategy counts from persisted state). In practice this is benign because both converge on the same behavior (escalate), but the dual-bookkeeping is a minor smell.

---

### [INFO] F-08: Data flow completeness -- failure to cooldown to reconciliation

The data flow is:

```
Task fails
  -> sleepOutcomes.push({ succeeded: false })
  -> queue written to disk (bare fs.writeFileSync)
  -> freshQueueForClassify re-reads from disk
  -> classifyFailure(freshQueue, taskKind) counts consecutive failures
  -> if persistent: recordPersistentFailure() -> readState + increment + writeState
  -> isTaskKindInCooldown() checked at start of next cycle
  -> startup-reconciler clears expired cooldowns on restart
```

**Gap analysis**:
1. The classifier re-reads the queue from disk after writing. This is correct but introduces a TOCTOU window -- another process could modify the queue between the write and the re-read. In practice this is mitigated by the file lock, but the lock is released before `handleTaskOutcome` runs.
2. `recordPersistentFailure` calls `readState` (async) while the classifier used `freshQueueForClassify` (sync read). The state file and queue file are independent, so no direct TOCTOU, but the failure classifier's consecutive count is from the **queue** while the cooldown tier is from the **state file**. This dual-source is architecturally sound (queue for evidence, state for escalation tracking) but should be documented.

**No critical gaps found** in the data flow. The path from failure to classification to escalation to cooldown checking is complete and functional.

---

### [INFO] F-09: `handleTaskOutcome` is correctly non-blocking

**Location**: `evolution-worker.ts` lines 52-75

The `handleTaskOutcome` function wraps all classification/escalation logic in try/catch with the comment "classification errors are non-blocking". This is correct -- failure classification is an optimization (backpressure on failing tasks), not a correctness requirement. If it throws, tasks still proceed normally on the next cycle.

This is a good architectural decision. The cooldown system is a guardrail, not a gatekeeper.

---

## Summary Table

| ID | Severity | Component | Summary |
|----|----------|-----------|---------|
| F-01 | CRITICAL | evolution-worker.ts | 11 bare `fs.writeFileSync` calls on queue -- no crash safety |
| F-02 | CRITICAL | correction-observer-types.ts | Duplicate files with divergent `updates` field optionality |
| F-03 | WARNING | nocturnal-runtime.ts | `writeState` uses lock but not tmp+rename -- crash can corrupt escalation state |
| F-04 | WARNING | prompt.ts | Hardcoded correction cue list not connected to CorrectionCueLearner |
| F-05 | WARNING | subagent-workflow/index.ts | Duplicate re-exports of CorrectionObserver types/classes |
| F-06 | WARNING | startup-reconciler.ts | Does not validate evolution queue integrity |
| F-07 | INFO | cooldown-strategy.ts | 3-tier escalation is proportionally engineered |
| F-08 | INFO | Data flow | Failure-to-cooldown flow is complete, no critical gaps |
| F-09 | INFO | handleTaskOutcome | Correctly non-blocking, good architectural decision |

---

## Recommended Fix Priority

1. **F-01** (queue atomic writes) -- Introduce shared `atomicWriteFileSync` utility, apply to all queue writes.
2. **F-02** (duplicate modules) -- Delete old-location copies, fix `updates` optionality, clean up index.ts.
3. **F-03** (runtime state atomic writes) -- Add tmp+rename to `writeState` inside the lock.
4. **F-06** (queue validation) -- Add queue JSON validation to startup-reconciler.
5. **F-04** (learner wiring) -- Connect CorrectionCueLearner to prompt hook's detection path.
6. **F-05** (duplicate exports) -- Remove duplicate re-exports from index.ts.

Items 1-3 should be addressed before merging to main. Items 4-6 can be follow-up PRs.
