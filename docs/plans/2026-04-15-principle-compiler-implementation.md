# Principle Compiler Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a unified reflection pipeline that compiles principles into executable JS rules, closing the enforcement gap in PD.

**Architecture:** A shared `ReflectionContextCollector` gathers Principle + Pain + Session data. The `PrincipleCompiler` (CodeSink) takes this context, generates validate JS code via templates or LLM, and registers it in the ledger so RuleHost can enforce it.

**Tech Stack:** TypeScript, node:vm sandbox, existing TrajectoryDatabase + principle-tree-ledger

**Design doc:** `docs/plans/2026-04-15-principle-compiler-design.md`

**Working directory:** `/home/csuzngjh/code/principles/packages/openclaw-plugin`

---

## Task 1: ReflectionContext Types + Collector

**Files:**
- Create: `src/core/reflection/reflection-context.ts`
- Test: `tests/core/reflection-context.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/reflection-context.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ReflectionContextCollector } from '../../src/core/reflection/reflection-context.js';
import type { ReflectionContext } from '../../src/core/reflection/reflection-context.js';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';
import { saveLedger, type HybridLedgerStore } from '../../src/core/principle-tree-ledger.js';

describe('ReflectionContextCollector', () => {
  let tmpDir: string;
  let stateDir: string;
  let trajectory: TrajectoryDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-reflection-'));
    stateDir = path.join(tmpDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    trajectory = new TrajectoryDatabase({ workspaceDir: tmpDir });
  });

  afterEach(() => {
    trajectory.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for unknown principle', () => {
    const collector = new ReflectionContextCollector(stateDir, trajectory);
    expect(collector.collect('P_UNKNOWN')).toBeNull();
  });

  it('collects principle from ledger', () => {
    setupLedgerWithPrinciple(stateDir);
    const collector = new ReflectionContextCollector(stateDir, trajectory);
    const ctx = collector.collect('P_001');
    expect(ctx).not.toBeNull();
    expect(ctx!.principle.id).toBe('P_001');
  });

  it('returns null when principle has no pain events', () => {
    setupLedgerWithPrinciple(stateDir); // no derivedFromPainIds
    const collector = new ReflectionContextCollector(stateDir, trajectory);
    const ctx = collector.collect('P_001');
    // principle exists but no pain events → null (nothing to ground code on)
    expect(ctx).toBeNull();
  });

  it('collects pain events from trajectory DB', () => {
    const sessionId = 'sess_001';
    setupLedgerWithPrinciple(stateDir, { derivedFromPainIds: ['pain_001'] });
    trajectory.recordSession(sessionId);
    trajectory.recordPainEvent({
      sessionId,
      source: 'tool_failure',
      score: 65,
      reason: 'bash heartbeat.sh failed',
      severity: 'moderate',
      origin: 'system_infer',
    });
    const collector = new ReflectionContextCollector(stateDir, trajectory);
    const ctx = collector.collect('P_001');
    expect(ctx).not.toBeNull();
    expect(ctx!.painEvents.length).toBeGreaterThanOrEqual(1);
    expect(ctx!.painEvents[0].reason).toContain('heartbeat');
  });

  it('collects session snapshot when session exists', () => {
    const sessionId = 'sess_001';
    setupLedgerWithPrinciple(stateDir, { derivedFromPainIds: ['pain_001'], sessionId });
    trajectory.recordSession(sessionId);
    trajectory.recordToolCall({
      sessionId,
      toolName: 'bash',
      outcome: 'failure',
      paramsJson: '{"command":"heartbeat.sh --run-tasks"}',
      errorMessage: 'task timeout',
    });
    trajectory.recordPainEvent({
      sessionId,
      source: 'tool_failure',
      score: 65,
      reason: 'bash heartbeat.sh failed',
      severity: 'moderate',
      origin: 'system_infer',
    });
    const collector = new ReflectionContextCollector(stateDir, trajectory);
    const ctx = collector.collect('P_001');
    expect(ctx).not.toBeNull();
    expect(ctx!.sessionSnapshot).not.toBeNull();
    expect(ctx!.sessionSnapshot.toolCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('collectBatch returns contexts for all eligible principles', () => {
    setupLedgerWithPrinciple(stateDir, { id: 'P_001', derivedFromPainIds: ['pain_001'] });
    setupLedgerWithPrinciple(stateDir, { id: 'P_002', derivedFromPainIds: [] }); // no pain
    const collector = new ReflectionContextCollector(stateDir, trajectory);
    const batch = collector.collectBatch();
    // Only P_001 has pain events (even if empty in DB, it has derivedFromPainIds)
    expect(batch.length).toBeGreaterThanOrEqual(1);
  });
});

// --- Helpers ---
function setupLedgerWithPrinciple(
  stateDir: string,
  opts: { id?: string; derivedFromPainIds?: string[]; sessionId?: string } = {}
) {
  const id = opts.id ?? 'P_001';
  const now = new Date().toISOString();
  const store: HybridLedgerStore = {
    trainingStore: {},
    tree: {
      principles: {
        [id]: {
          id,
          version: 1,
          text: `Principle ${id} text`,
          triggerPattern: '',
          action: '',
          status: 'active',
          priority: 'P1',
          evaluability: 'deterministic',
          scope: 'global',
          valueScore: 0,
          adherenceRate: 0,
          painPreventedCount: 0,
          derivedFromPainIds: opts.derivedFromPainIds ?? [],
          ruleIds: [],
          conflictsWithPrincipleIds: [],
          createdAt: now,
          updatedAt: now,
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: now,
    },
  };
  saveLedger(stateDir, store);
}
```

**Step 2: Run test to verify it fails**

Run: `cd packages/openclaw-plugin && npx vitest run tests/core/reflection-context.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/core/reflection/reflection-context.ts
import type { Principle } from '../../types/principle-tree-schema.js';
import type { NocturnalPainEvent, NocturnalSessionSnapshot } from '../nocturnal-trajectory-extractor.js';
import { createNocturnalTrajectoryExtractor } from '../nocturnal-trajectory-extractor.js';
import { loadLedger } from '../principle-tree-ledger.js';
import type { TrajectoryDatabase } from '../trajectory.js';

export interface ReflectionContext {
  principle: Principle;
  painEvents: NocturnalPainEvent[];
  sessionSnapshot: NocturnalSessionSnapshot | null;
  lineage: {
    sourcePainIds: string[];
    sessionId: string | null;
  };
}

export class ReflectionContextCollector {
  private readonly stateDir: string;
  private readonly trajectory: TrajectoryDatabase;

  constructor(stateDir: string, trajectory: TrajectoryDatabase) {
    this.stateDir = stateDir;
    this.trajectory = trajectory;
  }

  collect(principleId: string): ReflectionContext | null {
    const ledger = loadLedger(this.stateDir);
    const principle = ledger.tree.principles[principleId];
    if (!principle) return null;

    const painIds = principle.derivedFromPainIds ?? [];
    if (painIds.length === 0) return null;

    // Collect pain events — find sessions that have pain events matching our IDs
    // Since we can't query by painId directly, we look for pain events in sessions
    const allPainEvents = this.trajectory.listPainEventsForSession(
      this.findSessionForPainIds(painIds)
    );
    const painEvents: NocturnalPainEvent[] = allPainEvents
      .filter((e) => e.source && e.score > 0)
      .map((e) => ({
        source: e.source,
        score: e.score,
        reason: e.reason ?? '',
        severity: e.severity ?? 'mild',
        origin: (e.origin as 'system_infer') ?? 'system_infer',
      }));

    // Get session snapshot if session exists
    let sessionSnapshot: NocturnalSessionSnapshot | null = null;
    const sessionId = this.findSessionForPainIds(painIds);
    if (sessionId) {
      const extractor = createNocturnalTrajectoryExtractor(
        this.trajectory['workspaceDir'] ?? '',
      );
      sessionSnapshot = extractor.getNocturnalSessionSnapshot(sessionId);
    }

    return {
      principle,
      painEvents,
      sessionSnapshot,
      lineage: {
        sourcePainIds: painIds,
        sessionId,
      },
    };
  }

  collectBatch(filter?: { status?: string }): ReflectionContext[] {
    const ledger = loadLedger(this.stateDir);
    const results: ReflectionContext[] = [];
    for (const principle of Object.values(ledger.tree.principles)) {
      if (filter?.status && principle.status !== filter.status) continue;
      const ctx = this.collect(principle.id);
      if (ctx) results.push(ctx);
    }
    return results;
  }

  private findSessionForPainIds(_painIds: string[]): string {
    // TODO: implement proper painId → sessionId resolution
    // For now, return empty string (no session match)
    return '';
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/openclaw-plugin && npx vitest run tests/core/reflection-context.test.ts`
Expected: Some tests pass, session-based ones may need helper refinement

**Step 5: Iterate until all tests pass, then commit**

```bash
git add src/core/reflection/reflection-context.ts tests/core/reflection-context.test.ts
git commit -m "feat: add ReflectionContextCollector for unified pipeline input"
```

---

## Task 2: Code Validator

**Files:**
- Create: `src/core/principle-compiler/code-validator.ts`
- Test: `tests/core/code-validator.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/code-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateGeneratedCode } from '../../src/core/principle-compiler/code-validator.js';

describe('validateGeneratedCode', () => {
  it('accepts valid code with meta and evaluate', () => {
    const code = `
export const meta = { name: 'test', version: '1.0.0' };
export function evaluate(input) {
  return { matched: false };
}
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(true);
  });

  it('rejects code with require()', () => {
    const code = `
export const meta = {};
export function evaluate(input) {
  const fs = require('fs');
  return { matched: false };
}
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('require');
  });

  it('rejects code with import statement', () => {
    const code = `
import fs from 'fs';
export const meta = {};
export function evaluate(input) { return { matched: false }; }
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('import');
  });

  it('rejects code with fetch()', () => {
    const code = `
export const meta = {};
export function evaluate(input) {
  fetch('http://evil.com');
  return { matched: false };
}
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('fetch');
  });

  it('rejects code with eval()', () => {
    const code = `
export const meta = {};
export function evaluate(input) {
  eval('1+1');
  return { matched: false };
}
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
  });

  it('rejects code with process/global access', () => {
    const code = `
export const meta = {};
export function evaluate(input) {
  process.exit(1);
  return { matched: false };
}
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
  });

  it('rejects code with syntax errors', () => {
    const code = `function { invalid syntax }}}`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('syntax');
  });

  it('rejects code missing evaluate function', () => {
    const code = `export const meta = {};`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('evaluate');
  });

  it('rejects code where evaluate does not return matched boolean', () => {
    const code = `
export const meta = {};
export function evaluate(input) {
  return { decision: 'block' };
}
`;
    // This one returns an object but evaluate itself can't be type-checked at runtime
    // The validator should at least run it with a mock input
    const result = validateGeneratedCode(code);
    // evaluate returns object without matched field → should flag
    expect(result.valid).toBe(false);
  });

  it('accepts code that blocks on tool match', () => {
    const code = `
export const meta = { name: 'Auto_P_066', ruleId: 'R_P066_auto' };
export function evaluate(input) {
  if (input.action.toolName === 'bash') {
    const cmd = input.action.paramsSummary.command || '';
    if (/heartbeat/.test(cmd)) {
      return { decision: 'block', matched: true, reason: 'blocked' };
    }
  }
  return { matched: false };
}
`;
    const result = validateGeneratedCode(code);
    expect(result.valid).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/openclaw-plugin && npx vitest run tests/core/code-validator.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/core/principle-compiler/code-validator.ts
import { loadRuleImplementationModule } from '../rule-implementation-runtime.js';
import type { RuleHostInput } from '../rule-host-types.js';

const FORBIDDEN_PATTERNS = [
  { pattern: /\brequire\s*\(/, name: 'require' },
  { pattern: /\bimport\s+/, name: 'import' },
  { pattern: /\bfetch\s*\(/, name: 'fetch' },
  { pattern: /\beval\s*\(/, name: 'eval' },
  { pattern: /\bFunction\s*\(/, name: 'Function constructor' },
  { pattern: /\bprocess\b/, name: 'process' },
  { pattern: /\bglobalThis\b/, name: 'globalThis' },
];

const MOCK_INPUT: RuleHostInput = {
  action: { toolName: 'bash', normalizedPath: '/tmp/test.ts', paramsSummary: { command: 'echo test' } },
  workspace: { isRiskPath: false, planStatus: 'NONE', hasPlanFile: false },
  session: { sessionId: 'test', currentGfi: 0, recentThinking: false },
  evolution: { epTier: 0 },
  derived: { estimatedLineChanges: 0, bashRisk: 'safe' },
};

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateGeneratedCode(code: string): ValidationResult {
  const errors: string[] = [];

  // 1. Syntax check
  try {
    new Function(code);
  } catch (e) {
    errors.push(`syntax error: ${(e as Error).message}`);
    return { valid: false, errors };
  }

  // 2. Forbidden pattern check
  for (const { pattern, name } of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      errors.push(`forbidden pattern: ${name}`);
    }
  }

  // 3. Load in sandbox and check exports
  let moduleExports;
  try {
    moduleExports = loadRuleImplementationModule(code, 'validator-check.js');
  } catch (e) {
    errors.push(`sandbox load failed: ${(e as Error).message}`);
    return { valid: false, errors };
  }

  if (!moduleExports.evaluate || typeof moduleExports.evaluate !== 'function') {
    errors.push('missing evaluate function export');
  }

  if (!moduleExports.meta || typeof moduleExports.meta !== 'object') {
    errors.push('missing meta object export');
  }

  // 4. Execute with mock input to check return shape
  if (typeof moduleExports.evaluate === 'function') {
    try {
      const result = moduleExports.evaluate(MOCK_INPUT);
      if (!result || typeof result !== 'object') {
        errors.push('evaluate() must return an object');
      } else if (typeof result.matched !== 'boolean') {
        errors.push('evaluate() return must have matched: boolean');
      }
    } catch {
      // evaluate throwing on mock input is acceptable (it may need specific input)
    }
  }

  return { valid: errors.length === 0, errors };
}
```

**Step 4: Run tests**

Run: `cd packages/openclaw-plugin && npx vitest run tests/core/code-validator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/principle-compiler/code-validator.ts tests/core/code-validator.test.ts
git commit -m "feat: add code validator for principle compiler output"
```

---

## Task 3: Template Generator

**Files:**
- Create: `src/core/principle-compiler/template-generator.ts`
- Test: `tests/core/template-generator.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/template-generator.test.ts
import { describe, it, expect } from 'vitest';
import { generateFromTemplate, type PainPattern } from '../../src/core/principle-compiler/template-generator.js';

describe('generateFromTemplate', () => {
  it('generates code for single tool + path pattern', () => {
    const patterns: PainPattern[] = [
      { toolName: 'bash', pathRegex: 'heartbeat', commandRegex: '--run-tasks', errorType: 'timeout' },
    ];
    const code = generateFromTemplate('P_066', 'Prevent task in heartbeat', patterns);
    expect(code).toContain('export const meta');
    expect(code).toContain('export function evaluate(input)');
    expect(code).toContain("'bash'");
    expect(code).toContain('heartbeat');
    expect(code).toContain('P_066');
  });

  it('generates code for write tool + path pattern', () => {
    const patterns: PainPattern[] = [
      { toolName: 'write', pathRegex: 'config\\.json$', contentRegex: 'production' },
    ];
    const code = generateFromTemplate('P_050', 'Do not overwrite production config', patterns);
    expect(code).toContain("'write'");
    expect(code).toContain('config');
  });

  it('generates code for multiple tool patterns', () => {
    const patterns: PainPattern[] = [
      { toolName: 'bash', pathRegex: 'heartbeat', commandRegex: 'task' },
      { toolName: 'write', pathRegex: 'heartbeat', contentRegex: 'task' },
    ];
    const code = generateFromTemplate('P_066', 'Separate heartbeat and tasks', patterns);
    expect(code).toContain("'bash'");
    expect(code).toContain("'write'");
    expect(code).toContain('heartbeat');
  });

  it('returns null when no patterns provided', () => {
    expect(generateFromTemplate('P_001', 'desc', [])).toBeNull();
  });

  it('generated code passes validation', () => {
    const patterns: PainPattern[] = [
      { toolName: 'bash', pathRegex: 'heartbeat', commandRegex: 'task' },
    ];
    const code = generateFromTemplate('P_066', 'desc', patterns);
    // Should not contain forbidden patterns
    expect(code).not.toContain('require');
    expect(code).not.toContain('import');
    expect(code).not.toContain('fetch');
    // Should have proper structure
    expect(code).toContain('matched: true');
    expect(code).toContain('decision: ');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/openclaw-plugin && npx vitest run tests/core/template-generator.test.ts`

**Step 3: Write implementation**

```typescript
// src/core/principle-compiler/template-generator.ts

export interface PainPattern {
  toolName: string;
  pathRegex?: string;
  commandRegex?: string;
  contentRegex?: string;
  errorType?: string;
}

export function generateFromTemplate(
  principleId: string,
  coversCondition: string,
  patterns: PainPattern[],
): string | null {
  if (patterns.length === 0) return null;

  const ruleId = `R_${principleId}_auto`;
  const now = new Date().toISOString();

  const branches = patterns.map((p) => generateBranch(principleId, p)).join('\n  ');

  return `// Auto-generated by Principle Compiler
export const meta = {
  name: 'Auto_${principleId}',
  version: '1.0.0',
  ruleId: '${ruleId}',
  coversCondition: '${coversCondition.replace(/'/g, "\\'")}',
  compiledAt: '${now}',
  sourcePrincipleId: '${principleId}',
};

export function evaluate(input) {
  ${branches}
  return { matched: false };
}
`;
}

function generateBranch(principleId: string, pattern: PainPattern): string {
  const conditions: string[] = [];

  conditions.push(`input.action.toolName === '${pattern.toolName}'`);

  if (pattern.pathRegex) {
    conditions.push(`/${pattern.pathRegex}/.test(input.action.normalizedPath || '')`);
  }

  if (pattern.commandRegex && pattern.toolName === 'bash') {
    conditions.push(`/${pattern.commandRegex}/.test(input.action.paramsSummary.command || '')`);
  }

  if (pattern.contentRegex && (pattern.toolName === 'write' || pattern.toolName === 'edit')) {
    conditions.push(`/${pattern.contentRegex}/.test(input.action.paramsSummary.content || input.action.paramsSummary.new_string || '')`);
  }

  const cond = conditions.join(' && ');
  return `if (${cond}) {
    return { decision: 'block', matched: true, reason: '[${principleId}] ${coversConditionFor(pattern)}' };
  }`;
}

function coversConditionFor(pattern: PainPattern): string {
  const parts = [`tool=${pattern.toolName}`];
  if (pattern.pathRegex) parts.push(`path~/${pattern.pathRegex}/`);
  if (pattern.commandRegex) parts.push(`cmd~/${pattern.commandRegex}/`);
  if (pattern.contentRegex) parts.push(`content~/${pattern.contentRegex}/`);
  return parts.join(' ');
}
```

**Step 4: Run tests**

Run: `cd packages/openclaw-plugin && npx vitest run tests/core/template-generator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/principle-compiler/template-generator.ts tests/core/template-generator.test.ts
git commit -m "feat: add template generator for simple pain patterns"
```

---

## Task 4: Ledger Registrar

**Files:**
- Create: `src/core/principle-compiler/ledger-registrar.ts`
- Test: `tests/core/ledger-registrar.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/ledger-registrar.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { registerCompiledRule } from '../../src/core/principle-compiler/ledger-registrar.js';
import { loadLedger, saveLedger, type HybridLedgerStore } from '../../src/core/principle-tree-ledger.js';

describe('registerCompiledRule', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-registrar-'));
    stateDir = path.join(tmpDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const now = new Date().toISOString();
    const store: HybridLedgerStore = {
      trainingStore: {},
      tree: {
        principles: {
          P_001: {
            id: 'P_001', version: 1, text: 'test', triggerPattern: '',
            action: '', status: 'active', priority: 'P1', evaluability: 'deterministic',
            scope: 'global', valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
            derivedFromPainIds: ['pain_001'], ruleIds: [], conflictsWithPrincipleIds: [],
            createdAt: now, updatedAt: now,
          },
        },
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: now,
      },
    };
    saveLedger(stateDir, store);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates Rule and Implementation in ledger', () => {
    const result = registerCompiledRule(stateDir, {
      principleId: 'P_001',
      codeContent: 'export function evaluate(i) { return { matched: false }; }',
      coversCondition: 'test condition',
    });
    expect(result.ruleId).toBe('R_P001_auto');
    expect(result.implementationId).toBe('IMPL_P001_auto');
    expect(result.success).toBe(true);

    // Verify ledger
    const ledger = loadLedger(stateDir);
    expect(ledger.tree.rules['R_P001_auto']).toBeDefined();
    expect(ledger.tree.rules['R_P001_auto'].enforcement).toBe('block');
    expect(ledger.tree.implementations['IMPL_P001_auto']).toBeDefined();
    expect(ledger.tree.implementations['IMPL_P001_auto'].lifecycleState).toBe('candidate');
  });

  it('links rule to principle', () => {
    registerCompiledRule(stateDir, {
      principleId: 'P_001',
      codeContent: 'export function evaluate(i) { return { matched: false }; }',
      coversCondition: 'test',
    });
    const ledger = loadLedger(stateDir);
    expect(ledger.tree.principles['P_001'].ruleIds).toContain('R_P001_auto');
  });

  it('links implementation to rule', () => {
    registerCompiledRule(stateDir, {
      principleId: 'P_001',
      codeContent: 'export function evaluate(i) { return { matched: false }; }',
      coversCondition: 'test',
    });
    const ledger = loadLedger(stateDir);
    expect(ledger.tree.rules['R_P001_auto'].implementationIds).toContain('IMPL_P001_auto');
  });

  it('throws for missing principle', () => {
    expect(() => registerCompiledRule(stateDir, {
      principleId: 'P_999',
      codeContent: 'export function evaluate(i) { return { matched: false }; }',
      coversCondition: 'test',
    })).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/openclaw-plugin && npx vitest run tests/core/ledger-registrar.test.ts`

**Step 3: Write implementation**

```typescript
// src/core/principle-compiler/ledger-registrar.ts
import { createRule, createImplementation } from '../principle-tree-ledger.js';
import type { LedgerRule } from '../principle-tree-ledger.js';
import type { Implementation } from '../../types/principle-tree-schema.js';

export interface RegisterInput {
  principleId: string;
  codeContent: string;
  coversCondition: string;
}

export interface RegisterResult {
  success: boolean;
  ruleId: string;
  implementationId: string;
  codePath: string;
}

export function registerCompiledRule(stateDir: string, input: RegisterInput): RegisterResult {
  const ruleId = `R_${input.principleId}_auto`;
  const implId = `IMPL_${input.principleId}_auto`;
  const now = new Date().toISOString();

  // 1. Create Rule
  const rule: LedgerRule = {
    id: ruleId,
    version: 1,
    name: `Auto-compiled rule for ${input.principleId}`,
    description: `Automatically compiled from principle ${input.principleId}`,
    type: 'gate',
    triggerCondition: input.coversCondition,
    enforcement: 'block',
    action: 'block_on_match',
    principleId: input.principleId,
    status: 'proposed',
    coverageRate: 0,
    falsePositiveRate: 0,
    implementationIds: [],
    createdAt: now,
    updatedAt: now,
  };
  createRule(stateDir, rule);

  // 2. Create Implementation (code stored via loadEntrySource manifest)
  const impl: Implementation = {
    id: implId,
    ruleId,
    type: 'code',
    path: '', // Code stored in manifest, not file path
    version: '1.0.0',
    coversCondition: input.coversCondition,
    coveragePercentage: 0,
    lifecycleState: 'candidate',
    createdAt: now,
    updatedAt: now,
  };
  createImplementation(stateDir, impl);

  return {
    success: true,
    ruleId,
    implementationId: implId,
    codePath: impl.path,
  };
}
```

**Step 4: Run tests**

Run: `cd packages/openclaw-plugin && npx vitest run tests/core/ledger-registrar.test.ts`

**Step 5: Commit**

```bash
git add src/core/principle-compiler/ledger-registrar.ts tests/core/ledger-registrar.test.ts
git commit -m "feat: add ledger registrar for compiled rules"
```

---

## Task 5: PrincipleCompiler Orchestrator

**Files:**
- Create: `src/core/principle-compiler/compiler.ts`
- Create: `src/core/principle-compiler/index.ts` (barrel export)
- Test: `tests/core/principle-compiler.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/principle-compiler.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PrincipleCompiler } from '../../src/core/principle-compiler/compiler.js';
import { loadLedger, saveLedger, type HybridLedgerStore } from '../../src/core/principle-tree-ledger.js';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';

describe('PrincipleCompiler', () => {
  let tmpDir: string;
  let stateDir: string;
  let trajectory: TrajectoryDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-compiler-'));
    stateDir = path.join(tmpDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    trajectory = new TrajectoryDatabase({ workspaceDir: tmpDir });
  });

  afterEach(() => {
    trajectory.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('compiles a principle with simple pain pattern into code', () => {
    // Setup: principle with bash tool failure
    const sessionId = 'sess_test';
    setupPrinciple(stateDir, 'P_066', { derivedFromPainIds: ['pain_001'] });
    trajectory.recordSession(sessionId);
    trajectory.recordToolCall({
      sessionId,
      toolName: 'bash',
      outcome: 'failure',
      paramsJson: '{"command":"heartbeat.sh --run-tasks"}',
      errorMessage: 'task timeout caused heartbeat skip',
    });
    trajectory.recordPainEvent({
      sessionId,
      source: 'tool_failure',
      score: 65,
      reason: 'bash heartbeat.sh --run-tasks failed with timeout',
      severity: 'moderate',
      origin: 'system_infer',
    });

    const compiler = new PrincipleCompiler(stateDir, trajectory);
    const result = compiler.compileOne('P_066');

    expect(result.success).toBe(true);
    expect(result.ruleId).toBe('R_P066_auto');
    expect(result.code).toContain('evaluate');
    expect(result.code).toContain('bash');

    // Verify ledger has the rule and implementation
    const ledger = loadLedger(stateDir);
    expect(ledger.tree.rules['R_P066_auto']).toBeDefined();
    expect(ledger.tree.implementations['IMPL_P066_auto']).toBeDefined();
  });

  it('skips principle with no pain events', () => {
    setupPrinciple(stateDir, 'P_001', { derivedFromPainIds: [] });
    const compiler = new PrincipleCompiler(stateDir, trajectory);
    const result = compiler.compileOne('P_001');
    expect(result.success).toBe(false);
    expect(result.reason).toContain('no pain');
  });

  it('skips unknown principle', () => {
    const compiler = new PrincipleCompiler(stateDir, trajectory);
    const result = compiler.compileOne('P_UNKNOWN');
    expect(result.success).toBe(false);
  });

  it('compileAll compiles all eligible principles', () => {
    setupPrinciple(stateDir, 'P_001', { derivedFromPainIds: ['pain_001'] });
    setupPrinciple(stateDir, 'P_002', { derivedFromPainIds: [] }); // no pain → skip
    setupPrinciple(stateDir, 'P_003', { derivedFromPainIds: ['pain_003'] });

    const compiler = new PrincipleCompiler(stateDir, trajectory);
    const results = compiler.compileAll();

    // At minimum, should attempt P_001 and P_003
    expect(results.length).toBeGreaterThanOrEqual(2);
  });
});

function setupPrinciple(
  stateDir: string,
  id: string,
  opts: { derivedFromPainIds?: string[] } = {},
) {
  const now = new Date().toISOString();
  const existing = loadLedger(stateDir);
  existing.tree.principles[id] = {
    id, version: 1, text: `Principle ${id}`, triggerPattern: '',
    action: '', status: 'active', priority: 'P1', evaluability: 'deterministic',
    scope: 'global', valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
    derivedFromPainIds: opts.derivedFromPainIds ?? [],
    ruleIds: [], conflictsWithPrincipleIds: [],
    createdAt: now, updatedAt: now,
  };
  saveLedger(stateDir, existing);
}
```

**Step 2: Run test to verify it fails**

Run: `cd packages/openclaw-plugin && npx vitest run tests/core/principle-compiler.test.ts`

**Step 3: Write implementation**

```typescript
// src/core/principle-compiler/compiler.ts
import type { TrajectoryDatabase } from '../trajectory.js';
import { ReflectionContextCollector, type ReflectionContext } from '../reflection/reflection-context.js';
import { generateFromTemplate, type PainPattern } from './template-generator.js';
import { validateGeneratedCode } from './code-validator.js';
import { registerCompiledRule } from './ledger-registrar.js';

export interface CompileResult {
  success: boolean;
  principleId: string;
  ruleId?: string;
  implementationId?: string;
  code?: string;
  reason?: string;
}

export class PrincipleCompiler {
  private readonly stateDir: string;
  private readonly trajectory: TrajectoryDatabase;

  constructor(stateDir: string, trajectory: TrajectoryDatabase) {
    this.stateDir = stateDir;
    this.trajectory = trajectory;
  }

  compileOne(principleId: string): CompileResult {
    const collector = new ReflectionContextCollector(this.stateDir, this.trajectory);
    const ctx = collector.collect(principleId);

    if (!ctx) {
      return { success: false, principleId, reason: 'no reflection context (missing principle or no pain events)' };
    }

    // Extract patterns from pain events
    const patterns = this.extractPatterns(ctx);
    if (patterns.length === 0) {
      return { success: false, principleId, reason: 'no extractable patterns from pain events' };
    }

    // Generate code
    const code = generateFromTemplate(principleId, ctx.principle.text, patterns);
    if (!code) {
      return { success: false, principleId, reason: 'template generation returned null' };
    }

    // Validate
    const validation = validateGeneratedCode(code);
    if (!validation.valid) {
      return { success: false, principleId, reason: `validation failed: ${validation.errors.join(', ')}` };
    }

    // Register in ledger
    try {
      const regResult = registerCompiledRule(this.stateDir, {
        principleId,
        codeContent: code,
        coversCondition: patterns.map((p) => `${p.toolName}${p.pathRegex ? ':' + p.pathRegex : ''}`).join(', '),
      });

      return {
        success: true,
        principleId,
        ruleId: regResult.ruleId,
        implementationId: regResult.implementationId,
        code,
      };
    } catch (e) {
      return { success: false, principleId, reason: `ledger registration failed: ${(e as Error).message}` };
    }
  }

  compileAll(): CompileResult[] {
    const collector = new ReflectionContextCollector(this.stateDir, this.trajectory);
    const contexts = collector.collectBatch({ status: 'active' });
    return contexts.map((ctx) => this.compileOne(ctx.principle.id));
  }

  private extractPatterns(ctx: ReflectionContext): PainPattern[] {
    const patterns: PainPattern[] = [];

    // Group pain events by tool name
    const toolGroups = new Map<string, PainPattern>();
    for (const pain of ctx.painEvents) {
      const toolName = this.inferToolFromPain(pain);
      if (!toolName) continue;

      if (!toolGroups.has(toolName)) {
        toolGroups.set(toolName, { toolName });
      }
      const pattern = toolGroups.get(toolName)!;

      // Extract path regex from reason
      const pathMatch = pain.reason?.match(/on\s+(\S+)/);
      if (pathMatch && !pattern.pathRegex) {
        pattern.pathRegex = escapeRegex(pathMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }
    }

    // Also extract from session tool calls
    if (ctx.sessionSnapshot) {
      for (const tc of ctx.sessionSnapshot.toolCalls) {
        if (tc.outcome === 'failure' && !toolGroups.has(tc.toolName)) {
          toolGroups.set(tc.toolName, { toolName: tc.toolName });
        }
      }
    }

    return Array.from(toolGroups.values());
  }

  private inferToolFromPain(pain: { reason?: string; source?: string }): string | null {
    const reason = pain.reason ?? '';
    if (reason.includes('bash')) return 'bash';
    if (reason.includes('write')) return 'write';
    if (reason.includes('edit')) return 'edit';
    // Fall back to source
    if (pain.source === 'tool_failure') return 'bash'; // common default
    return null;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

**Step 4: Create barrel export**

```typescript
// src/core/principle-compiler/index.ts
export { PrincipleCompiler, type CompileResult } from './compiler.js';
export { validateGeneratedCode, type ValidationResult } from './code-validator.js';
export { generateFromTemplate, type PainPattern } from './template-generator.js';
export { registerCompiledRule, type RegisterInput, type RegisterResult } from './ledger-registrar.js';
```

**Step 5: Run tests**

Run: `cd packages/openclaw-plugin && npx vitest run tests/core/principle-compiler.test.ts`

**Step 6: Commit**

```bash
git add src/core/principle-compiler/ tests/core/principle-compiler.test.ts
git commit -m "feat: add PrincipleCompiler orchestrator with template path"
```

---

## Task 6: Integration — Hook into sync-plugin

**Files:**
- Modify: `scripts/sync-plugin.mjs`
- Modify: `scripts/bootstrap-rules.mjs`

**Step 1:** Add a `compile-principles` step to `sync-plugin.mjs` after bootstrap-rules, calling `PrincipleCompiler.compileAll()`.

**Step 2:** Add a new npm script `"compile-principles"` in `package.json`.

**Step 3:** Run existing tests to verify nothing broke.

Run: `cd packages/openclaw-plugin && npm run test:unit`

**Step 4: Commit**

```bash
git commit -m "feat: wire PrincipleCompiler into sync-plugin pipeline"
```

---

## Task 7: End-to-End Verification

**Files:**
- Create: `tests/integration/principle-compiler-e2e.test.ts`

**Step 1: Write E2E test**

This test creates a full workspace with trajectory DB, registers a principle with pain events, runs the compiler, and verifies RuleHost can load and execute the generated code.

```typescript
// tests/integration/principle-compiler-e2e.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PrincipleCompiler } from '../../src/core/principle-compiler/compiler.js';
import { RuleHost } from '../../src/core/rule-host.js';
import { loadLedger, saveLedger, type HybridLedgerStore } from '../../src/core/principle-tree-ledger.js';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';
import { saveEntrySource } from '../../src/core/code-implementation-storage.js';
import type { RuleHostInput } from '../../src/core/rule-host-types.js';

describe('Principle Compiler E2E', () => {
  let tmpDir: string;
  let stateDir: string;
  let trajectory: TrajectoryDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-e2e-'));
    stateDir = path.join(tmpDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    trajectory = new TrajectoryDatabase({ workspaceDir: tmpDir });
  });

  afterEach(() => {
    trajectory.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('compiled rule is enforced by RuleHost after promotion', () => {
    // 1. Setup principle + pain
    const sessionId = 'sess_e2e';
    const now = new Date().toISOString();
    const store: HybridLedgerStore = {
      trainingStore: {},
      tree: {
        principles: {
          P_066: {
            id: 'P_066', version: 1, text: 'Separate heartbeat from tasks',
            triggerPattern: '', action: '', status: 'active', priority: 'P1',
            evaluability: 'deterministic', scope: 'global', valueScore: 0,
            adherenceRate: 0, painPreventedCount: 0,
            derivedFromPainIds: ['pain_e2e'], ruleIds: [],
            conflictsWithPrincipleIds: [], createdAt: now, updatedAt: now,
          },
        },
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: now,
      },
    };
    saveLedger(stateDir, store);
    trajectory.recordSession(sessionId);
    trajectory.recordToolCall({
      sessionId,
      toolName: 'bash',
      outcome: 'failure',
      paramsJson: '{"command":"heartbeat.sh --run-tasks"}',
      errorMessage: 'timeout',
    });
    trajectory.recordPainEvent({
      sessionId,
      source: 'tool_failure',
      score: 65,
      reason: 'bash heartbeat.sh --run-tasks failed',
      severity: 'moderate',
      origin: 'system_infer',
    });

    // 2. Compile
    const compiler = new PrincipleCompiler(stateDir, trajectory);
    const result = compiler.compileOne('P_066');
    expect(result.success).toBe(true);

    // 3. Promote implementation to active
    const ledger = loadLedger(stateDir);
    const impl = ledger.tree.implementations['IMPL_P066_auto'];
    impl.lifecycleState = 'active';
    // Store code in manifest so RuleHost can load it
    saveEntrySource(stateDir, impl.id, result.code!);
    saveLedger(stateDir, ledger);

    // 4. RuleHost should now block
    const host = new RuleHost(stateDir);
    const hostInput: RuleHostInput = {
      action: {
        toolName: 'bash',
        normalizedPath: null,
        paramsSummary: { command: 'heartbeat.sh --run-tasks' },
      },
      workspace: { isRiskPath: false, planStatus: 'NONE', hasPlanFile: false },
      session: { currentGfi: 0, recentThinking: false },
      evolution: { epTier: 0 },
      derived: { estimatedLineChanges: 0, bashRisk: 'safe' },
    };
    const hostResult = host.evaluate(hostInput);
    expect(hostResult).toBeDefined();
    expect(hostResult!.decision).toBe('block');
    expect(hostResult!.matched).toBe(true);
  });
});
```

**Step 2: Run test**

Run: `cd packages/openclaw-plugin && npx vitest run tests/integration/principle-compiler-e2e.test.ts`

**Step 3: Commit**

```bash
git commit -m "test: add E2E test for principle compiler → RuleHost enforcement"
```

---

## Summary

| Task | Component | Key Files |
|------|-----------|-----------|
| 1 | ReflectionContextCollector | `src/core/reflection/reflection-context.ts` |
| 2 | Code Validator | `src/core/principle-compiler/code-validator.ts` |
| 3 | Template Generator | `src/core/principle-compiler/template-generator.ts` |
| 4 | Ledger Registrar | `src/core/principle-compiler/ledger-registrar.ts` |
| 5 | PrincipleCompiler (orchestrator) | `src/core/principle-compiler/compiler.ts` |
| 6 | Integration hook | `scripts/sync-plugin.mjs` |
| 7 | E2E test | `tests/integration/principle-compiler-e2e.test.ts` |

Each task follows TDD: test first → verify fail → implement → verify pass → commit.
