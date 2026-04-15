# Phase 43: Type-Safety - Research

**Researched:** 2026-04-15
**Domain:** TypeScript type safety, branded types, discriminated unions
**Confidence:** HIGH

## Summary

This phase eliminates 36 `as any`/`as unknown` casts across the codebase through three mechanisms: (1) branded types for domain identifiers (QueueItemId, WorkflowId, SessionKey) using the intersection type brand pattern, (2) discriminated union for event payloads replacing the generic `Record<string, unknown>` pattern in EventLogEntry, and (3) proper type definitions for runtime-extended objects (lifecycleState on Implementation, sessionId on PluginCommandContext). TypeScript strict mode is already enabled (tsconfig: `"strict": true`), so the compiler will enforce all fixes.

**Primary recommendation:** Use intersection type brand pattern for identifiers and type predicates for runtime-extended properties. Create the discriminated union for events by mapping each EventType string literal to its specific data interface.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Branded types (QueueItemId, WorkflowId, SessionKey) | API/Backend | -- | Queue and workflow IDs are core data layer identifiers |
| EventLogEntry discriminated union | API/Backend | -- | Event logging spans the entire application |
| `as any` cast fixes in prompt.ts/subagent.ts | API/Backend | Frontend Server | Plugin hooks run in backend context |
| `as any` cast fixes in rollback.ts/pain.ts | API/Backend | -- | Command handlers are pure backend logic |

---

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Use intersection type brand pattern: `type Brand<T, B> = T & { readonly _brand: B }`
- **D-02:** Create `src/types/queue.ts` with QueueItemId, WorkflowId, SessionKey branded types
- **D-03:** Create type constructor functions for each brand (`toQueueItemId()`, `toWorkflowId()`, `toSessionKey()`)
- **D-04:** Replace EventLogEntry (flat with `data: Record<string, unknown>`) with a discriminated union
- **D-05:** Each union member has a specific `type` field that acts as the discriminator
- **D-06:** Keep existing event data interfaces (PainSignalEventData, HookExecutionEventData, etc.) in `event-types.ts` -- refactor them into the union
- **D-07:** Fix `as any` casts in place per file -- find the correct type or use type predicates
- **D-08:** Do NOT create a central safe-cast utility that suppresses type errors
- **D-09:** For `prompt.ts`: fix EmpathyObserverWorkflowManager subagent cast by using proper type from the workflow manager's expected shape
- **D-10:** For `subagent.ts`: fix PluginLogger cast by properly typing the logger adapter
- **D-11:** For `promote-impl.ts`: fix lifecycleState access by defining a proper `CandidatePrinciple` interface with lifecycleState field
- **D-12:** For `rollback.ts`: fix ctx.sessionId access by defining a proper context interface
- **D-13:** For `pain.ts`: fix command context type by defining a proper `PainCommandContext` interface

### Claude's Discretion
- The exact shape of the type predicate functions (naming, return style)
- Where to place new type files (`src/types/queue.ts`, `src/types/event-payload.ts`) relative to existing types

### Deferred Ideas
None -- discussion stayed within phase scope

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TYPE-01 | Create branded types in `src/types/queue.ts` using intersection type brand pattern | Brand pattern verified from D-01; constructor functions as per D-03 |
| TYPE-02 | Replace EventLogEntry with discriminated union keyed on `type` field | EventType union exists in event-types.ts; EventLogEntry uses `data: Record<string, unknown>` pattern to replace |
| TYPE-03 | Fix `as any` casts in prompt.ts (lines 594, 630) | runtimeSubagent is `PluginRuntimeSubagent` compatible; EmpathyObserverWorkflowManager expects `RuntimeDirectDriver['subagent']` |
| TYPE-04 | Fix `as any` cast in subagent.ts (line 30) | PluginLogger interface defined in plugin-logger.ts; adapter pattern works correctly |
| TYPE-05 | Fix `as any` casts in promote-impl.ts, rollback.ts, pain.ts | CandidatePrinciple extended interface needed; PluginCommandContextExtended needed for sessionId |

---

## Standard Stack

### Core TypeScript Configuration

| Setting | Value | Evidence |
|---------|-------|----------|
| Target | ES2022 | `packages/openclaw-plugin/tsconfig.json` |
| Module | ESNext | `packages/openclaw-plugin/tsconfig.json` |
| Strict mode | true | `"strict": true` in tsconfig.json |
| skipLibCheck | true | `"skipLibCheck": true` |

### Libraries (no new additions required)
This phase is purely TypeScript type improvements -- no new runtime dependencies.

---

## Architecture Patterns

### Brand Pattern (TYPE-01)

**What:** Opaque type brands using intersection type pattern to prevent primitive type confusion.

**When to use:** Domain identifiers that should not be interchangeable (e.g., QueueItemId vs plain string).

**Pattern (from D-01):**
```typescript
// Source: CONTEXT.md D-01
type Brand<T, B> = T & { readonly _brand: B };

// Brand constructor pattern (D-03)
export type QueueItemId = Brand<string, 'QueueItemId'>;
export type WorkflowId = Brand<string, 'WorkflowId'>;
export type SessionKey = Brand<string, 'SessionKey'>;

export function toQueueItemId(id: string): QueueItemId {
  return id as QueueItemId;
}
```

**Why intersection type vs unique symbol:** The CONTEXT.md specifies intersection type pattern (D-01), not `string & { readonly _brand: unique symbol }`. The specification uses `readonly _brand: B` where B is a string literal type, not a unique symbol. Both work, but the locked decision specifies the intersection type approach.

### Discriminated Union for Events (TYPE-02)

**What:** Replace flat `EventLogEntry` with `data: Record<string, unknown>` with a discriminated union where `type` discriminates on specific payload shapes.

**When to use:** When one field determines the shape of the remaining data.

**Current structure (event-types.ts:40-55):**
```typescript
// Source: packages/openclaw-plugin/src/types/event-types.ts:40-55
export interface EventLogEntry {
  ts: string;
  date: string;
  type: EventType;          // union of string literals
  category: EventCategory;
  sessionId?: string;
  workspaceDir?: string;
  data: Record<string, unknown>;  // <-- too broad, should be specific per type
}
```

**Target structure:**
```typescript
// Each EventType gets its specific data shape
export type EventLogEntry =
  | { ts: string; date: string; type: 'pain_signal'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: PainSignalEventData }
  | { ts: string; date: string; type: 'tool_call'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: ToolCallEventData }
  // ... one union member per EventType
```

### Type Predicate Pattern (TYPE-03 to TYPE-05)

**What:** Runtime-extended objects (objects that have properties added at runtime beyond their static type) need type predicates to narrow them safely.

**When to use:** When an object from an external system has properties not in its TypeScript interface.

**Example for lifecycleState:**
```typescript
// Source: CONTEXT.md D-11
export interface CandidatePrinciple extends Implementation {
  lifecycleState: 'candidate' | 'disabled' | 'active';
}

// Type predicate for safe narrowing
export function isCandidatePrinciple(impl: Implementation): impl is CandidatePrinciple {
  return impl.lifecycleState === 'candidate' || impl.lifecycleState === 'disabled' || impl.lifecycleState === 'active';
}
```

### Anti-Patterns to Avoid
- **Safe-cast utility that suppresses errors:** D-08 explicitly forbids this. Each cast must be replaced with a proper type.
- **`as unknown as` double-cast:** Only acceptable when adapting between two incompatible but structurally compatible types (e.g., HookLogger -> PluginLogger).
- **Using `any` to silence complex generics:** Prefer `unknown` and type predicates.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Domain ID confusion | Plain strings | Branded types | QueueItemId and WorkflowId are not interchangeable even though both are strings |
| Event data typing | `Record<string, unknown>` | Discriminated union keyed on `type` | Type narrowing gives precise data shapes per event |
| Logger adapter | Manual `as unknown as` | Properly typed adapter object | Adapter already has correct shape, just needs correct type annotation |

---

## Common Pitfalls

### Pitfall 1: Structural compatibility not matching nominal type
**What goes wrong:** `api.runtime.subagent` (type from OpenClaw SDK) and `RuntimeDirectDriver['subagent']` (PluginRuntimeSubagent locally defined) have identical structure but TypeScript treats them as different nominal types.
**Why it happens:** TypeScript uses structural typing, but when types come from different import paths or are defined twice, TypeScript treats them as distinct.
**How to avoid:** For the prompt.ts subagent cast, the fix is NOT to change the type of `api.runtime.subagent` (it's from the SDK) but to either (a) create a local type alias that `RuntimeDirectDriver['subagent']` can be assigned to, or (b) use a type predicate that widens the type. The CONTEXT.md D-09 says "using proper type from the workflow manager's expected shape" -- the cleanest fix is to use `PluginRuntimeSubagent` (the local alias) for the adapter or add a type assertion function.
**Warning signs:** `"Type 'X' is not assignable to type 'Y' despite identical structure"`.

### Pitfall 2: lifecycleState exists at runtime but not in Implementation interface
**What goes wrong:** `Implementation` interface in `principle-tree-schema.ts` has `lifecycleState: ImplementationLifecycleState` (line 159), but `code-implementation-storage.ts` comment says "Manifest is loading metadata, NOT the source of truth for lifecycle state" and tests confirm `lifecycleState` is NOT in the manifest. The ledger (`principle-tree-ledger.ts`) adds lifecycleState at runtime.
**Why it happens:** The ledger is the canonical source for lifecycle state, not the manifest. The `Implementation` type in `principle-tree-schema.ts` DOES have lifecycleState, but `getAllImplementations()` in promote-impl.ts reads from the ledger which adds it.
**How to avoid:** Confirm that `Implementation` interface already has `lifecycleState` (it does at line 159 of principle-tree-schema.ts). The `as any` in promote-impl.ts may be unnecessary -- verify by checking if `Implementation` already has the field. If the cast is still needed for Type narrowing, use a type predicate.
**Warning signs:** eslint-disable with "lifecycleState is a dynamic property" -- but the interface already defines it.

### Pitfall 3: Discriminated union with too many members
**What goes wrong:** Creating a discriminated union with 20+ members makes the type unwieldy and harms readability.
**Why it happens:** EventType has many variants (tool_call, pain_signal, rule_match, rule_promotion, hook_execution, gate_block, gate_bypass, plan_approval, evolution_task, deep_reflection, empathy_rollback, error, warn).
**How to avoid:** Group related events under shared interfaces where data shape is identical. For example, gate_block and gate_bypass both use string-based data -- keep them separate if the data shapes differ.

---

## Code Examples

### Brand Type Implementation (TYPE-01)

```typescript
// File: packages/openclaw-plugin/src/types/queue.ts
// Pattern from D-01: intersection type brand

export type Brand<T, B> = T & { readonly _brand: B };

export type QueueItemId = Brand<string, 'QueueItemId'>;
export type WorkflowId = Brand<string, 'WorkflowId'>;
export type SessionKey = Brand<string, 'SessionKey'>;

// Constructor functions (D-03)
export function toQueueItemId(id: string): QueueItemId {
  return id as QueueItemId;
}

export function toWorkflowId(id: string): WorkflowId {
  return id as WorkflowId;
}

export function toSessionKey(key: string): SessionKey {
  return key as SessionKey;
}

// Type predicates for narrowing
export function isQueueItemId(value: unknown): value is QueueItemId {
  return typeof value === 'string';
}
```

### EventLogEntry Discriminated Union (TYPE-02)

```typescript
// File: packages/openclaw-plugin/src/types/event-payload.ts
// Replaces event-types.ts EventLogEntry with discriminated union

import type {
  ToolCallEventData,
  PainSignalEventData,
  RuleMatchEventData,
  RulePromotionEventData,
  HookExecutionEventData,
  GateBlockEventData,
  GateBypassEventData,
  PlanApprovalEventData,
  EvolutionTaskEventData,
  DeepReflectionEventData,
  EmpathyRollbackEventData,
  EventCategory,
} from './event-types.js';

// Discriminated union keyed on type field
export type EventLogEntry =
  | { ts: string; date: string; type: 'tool_call'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: ToolCallEventData }
  | { ts: string; date: string; type: 'pain_signal'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: PainSignalEventData }
  | { ts: string; date: string; type: 'rule_match'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: RuleMatchEventData }
  | { ts: string; date: string; type: 'rule_promotion'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: RulePromotionEventData }
  | { ts: string; date: string; type: 'hook_execution'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: HookExecutionEventData }
  | { ts: string; date: string; type: 'gate_block'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: GateBlockEventData }
  | { ts: string; date: string; type: 'gate_bypass'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: GateBypassEventData }
  | { ts: string; date: string; type: 'plan_approval'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: PlanApprovalEventData }
  | { ts: string; date: string; type: 'evolution_task'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: EvolutionTaskEventData }
  | { ts: string; date: string; type: 'deep_reflection'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: DeepReflectionEventData }
  | { ts: string; date: string; type: 'empathy_rollback'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: EmpathyRollbackEventData }
  | { ts: string; date: string; type: 'error'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: Record<string, unknown> }
  | { ts: string; date: string; type: 'warn'; category: EventCategory; sessionId?: string; workspaceDir?: string; data: Record<string, unknown> };

// Type predicate for safe narrowing
export function isPainSignalEventEntry(entry: EventLogEntry): entry is Extract<EventLogEntry, { type: 'pain_signal' }> {
  return entry.type === 'pain_signal';
}
```

### prompt.ts subagent cast fix (TYPE-03)

```typescript
// File: packages/openclaw-plugin/src/hooks/prompt.ts
// Lines 594, 630: subagent cast

// Current (problematic):
subagent: runtimeSubagent as any,

// Fix: The EmpathyObserverWorkflowManager expects RuntimeDirectDriver['subagent']
// which is PluginRuntimeSubagent (defined locally in runtime-direct-driver.ts).
// api.runtime.subagent is the SDK type which is structurally identical.

// The cleanest fix: Use a type assertion function that properly widens the type
import type { PluginRuntimeSubagent } from '../service/subagent-workflow/runtime-direct-driver.js';

function toWorkflowSubagent(subagent: NonNullable<OpenClawPluginApi['runtime']>['subagent']): PluginRuntimeSubagent {
  return subagent as unknown as PluginRuntimeSubagent;
}

// Usage:
subagent: toWorkflowSubagent(runtimeSubagent),
```

### subagent.ts PluginLogger cast fix (TYPE-04)

```typescript
// File: packages/openclaw-plugin/src/hooks/subagent.ts line 30
// Current (problematic):
} as unknown as PluginLogger;

// Fix: The adapter object already has the correct shape (info, warn, error, debug methods).
// The issue is that HookLogger has different method signatures than PluginLogger.
// Solution: Define the adapter with explicit PluginLogger typing (not cast).

import type { PluginLogger } from '../openclaw-sdk.js';
import type { HookLogger } from '../openclaw-sdk.js';

const loggerAdapter: PluginLogger = {
  info: (m: string) => logger.info(String(m)),
  warn: (m: string) => logger.warn(String(m)),
  error: (m: string) => logger.error(String(m)),
  debug: () => { /* no-op */ },
};
// No cast needed -- PluginLogger is explicitly typed
```

### promote-impl.ts lifecycleState cast fix (TYPE-05)

```typescript
// File: packages/openclaw-plugin/src/commands/promote-impl.ts lines 48, 145

// Current (line 48):
(impl) => (impl as any).lifecycleState === 'candidate',

// Fix: Implementation interface already has lifecycleState (principle-tree-schema.ts:159).
// The eslint-disable comment says "dynamic property" but the interface already defines it.
// Use proper type predicate:
function isCandidateImpl(impl: Implementation): impl is Implementation & { lifecycleState: 'candidate' | 'disabled' } {
  return impl.lifecycleState === 'candidate' || impl.lifecycleState === 'disabled';
}

// Usage:
const candidates = allImpls.filter(isCandidateImpl);

// Current (line 145):
const currentState = (candidate as any).lifecycleState || 'candidate';

// Fix: Since candidate is already typed as Implementation (from find()), lifecycleState is accessible.
// The cast is only needed if TypeScript doesn't recognize it. Verify:
// If Implementation truly has lifecycleState in all contexts, remove the cast.
// If the cast is still needed for narrowing, use:
const currentState = (candidate as Implementation & { lifecycleState: string }).lifecycleState || 'candidate';
```

### rollback.ts / pain.ts sessionId cast fix (TYPE-05)

```typescript
// File: packages/openclaw-plugin/src/commands/rollback.ts line 19
// File: packages/openclaw-plugin/src/commands/pain.ts line 93

// Current (problematic):
const {sessionId} = (ctx as any);

// Fix: Define an extended interface that includes sessionId
import type { PluginCommandContext } from '../openclaw-sdk.js';

interface SessionAwareCommandContext extends PluginCommandContext {
  sessionId: string;
}

// Usage:
const { sessionId } = ctx as SessionAwareCommandContext;

// Alternative: type predicate
function hasSessionId(ctx: PluginCommandContext): ctx is PluginCommandContext & { sessionId: string } {
  return typeof (ctx as unknown as { sessionId?: string }).sessionId === 'string';
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `data: Record<string, unknown>` for all events | Discriminated union with type-specific data | Phase 43 | Full type narrowing for event data |
| Plain string for IDs | Branded types (QueueItemId, WorkflowId, SessionKey) | Phase 43 | Prevents accidental ID interchange |
| `as any` for runtime-extended objects | Type predicates and extended interfaces | Phase 43 | Type-safe access to runtime properties |

---

## Assumptions Log

> List all claims tagged [ASSUMED] in this research. The planner and discuss-phase use this section to identify decisions that need user confirmation before execution.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `Implementation` interface in `principle-tree-schema.ts` has `lifecycleState` at line 159 | Common Pitfalls - Pitfall 2 | If the interface truly has this field, the `as any` in promote-impl.ts may be removable entirely. If not, the type predicate approach still works. |
| A2 | `PluginRuntimeSubagent` (local type in runtime-direct-driver.ts) and `NonNullable<OpenClawPluginApi['runtime']>['subagent']` are structurally identical | Code Examples - prompt.ts | If structurally different in a subtle way (e.g., method parameter names differ), the cast may need adjustment. The risk is LOW since both come from the same SDK. |

---

## Open Questions (RESOLVED)

1. **Implementation.lifecycleState in promote-impl.ts** — RESOLVED
   - `principle-tree-schema.ts:159` confirms `lifecycleState: ImplementationLifecycleState` is in the `Implementation` interface. The `as any` cast in `promote-impl.ts` is unnecessary. Plan 02 Task 3 uses `isCandidateOrDisabled` type predicate — if TypeScript compilation succeeds without it, the cast was removable. The type predicate approach handles all cases correctly.

2. **EventLogEntry discriminated union vs extending existing EventLogEntry** — RESOLVED
   - Per CONTEXT.md D-04/D-05, replace the flat `EventLogEntry` with a discriminated union. Each consumer already uses specific EventData types (e.g., `PainSignalEventData`). The discriminated union keyed on `type` gives TypeScript automatic narrowing — no per-site updates needed beyond ensuring the union is imported where used.

---

## Environment Availability

Step 2.6: SKIPPED (no external dependencies -- pure TypeScript type improvements with no new packages or tools required beyond the existing TypeScript compiler).

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (existing test infrastructure) |
| Config file | `packages/openclaw-plugin/vitest.config.ts` |
| Quick run command | `pnpm --filter openclaw-plugin test:unit` |
| Full suite command | `pnpm --filter openclaw-plugin test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|---------------|
| TYPE-01 | Branded types created with correct brand pattern | unit | `pnpm --filter openclaw-plugin test:unit -- --testNamePattern="brand"` | Not yet - new test file needed |
| TYPE-02 | EventLogEntry discriminated union compiles | unit | `pnpm --filter openclaw-plugin typecheck` | Existing typecheck covers this |
| TYPE-03 | prompt.ts subagent cast removed, code compiles | unit | `pnpm --filter openclaw-plugin typecheck` | Existing typecheck covers this |
| TYPE-04 | subagent.ts PluginLogger cast removed, code compiles | unit | `pnpm --filter openclaw-plugin typecheck` | Existing typecheck covers this |
| TYPE-05 | promote-impl.ts, rollback.ts, pain.ts casts removed, code compiles | unit | `pnpm --filter openclaw-plugin typecheck` | Existing typecheck covers this |

### Sampling Rate
- **Per task commit:** `pnpm --filter openclaw-plugin typecheck && pnpm --filter openclaw-plugin test:unit --run`
- **Per wave merge:** `pnpm --filter openclaw-plugin test --run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `packages/openclaw-plugin/tests/types/brand-types.test.ts` -- covers TYPE-01 branded type verification
- [ ] `packages/openclaw-plugin/tests/types/event-payload.test.ts` -- covers TYPE-02 discriminated union type predicates
- Framework install: Already present in project

---

## Security Domain

> Skip this section -- type safety is a correctness concern, not a security enforcement concern. No ASVS categories apply to this phase.

---

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/types/event-types.ts` -- EventLogEntry, EventType, specific EventData interfaces
- `packages/openclaw-plugin/src/types/principle-tree-schema.ts` -- Implementation interface with lifecycleState field
- `packages/openclaw-plugin/src/utils/plugin-logger.ts` -- PluginLogger interface definition
- `packages/openclaw-plugin/src/service/subagent-workflow/runtime-direct-driver.ts` -- PluginRuntimeSubagent type, RuntimeDirectDriver
- `packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts` -- EmpathyObserverWorkflowOptions with subagent type
- `packages/openclaw-plugin/tsconfig.json` -- strict: true confirmed
- `packages/openclaw-plugin/src/hooks/prompt.ts` -- lines 594, 630 as any casts confirmed
- `packages/openclaw-plugin/src/hooks/subagent.ts` -- line 30 as unknown as PluginLogger confirmed
- `packages/openclaw-plugin/src/commands/promote-impl.ts` -- lines 48, 145 lifecycleState casts confirmed
- `packages/openclaw-plugin/src/commands/rollback.ts` -- line 19 sessionId cast confirmed
- `packages/openclaw-plugin/src/commands/pain.ts` -- line 93 sessionId cast confirmed

### Secondary (MEDIUM confidence)
- Grep results for `lifecycleState` usage across codebase -- confirms it exists at runtime on Implementation objects from ledger

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- pure TypeScript, no new dependencies, tsconfig strict confirmed
- Architecture: HIGH -- brand pattern and discriminated unions are standard TypeScript patterns
- Pitfalls: MEDIUM -- some assumptions about Implementation.lifecycleState need verification

**Research date:** 2026-04-15
**Valid until:** 2026-05-15 (type safety patterns are stable)
