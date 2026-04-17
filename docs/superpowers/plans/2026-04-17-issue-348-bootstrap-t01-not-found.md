# Issue #348 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `ensureCorePrinciples()` to write T-01...T-10 to both Training Store AND Ledger Tree, and add migration logic for existing workspaces.

**Architecture:** Two changes: (1) augment `ensureCorePrinciples()` to also call `addPrincipleToLedger()` for each T-0X, (2) add idempotent migration in `bootstrapRules()` that fills Ledger Tree from Training Store if T-01 is missing.

**Tech Stack:** TypeScript, `principle-tree-ledger.ts`, `init.ts`

---

### Task 1: Add Ledger Tree initialization to `ensureCorePrinciples()`

**Files:**
- Modify: `packages/openclaw-plugin/src/core/init.ts:187-220`
- Test: `packages/openclaw-plugin/src/core/init.test.ts` (new or existing)

- [ ] **Step 1: Add imports for Ledger Tree functions**

In `init.ts` header, add:
```typescript
import { addPrincipleToLedger } from './principle-tree-ledger.js';
import type { LedgerPrinciple } from './principle-tree-ledger.js';
```

- [ ] **Step 2: Augment `ensureCorePrinciples()` to write Ledger Tree**

After the existing `setPrincipleState()` loop, add for each `model` of `CORE_THINKING_MODELS`:
```typescript
const now = new Date().toISOString();
const ledgerPrinciple: LedgerPrinciple = {
  id: model.id,
  version: 1,
  text: model.description,
  coreAxiomId: model.id,
  triggerPattern: '',
  action: '',
  status: 'active',
  priority: 'P1',
  scope: 'general',
  evaluability: 'deterministic',
  valueScore: 0,
  adherenceRate: 0,
  painPreventedCount: 0,
  derivedFromPainIds: [],
  ruleIds: [],
  createdAt: now,
  updatedAt: now,
  suggestedRules: [],
};
addPrincipleToLedger(stateDir, ledgerPrinciple);
```

- [ ] **Step 3: Build and verify init compiles**

Run: `cd D:\Code\principles && npm run build --workspace=packages/openclaw-plugin`
Expected: No TypeScript errors

- [ ] **Step 4: Run existing init tests**

Run: `cd D:\Code\principles && npm test --workspace=packages/openclaw-plugin -- --testPathPattern=init`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/openclaw-plugin/src/core/init.ts
git commit -m "fix: ensureCorePrinciples writes T-01..T-10 to both Training Store and Ledger Tree"
```

---

### Task 2: Add migration logic in `bootstrapRules()` for existing workspaces

**Files:**
- Modify: `packages/openclaw-plugin/src/core/bootstrap-rules.ts`
- Test: `packages/openclaw-plugin/tests/core/bootstrap-rules.test.ts`

- [ ] **Step 1: Add migration guard at top of `bootstrapRules()`**

Add before the store load (bootstrapRules calls loadLedger after selectPrinciplesForBootstrap, so put migration at top of bootstrapRules before selectPrinciplesForBootstrap):
```typescript
// Migration: if T-01..T-10 exist in Training Store but not in Ledger Tree, backfill.
// This handles workspaces initialized before Ledger Tree was added.
const store = loadStore(stateDir);
const ledger = loadLedger(stateDir);
const hasTrainingT = Object.keys(store).some(id => id.startsWith('T-'));
const hasAnyLedgerT = Object.keys(ledger.tree.principles).some(id => id.startsWith('T-'));
if (hasTrainingT && !hasAnyLedgerT) {
  console.warn('[bootstrap] Migrating T-01..T-10 from Training Store to Ledger Tree');
  const now = new Date().toISOString();
  for (const [id, entry] of Object.entries(store)) {
    if (!id.startsWith('T-')) continue;
    const model = CORE_THINKING_MODELS.find(m => m.id === id);
    if (!model) continue;
    const lp: LedgerPrinciple = {
      id,
      version: 1,
      text: model.description,
      coreAxiomId: id,
      triggerPattern: '',
      action: '',
      status: 'active',
      priority: 'P1',
      scope: 'general',
      evaluability: entry.evaluability,
      valueScore: 0,
      adherenceRate: 0,
      painPreventedCount: 0,
      derivedFromPainIds: [],
      ruleIds: [],
      createdAt: now,
      updatedAt: now,
      suggestedRules: [],
    };
    addPrincipleToLedger(stateDir, lp);
  }
}
```

- [ ] **Step 2: Add imports in bootstrap-rules.ts**

Add to the existing import block:
```typescript
import { addPrincipleToLedger } from './principle-tree-ledger.js';
import type { LedgerPrinciple } from './principle-tree-ledger.js';
// CORE_THINKING_MODELS — duplicate the array from init.ts (avoids circular dep)
const CORE_THINKING_MODELS = [
  { id: 'T-01', name: 'Survey Before Acting', description: 'Understand the structure first before making changes.' },
  { id: 'T-02', name: 'Respect Constraints', description: 'Trust files, not your context window. Write conclusions to files.' },
  { id: 'T-03', name: 'Evidence Over Assumption', description: 'Use logs, code, and outputs before inferring causes.' },
  { id: 'T-04', name: 'Reversible First', description: 'Prefer changes that are safe to roll back when risk is high.' },
  { id: 'T-05', name: 'Safety Rails', description: 'Call out guardrails, prohibitions, and failure-prevention constraints.' },
  { id: 'T-06', name: 'Simplicity First', description: 'Prefer the smallest understandable solution over over-engineering.' },
  { id: 'T-07', name: 'Minimal Change Surface', description: 'Limit the blast radius and touch only what is necessary.' },
  { id: 'T-08', name: 'Pain As Signal', description: 'Treat failures and friction as clues to step back and rethink.' },
  { id: 'T-09', name: 'Divide And Conquer', description: 'Split the task into smaller phases before execution.' },
  { id: 'T-10', name: 'Memory Externalization', description: 'Write intermediate conclusions to files for persistence.' },
];
```

- [ ] **Step 3: Run bootstrap on a clean workspace**

Run: `cd D:\Code\principles && node scripts/bootstrap-rules.mjs`
Expected: No error about T-01 not found

- [ ] **Step 4: Verify Ledger Tree now has T-01**

Run: `node -e "const {loadLedger}=require('./dist/core/principle-tree-ledger.js'); const l=loadLedger('D:/Code/principles/.state'); console.log(Object.keys(l.tree.principles).filter(k=>k.startsWith('T-')))"`
Expected: `['T-01','T-02',...,'T-10']`

- [ ] **Step 5: Run bootstrap tests**

Run: `cd D:\Code\principles && npm test --workspace=packages/openclaw-plugin -- --testPathPattern=bootstrap-rules`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/openclaw-plugin/src/core/bootstrap-rules.ts
git commit -m "fix: bootstrap-rules migrates T-01..T-10 from Training Store to Ledger Tree for existing workspaces"
```

---

### Task 3: End-to-end verification

- [ ] **Step 1: Clean workspace bootstrap test**

Delete Ledger Tree entries for T-01..T-10 from `D:\.openclaw\workspace\.state\principle-tree.json` (backup first), then run `node D:\Code\principles\scripts\bootstrap-rules.mjs`
Expected: No T-01 not found error

- [ ] **Step 2: Sync plugin test**

Run: `cd D:\Code\principles && npm run sync-plugin`
Expected: Completes without error

- [ ] **Step 3: Verify both stores have T-01..T-10**

Run verification commands checking both loadLedger() and loadStore()
Expected: Both return T-01..T-10
