# Runtime Auto-Trigger: Principle Compiler Integration

## Status

Draft — awaiting implementation.

## Problem

Since v1.18 (PR #327), the Principle Compiler pipeline exists:
```
Pain → createPrincipleFromDiagnosis() → tree.principles (registered)
                                               ↓
                         [NOBODY CALLS THE COMPILER]
                                               ↓
                            tree.implementations (empty forever)
                                               ↓
                            RuleHost.evaluate() finds nothing
```

The compiler only runs when `scripts/compile-principles.mjs` is executed manually. New principles are created but never compiled into executable rules.

## Goals

- New principles auto-compile on creation
- Compilation failures retry on every heartbeat cycle
- After 5 consecutive failures, principle is downgraded to `manual_only` with explicit `COMPILE_EXHAUSTED` event
- Old pre-existing principles are backfilled on first heartbeat after deploy
- No silent failures; every error is logged

## Non-Goals

- Do not modify pain pipeline, evolution queue, or RuleHost evaluation logic
- Do not add new files beyond schema extension
- Do not add silent fallbacks; fail-fast on uncertain runtime behavior

## Design

### Retry Count Storage

`compilationRetryCount?: number` added to `Principle` interface (`principle-tree-schema.ts`).

| State | Meaning |
|-------|---------|
| `compilationRetryCount === undefined` | Not yet attempted (or succeeded on last attempt) |
| `compilationRetryCount === 0` | Queued for compilation |
| `compilationRetryCount >= 1` | In retry; attempt count |
| `>= 5 after failure` | Downgrade to `manual_only` |

This field also serves as the compilation queue: `compilationRetryCount >= 0` means "pending".

### Trigger: Sync on Principle Creation

In `createPrincipleFromDiagnosis()` (`evolution-reducer.ts`), after principle is created and added to ledger:

```typescript
// compilationRetryCount = 0 means "queued"
updatePrinciple(stateDir, principleId, { compilationRetryCount: 0 });

try {
  const result = compiler.compileOne(principleId);
  if (!result.success) {
    throw new Error(result.reason ?? 'compile failed');
  }
  // Success: reset retry count
  updatePrinciple(stateDir, principleId, { compilationRetryCount: undefined });
} catch (err) {
  // Failure: increment count, log explicitly
  updatePrinciple(stateDir, principleId, { compilationRetryCount: 1 });
  SystemLogger.log(workspaceDir, 'COMPILE_FAILED',
    `Principle ${principleId} compile failed: ${String(err)} (attempt 1/5)`);
}
```

### Trigger: Heartbeat Backfill

In `processEvolutionQueue()` (`evolution-worker.ts`), add to heartbeat loop:

```
On every heartbeat cycle:
1. Scan tree.principles where compilationRetryCount >= 0 AND evaluability != 'manual_only'
2. For each such principle:
   a. Call compiler.compileOne(principleId)
   b. On success: updatePrinciple(id, { compilationRetryCount: undefined }), log COMPILE_SUCCESS
   c. On failure:
      - count = compilationRetryCount + 1
      - updatePrinciple(id, { compilationRetryCount: count })
      - if count >= 5:
          updateEvaluability(id, 'manual_only')
          updatePrinciple(id, { compilationRetryCount: undefined })
          log COMPILE_EXHAUSTED with reason
      - else:
          log COMPILE_FAILED with attempt count
```

### Old Principles Backfill

On first heartbeat after deploy, scan all principles where:
- `compilationRetryCount === undefined`
- `evaluability !== 'manual_only'`
- No active implementation in `tree.implementations`

For each match: set `compilationRetryCount = 0` so the normal heartbeat retry loop picks them up.

Detection: use a flag stored in `stateDir` (e.g., `compilationBackfillDone` in a `compilation-meta.json` small file), or scan once per heartbeat until all are resolved. The simplest approach: just treat undefined as "queue me" — on first heartbeat, the backfill scan sets count to 0, subsequent heartbeats process normally.

### Events

| Event | When | Data |
|-------|------|------|
| `COMPILE_SUCCESS` | Compilation succeeds | principleId |
| `COMPILE_FAILED` | Compilation fails (each attempt) | principleId, attempt, error |
| `COMPILE_EXHAUSTED` | 5 failures reached, downgraded | principleId, finalError |

All via `SystemLogger.log()` → `events.jsonl`.

## Interface Contracts

### `Principle.compilationRetryCount?: number`
- Added to `Principle` interface in `principle-tree-schema.ts`
- Optional — existing principles have `undefined`
- Mutations via `updatePrinciple(stateDir, id, { compilationRetryCount: n })`

### `compileOne(principleId)` (`PrincipleCompiler`)
- Already public; returns `{ success: boolean, reason?: string }`
- Throws on unexpected errors (fail-fast)
- Returns `success: false` with reason on expected failures (validation, no patterns, etc.)

### `updateEvaluability(principleId, 'manual_only')`
- Uses existing `updatePrinciple` with `evaluability` field
- No new function needed

## Data Flow

```
createPrincipleFromDiagnosis()
  → addPrincipleToLedger()         [ledger]
  → updatePrinciple(count=0)       [queue signal]
  → compiler.compileOne()           [try]
    → success: updatePrinciple(count=undefined)
    → fail:   updatePrinciple(count=1) + COMPILE_FAILED

heartbeat
  → scan compilationRetryCount >= 0
  → compiler.compileOne()
    → success: updatePrinciple(count=undefined)
    → fail:   updatePrinciple(count+=1)
                → count >= 5: updateEvaluability(manual_only) + COMPILE_EXHAUSTED
                → else:       COMPILE_FAILED
```

## Files Changed

1. `src/types/principle-tree-schema.ts` — add `compilationRetryCount?: number` to `Principle`
2. `src/core/evolution-reducer.ts` — sync compile on creation, retry count management
3. `src/service/evolution-worker.ts` — heartbeat backfill and retry loop

## Verification

- [ ] Unit test: `compilationRetryCount` resets on successful compile
- [ ] Unit test: `compilationRetryCount` increments on failure
- [ ] Unit test: 5th failure triggers `manual_only` downgrade
- [ ] Unit test: old principles with `undefined` count are picked up by backfill
- [ ] Integration test: pain → principle → compiled rule → RuleHost.evaluate() fires
- [ ] Build: TypeScript compiles clean
