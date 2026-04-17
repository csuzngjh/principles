---
phase: 00b-adapter-abstraction
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/openclaw-plugin/src/core/pain-signal-adapter.ts
  - packages/openclaw-plugin/tests/core/pain-signal-adapter.test.ts
autonomous: true
requirements:
  - SDK-ADP-01
  - SDK-ADP-02

must_haves:
  truths:
    - "PainSignalAdapter is framework-agnostic via generic type parameter"
    - "capture() translates framework events to PainSignal or returns null"
    - "capture() returns null for translation failures (resilient, non-throwing)"
  artifacts:
    - path: "packages/openclaw-plugin/src/core/pain-signal-adapter.ts"
      provides: "PainSignalAdapter<TRawEvent> interface definition"
      exports: ["PainSignalAdapter"]
    - path: "packages/openclaw-plugin/tests/core/pain-signal-adapter.test.ts"
      provides: "Interface contract tests with mock framework event type"
      min_lines: 60
  key_links:
    - from: "src/core/pain-signal-adapter.ts"
      to: "src/core/pain-signal.ts"
      via: "import type PainSignal"
      pattern: "import type.*PainSignal.*from.*pain-signal"
---

<objective>
Define the PainSignalAdapter interface -- the framework-agnostic boundary for capturing pain signals from any AI agent framework.

Purpose: Decouple pain signal capture from OpenClaw-specific event types, enabling future framework implementations (Claude Code, Cursor, etc.) to plug in without modifying core logic.
Output: Interface file + contract tests.
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
<!-- Phase 0a outputs this plan depends on. Executor should use these directly. -->

From packages/openclaw-plugin/src/core/pain-signal.ts:
```typescript
export const PainSignalSchema = Type.Object({
  source: Type.String({ minLength: 1 }),
  score: Type.Number({ minimum: 0, maximum: 100 }),
  timestamp: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
  sessionId: Type.String(),
  agentId: Type.String(),
  traceId: Type.String(),
  triggerTextPreview: Type.String(),
  domain: Type.String({ default: 'coding' }),
  severity: PainSeverity,
  context: Type.Record(Type.String(), Type.Unknown()),
});
export type PainSignal = Static<typeof PainSignalSchema>;
export function validatePainSignal(input: unknown): PainSignalValidationResult;
export function deriveSeverity(score: number): PainSeverity;
```

From packages/openclaw-plugin/src/core/storage-adapter.ts (pattern precedent):
```typescript
export interface StorageAdapter {
  loadLedger(): Promise<HybridLedgerStore>;
  saveLedger(store: HybridLedgerStore): Promise<void>;
  mutateLedger<T>(mutate: (store: HybridLedgerStore) => T | Promise<T>): Promise<T>;
}
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create PainSignalAdapter interface</name>
  <files>packages/openclaw-plugin/src/core/pain-signal-adapter.ts</files>
  <read_first>
    - packages/openclaw-plugin/src/core/pain-signal.ts (output type this adapter produces)
    - packages/openclaw-plugin/src/core/storage-adapter.ts (pattern precedent: generic interface with doc block)
  </read_first>
  <action>
Create `packages/openclaw-plugin/src/core/pain-signal-adapter.ts` with the following exact content structure:

1. **File header JSDoc** (follow storage-adapter.ts pattern):
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

2. **Import** -- use `import type` only:
```typescript
import type { PainSignal } from './pain-signal.js';
```

3. **Interface definition** (per D-01, D-02):
```typescript
/**
 * Framework-agnostic adapter for capturing pain signals.
 *
 * @typeParam TRawEvent - The framework-specific event type
 * (e.g., PluginHookAfterToolCallEvent for OpenClaw)
 */
export interface PainSignalAdapter<TRawEvent> {
  /**
   * Translate a framework-specific event into a universal PainSignal.
   *
   * Returns null when the event does not produce a pain signal (e.g., the
   * event type is not a failure, or the event lacks required fields).
   *
   * This method performs pure translation only. Trigger decision logic
   * (e.g., GFI threshold checks, tool name filtering) stays in the
   * framework-side hook logic. Per D-02, capture() only translates.
   *
   * Translation failures (malformed events, missing required fields)
   * return null rather than throwing. This keeps the adapter resilient.
   *
   * @param rawEvent - The framework-specific event to translate
   * @returns A valid PainSignal, or null if the event does not produce one
   */
  capture(rawEvent: TRawEvent): PainSignal | null;
}
```

4. No other exports, no classes, no implementations. This is a pure interface file.

5. Use `.js` extension in the import (ESM convention per project conventions).
  </action>
  <verify>
    <automated>npx vitest run tests/core/pain-signal-adapter.test.ts -x 2>/dev/null; grep -q "export interface PainSignalAdapter" packages/openclaw-plugin/src/core/pain-signal-adapter.ts</automated>
  </verify>
  <acceptance_criteria>
    - File `packages/openclaw-plugin/src/core/pain-signal-adapter.ts` exists
    - Contains `export interface PainSignalAdapter<TRawEvent>` with generic type parameter
    - Contains `capture(rawEvent: TRawEvent): PainSignal | null` method
    - Imports `PainSignal` from `./pain-signal.js` using `import type`
    - No other exports besides the interface
    - File starts with JSDoc comment block describing purpose
  </acceptance_criteria>
  <done>PainSignalAdapter interface file exists with generic capture() method, correct imports, and no extra exports.</done>
</task>

<task type="auto">
  <name>Task 2: Create PainSignalAdapter contract tests</name>
  <files>packages/openclaw-plugin/tests/core/pain-signal-adapter.test.ts</files>
  <read_first>
    - packages/openclaw-plugin/src/core/pain-signal-adapter.ts (the interface being tested)
    - packages/openclaw-plugin/tests/core/storage-conformance.test.ts (test pattern precedent: interface contract testing)
    - packages/openclaw-plugin/tests/core/pain-signal.test.ts (test helper pattern: validSignal factory)
  </read_first>
  <action>
Create `packages/openclaw-plugin/tests/core/pain-signal-adapter.test.ts` with the following structure:

1. **Imports** (vitest, interface, PainSignal):
```typescript
import { describe, it, expect } from 'vitest';
import type { PainSignalAdapter } from '../../src/core/pain-signal-adapter.js';
import type { PainSignal } from '../../src/core/pain-signal.js';
import { validatePainSignal } from '../../src/core/pain-signal.js';
```

2. **Mock framework event type** (simulates an OpenClaw-like event):
```typescript
/** Simulated framework-specific event for testing */
interface MockToolCallEvent {
  toolName: string;
  success: boolean;
  errorMessage?: string;
  sessionId: string;
  agentId: string;
  timestamp: string;
}
```

3. **Test implementation** of PainSignalAdapter<MockToolCallEvent>:
```typescript
/** Test adapter that translates MockToolCallEvent to PainSignal */
const mockAdapter: PainSignalAdapter<MockToolCallEvent> = {
  capture(event: MockToolCallEvent): PainSignal | null {
    // Per D-02: pure translation. Only failed tool calls produce signals.
    if (event.success) return null;

    // Per Claude's discretion: return null for malformed events
    if (!event.toolName || !event.errorMessage) return null;

    return {
      source: 'tool_failure',
      score: 75,
      timestamp: event.timestamp,
      reason: `Tool ${event.toolName} failed: ${event.errorMessage}`,
      sessionId: event.sessionId,
      agentId: event.agentId,
      traceId: `test-${Date.now()}`,
      triggerTextPreview: event.errorMessage.slice(0, 100),
      domain: 'coding',
      severity: 'high',
      context: { toolName: event.toolName },
    };
  },
};
```

4. **Helper** to create valid mock events:
```typescript
function mockToolFailure(overrides: Partial<MockToolCallEvent> = {}): MockToolCallEvent {
  return {
    toolName: 'edit_file',
    success: false,
    errorMessage: 'File not found: test.ts',
    sessionId: 'session-001',
    agentId: 'main',
    timestamp: '2026-04-17T00:00:00.000Z',
    ...overrides,
  };
}
```

5. **Test cases**:
   - `describe('PainSignalAdapter')`:
     - `it('captures a failed tool call as PainSignal')`: Pass mockToolFailure(), verify result is non-null, has `source: 'tool_failure'`, and result passes validatePainSignal().
     - `it('returns null for successful tool calls')`: Pass `{ success: true }`, verify returns null.
     - `it('returns null for malformed events missing toolName')`: Pass `{ success: false, toolName: '', errorMessage: 'err' }`, verify returns null.
     - `it('returns null for malformed events missing errorMessage')`: Pass `{ success: false, toolName: 'edit', errorMessage: undefined }`, verify returns null.
     - `it('produces signals that pass validatePainSignal')`: Generate a signal from mockAdapter.capture(), pass to validatePainSignal(), assert `result.valid === true`.
     - `it('satisfies the PainSignalAdapter interface type contract')`: Create a typed const `const adapter: PainSignalAdapter<MockToolCallEvent> = mockAdapter;`, verify `typeof adapter.capture === 'function'`.
  </action>
  <verify>
    <automated>cd packages/openclaw-plugin && npx vitest run tests/core/pain-signal-adapter.test.ts -x</automated>
  </verify>
  <acceptance_criteria>
    - File `packages/openclaw-plugin/tests/core/pain-signal-adapter.test.ts` exists
    - Test suite `describe('PainSignalAdapter')` contains at least 5 test cases
    - All tests pass: `npx vitest run tests/core/pain-signal-adapter.test.ts -x` exits 0
    - Tests verify: successful capture, null for success events, null for malformed events, validatePainSignal pass, interface type satisfaction
    - Test creates a `PainSignalAdapter<MockToolCallEvent>` implementation (proves generic type parameter works)
  </acceptance_criteria>
  <done>All PainSignalAdapter contract tests pass -- interface is generic, capture() translates correctly, returns null for non-pain/malformed events, output validates via validatePainSignal.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Framework event -> PainSignalAdapter.capture() | Untrusted framework event data enters the SDK here |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-0b-01 | Tampering | PainSignalAdapter.capture() output | mitigate | Adapter output validated via validatePainSignal() (Phase 0a) at consumption points |
| T-0b-02 | Information Disclosure | PainSignalAdapter.capture() | accept | PainSignal contains no PII by design; framework adapter responsible for sanitizing triggerTextPreview |
</threat_model>

<verification>
```bash
cd packages/openclaw-plugin
npx vitest run tests/core/pain-signal-adapter.test.ts -x
```
All tests pass.
</verification>

<success_criteria>
1. `pain-signal-adapter.ts` exports `PainSignalAdapter<TRawEvent>` interface with single `capture()` method.
2. `capture()` returns `PainSignal | null`, matching D-01 and D-02.
3. All contract tests pass, including validatePainSignal integration.
4. TypeScript compilation succeeds: `npx tsc --noEmit` clean.
</success_criteria>

<output>
After completion, create `.planning/phases/00b-adapter-abstraction/00b-01-SUMMARY.md`
</output>
