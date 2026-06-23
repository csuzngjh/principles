# PRI-443: Core Boundary Repair Implementation Plan

> **Goal:** Eliminate I/O code from principles-core, restoring its pure-logic boundary without breaking MVP activation channels.

**Architecture:** Extract pure types/parsers from `principle-tree-ledger.ts` into new pure modules. Unify duplicate `pain-signal.ts`. Delete `io.ts` (only consumer is within core itself; zero external `@principles/core/io` imports). Fix `runtime-v2/index.ts` barrel to stop re-exporting I/O functions. Add `"./principle-tree-ledger"` export path to package.json for pd-cli consumers. Each phase is independently revertable.

**Pre-flight verification (all passed):**
- `@principles/core/io` — zero external consumers
- `@principles/core/pain-signal` — zero external consumers (all via barrel)
- `AsyncQueueLock` — only defined in `io.ts`, zero other core importers
- Plugin `validatePainSignal` — zero plugin imports
- MVP activation channels — zero dependency on refactored files

**Tech Stack:** TypeScript, TypeBox, Vitest, npm workspaces

**MVP Safety:** Three activation channels (prompt, code_tool_hook, defer_archive) all read from SQLite `activations` table — zero dependency on the files being refactored.

---

## File Structure

### New files (pure logic, zero I/O)
| File | Responsibility |
|------|---------------|
| `packages/principles-core/src/runtime-v2/types/ledger-store.ts` | All ledger type definitions (LedgerPrinciple, LedgerRule, HybridLedgerStore, etc.) |
| `packages/principles-core/src/runtime-v2/principle-tree/ledger-codec.ts` | Pure parse/serialize functions for ledger data |
| `packages/principles-core/src/runtime-v2/principle-tree/index.ts` | Barrel for principle-tree module |

### Modified files
| File | Change |
|------|--------|
| `packages/principles-core/src/principle-tree-ledger.ts` | Import types/parsers from new modules; inline `atomicWriteFileSync`; becomes thin I/O adapter |
| `packages/principles-core/src/pain-signal.ts` | Re-export from `runtime-v2/types/pain-signal.ts`; delete duplicate code |
| `packages/principles-core/src/runtime-v2/types/pain-signal.ts` | Merge stricter validation (timestamp ISO 8601, context size limit) from top-level version |
| `packages/principles-core/src/runtime-v2/index.ts` | Stop re-exporting I/O functions (`loadLedger`, `saveLedger`, etc.) |
| `packages/principles-core/src/index.ts` | Stop exporting `atomicWriteFileSync` |
| `packages/principles-core/src/runtime-v2/types/index.ts` | Re-export ledger types from new location |
| `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts` | Update definition-location assertions; add new boundary guards |
| `packages/pd-cli/src/commands/candidate.ts` | Import `loadLedger` from `@principles/core/principle-tree-ledger` instead of `@principles/core/runtime-v2` |
| `packages/pd-cli/src/services/runtime-adapter-resolver.ts` | Same import path change |

### Deleted files
| File | Reason |
|------|--------|
| `packages/principles-core/src/io.ts` | Only consumer is `principle-tree-ledger.ts`; `atomicWriteFileSync` inlined there; `AsyncQueueLock` is unused in core |

---

## Phase 1: Extract pure ledger types

**Goal:** Move all type definitions from `principle-tree-ledger.ts` to a new pure module. Zero behavior change.

### Task 1.1: Create ledger-store.ts types module

**Files:**
- Create: `packages/principles-core/src/runtime-v2/types/ledger-store.ts`

- [ ] **Step 1: Create the types file**

```typescript
/**
 * Ledger store types — pure type definitions, no I/O.
 *
 * Extracted from principle-tree-ledger.ts to separate pure types
 * from filesystem operations.
 */

export type PrincipleStatus = 'candidate' | 'active' | 'archived' | 'deprecated' | 'probation';
export type PrinciplePriority = 'P0' | 'P1' | 'P2';
export type PrincipleScope = 'general' | 'domain';
export type PrincipleEvaluability = 'manual_only' | 'deterministic' | 'weak_heuristic';

export interface Principle {
  id: string;
  version: number;
  text: string;
  triggerPattern: string;
  action: string;
  status: PrincipleStatus;
  priority: PrinciplePriority;
  scope: PrincipleScope;
  evaluability: PrincipleEvaluability;
  valueScore: number;
  adherenceRate: number;
  painPreventedCount: number;
  derivedFromPainIds: string[];
  ruleIds: string[];
  conflictsWithPrincipleIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Rule {
  id: string;
  principleId: string;
  ruleIds: string[];
  implementationIds: string[];
  type?: string;
  status?: string;
  lifecycleState?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Implementation {
  id: string;
  ruleId: string;
  type?: string;
  lifecycleState?: string;
  [key: string]: unknown;
}

export interface PrincipleValueMetrics {
  principleId: string;
  painPreventedCount?: number;
  lastPainPreventedAt?: string;
  avgPainSeverityPrevented?: number;
  totalOpportunities?: number;
  adheredCount?: number;
  violatedCount?: number;
  implementationCost?: number;
  benefitScore?: number;
  calculatedAt?: string;
}

export interface LedgerPrinciple extends Principle {
  suggestedRules?: string[];
  lastTriggeredAt?: string;
}

export interface LedgerRule extends Rule {
  implementationIds: string[];
}

export interface LedgerTreeStore {
  principles: Record<string, LedgerPrinciple>;
  rules: Record<string, LedgerRule>;
  implementations: Record<string, Implementation>;
  metrics: Record<string, PrincipleValueMetrics>;
  lastUpdated: string;
}

export interface LegacyPrincipleTrainingState {
  principleId: string;
  evaluability: 'deterministic' | 'weak_heuristic' | 'manual_only';
  applicableOpportunityCount: number;
  observedViolationCount: number;
  complianceRate: number;
  violationTrend: number;
  generatedSampleCount: number;
  approvedSampleCount: number;
  includedTrainRunIds: string[];
  deployedCheckpointIds: string[];
  lastEvalScore?: number;
  internalizationStatus:
    | 'prompt_only'
    | 'needs_training'
    | 'in_training'
    | 'deployed_pending_eval'
    | 'internalized'
    | 'regressed';
}

export type LegacyPrincipleTrainingStore = Record<string, LegacyPrincipleTrainingState>;

export interface HybridLedgerStore {
  trainingStore: LegacyPrincipleTrainingStore;
  tree: LedgerTreeStore;
}

export const TREE_NAMESPACE = '_tree';
```

- [ ] **Step 2: Re-export from runtime-v2/types/index.ts**

Add to `packages/principles-core/src/runtime-v2/types/index.ts`:

```typescript
export * from './ledger-store.js';
```

- [ ] **Step 3: Commit**

```bash
git add packages/principles-core/src/runtime-v2/types/ledger-store.ts packages/principles-core/src/runtime-v2/types/index.ts
git commit -m "refactor(core): extract ledger types to pure module (PRI-443)"
```

### Task 1.2: Update principle-tree-ledger.ts to import types from new module

**Files:**
- Modify: `packages/principles-core/src/principle-tree-ledger.ts`

- [ ] **Step 1: Replace type definitions with imports**

Remove all type/interface/const definitions (lines 24-131 in original file) and replace with:

```typescript
import type {
  PrincipleStatus,
  PrinciplePriority,
  PrincipleScope,
  PrincipleEvaluability,
  Principle,
  Rule,
  Implementation,
  PrincipleValueMetrics,
  LedgerPrinciple,
  LedgerRule,
  LedgerTreeStore,
  LegacyPrincipleTrainingState,
  LegacyPrincipleTrainingStore,
  HybridLedgerStore,
} from './runtime-v2/types/ledger-store.js';

export type {
  PrincipleStatus,
  PrinciplePriority,
  PrincipleScope,
  PrincipleEvaluability,
  Principle,
  Rule,
  Implementation,
  PrincipleValueMetrics,
  LedgerPrinciple,
  LedgerRule,
  LedgerTreeStore,
  LegacyPrincipleTrainingState,
  LegacyPrincipleTrainingStore,
  HybridLedgerStore,
};

import { TREE_NAMESPACE } from './runtime-v2/types/ledger-store.js';
export { TREE_NAMESPACE };
```

Keep all parser functions, I/O functions, and public API functions in place.

- [ ] **Step 2: Run build to verify compilation**

```bash
cd packages/principles-core && npm run build
```
Expected: Build succeeds with no errors.

- [ ] **Step 3: Run existing tests**

```bash
cd packages/principles-core && npm run test
```
Expected: All tests pass.

- [ ] **Step 4: Update architecture-regression test**

In `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`:

Find the assertion at line ~3472:
```typescript
it('HybridLedgerStore is defined exactly once in core/src/', () => {
  const hits = findDefinitions(/export\s+interface\s+HybridLedgerStore\s*\{/);
  expect(hits).toEqual(['principle-tree-ledger.ts']);
});
```

Change to:
```typescript
it('HybridLedgerStore is defined exactly once in core/src/', () => {
  const hits = findDefinitions(/export\s+interface\s+HybridLedgerStore\s*\{/);
  expect(hits).toEqual(['runtime-v2/types/ledger-store.ts']);
});
```

Also find the assertion at line ~2814:
```typescript
const src = readFileSync(resolve(__dirname, '..', '..', 'principle-tree-ledger.ts'), 'utf-8');
expect(src).toContain('lastTriggeredAt');
```

Change to:
```typescript
const src = readFileSync(resolve(__dirname, '..', 'types', 'ledger-store.ts'), 'utf-8');
expect(src).toContain('lastTriggeredAt');
```

- [ ] **Step 5: Run architecture-regression test**

```bash
cd packages/principles-core && npx vitest run src/runtime-v2/__tests__/architecture-regression.test.ts
```
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(core): principle-tree-ledger imports types from pure module (PRI-443)"
```

---

## Phase 2: Extract pure parsers to ledger-codec.ts

**Goal:** Move all parse/serialize/helper functions out of `principle-tree-ledger.ts` into a pure module with zero I/O imports.

### Task 2.1: Create ledger-codec.ts

**Files:**
- Create: `packages/principles-core/src/runtime-v2/principle-tree/ledger-codec.ts`
- Create: `packages/principles-core/src/runtime-v2/principle-tree/index.ts`

- [ ] **Step 1: Create the codec file**

Move these functions from `principle-tree-ledger.ts` to `ledger-codec.ts`:
- `isRecord`, `stringArray`, `clampFloat`, `clampInt`, `uniqueStrings` (helpers)
- `parseLegacyTrainingStore`, `parsePrinciples`, `parseRules`, `parseImplementations`, `parseMetrics` (parsers)
- `createEmptyTree`, `parseTree` (tree parsers)
- `serializeLedger` (serializer)
- `VALID_EVALUABILITIES`, `VALID_INTERNALIZATION_STATUSES` (constants)

```typescript
/**
 * Ledger codec — pure parse/serialize functions, zero I/O.
 *
 * Extracted from principle-tree-ledger.ts to separate pure logic
 * from filesystem operations.
 */

import type {
  LegacyPrincipleTrainingStore,
  LegacyPrincipleTrainingState,
  LedgerPrinciple,
  LedgerRule,
  Implementation,
  PrincipleValueMetrics,
  LedgerTreeStore,
  HybridLedgerStore,
} from '../types/ledger-store.js';
import { TREE_NAMESPACE } from '../types/ledger-store.js';

const VALID_EVALUABILITIES = ['deterministic', 'weak_heuristic', 'manual_only'] as const;
const VALID_INTERNALIZATION_STATUSES = [
  'prompt_only', 'needs_training', 'in_training',
  'deployed_pending_eval', 'internalized', 'regressed',
] as const;

// --- Helpers ---

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((e): e is string => typeof e === 'string') : [];
}

export function clampFloat(value: unknown, opts: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return opts.fallback;
  return Math.max(opts.min, Math.min(opts.max, value));
}

export function clampInt(value: unknown, opts: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return opts.fallback;
  return Math.max(opts.min, Math.min(opts.max, Math.round(value)));
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

// --- Parsers ---

export function parseLegacyTrainingStore(raw: unknown): LegacyPrincipleTrainingStore {
  if (!isRecord(raw)) return {};
  const result: LegacyPrincipleTrainingStore = {};
  for (const [principleId, candidate] of Object.entries(raw)) {
    if (principleId === TREE_NAMESPACE || !isRecord(candidate)) continue;
    if (candidate.principleId !== principleId) continue;
    result[principleId] = {
      principleId,
      evaluability: VALID_EVALUABILITIES.includes(candidate.evaluability as typeof VALID_EVALUABILITIES[number])
        ? candidate.evaluability as LegacyPrincipleTrainingState['evaluability']
        : 'manual_only',
      applicableOpportunityCount: clampInt(candidate.applicableOpportunityCount, { min: 0, max: Infinity, fallback: 0 }),
      observedViolationCount: clampInt(candidate.observedViolationCount, { min: 0, max: Infinity, fallback: 0 }),
      complianceRate: clampFloat(candidate.complianceRate, { min: 0, max: 1, fallback: 0 }),
      violationTrend: clampFloat(candidate.violationTrend, { min: -1, max: 1, fallback: 0 }),
      generatedSampleCount: clampInt(candidate.generatedSampleCount, { min: 0, max: Infinity, fallback: 0 }),
      approvedSampleCount: clampInt(candidate.approvedSampleCount, { min: 0, max: Infinity, fallback: 0 }),
      includedTrainRunIds: stringArray(candidate.includedTrainRunIds),
      deployedCheckpointIds: stringArray(candidate.deployedCheckpointIds),
      lastEvalScore: typeof candidate.lastEvalScore === 'number' && Number.isFinite(candidate.lastEvalScore)
        ? clampFloat(candidate.lastEvalScore, { min: 0, max: 1, fallback: 0 }) : undefined,
      internalizationStatus: VALID_INTERNALIZATION_STATUSES.includes(
        candidate.internalizationStatus as typeof VALID_INTERNALIZATION_STATUSES[number],
      )
        ? candidate.internalizationStatus as LegacyPrincipleTrainingState['internalizationStatus']
        : 'prompt_only',
    };
  }
  return result;
}

export function parsePrinciples(raw: unknown): Record<string, LedgerPrinciple> {
  if (!isRecord(raw)) return {};
  const principles: Record<string, LedgerPrinciple> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    principles[id] = {
      ...value,
      id,
      ruleIds: stringArray(value.ruleIds),
      conflictsWithPrincipleIds: stringArray(value.conflictsWithPrincipleIds),
      derivedFromPainIds: stringArray(value.derivedFromPainIds),
    } as LedgerPrinciple;
  }
  return principles;
}

export function parseRules(raw: unknown): Record<string, LedgerRule> {
  if (!isRecord(raw)) return {};
  const rules: Record<string, LedgerRule> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    rules[id] = {
      ...value,
      id,
      principleId: typeof value.principleId === 'string' ? value.principleId : '',
      implementationIds: stringArray(value.implementationIds),
    } as LedgerRule;
  }
  return rules;
}

export function parseImplementations(raw: unknown): Record<string, Implementation> {
  if (!isRecord(raw)) return {};
  const implementations: Record<string, Implementation> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value.ruleId !== 'string') continue;
    implementations[id] = { ...value, id, ruleId: value.ruleId };
  }
  return implementations;
}

export function parseMetrics(raw: unknown): Record<string, PrincipleValueMetrics> {
  if (!isRecord(raw)) return {};
  const metrics: Record<string, PrincipleValueMetrics> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    metrics[id] = { ...value, principleId: typeof value.principleId === 'string' ? value.principleId : id };
  }
  return metrics;
}

export function createEmptyTree(): LedgerTreeStore {
  return { principles: {}, rules: {}, implementations: {}, metrics: {}, lastUpdated: new Date(0).toISOString() };
}

export function parseTree(raw: unknown): LedgerTreeStore {
  if (!isRecord(raw)) return createEmptyTree();
  return {
    principles: parsePrinciples(raw.principles),
    rules: parseRules(raw.rules),
    implementations: parseImplementations(raw.implementations),
    metrics: parseMetrics(raw.metrics),
    lastUpdated: typeof raw.lastUpdated === 'string' ? raw.lastUpdated : new Date(0).toISOString(),
  };
}

export function parseHybridLedger(raw: unknown): HybridLedgerStore {
  if (!isRecord(raw)) return { trainingStore: {}, tree: createEmptyTree() };
  const trainingStoreRaw = raw.trainingStore ?? raw;
  const treeRaw = raw[TREE_NAMESPACE] ?? raw.tree;
  return {
    trainingStore: parseLegacyTrainingStore(trainingStoreRaw),
    tree: parseTree(treeRaw),
  };
}

export function serializeLedger(store: HybridLedgerStore): string {
  return JSON.stringify({
    ...store.trainingStore,
    [TREE_NAMESPACE]: { ...store.tree, lastUpdated: new Date().toISOString() },
  }, null, 2);
}
```

- [ ] **Step 2: Create barrel file**

`packages/principles-core/src/runtime-v2/principle-tree/index.ts`:

```typescript
export * from './ledger-codec.js';
```

- [ ] **Step 3: Commit**

```bash
git add packages/principles-core/src/runtime-v2/principle-tree/
git commit -m "refactor(core): extract ledger codec to pure module (PRI-443)"
```

### Task 2.2: Update principle-tree-ledger.ts to use codec module

**Files:**
- Modify: `packages/principles-core/src/principle-tree-ledger.ts`

- [ ] **Step 1: Remove moved functions, import from codec**

Replace the helper functions, parsers, and serializer with imports:

```typescript
import {
  isRecord,
  uniqueStrings,
  createEmptyTree,
  parseHybridLedger,
  serializeLedger,
} from './runtime-v2/principle-tree/ledger-codec.js';
```

Remove the now-duplicate function definitions. Keep only the I/O functions:
- `getLedgerFilePath`
- `readLedgerFromFile` (now calls `parseHybridLedger` instead of inline parsing)
- `mutateLedger`
- `loadLedger`, `saveLedger`, `addPrincipleToLedger`, `updatePrinciple`, `updatePrincipleValueMetrics`, `getLedgerFilePathPublic`

The `readLedgerFromFile` function simplifies to:

```typescript
function readLedgerFromFile(filePath: string): HybridLedgerStore {
  if (!fs.existsSync(filePath)) {
    return { trainingStore: {}, tree: createEmptyTree() };
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content || content.trim() === '') {
      return { trainingStore: {}, tree: createEmptyTree() };
    }
    const parsed = JSON.parse(content) as unknown;
    return parseHybridLedger(parsed);
  } catch {
    return { trainingStore: {}, tree: createEmptyTree() };
  }
}
```

- [ ] **Step 2: Run build and tests**

```bash
cd packages/principles-core && npm run build && npm run test
```
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(core): principle-tree-ledger uses codec module (PRI-443)"
```

---

## Phase 3: Unify pain-signal.ts

**Goal:** Merge the two duplicate `pain-signal.ts` files into one canonical version.

### Task 3.1: Merge stricter validation into runtime-v2 version

**Files:**
- Modify: `packages/principles-core/src/runtime-v2/types/pain-signal.ts`

- [ ] **Step 1: Add timestamp ISO 8601 validation and context size limit**

The runtime-v2 version is missing two validations from the top-level version:
1. ISO 8601 timestamp format check
2. Context size limit (10KB)

Add these to `validatePainSignal` in `runtime-v2/types/pain-signal.ts`, after the `hydrated` object is created:

```typescript
  // Security: enforce context size limit to prevent memory exhaustion
  const MAX_CONTEXT_SIZE = 10_000;
  if (JSON.stringify(hydrated.context).length > MAX_CONTEXT_SIZE) {
    return { valid: false, errors: ['Context object exceeds maximum size (10KB)'] };
  }

  // Validate ISO 8601 timestamp format
  if (
    typeof hydrated.timestamp === 'string' &&
    isNaN(Date.parse(hydrated.timestamp))
  ) {
    return { valid: false, errors: ['timestamp must be a valid ISO 8601 date string'] };
  }
```

Also add `version` field to the schema (present in top-level, missing in runtime-v2):

```typescript
  /** Schema version for forward compatibility (e.g., '0.1.0') */
  version: Type.Optional(Type.String({ default: '0.1.0' })),
```

And in the `hydrated` object, add:
```typescript
    version: raw.version ?? '0.1.0',
```

- [ ] **Step 2: Run tests**

```bash
cd packages/principles-core && npx vitest run src/runtime-v2/types/__tests__/pain-signal.test.ts
```
Expected: All pass. If any test fails because it expects the old lenient behavior, update the test to match the stricter validation.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(core): merge stricter validation into runtime-v2 pain-signal (PRI-443)"
```

### Task 3.2: Make top-level pain-signal.ts a re-export

**Files:**
- Modify: `packages/principles-core/src/pain-signal.ts`

- [ ] **Step 1: Replace file content with re-export**

```typescript
/**
 * Pain signal schema — re-exported from runtime-v2/types/pain-signal.ts.
 *
 * This file exists for backward compatibility with imports from
 * @principles/core (top-level barrel). The canonical definition
 * lives in runtime-v2/types/pain-signal.ts.
 */

export {
  PainSignalSchema,
  validatePainSignal,
  deriveSeverity,
  PainSeverity,
} from './runtime-v2/types/pain-signal.js';

export type {
  PainSignal,
  PainSignalValidationResult,
} from './runtime-v2/types/pain-signal.js';
```

- [ ] **Step 2: Run build and tests**

```bash
cd packages/principles-core && npm run build && npm run test
```
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(core): top-level pain-signal.ts re-exports from runtime-v2 (PRI-443)"
```

---

## Phase 4: Delete io.ts from core

**Goal:** Remove `io.ts` — its only consumer within core is `principle-tree-ledger.ts`. The plugin already has its own copy.

### Task 4.1: Inline atomicWriteFileSync into principle-tree-ledger.ts

**Files:**
- Modify: `packages/principles-core/src/principle-tree-ledger.ts`

- [ ] **Step 1: Inline atomicWriteFileSync**

Remove the import:
```typescript
import { atomicWriteFileSync } from './io.js';
```

Add the inlined function (simplified, without AsyncQueueLock which is unused in core):

```typescript
const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, data, 'utf8');

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < RENAME_MAX_RETRIES; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      lastError = err as Error;
      const code = (err as { code?: string }).code;
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        if (attempt < RENAME_MAX_RETRIES - 1) {
          const delay = RENAME_BASE_DELAY_MS * Math.pow(2, attempt);
          const waitUntil = Date.now() + delay;
          while (Date.now() < waitUntil) {
            try { fs.accessSync(tmpPath); } catch { /* ignore */ }
          }
        }
        continue;
      }
      break;
    }
  }

  try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
  throw lastError ?? new Error('atomicWriteFileSync: rename failed');
}
```

Note: This function is NOT exported — it's a private utility within `principle-tree-ledger.ts`.

- [ ] **Step 2: Delete io.ts**

Delete `packages/principles-core/src/io.ts`.

- [ ] **Step 3: Remove io.ts export from package.json**

In `packages/principles-core/package.json`, remove the `"./io"` export block:

```json
    "./io": {
      "types": "./dist/io.d.ts",
      "default": "./dist/io.js"
    },
```

- [ ] **Step 4: Update index.ts barrel**

In `packages/principles-core/src/index.ts`, remove:
```typescript
export { atomicWriteFileSync } from './io.js';
```

- [ ] **Step 5: Update architecture-regression test**

Remove or update the assertion at line ~3475:
```typescript
it('atomicWriteFileSync is defined exactly once in core/src/', () => {
  const hits = findDefinitions(/export\s+function\s+atomicWriteFileSync\s*\(/);
  expect(hits).toEqual(['io.ts']);
});
```

Change to verify it's NOT exported from core:
```typescript
it('atomicWriteFileSync is not exported from core/src/', () => {
  const hits = findDefinitions(/export\s+function\s+atomicWriteFileSync\s*\(/);
  expect(hits).toEqual([]);
});
```

- [ ] **Step 6: Run build and tests**

```bash
cd packages/principles-core && npm run build && npm run test
```
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(core): delete io.ts, inline atomicWriteFileSync (PRI-443)"
```

---

## Phase 5: Fix runtime-v2/index.ts barrel exports

**Goal:** Stop re-exporting I/O functions from the runtime-v2 barrel. pd-cli imports should go directly to `@principles/core/principle-tree-ledger`.

### Task 5.1: Remove I/O re-exports from runtime-v2/index.ts

**Files:**
- Modify: `packages/principles-core/src/runtime-v2/index.ts`

- [ ] **Step 1: Remove I/O re-exports**

Remove these lines from `runtime-v2/index.ts`:

```typescript
export { loadLedger, saveLedger, getLedgerFilePathPublic, updatePrinciple } from '../principle-tree-ledger.js';
```

Keep the type re-export:
```typescript
export type { LedgerTreeStore } from '../principle-tree-ledger.js';
```

Change this to import from the new pure types module:
```typescript
export type { LedgerTreeStore, HybridLedgerStore, LedgerPrinciple, LedgerRule } from './types/ledger-store.js';
```

- [ ] **Step 2: Run build**

```bash
cd packages/principles-core && npm run build
```
Expected: Build succeeds (internal callers within core still work because they import directly from `principle-tree-ledger.js`).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(core): stop re-exporting I/O from runtime-v2 barrel (PRI-443)"
```

### Task 5.2: Add principle-tree-ledger export path & update pd-cli imports

**Files:**
- Modify: `packages/principles-core/package.json`
- Modify: `packages/pd-cli/src/commands/candidate.ts`
- Modify: `packages/pd-cli/src/commands/health.ts`
- Modify: `packages/pd-cli/src/services/runtime-adapter-resolver.ts`

- [ ] **Step 1: Add export path to package.json**

In `packages/principles-core/package.json`, add the `"./principle-tree-ledger"` export:

```json
    "./principle-tree-ledger": {
      "types": "./dist/principle-tree-ledger.d.ts",
      "default": "./dist/principle-tree-ledger.js"
    },
```

Place it alphabetically near the other entries (after `"./principle-injector"`).

- [ ] **Step 2: Update candidate.ts import**

`packages/pd-cli/src/commands/candidate.ts` imports from `@principles/core/runtime-v2`:

```typescript
  loadLedger,
  getLedgerFilePathPublic,
```

Remove `loadLedger` and `getLedgerFilePathPublic` from the `@principles/core/runtime-v2` import block. Add:

```typescript
import { loadLedger, getLedgerFilePathPublic } from '@principles/core/principle-tree-ledger';
```

- [ ] **Step 3: Update health.ts import**

`packages/pd-cli/src/commands/health.ts` line 15 imports from `@principles/core/runtime-v2`:

```typescript
import { PruningReadModel, PainChainReadModel, auditCandidateLedgerConsistency, getLedgerFilePathPublic } from '@principles/core/runtime-v2';
```

Split into two imports:

```typescript
import { PruningReadModel, PainChainReadModel, auditCandidateLedgerConsistency } from '@principles/core/runtime-v2';
import { getLedgerFilePathPublic } from '@principles/core/principle-tree-ledger';
```

- [ ] **Step 4: Update runtime-adapter-resolver.ts import**

Change:
```typescript
  loadLedger,
```
(imported from `@principles/core/runtime-v2`)

To:
```typescript
import { loadLedger } from '@principles/core/principle-tree-ledger';
```

Remove `loadLedger` from the `@principles/core/runtime-v2` import block.

- [ ] **Step 5: Run build and tests**

```bash
cd packages/pd-cli && npm run build && npm run test
```
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(pd-cli): import ledger functions from principle-tree-ledger directly (PRI-443)"
```

---

## Phase 6: Add architecture-regression guards

**Goal:** Prevent future I/O code from entering core's pure modules.

### Task 6.1: Add fs/path import guards for pure modules

**Files:**
- Modify: `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`

- [ ] **Step 1: Add guard test**

Add a new describe block:

```typescript
describe('PRI-443: pure modules must not import fs/path', () => {
  const PURE_DIRS = [
    'runtime-v2/types',
    'runtime-v2/principle-tree',
  ];

  it('no file in pure dirs imports fs or path', () => {
    const violations: string[] = [];
    for (const dir of PURE_DIRS) {
      const fullDir = resolve(__dirname, '..', '..', dir);
      if (!existsSync(fullDir)) continue;
      const files = readdirSync(fullDir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
      for (const file of files) {
        const src = readFileSync(resolve(fullDir, file), 'utf-8');
        if (/from\s+['"]fs['"]|from\s+['"]path['"]|from\s+['"]node:fs|from\s+['"]node:path/.test(src)) {
          violations.push(`${dir}/${file}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
```

- [ ] **Step 2: Add barrel export guard**

```typescript
describe('PRI-443: runtime-v2 barrel must not export I/O functions', () => {
  it('runtime-v2/index.ts does not export loadLedger or saveLedger', () => {
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).not.toContain("loadLedger");
    expect(src).not.toContain("saveLedger");
    expect(src).not.toContain("atomicWriteFileSync");
  });
});
```

- [ ] **Step 3: Run architecture-regression test**

```bash
cd packages/principles-core && npx vitest run src/runtime-v2/__tests__/architecture-regression.test.ts
```
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(core): add PRI-443 boundary guards for pure modules (PRI-443)"
```

---

## Phase 7: Final verification

**Status: COMPLETED**

- [x] **Step 1: Build all packages**

```bash
cd packages/principles-core && npm run build
cd packages/openclaw-plugin && npm run build
cd packages/pd-cli && npm run build
```
Result: All builds succeed.

- [x] **Step 2: Run all tests**

```bash
cd packages/principles-core && npm run test   # 5039 passed | 3 skipped | 3 todo
cd packages/openclaw-plugin && npm run test   # 1822 passed | 29 skipped
cd packages/pd-cli && npm run test            # 1072 passed | 2 skipped
cd packages/pd-console && npm run test        # 1108 passed | 1 expected fail
```
Result: All tests pass.

- [x] **Step 3: Run lint**

```bash
npm run lint
```
Result: 0 errors (1 pre-existing warning in create-principles-disciple, unrelated).

- [x] **Step 4: Run verify:merge**

```bash
npm run verify:merge
```
Result: All checks pass (including pd-console typecheck).

- [x] **Step 5: Verify MVP activation channels**

Ran targeted activation tests across all packages:

```bash
# core: activation dispatcher + rule-host writer + evaluator
cd packages/principles-core && npx vitest run \
  src/runtime-v2/activation/__tests__/activation-dispatcher.test.ts \
  src/runtime-v2/activation/writers/__tests__/rule-host-writer.test.ts \
  src/runtime-v2/__tests__/activation-types-helpers.test.ts \
  src/runtime-v2/__tests__/rule-host-evaluator.test.ts
# Result: 149 passed

# plugin: rule-host SQLite source + validation + autocorrect VM
cd packages/openclaw-plugin && npx vitest run \
  tests/core/rule-host-sqlite-source.test.ts \
  tests/core/rule-host-validation.test.ts \
  tests/core/rule-host-autocorrect-vm.test.ts
# Result: 17 passed

# console: activations model + disable route
cd packages/pd-console && npx vitest run \
  tests/models/activations-console-model.test.ts \
  tests/server/routes/activations-disable.test.ts
# Result: 20 passed
```
Result: All MVP activation channel tests PASS (prompt, code_tool_hook, defer_archive). Zero dependency on refactored files confirmed.

**Phase 7 fix:** pd-console's `ApprovalsGroupedConsoleModel.ts` and `ConsoleLifecycleDatasource.ts` were missed in Phase 5 — they still imported `loadLedger` from `@principles/core/runtime-v2`. Fixed by updating imports to `@principles/core/principle-tree-ledger`.

---

## ERR Checklist

| ERR | Title | How avoided |
|-----|-------|-------------|
| ERR-001 | Treat untrusted data as unknown | No new untrusted data handling; existing `isRecord` guards preserved |
| ERR-005 | Do not use `as` to bypass validation | Top-level `pain-signal.ts` had `as Record<string, unknown>` — replaced by re-export from runtime-v2 version which uses `isStringRecord` type guard |
| ERR-009 | Required fields must fail loud | No validation logic changed; stricter validation merged INTO runtime-v2 version |
| ERR-012 | Stale-main rollback | Each phase is a separate commit; git revert per phase is clean |
| ERR-015 | Retry/repair loops state | No retry loops touched |

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| pd-cli import path change breaks CLI | Phase 5.2 updates pd-cli imports; tested in same phase |
| Architecture-regression test failures | Each test assertion update is in the same commit as the code change |
| pain-signal validation behavior change | Stricter validation is additive (was already in top-level version); tests updated in same commit |
| MVP activation channel regression | E2E tests run in Phase 7; channels don't depend on refactored files |

## Out of Scope (follow-up issues)

- `trajectory-store.ts` and `evolution-store.ts` direct SQLite access (SDK convenience, not on MVP path)
- `workflow-funnel-loader.ts` fs/path imports (needs interface extraction)
- Various read-model files with fs/path (lower priority, not on MVP path)
- `runtime-v2/pain-signal-observability.ts` and other read-model files (defer to post-MVP)
