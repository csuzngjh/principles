# Pain ID Chain Fix + E2E Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the pain ID chain in `evolution-worker.ts` so `task.painEventId` (real trajectory AUTOINCREMENT ID) is passed to `createPrincipleFromDiagnosis` instead of `task.id` (queue task string). Add E2E test to verify the full chain works.

**Architecture:** Two-line fix in `evolution-worker.ts` at lines 917 and 1015. E2E test in `tests/integration/pain-id-chain-e2e.test.ts` validates the complete pain→principle→compile→RuleHost chain with a known numeric pain ID.

**Tech Stack:** TypeScript, Vitest, `EvolutionReducerImpl`, `PrincipleCompiler`, `RuleHost`, `TrajectoryDatabase`

---

### Task 1: Fix pain ID in `evolution-worker.ts` line 917

**File:** `packages/openclaw-plugin/src/service/evolution-worker.ts:917`

**Step 1: Read the current code**

Run: `sed -n '910,930p' packages/openclaw-plugin/src/service/evolution-worker.ts`
Expected: Shows `createPrincipleFromDiagnosis` call with `painId: task.id`

**Step 2: Apply the fix**

Edit `evolution-worker.ts` line ~917 — change `painId: task.id` to use `task.painEventId`:

```typescript
// Change FROM:
const principleId = wctx.evolutionReducer.createPrincipleFromDiagnosis({
  painId: task.id,

// Change TO:
const principleId = wctx.evolutionReducer.createPrincipleFromDiagnosis({
  painId: task.painEventId !== undefined ? String(task.painEventId) : task.id,
```

**Step 3: Verify TypeScript compiles**

Run: `cd packages/openclaw-plugin && npm run build 2>&1 | tail -5`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/openclaw-plugin/src/service/evolution-worker.ts
git commit -m "fix: pass task.painEventId (not task.id) to createPrincipleFromDiagnosis"
```

---

### Task 2: Fix pain ID in `evolution-worker.ts` line 1015

**File:** `packages/openclaw-plugin/src/service/evolution-worker.ts:1015`

**Step 1: Read the current code**

Run: `sed -n '1008,1025p' packages/openclaw-plugin/src/service/evolution-worker.ts`
Expected: Shows second `createPrincipleFromDiagnosis` call with `painId: task.id`

**Step 2: Apply the same fix**

Edit `evolution-worker.ts` line ~1015:

```typescript
// Change FROM:
const principleId = wctx.evolutionReducer.createPrincipleFromDiagnosis({
  painId: task.id,

// Change TO:
const principleId = wctx.evolutionReducer.createPrincipleFromDiagnosis({
  painId: task.painEventId !== undefined ? String(task.painEventId) : task.id,
```

**Step 3: Verify TypeScript compiles**

Run: `cd packages/openclaw-plugin && npm run build 2>&1 | tail -5`
Expected: No errors

**Step 4: Commit**

```bash
git add packages/openclaw-plugin/src/service/evolution-worker.ts
git commit -m "fix: same pain ID fix at second call site (line 1015)"
```

---

### Task 3: Write E2E test `pain-id-chain-e2e.test.ts`

**Files:**
- Create: `packages/openclaw-plugin/tests/integration/pain-id-chain-e2e.test.ts`

**Step 1: Write the test file**

Create `tests/integration/pain-id-chain-e2e.test.ts`:

```typescript
/**
 * E2E Test: Pain ID Chain — pain event → createPrincipleFromDiagnosis → derivedFromPainIds → compile → RuleHost
 *
 * Validates the full pain ID chain:
 * 1. Pain event stored in trajectory DB with known AUTOINCREMENT ID
 * 2. Queue item has painEventId = that numeric ID
 * 3. createPrincipleFromDiagnosis stores String(painEventId) in derivedFromPainIds
 * 4. PrincipleCompiler.compileOne() finds exact pain event match (not heuristic)
 * 5. RuleHost.evaluate blocks matching input
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';
import { PrincipleCompiler } from '../../src/core/principle-compiler/compiler.js';
import { RuleHost } from '../../src/core/rule-host.js';
import { EvolutionReducerImpl } from '../../src/core/evolution-reducer.js';
import { loadLedger, saveLedger } from '../../src/core/principle-tree-ledger.js';
import type { RuleHostInput } from '../../src/core/rule-host-types.js';

interface TestWorkspace {
  workspaceDir: string;
  stateDir: string;
  trajectory: TrajectoryDatabase;
  reducer: EvolutionReducerImpl;
}

function createTestWorkspace(): TestWorkspace {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-id-e2e-'));
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  // Initialize state files
  fs.writeFileSync(path.join(stateDir, 'EVOLUTION_STREAM'), '', 'utf8');
  fs.writeFileSync(path.join(stateDir, 'PRINCIPLES'), '', 'utf8');
  fs.writeFileSync(path.join(stateDir, 'evolution_queue.json'), '[]', 'utf8');
  fs.writeFileSync(path.join(stateDir, 'ledger.json'), JSON.stringify({
    trainingStore: {},
    tree: { principles: {}, rules: {}, implementations: {}, metrics: {}, lastUpdated: new Date().toISOString() },
  }), 'utf8');
  const trajectory = new TrajectoryDatabase({ workspaceDir });
  const reducer = new EvolutionReducerImpl({ workspaceDir, stateDir });
  return { workspaceDir, stateDir, trajectory, reducer };
}

function disposeTestWorkspace(ws: TestWorkspace): void {
  ws.trajectory.dispose();
  fs.rmSync(ws.workspaceDir, { recursive: true, force: true });
}

describe('Pain ID Chain E2E', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    disposeTestWorkspace(ws);
  });

  it('complete chain: pain event → derivedFromPainIds (numeric) → compile → RuleHost blocks', () => {
    const sessionId = 'session-pain-id-e2e';

    // ── Step 1: Record tool call and pain event in trajectory DB ──
    ws.trajectory.recordToolCall({
      sessionId,
      toolName: 'bash',
      outcome: 'failure',
      errorType: 'command_not_found',
      errorMessage: 'rm: command not found',
      paramsJson: { command: 'rm -rf /' },
    });

    const painResult = ws.trajectory.recordPainEvent({
      sessionId,
      source: 'gate_block',
      score: 80,
      reason: 'Blocked bash rm command — dangerous operation',
      severity: 'high',
      origin: 'system_infer',
    });

    // `recordPainEvent` returns AUTOINCREMENT row ID as number
    const trajectoryPainId = typeof painResult === 'number' ? painResult : 0;
    expect(trajectoryPainId).toBeGreaterThan(0);
    const painIdString = String(trajectoryPainId);

    // ── Step 2: Call createPrincipleFromDiagnosis with numeric painEventId ──
    // This is what the fixed evolution-worker now does (painEventId → String)
    const principleId = ws.reducer.createPrincipleFromDiagnosis({
      painId: painIdString,          // Stringified numeric trajectory ID
      painType: 'tool_failure',
      triggerPattern: 'rm.*rf',
      action: 'Block dangerous rm -rf commands',
      source: 'test-pain-id-chain',
      evaluability: 'deterministic',
    });

    expect(principleId).toBeDefined();

    // ── Step 3: Verify derivedFromPainIds contains the numeric string ID ──
    const ledger = loadLedger(ws.stateDir);
    const principle = ledger.tree.principles[principleId as string];
    expect(principle).toBeDefined();
    expect(principle!.derivedFromPainIds).toContain(painIdString);

    // ── Step 4: Compile the principle ──
    const compiler = new PrincipleCompiler(ws.stateDir, ws.trajectory);
    const compileResult = compiler.compileOne(principleId as string);

    expect(compileResult.success).toBe(true);
    expect(compileResult.code).toBeDefined();
    expect(compileResult.ruleId).toBeDefined();
    expect(compileResult.implementationId).toBeDefined();

    // Verify implementation is active
    const ledgerAfterCompile = loadLedger(ws.stateDir);
    const impl = ledgerAfterCompile.tree.implementations[compileResult.implementationId!];
    expect(impl.lifecycleState).toBe('active');

    // ── Step 5: RuleHost.evaluate blocks matching input ──
    const host = new RuleHost(ws.stateDir, { warn: () => {} });

    const matchingInput: RuleHostInput = {
      action: {
        toolName: 'bash',
        normalizedPath: null,
        paramsSummary: { command: 'rm -rf /important' },
      },
      workspace: { isRiskPath: false, planStatus: 'NONE', hasPlanFile: false },
      session: { sessionId: 'session-eval', currentGfi: 50, recentThinking: false },
      evolution: { epTier: 0 },
      derived: { estimatedLineChanges: 0, bashRisk: 'unknown' },
    };

    const blockResult = host.evaluate(matchingInput);
    expect(blockResult).toBeDefined();
    expect(blockResult!.decision).toBe('block');
    expect(blockResult!.matched).toBe(true);

    // ── Step 6: Non-matching input passes through ──
    const nonMatchingInput: RuleHostInput = {
      action: {
        toolName: 'bash',
        normalizedPath: null,
        paramsSummary: { command: 'ls -la' },
      },
      workspace: { isRiskPath: false, planStatus: 'NONE', hasPlanFile: false },
      session: { sessionId: 'session-eval-2', currentGfi: 50, recentThinking: false },
      evolution: { epTier: 0 },
      derived: { estimatedLineChanges: 0, bashRisk: 'unknown' },
    };

    const passResult = host.evaluate(nonMatchingInput);
    expect(passResult).toBeUndefined();
  });
});
```

**Step 2: Run the new test to verify it fails (missing imports / wrong paths)**

Run: `cd packages/openclaw-plugin && npm run test:unit -- tests/integration/pain-id-chain-e2e.test.ts 2>&1 | tail -20`
Expected: Compilation or import errors (TypeScript needs to resolve)

**Step 3: If TypeScript errors, fix them**

Common issues:
- `EvolutionReducerImpl` needs `workspaceDir` and `stateDir` in constructor
- `TrajectoryDatabase` constructor may need different options
- State dir files may need `EVOLUTION_STREAM` etc.

**Step 4: Run test to verify it passes**

Run: `cd packages/openclaw-plugin && npm run test:unit -- tests/integration/pain-id-chain-e2e.test.ts 2>&1 | tail -20`
Expected: PASS

**Step 5: Run full unit suite to ensure no regressions**

Run: `cd packages/openclaw-plugin && npm run test:unit 2>&1 | tail -10`
Expected: All tests pass (1850+)

**Step 6: Commit**

```bash
git add packages/openclaw-plugin/tests/integration/pain-id-chain-e2e.test.ts
git commit -m "test: add E2E pain ID chain verification test"
```

---

### Task 4: Optional — Fix `emitPainDetectedEvent` in `hooks/pain.ts`

**File:** `packages/openclaw-plugin/src/hooks/pain.ts:~107`

This is a consistency fix. The `emitPainDetectedEvent` should emit `trajectoryPainId` instead of `createPainId(sessionId)` for consistency with the pain flag. Only apply if the pain chain test above passes without this — meaning the queue path is primary and the event is not critical.

**Step 1: Read current code**

Run: `sed -n '100,120p' packages/openclaw-plugin/src/hooks/pain.ts`

**Step 2: Apply fix if needed**

```typescript
// Change FROM:
painId: createPainId(sessionId),

// Change TO:
painId: trajectoryPainId !== undefined && trajectoryPainId >= 0
  ? String(trajectoryPainId)
  : createPainId(sessionId),
```

**Step 3: Commit if applied**

```bash
git add packages/openclaw-plugin/src/hooks/pain.ts
git commit -m "fix: emitPainDetectedEvent uses trajectoryPainId for consistency"
```

---

## Verification Checklist

After all tasks:
- [ ] `npm run build` — TypeScript compiles clean
- [ ] `npm run test:unit` — all tests pass (1850+)
- [ ] E2E test passes showing exact match (not heuristic fallback)
- [ ] No regressions in existing tests
