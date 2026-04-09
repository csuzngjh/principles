# Issue #219: Nocturnal pipeline — `no_evaluable_principles` because `parseLegacyTrainingStore` reads wrong JSON field

## Evidence

**Symptom**: All nocturnal sleep_reflection workflows fail instantly with reason `no_target_selected` → `skipReason: no_evaluable_principles` (from workflow event payload).

**Root cause identified** (`packages/openclaw-plugin/src/core/principle-tree-ledger.ts` line 295):

```ts
// CURRENT (BUG):
return {
  trainingStore: parseLegacyTrainingStore(raw),   // ← raw is the WHOLE JSON file
  tree: parseTree(raw[TREE_NAMESPACE]),
};

// FIX:
return {
  trainingStore: parseLegacyTrainingStore(raw['trainingStore'] ?? raw),  // ← pass trainingStore sub-object
  tree: parseTree(raw[TREE_NAMESPACE]),
};
```

**Full causal chain**:

```
principle_training_state.json structure:
{
  "trainingStore": { "P_001": {...}, ..., "P_074": {...} },  ← 74 evaluable principles
  "tree": {...},
  "_migratedFrom": "..."
}

readLedgerFromFile() reads the whole JSON → raw = {trainingStore, tree, _migratedFrom}
parseLegacyTrainingStore(raw) iterates raw's top-level keys:
  "trainingStore" → skipped (not P_xxx)
  "tree"          → skipped (not P_xxx)
  "_migratedFrom" → skipped (not P_xxx)
→ returns {} (empty)

loadStore() → {trainingStore: {}}
listEvaluablePrinciples() → []
selector.decision = 'skip', skipReason = 'no_evaluable_principles'
→ All nocturnal workflows fail
```

**Fix**: Pass `raw['trainingStore']` to `parseLegacyTrainingStore` instead of `raw`.

## Fix

```ts
// Line 295 — change:
trainingStore: parseLegacyTrainingStore(raw),
// to:
trainingStore: parseLegacyTrainingStore(raw['trainingStore'] ?? raw),
```

## Scope

- File: `packages/openclaw-plugin/src/core/principle-tree-ledger.ts`
- Line: 295
- Only affects `readLedgerFromFile` (used for loading, not saving — safe)
- No migration needed — JSON file structure is correct, only the reader was wrong
