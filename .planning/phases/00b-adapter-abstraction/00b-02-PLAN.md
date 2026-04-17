---
phase: 00b-adapter-abstraction
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/openclaw-plugin/src/core/evolution-hook.ts
  - packages/openclaw-plugin/src/core/principle-injector.ts
  - packages/openclaw-plugin/tests/core/evolution-hook.test.ts
  - packages/openclaw-plugin/tests/core/principle-injector.test.ts
autonomous: true
requirements:
  - SDK-ADP-03
  - SDK-ADP-04
  - SDK-ADP-05

must_haves:
  truths:
    - "EvolutionHook interface has exactly 3 methods: onPainDetected, onPrincipleCreated, onPrinciplePromoted"
    - "PrincipleInjector.getRelevantPrinciples() delegates to selectPrinciplesForInjection"
    - "PrincipleInjector.formatForInjection() delegates to formatPrinciple"
    - "PrincipleInjector accepts InjectionContext with domain, sessionId, budgetChars (no framework-specific fields)"
  artifacts:
    - path: "packages/openclaw-plugin/src/core/evolution-hook.ts"
      provides: "EvolutionHook interface with 3 callback methods + event types + noOpEvolutionHook"
      exports: ["EvolutionHook", "PrincipleCreatedEvent", "PrinciplePromotedEvent", "noOpEvolutionHook"]
    - path: "packages/openclaw-plugin/src/core/principle-injector.ts"
      provides: "PrincipleInjector interface + InjectionContext type + DefaultPrincipleInjector class"
      exports: ["PrincipleInjector", "InjectionContext", "DefaultPrincipleInjector"]
    - path: "packages/openclaw-plugin/tests/core/evolution-hook.test.ts"
      provides: "EvolutionHook interface contract tests"
      min_lines: 80
    - path: "packages/openclaw-plugin/tests/core/principle-injector.test.ts"
      provides: "PrincipleInjector delegation contract tests"
      min_lines: 60
  key_links:
    - from: "src/core/principle-injector.ts"
      to: "src/core/principle-injection.ts"
      via: "import selectPrinciplesForInjection, formatPrinciple"
      pattern: "import.*selectPrinciplesForInjection.*formatPrinciple.*from.*principle-injection"
    - from: "src/core/evolution-hook.ts"
      to: "src/core/pain-signal.ts"
      via: "import type PainSignal"
      pattern: "import type.*PainSignal.*from.*pain-signal"
---

<objective>
Define the EvolutionHook and PrincipleInjector interfaces -- lifecycle observation and principle injection abstractions.

Purpose: EvolutionHook provides a callback-based interface for observing evolution lifecycle events (pain detection, principle creation, promotion) without coupling to EvolutionReducer internals. PrincipleInjector wraps the existing injection logic into a framework-agnostic contract with generic InjectionContext.
Output: Two interface files + DefaultPrincipleInjector implementation + contract tests for both.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md

<interfaces>
<!-- Phase 0a and existing outputs this plan depends on. -->

From packages/openclaw-plugin/src/core/pain-signal.ts:
```typescript
export type PainSignal = Static<typeof PainSignalSchema>;
```

From packages/openclaw-plugin/src/core/principle-injection.ts:
```typescript
export interface InjectablePrinciple {
  id: string;
  text: string;
  priority?: PrinciplePriority;
  createdAt: string;
}
export interface PrincipleSelectionResult {
  selected: InjectablePrinciple[];
  totalChars: number;
  breakdown: { p0: number; p1: number; p2: number };
  hasP0: boolean;
  wasTruncated: boolean;
}
export function selectPrinciplesForInjection(
  principles: InjectablePrinciple[],
  budgetChars: number,
): PrincipleSelectionResult;
export function formatPrinciple(p: InjectablePrinciple): string;
```

From packages/openclaw-plugin/src/core/evolution-types.ts (event shapes to extract minimal payloads from):
```typescript
export interface CandidateCreatedData {
  principleId: string;
  trigger: string;
  action: string;
  // ... many other fields
}
export interface PrinciplePromotedData {
  principleId: string;
  from: 'candidate' | 'probation';
  to: 'probation' | 'active';
  // ... other fields
}
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create EvolutionHook interface + PrincipleInjector interface</name>
  <files>packages/openclaw-plugin/src/core/evolution-hook.ts, packages/openclaw-plugin/src/core/principle-injector.ts</files>
  <read_first>
    - packages/openclaw-plugin/src/core/pain-signal.ts (PainSignal type used by EvolutionHook)
    - packages/openclaw-plugin/src/core/principle-injection.ts (delegate target for PrincipleInjector)
    - packages/openclaw-plugin/src/core/evolution-reducer.ts lines 644-672 (applyEvent switch/case showing the 3 lifecycle events)
    - packages/openclaw-plugin/src/core/evolution-types.ts lines 394-430 (PainDetectedData, CandidateCreatedData, PrinciplePromotedData shapes)
    - packages/openclaw-plugin/src/core/storage-adapter.ts (interface pattern precedent)
  </read_first>
  <action>
Create TWO files:

---

**File 1: `packages/openclaw-plugin/src/core/evolution-hook.ts`**

1. **File header**:
```typescript
/**
 * EvolutionHook interface for the Evolution SDK.
 *
 * Provides a callback-based interface for observing evolution lifecycle
 * events: pain detection, principle creation, and principle promotion.
 *
 * Per D-03, this interface contains only the 3 core event methods.
 * Per D-04, consumers implement the interface directly (no EventEmitter).
 * Hooks not needed can use the provided noOpEvolutionHook and override
 * individual methods.
 */
```

2. **Import** (import type only):
```typescript
import type { PainSignal } from './pain-signal.js';
```

3. **Event types** (minimal, serializable payloads -- NOT full internal types):
```typescript
/** Event payload for principle creation lifecycle events. */
export interface PrincipleCreatedEvent {
  /** Unique principle identifier */
  id: string;
  /** Principle text ("When X, then Y.") */
  text: string;
  /** What triggered this principle's creation */
  trigger: string;
}

/** Event payload for principle promotion lifecycle events. */
export interface PrinciplePromotedEvent {
  /** Unique principle identifier */
  id: string;
  /** Previous status tier */
  from: string;
  /** New status tier */
  to: string;
}
```

4. **EvolutionHook interface** (per D-03, D-04):
```typescript
/**
 * Callback interface for observing evolution lifecycle events.
 *
 * Implement all 3 methods, or spread noOpEvolutionHook and override
 * only the methods you need:
 *
 * @example
 * ```ts
 * const myHook: EvolutionHook = {
 *   ...noOpEvolutionHook,
 *   onPainDetected(signal) { console.log(signal); },
 * };
 * ```
 */
export interface EvolutionHook {
  /** Called when a pain signal is detected and recorded. */
  onPainDetected(signal: PainSignal): void;
  /** Called when a new principle candidate is created. */
  onPrincipleCreated(event: PrincipleCreatedEvent): void;
  /** Called when a principle is promoted to a higher tier. */
  onPrinciplePromoted(event: PrinciplePromotedEvent): void;
}
```

5. **No-op helper** (Claude's discretion -- object literal, not class):
```typescript
/** No-op implementation -- consumers can spread and override individual methods. */
export const noOpEvolutionHook: EvolutionHook = {
  onPainDetected(_signal: PainSignal): void {},
  onPrincipleCreated(_event: PrincipleCreatedEvent): void {},
  onPrinciplePromoted(_event: PrinciplePromotedEvent): void {},
};
```

---

**File 2: `packages/openclaw-plugin/src/core/principle-injector.ts`**

1. **File header**:
```typescript
/**
 * PrincipleInjector interface for the Evolution SDK.
 *
 * Wraps the existing principle injection logic into a framework-agnostic
 * contract. Per D-05, this delegates to selectPrinciplesForInjection and
 * formatPrinciple without any behavioral changes.
 *
 * Per D-06, InjectionContext contains only generic fields (domain, sessionId,
 * budgetChars) -- no framework-specific fields.
 */
```

2. **Imports**:
```typescript
import type { InjectablePrinciple } from './principle-injection.js';
import { selectPrinciplesForInjection, formatPrinciple } from './principle-injection.js';
```

3. **InjectionContext type** (per D-06):
```typescript
/** Generic injection context -- no framework-specific fields. */
export interface InjectionContext {
  /** Domain context (e.g., 'coding', 'writing', 'analysis') */
  domain: string;
  /** Session identifier */
  sessionId: string;
  /** Maximum characters allowed for injected principles */
  budgetChars: number;
}
```

4. **PrincipleInjector interface**:
```typescript
/**
 * Framework-agnostic principle injection interface.
 *
 * Wraps the existing budget-aware selection and formatting logic.
 * Framework adapters convert their context to InjectionContext before calling.
 */
export interface PrincipleInjector {
  /**
   * Select principles relevant for injection within a character budget.
   * Delegates to selectPrinciplesForInjection from principle-injection.ts.
   *
   * @param principles - All available principles to select from
   * @param context - Generic injection context with budget constraint
   * @returns Selected principles in injection order
   */
  getRelevantPrinciples(
    principles: InjectablePrinciple[],
    context: InjectionContext,
  ): InjectablePrinciple[];

  /**
   * Format a single principle for prompt injection.
   * Delegates to formatPrinciple from principle-injection.ts.
   *
   * Format: "- [ID] text"
   *
   * @param principle - The principle to format
   * @returns Formatted string for prompt injection
   */
  formatForInjection(principle: InjectablePrinciple): string;
}
```

5. **DefaultPrincipleInjector** (thin wrapper, delegates):
```typescript
/**
 * Default implementation that delegates to existing functions.
 * Zero rewrite risk -- behavior is identical to calling the functions directly.
 */
export class DefaultPrincipleInjector implements PrincipleInjector {
  getRelevantPrinciples(
    principles: InjectablePrinciple[],
    context: InjectionContext,
  ): InjectablePrinciple[] {
    const result = selectPrinciplesForInjection(principles, context.budgetChars);
    return result.selected;
  }

  formatForInjection(principle: InjectablePrinciple): string {
    return formatPrinciple(principle);
  }
}
```
  </action>
  <verify>
    <automated>cd packages/openclaw-plugin && npx tsc --noEmit 2>&1 | grep -c "error" | xargs -I{} test {} -eq 0 && echo "COMPILE_OK" || echo "COMPILE_FAIL"</automated>
  </verify>
  <acceptance_criteria>
    - File `packages/openclaw-plugin/src/core/evolution-hook.ts` exists
    - Contains `export interface EvolutionHook` with exactly 3 methods: `onPainDetected(signal: PainSignal): void`, `onPrincipleCreated(event: PrincipleCreatedEvent): void`, `onPrinciplePromoted(event: PrinciplePromotedEvent): void`
    - Contains `export interface PrincipleCreatedEvent` with fields: `id: string`, `text: string`, `trigger: string`
    - Contains `export interface PrinciplePromotedEvent` with fields: `id: string`, `from: string`, `to: string`
    - Contains `export const noOpEvolutionHook: EvolutionHook` with 3 no-op methods
    - File `packages/openclaw-plugin/src/core/principle-injector.ts` exists
    - Contains `export interface InjectionContext` with fields: `domain: string`, `sessionId: string`, `budgetChars: number`
    - Contains `export interface PrincipleInjector` with methods: `getRelevantPrinciples(principles, context): InjectablePrinciple[]`, `formatForInjection(principle): string`
    - Contains `export class DefaultPrincipleInjector implements PrincipleInjector`
    - DefaultPrincipleInjector.getRelevantPrinciples calls `selectPrinciplesForInjection` and returns `result.selected`
    - DefaultPrincipleInjector.formatForInjection calls `formatPrinciple`
    - TypeScript compilation succeeds with no errors
  </acceptance_criteria>
  <done>EvolutionHook interface (3 methods + event types + noOpEvolutionHook) and PrincipleInjector interface (InjectionContext + DefaultPrincipleInjector delegation) are defined, compile cleanly, and delegate correctly.</done>
</task>

<task type="auto">
  <name>Task 2: Create contract tests for EvolutionHook and PrincipleInjector</name>
  <files>packages/openclaw-plugin/tests/core/evolution-hook.test.ts, packages/openclaw-plugin/tests/core/principle-injector.test.ts</files>
  <read_first>
    - packages/openclaw-plugin/src/core/evolution-hook.ts (interface being tested)
    - packages/openclaw-plugin/src/core/principle-injector.ts (interface + DefaultPrincipleInjector being tested)
    - packages/openclaw-plugin/src/core/principle-injection.ts (delegate target -- needed for test fixtures)
    - packages/openclaw-plugin/tests/core/principle-injection.test.ts (existing test fixtures pattern)
    - packages/openclaw-plugin/tests/core/storage-conformance.test.ts (contract test pattern)
  </read_first>
  <action>
Create TWO test files:

---

**File 1: `packages/openclaw-plugin/tests/core/evolution-hook.test.ts`**

1. **Imports**:
```typescript
import { describe, it, expect } from 'vitest';
import type { EvolutionHook, PrincipleCreatedEvent, PrinciplePromotedEvent } from '../../src/core/evolution-hook.js';
import { noOpEvolutionHook } from '../../src/core/evolution-hook.js';
import type { PainSignal } from '../../src/core/pain-signal.js';
```

2. **Test fixture helpers**:
```typescript
function validPainSignal(overrides: Partial<PainSignal> = {}): PainSignal {
  return {
    source: 'tool_failure',
    score: 75,
    timestamp: '2026-04-17T00:00:00.000Z',
    reason: 'File not found',
    sessionId: 'session-001',
    agentId: 'main',
    traceId: 'trace-001',
    triggerTextPreview: 'File not found: test.ts',
    domain: 'coding',
    severity: 'high',
    context: {},
    ...overrides,
  };
}
```

3. **Test cases** for EvolutionHook:
   - `describe('EvolutionHook')`:
     - `it('implements all 3 methods')`: Create an object implementing EvolutionHook, call all 3 methods, verify invocation order via a calls array.
     - `it('onPainDetected receives a PainSignal')`: Call onPainDetected with validPainSignal(), verify the signal is passed through unchanged.
     - `it('onPrincipleCreated receives a PrincipleCreatedEvent')`: Call with `{ id: 'p-1', text: 'Test principle', trigger: 'tool failure' }`, verify reception.
     - `it('onPrinciplePromoted receives a PrinciplePromotedEvent')`: Call with `{ id: 'p-1', from: 'candidate', to: 'active' }`, verify reception.

   - `describe('noOpEvolutionHook')`:
     - `it('implements all 3 methods as no-ops')`: Call all 3 methods, verify no errors thrown.
     - `it('can be spread to override individual methods')`: Create `{ ...noOpEvolutionHook, onPainDetected: (s) => calls.push(s.source) }`, call onPainDetected, verify only the overridden method fires, onPrincipleCreated is still no-op.

   - `describe('PrincipleCreatedEvent')`:
     - `it('has required fields: id, text, trigger')`: Verify type narrowing (create a typed const).

   - `describe('PrinciplePromotedEvent')`:
     - `it('has required fields: id, from, to')`: Verify type narrowing (create a typed const).

---

**File 2: `packages/openclaw-plugin/tests/core/principle-injector.test.ts`**

1. **Imports**:
```typescript
import { describe, it, expect } from 'vitest';
import type { PrincipleInjector, InjectionContext } from '../../src/core/principle-injector.js';
import { DefaultPrincipleInjector } from '../../src/core/principle-injector.js';
import type { InjectablePrinciple } from '../../src/core/principle-injection.js';
import { selectPrinciplesForInjection, formatPrinciple } from '../../src/core/principle-injection.js';
```

2. **Test fixture helper**:
```typescript
function makePrinciple(overrides: Partial<InjectablePrinciple> = {}): InjectablePrinciple {
  return {
    id: overrides.id ?? 'P_001',
    text: overrides.text ?? 'Always verify file content before editing',
    priority: overrides.priority ?? 'P1',
    createdAt: overrides.createdAt ?? '2026-04-01T00:00:00.000Z',
  };
}
```

3. **Test cases** for PrincipleInjector:
   - `describe('DefaultPrincipleInjector')`:
     - `it('getRelevantPrinciples delegates to selectPrinciplesForInjection')`:
       - Create 5 principles (P0, P1, P2 mix).
       - Create context with budgetChars: 4000.
       - Call injector.getRelevantPrinciples(principles, context).
       - Compare with direct call: `selectPrinciplesForInjection(principles, 4000).selected`.
       - Assert deep equal.
     - `it('formatForInjection delegates to formatPrinciple')`:
       - Call injector.formatForInjection(makePrinciple({ id: 'P_001', text: 'Test' })).
       - Compare with `formatPrinciple(makePrinciple({ id: 'P_001', text: 'Test' }))`.
       - Assert equal.
     - `it('formatForInjection returns "- [ID] text" format')`:
       - Call with `{ id: 'P_001', text: 'Verify before edit' }`.
       - Assert result equals `- [P_001] Verify before edit`.
     - `it('getRelevantPrinciples respects budget constraint')`:
       - Create principles with long texts totaling >4000 chars.
       - Call with budgetChars: 500.
       - Verify result total chars <= 500 + one forced P0.
     - `it('getRelevantPrinciples returns empty array for empty input')`:
       - Call with `[]`.
       - Assert result is empty array.

   - `describe('InjectionContext')`:
     - `it('has domain, sessionId, and budgetChars fields')`:
       - Create a typed const `const ctx: InjectionContext = { domain: 'coding', sessionId: 's-1', budgetChars: 4000 };`.
       - Assert ctx.domain === 'coding', ctx.sessionId === 's-1', ctx.budgetChars === 4000.
  </action>
  <verify>
    <automated>cd packages/openclaw-plugin && npx vitest run tests/core/evolution-hook.test.ts tests/core/principle-injector.test.ts -x</automated>
  </verify>
  <acceptance_criteria>
    - File `packages/openclaw-plugin/tests/core/evolution-hook.test.ts` exists
    - File `packages/openclaw-plugin/tests/core/principle-injector.test.ts` exists
    - EvolutionHook tests verify: all 3 methods callable, noOpEvolutionHook works, spread+override works, event types have required fields
    - PrincipleInjector tests verify: getRelevantPrinciples delegates correctly to selectPrinciplesForInjection, formatForInjection delegates to formatPrinciple, budget constraint respected, empty input handled
    - All tests pass: `npx vitest run tests/core/evolution-hook.test.ts tests/core/principle-injector.test.ts -x` exits 0
  </acceptance_criteria>
  <done>Both EvolutionHook and PrincipleInjector contract tests pass. Delegation to existing functions verified. noOpEvolutionHook spread-override pattern works. InjectionContext has exactly domain, sessionId, budgetChars (per D-06).</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| EvolutionHook callbacks | External consumer code runs during lifecycle events |
| PrincipleInjector.getRelevantPrinciples input | Caller provides principles array (trusted internal data) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-0b-03 | Denial of Service | EvolutionHook.onPainDetected() | accept | Callback runs in-process; misbehaving hooks can slow but not crash (void return, synchronous per D-04) |
| T-0b-04 | Tampering | PrincipleInjector.getRelevantPrinciples() input | accept | Principles are internal data, not user input; validated upstream |
</threat_model>

<verification>
```bash
cd packages/openclaw-plugin
npx vitest run tests/core/evolution-hook.test.ts tests/core/principle-injector.test.ts -x
```
All tests pass.
</verification>

<success_criteria>
1. EvolutionHook interface has exactly 3 methods per D-03: onPainDetected, onPrincipleCreated, onPrinciplePromoted.
2. noOpEvolutionHook is exported and implements all 3 methods as no-ops per D-04.
3. PrincipleInjector.getRelevantPrinciples() delegates to selectPrinciplesForInjection per D-05.
4. PrincipleInjector.formatForInjection() delegates to formatPrinciple per D-05.
5. InjectionContext has domain, sessionId, budgetChars per D-06 (no framework-specific fields).
6. All contract tests pass, TypeScript compiles cleanly.
</success_criteria>

<output>
After completion, create `.planning/phases/00b-adapter-abstraction/00b-02-SUMMARY.md`
</output>
