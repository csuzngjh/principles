# Phase 43: Type-Safety - Pattern Map

**Mapped:** 2026-04-15
**Files analyzed:** 9
**Analogs found:** 7 / 9

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `packages/openclaw-plugin/src/types/queue.ts` | type | static | `packages/openclaw-plugin/src/types/event-types.ts` | role-match |
| `packages/openclaw-plugin/src/types/event-payload.ts` | type | static | `packages/openclaw-plugin/src/types/event-types.ts` | exact |
| `packages/openclaw-plugin/src/hooks/prompt.ts` | hook | request-response | `packages/openclaw-plugin/src/tools/deep-reflect.ts:169` | role-match |
| `packages/openclaw-plugin/src/hooks/subagent.ts` | hook | request-response | `packages/openclaw-plugin/src/utils/plugin-logger.ts` | exact |
| `packages/openclaw-plugin/src/commands/promote-impl.ts` | command | request-response | `packages/openclaw-plugin/src/types/principle-tree-schema.ts:159` | role-match |
| `packages/openclaw-plugin/src/commands/rollback.ts` | command | request-response | `packages/openclaw-plugin/src/commands/pain.ts:93` | exact |
| `packages/openclaw-plugin/src/commands/pain.ts` | command | request-response | `packages/openclaw-plugin/src/commands/rollback.ts:19` | exact |
| `packages/openclaw-plugin/src/tools/deep-reflect.ts` | tool | request-response | `packages/openclaw-plugin/src/hooks/prompt.ts:594,630` | role-match |
| `packages/openclaw-plugin/src/hooks/message-sanitize.ts` | hook | request-response | `packages/openclaw-plugin/src/hooks/message-sanitize.ts` | self (type predicate approach) |

---

## Pattern Assignments

### `packages/openclaw-plugin/src/types/queue.ts` (type, static) — NEW FILE

**Analog:** `packages/openclaw-plugin/src/types/event-types.ts`

**File location pattern** (event-types.ts:1-3):
```typescript
/**
 * Event types for structured logging and daily statistics.
 */
```

**Type definition pattern** (event-types.ts:36-55):
```typescript
export interface EventLogEntry {
  ts: string;
  date: string;
  type: EventType;
  category: EventCategory;
  sessionId?: string;
  workspaceDir?: string;
  data: Record<string, unknown>;
}
```

**Implementation for queue.ts** — use intersection type brand pattern per D-01:
```typescript
// Brand type constructor (D-01)
export type Brand<T, B> = T & { readonly _brand: B };

// Branded domain IDs (D-02)
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

// Type predicates for narrowing (D-03)
export function isQueueItemId(value: unknown): value is QueueItemId {
  return typeof value === 'string';
}
```

---

### `packages/openclaw-plugin/src/types/event-payload.ts` (type, static) — NEW FILE

**Analog:** `packages/openclaw-plugin/src/types/event-types.ts:40-55`

**Current problematic pattern to replace** (event-types.ts:40-55):
```typescript
export interface EventLogEntry {
  ts: string;
  date: string;
  type: EventType;
  category: EventCategory;
  sessionId?: string;
  workspaceDir?: string;
  data: Record<string, unknown>;  // <-- too broad
}
```

**Target discriminated union pattern** — per D-04/D-05, each union member keyed on `type` field:
```typescript
// Discriminated union keyed on type field (D-04, D-05)
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

// Type predicate for safe narrowing (D-07)
export function isPainSignalEventEntry(entry: EventLogEntry): entry is Extract<EventLogEntry, { type: 'pain_signal' }> {
  return entry.type === 'pain_signal';
}
```

---

### `packages/openclaw-plugin/src/hooks/prompt.ts` (hook, request-response)

**Analogs:** `packages/openclaw-plugin/src/tools/deep-reflect.ts:169` (same subagent cast), `packages/openclaw-plugin/src/hooks/subagent.ts:24-30` (logger adapter pattern)

**Current problematic casts** (prompt.ts:594, 630):
```typescript
// Line 594
subagent: runtimeSubagent as any,

// Line 630
subagent: api.runtime.subagent as any,
```

**Fix approach** — type assertion function per D-09:
```typescript
import type { PluginRuntimeSubagent } from '../service/subagent-workflow/runtime-direct-driver.js';

// Type assertion function (D-09)
function toWorkflowSubagent(subagent: NonNullable<OpenClawPluginApi['runtime']>['subagent']): PluginRuntimeSubagent {
  return subagent as unknown as PluginRuntimeSubagent;
}

// Usage in EmpathyObserverWorkflowManager construction:
// subagent: toWorkflowSubagent(runtimeSubagent),
// subagent: toWorkflowSubagent(api.runtime.subagent),
```

---

### `packages/openclaw-plugin/src/hooks/subagent.ts` (hook, request-response)

**Analog:** `packages/openclaw-plugin/src/utils/plugin-logger.ts` (PluginLogger interface definition)

**Current problematic cast** (subagent.ts:30):
```typescript
} as unknown as PluginLogger;
```

**Fix approach** — explicit interface typing per D-10:
```typescript
// Line 24-30 - explicit PluginLogger typing instead of cast
const loggerAdapter: PluginLogger = {
    info: (m: string) => logger.info(String(m)),
    warn: (m: string) => logger.warn(String(m)),
    error: (m: string) => logger.error(String(m)),
    debug: () => { /* no-op */ },
};  // No cast needed - PluginLogger is explicitly typed
```

---

### `packages/openclaw-plugin/src/commands/promote-impl.ts` (command, request-response)

**Analog:** `packages/openclaw-plugin/src/types/principle-tree-schema.ts:159` (Implementation interface already has lifecycleState)

**Current problematic casts** (promote-impl.ts:48, 145):
```typescript
// Line 48
(impl) => (impl as any).lifecycleState === 'candidate',

// Line 145
const currentState = (candidate as any).lifecycleState || 'candidate';
```

**Key finding:** `Implementation` interface in `principle-tree-schema.ts:159` already defines `lifecycleState: ImplementationLifecycleState`. The eslint-disable comments claim it is "dynamic property" but the interface actually has it.

**Fix approach** — type predicate per D-11:
```typescript
import type { Implementation, ImplementationLifecycleState } from '../types/principle-tree-schema.js';

// Type predicate for Implementation with lifecycleState (D-11)
function isCandidateImpl(impl: Implementation): impl is Implementation & { lifecycleState: ImplementationLifecycleState } {
  return impl.lifecycleState === 'candidate' || impl.lifecycleState === 'disabled';
}

// Line 48 usage:
const candidates = allImpls.filter(isCandidateImpl);

// Line 145 usage - since candidate is typed as Implementation, lifecycleState is already accessible:
const currentState = candidate.lifecycleState || 'candidate';
```

---

### `packages/openclaw-plugin/src/commands/rollback.ts` (command, request-response)

**Analog:** `packages/openclaw-plugin/src/commands/pain.ts:93` (identical pattern)

**Current problematic cast** (rollback.ts:19):
```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Reason: sessionId injected by OpenClaw plugin framework - type not available in PluginCommandContext
const {sessionId} = (ctx as any);
```

**Fix approach** — extended interface per D-12:
```typescript
import type { PluginCommandContext } from '../openclaw-sdk.js';

// Extended interface for session-aware context (D-12)
interface SessionAwareCommandContext extends PluginCommandContext {
  sessionId: string;
}

// Usage:
const { sessionId } = ctx as SessionAwareCommandContext;
```

---

### `packages/openclaw-plugin/src/commands/pain.ts` (command, request-response)

**Analog:** `packages/openclaw-plugin/src/commands/rollback.ts:19` (identical pattern)

**Current problematic cast** (pain.ts:93):
```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Reason: sessionId injected by OpenClaw plugin framework - type not available in PluginCommandContext
const {sessionId} = (ctx as any);
```

**Fix approach** — identical to rollback.ts:
```typescript
import type { PluginCommandContext } from '../openclaw-sdk.js';

interface SessionAwareCommandContext extends PluginCommandContext {
  sessionId: string;
}

const { sessionId } = ctx as SessionAwareCommandContext;
```

---

### `packages/openclaw-plugin/src/tools/deep-reflect.ts` (tool, request-response) — ADDITIONAL CAST FOUND

**Analog:** `packages/openclaw-plugin/src/hooks/prompt.ts:594,630` (same subagent cast)

**Current problematic cast** (deep-reflect.ts:169):
```typescript
subagent: api.runtime.subagent as any,
```

**Fix approach** — same as prompt.ts:
```typescript
import type { PluginRuntimeSubagent } from './subagent-workflow/runtime-direct-driver.js';

function toWorkflowSubagent(subagent: NonNullable<OpenClawPluginApi['runtime']>['subagent']): PluginRuntimeSubagent {
  return subagent as unknown as PluginRuntimeSubagent;
}

// Usage:
subagent: toWorkflowSubagent(api.runtime.subagent),
```

---

### `packages/openclaw-plugin/src/hooks/message-sanitize.ts` (hook, request-response)

**Note:** Casts at lines 30 and 43 are for preserving message type after dynamic content modification. These are intentional type coercion to preserve the union type. Not all `as any` casts are removable — per D-07, fix casts "in place per file - find the correct type or use type predicates."

**Current casts** (message-sanitize.ts:30, 43):
```typescript
// Line 30
return { message: { ...msg, content: sanitized } as any };

// Line 43
return { message: { ...msg, content: next } as any };
```

**Fix approach** — type predicate per D-07:
```typescript
// Helper type to preserve message union shape
function isAssistantMessage(msg: unknown): msg is { role: 'assistant'; content: unknown } {
  return typeof msg === 'object' && msg !== null && (msg as { role?: string }).role === 'assistant';
}

// Usage with proper type guard:
if (isAssistantMessage(msg) && typeof msg.content === 'string') {
  const sanitized = sanitizeAssistantText(msg.content);
  if (sanitized !== msg.content) {
    return { message: { ...msg, content: sanitized } };
  }
}
```

---

## Shared Patterns

### PluginLogger Interface

**Source:** `packages/openclaw-plugin/src/utils/plugin-logger.ts:4-11`

**Apply to:** All files creating logger adapters

```typescript
export interface PluginLogger {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
}
```

### HookLogger Type

**Source:** `packages/openclaw-plugin/src/hooks/subagent.ts:52`

**Apply to:** Files adapting between HookLogger and PluginLogger

```typescript
type HookLogger = Pick<PluginLogger, 'info' | 'warn' | 'error'>;
```

### Implementation Interface with lifecycleState

**Source:** `packages/openclaw-plugin/src/types/principle-tree-schema.ts:144-175`

**Key field at line 159:**
```typescript
lifecycleState: ImplementationLifecycleState;
```

**Apply to:** Any code accessing lifecycleState on Implementation objects from ledger (not manifest).

### PluginCommandContext Extended Pattern

**Source:** CONTEXT.md D-12, D-13

**Apply to:** rollback.ts, pain.ts

```typescript
interface SessionAwareCommandContext extends PluginCommandContext {
  sessionId: string;
}
```

---

## No Analog Found

Files with no close match in the codebase (planner should use RESEARCH.md patterns instead):

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `packages/openclaw-plugin/src/types/queue.ts` | type | static | No existing branded types in codebase — net new pattern |
| `packages/openclaw-plugin/src/types/event-payload.ts` | type | static | Discriminated union for event payloads is net new — EventLogEntry currently uses `Record<string, unknown>` |

---

## Metadata

**Analog search scope:** `packages/openclaw-plugin/src/types/`, `packages/openclaw-plugin/src/hooks/`, `packages/openclaw-plugin/src/commands/`, `packages/openclaw-plugin/src/utils/`, `packages/openclaw-plugin/src/tools/`

**Files scanned:** 80+

**Pattern extraction date:** 2026-04-15

**Additional casts discovered during analysis:**
- `packages/openclaw-plugin/src/tools/deep-reflect.ts:169` — subagent cast (same pattern as prompt.ts)
- `packages/openclaw-plugin/src/hooks/message-sanitize.ts:30,43` — message content casts (requires type predicate approach)

**Note on Implementation.lifecycleState:** The `as any` casts in promote-impl.ts claim `lifecycleState` is a "dynamic property" not in the official interface. However, `principle-tree-schema.ts:159` shows it IS in the interface. The casts may be removable entirely after verifying the Implementation type returned by `getAllImplementations()` matches the schema interface.
