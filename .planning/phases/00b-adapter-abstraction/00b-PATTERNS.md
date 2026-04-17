# Phase 0b: Adapter Abstraction - Pattern Map

**Mapped:** 2026-04-17
**Files analyzed:** 8 (4 source + 4 test)
**Analogs found:** 8 / 8

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/core/pain-signal-adapter.ts` | interface | transform | `src/core/storage-adapter.ts` | exact (generic adapter interface pattern) |
| `src/core/evolution-hook.ts` | interface | event-driven | `src/core/evolution-reducer.ts` | exact (event type extraction) |
| `src/core/principle-injector.ts` | interface | transform | `src/core/principle-injection.ts` | exact (wraps existing functions) |
| `src/core/telemetry-event.ts` | model | event-driven | `src/core/pain-signal.ts` | exact (TypeBox schema + validation) |
| `tests/core/pain-signal-adapter.test.ts` | test | transform | `tests/core/storage-conformance.test.ts` | exact (interface contract test) |
| `tests/core/evolution-hook.test.ts` | test | event-driven | `tests/core/evolution-types-loop.test.ts` | role-match |
| `tests/core/principle-injector.test.ts` | test | transform | `tests/core/principle-injection.test.ts` | exact (delegation verification) |
| `tests/core/telemetry-event.test.ts` | test | event-driven | `tests/core/pain-signal.test.ts` | exact (schema validation test) |

## Pattern Assignments

### `src/core/pain-signal-adapter.ts` (interface, transform)

**Analog:** `src/core/storage-adapter.ts` (lines 1-65)

This is the PRIMARY pattern to copy. StorageAdapter is the exact same concept: a generic interface with methods that framework-specific implementations will satisfy.

**File header / doc block pattern** (storage-adapter.ts lines 1-12):
```typescript
/**
 * PainSignalAdapter interface for the Evolution SDK.
 *
 * This interface decouples the evolution engine from specific AI agent
 * frameworks (OpenClaw, Claude Code, etc.). All modules that need to
 * capture pain signals from tool failures should depend on this interface
 * rather than importing framework-specific event types directly.
 *
 * The interface uses a generic type parameter for the raw framework event,
 * so each framework implementation provides its own concrete type.
 */
```

**Generic interface pattern** (storage-adapter.ts lines 30-65):
```typescript
export interface StorageAdapter {
  /**
   * Load the current ledger state from persistence.
   *
   * If no persisted state exists (first run), returns an empty store.
   */
  loadLedger(): Promise<HybridLedgerStore>;

  /**
   * Persist the full ledger state.
   *
   * Must be atomic -- partial writes must never be visible to readers.
   */
  saveLedger(store: HybridLedgerStore): Promise<void>;

  // ...
}
```

**Imports pattern** -- minimal, `import type` only:
```typescript
import type { PainSignal } from './pain-signal.js';
```

**Interface body** -- use generic type parameter `<TRawEvent>` per D-01:
```typescript
export interface PainSignalAdapter<TRawEvent> {
  /**
   * Translate a framework-specific event into a universal PainSignal.
   * Returns null when the event does not produce a signal.
   */
  capture(rawEvent: TRawEvent): PainSignal | null;
}
```

---

### `src/core/evolution-hook.ts` (interface, event-driven)

**Analog:** `src/core/evolution-reducer.ts` (lines 644-672, applyEvent method)

The EvolutionHook interface extracts the 3 lifecycle events from the reducer's internal switch/case. The event data types are already defined in `evolution-types.ts`.

**Event data type extraction pattern** -- extract minimal, serializable payloads from evolution-types.ts:

From evolution-reducer.ts lines 647-660, the existing events:
```typescript
switch (event.type) {
  case 'pain_detected':
    this.onPainDetected(event.data, event.ts);  // PainDetectedData
    return;
  case 'candidate_created':
    this.onCandidateCreated(event.data, event.ts);  // CandidateCreatedData
    return;
  case 'principle_promoted':
    this.onPrinciplePromoted(event.data, event.ts);  // PrinciplePromotedData
    return;
  // ...
}
```

**Imports pattern**:
```typescript
import type { PainSignal } from './pain-signal.js';
```

**Interface + event types pattern** (per D-03, D-04):
```typescript
export interface PrincipleCreatedEvent {
  id: string;
  text: string;
  trigger: string;
}

export interface PrinciplePromotedEvent {
  id: string;
  from: string;
  to: string;
}

export interface EvolutionHook {
  onPainDetected(signal: PainSignal): void;
  onPrincipleCreated(event: PrincipleCreatedEvent): void;
  onPrinciplePromoted(event: PrinciplePromotedEvent): void;
}
```

**Optional no-op helper** (Claude's discretion per RESEARCH open question #1):
```typescript
/** No-op implementation -- consumers can spread and override individual methods. */
export const noOpEvolutionHook: EvolutionHook = {
  onPainDetected(_signal: PainSignal): void {},
  onPrincipleCreated(_event: PrincipleCreatedEvent): void {},
  onPrinciplePromoted(_event: PrinciplePromotedEvent): void {},
};
```

---

### `src/core/principle-injector.ts` (interface, transform)

**Analog:** `src/core/principle-injection.ts` (lines 1-209)

The PrincipleInjector interface wraps the existing `selectPrinciplesForInjection` and `formatPrinciple` functions. Per D-05, zero rewrite risk.

**Imports pattern** -- import existing types to reuse:
```typescript
import type { InjectablePrinciple } from './principle-injection.js';
```

**InjectionContext type** (per D-06):
```typescript
export interface InjectionContext {
  domain: string;
  sessionId: string;
  budgetChars: number;
}
```

**Interface pattern** -- thin wrapper, delegates to existing functions:
```typescript
export interface PrincipleInjector {
  /**
   * Select principles relevant for injection within a character budget.
   * Delegates to selectPrinciplesForInjection from principle-injection.ts.
   */
  getRelevantPrinciples(
    principles: InjectablePrinciple[],
    context: InjectionContext,
  ): InjectablePrinciple[];

  /**
   * Format a single principle for prompt injection.
   * Delegates to formatPrinciple from principle-injection.ts.
   */
  formatForInjection(principle: InjectablePrinciple): string;
}
```

**Key constraint from existing code** (principle-injection.ts lines 123-126):
```typescript
export function selectPrinciplesForInjection(
  principles: InjectablePrinciple[],
  budgetChars: number,
): PrincipleSelectionResult {
```

The `getRelevantPrinciples` method should extract `context.budgetChars` and pass it to `selectPrinciplesForInjection`. The return value should be `PrincipleSelectionResult.selected` (the `InjectablePrinciple[]` portion).

---

### `src/core/telemetry-event.ts` (model, event-driven)

**Analog:** `src/core/pain-signal.ts` (lines 1-137)

The TelemetryEvent schema follows the same TypeBox pattern as PainSignalSchema: schema definition + exported type + optional validation function.

**Imports pattern** (pain-signal.ts lines 11-12):
```typescript
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
```

**TypeBox schema pattern** (pain-signal.ts lines 25-64):
```typescript
export const PainSeverity = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('critical'),
]);

export const PainSignalSchema = Type.Object({
  source: Type.String({ minLength: 1 }),
  score: Type.Number({ minimum: 0, maximum: 100 }),
  // ... more fields
});

export type PainSignal = Static<typeof PainSignalSchema>;
```

**Telemetry event schema pattern** (per D-07, D-08):
```typescript
export const TelemetryEventType = Type.Union([
  Type.Literal('pain_detected'),
  Type.Literal('principle_candidate_created'),
  Type.Literal('principle_promoted'),
]);

export const TelemetryEventSchema = Type.Object({
  eventType: TelemetryEventType,
  traceId: Type.String(),
  timestamp: Type.String(),
  sessionId: Type.String(),
  agentId: Type.Optional(Type.String()),
  payload: Type.Record(Type.String(), Type.Unknown()),
});

export type TelemetryEvent = Static<typeof TelemetryEventSchema>;
```

**Validation pattern** (pain-signal.ts lines 103-136):
```typescript
export function validatePainSignal(input: unknown): PainSignalValidationResult {
  // ...check type, apply defaults, collect TypeBox errors...
  const errors = [...Value.Errors(PainSignalSchema, hydrated)];
  if (errors.length > 0) {
    return { valid: false, errors: errors.map(...) };
  }
  return { valid: true, errors: [], signal: Value.Cast(...) };
}
```

**Alignment with existing EvolutionLogger** (evolution-logger.ts lines 17-24):
```typescript
export type EvolutionStage =
  | 'pain_detected'      // maps to 'pain_detected'
  | 'principle_generated'// maps to 'principle_candidate_created'
  | 'completed'          // maps to 'principle_promoted'
  // ... other stages out of scope
```

---

### `tests/core/pain-signal-adapter.test.ts` (test, transform)

**Analog:** `tests/core/storage-conformance.test.ts` (lines 1-434)

The storage conformance test is the pattern for testing adapter interfaces: it tests the contract that any implementation must satisfy.

**Test structure pattern** (storage-conformance.test.ts lines 1-18):
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// ...imports...
```

**For pain-signal-adapter, the test should**:
1. Define a mock `TRawEvent` type (e.g., `{ toolName: string; error?: string; sessionId: string }`)
2. Create a test implementation of `PainSignalAdapter<MockEvent>`
3. Test that `capture()` returns `PainSignal | null` correctly
4. Test edge cases: null return for non-pain events, malformed events

**Test helper pattern** (pain-signal.test.ts lines 14-29):
```typescript
function validSignal(overrides: Partial<PainSignal> = {}): PainSignal {
  return {
    source: 'tool_failure',
    score: 75,
    // ... all required fields ...
    ...overrides,
  };
}
```

---

### `tests/core/evolution-hook.test.ts` (test, event-driven)

**Analog:** `tests/core/evolution-types-loop.test.ts`

The test should verify:
1. Interface shape: all 3 methods exist with correct signatures
2. Event types: `PrincipleCreatedEvent` and `PrinciplePromotedEvent` have required fields
3. `noOpEvolutionHook` (if provided) implements all methods as no-ops
4. Custom implementations can override individual methods

**Test pattern** -- verify interface satisfaction:
```typescript
it('allows implementing all 3 methods', () => {
  const calls: string[] = [];
  const hook: EvolutionHook = {
    onPainDetected(_signal) { calls.push('pain'); },
    onPrincipleCreated(_event) { calls.push('created'); },
    onPrinciplePromoted(_event) { calls.push('promoted'); },
  };
  // invoke methods...
  expect(calls).toEqual(['pain', 'created', 'promoted']);
});
```

---

### `tests/core/principle-injector.test.ts` (test, transform)

**Analog:** `tests/core/principle-injection.test.ts` (lines 1-224)

This test verifies that the `PrincipleInjector` interface correctly delegates to the existing `selectPrinciplesForInjection` and `formatPrinciple` functions. The existing tests should pass unchanged (D-05).

**Test pattern** -- use same fixtures as principle-injection.test.ts (lines 15-36):
```typescript
function makePrinciple(overrides: Partial<{...}> = {}): InjectablePrinciple {
  return {
    id: overrides.id ?? 'P_001',
    text: overrides.text ?? 'Always verify file content before editing',
    priority: overrides.priority ?? 'P1',
    createdAt: overrides.createdAt ?? '2026-04-01T00:00:00.000Z',
  };
}
```

**Delegation verification pattern**:
```typescript
it('getRelevantPrinciples delegates to selectPrinciplesForInjection', () => {
  const injector: PrincipleInjector = new DefaultPrincipleInjector();
  const principles = [makePrinciple()];
  const context: InjectionContext = { domain: 'coding', sessionId: 's-1', budgetChars: 4000 };
  const result = injector.getRelevantPrinciples(principles, context);
  // Same result as calling selectPrinciplesForInjection(principles, 4000)
});

it('formatForInjection delegates to formatPrinciple', () => {
  const injector: PrincipleInjector = new DefaultPrincipleInjector();
  const p = makePrinciple({ id: 'P_001', text: 'Test' });
  expect(injector.formatForInjection(p)).toBe('- [P_001] Test');
});
```

---

### `tests/core/telemetry-event.test.ts` (test, event-driven)

**Analog:** `tests/core/pain-signal.test.ts` (lines 1-191)

Follow the exact same pattern as pain-signal.test.ts: test schema acceptance, rejection, validation function behavior.

**Test structure** (pain-signal.test.ts):
```typescript
import { describe, it, expect } from 'vitest';
import { TelemetryEventSchema, validateTelemetryEvent, type TelemetryEvent } from '../../src/core/telemetry-event.js';
import { Value } from '@sinclair/typebox/value';

function validEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    eventType: 'pain_detected',
    traceId: 'trace-001',
    timestamp: '2026-04-17T00:00:00.000Z',
    sessionId: 'session-001',
    payload: {},
    ...overrides,
  };
}

describe('TelemetryEventSchema', () => {
  it('accepts a valid pain_detected event', () => {
    expect(Value.Check(TelemetryEventSchema, validEvent())).toBe(true);
  });
  // ... reject missing fields, invalid eventType, etc.
});
```

## Shared Patterns

### Import Conventions
**Source:** All core modules in `src/core/`
**Apply to:** All new source files

```typescript
// Use .js extension in imports (ESM convention)
import type { PainSignal } from './pain-signal.js';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
```

Rules:
- Use `import type` for type-only imports
- Use `.js` extension in relative imports (ESM)
- No barrel imports -- import directly from source file
- Group imports: external packages first, then internal

### File Header / Documentation
**Source:** `src/core/storage-adapter.ts` (lines 1-12), `src/core/pain-signal.ts` (lines 1-10)
**Apply to:** All new source files

```typescript
/**
 * [Module Name] for the Evolution SDK.
 *
 * [1-2 sentence description of purpose]
 *
 * [Additional context about design decisions]
 */
```

Rules:
- Every module starts with a JSDoc comment block
- Describe purpose, not implementation details
- Mention related interfaces when applicable

### TypeBox Schema Pattern
**Source:** `src/core/pain-signal.ts` (lines 41-66)
**Apply to:** `telemetry-event.ts`

```typescript
// 1. Define schema with Type.Object
export const TelemetryEventSchema = Type.Object({ ... });

// 2. Derive TypeScript type from schema
export type TelemetryEvent = Static<typeof TelemetryEventSchema>;

// 3. Provide validation function (optional, for schema validation tests)
export function validateTelemetryEvent(input: unknown): ValidationResult { ... }
```

### Test Conventions
**Source:** All test files in `tests/core/`
**Apply to:** All new test files

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
```

Rules:
- Import from `vitest`, not `jest`
- Use `describe`/`it` blocks for organization
- Helper functions produce valid test fixtures with `overrides` pattern
- Tests exempt from `no-console` and `no-explicit-any` lint rules
- Use `safeRmDir(tmpDir)` in `afterEach` for temp directory cleanup (from `../test-utils.js`)

### Error Handling for Adapters
**Source:** `src/hooks/pain.ts` (lines 37-43), `src/core/evolution-reducer.ts` (lines 131-143)
**Apply to:** PainSignalAdapter error handling (Claude's discretion)

```typescript
// Pattern from pain.ts: wrap calls in try/catch, log errors, continue
try {
  wctx.evolutionReducer.emitSync(event);
} catch (e) {
  SystemLogger.log(wctx.workspaceDir, 'EVOLUTION_EMIT_WARN', `Failed to emit: ${String(e)}`);
}
```

For PainSignalAdapter error handling (per RESEARCH open question #2): Return `null` for translation failures. Log the error for observability but do not propagate.

### Cyclomatic Complexity Constraint
**Source:** CLAUDE.md conventions
**Apply to:** All new source files

- Max cyclomatic complexity: **10** per function
- These interfaces are inherently simple (single methods, thin wrappers)
- Any implementation exceeding complexity 5 should be refactored

## No Analog Found

All 8 files have close analogs in the codebase. No files require falling back to RESEARCH.md patterns alone.

| File | Analog | Confidence |
|------|--------|------------|
| `pain-signal-adapter.ts` | `storage-adapter.ts` (generic interface pattern) | HIGH |
| `evolution-hook.ts` | `evolution-reducer.ts` (event method extraction) | HIGH |
| `principle-injector.ts` | `principle-injection.ts` (function wrapping) | HIGH |
| `telemetry-event.ts` | `pain-signal.ts` (TypeBox schema pattern) | HIGH |
| All 4 test files | Existing test files in `tests/core/` | HIGH |

## Metadata

**Analog search scope:** `packages/openclaw-plugin/src/core/`, `packages/openclaw-plugin/tests/core/`, `packages/openclaw-plugin/src/hooks/`
**Files scanned:** 12 source files, 78 test files
**Pattern extraction date:** 2026-04-17
