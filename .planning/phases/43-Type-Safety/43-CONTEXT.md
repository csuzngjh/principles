# Phase 43: Type Safety - Context

**Gathered:** 2026-04-15
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace `as any` casts with proper TypeScript types across the codebase:
- TYPE-01: Define `src/types/queue.ts` with branded types for `QueueItemId`, `WorkflowId`, `SessionKey`
- TYPE-02: Define `src/types/event-payload.ts` with discriminated union types for dynamic event payloads
- TYPE-03: Replace `as any` casts in `src/hooks/prompt.ts` with proper type predicates
- TYPE-04: Replace `as any` casts in `src/hooks/subagent.ts` with module augmentation
- TYPE-05: Audit and replace `as any` casts across all 6 files
</domain>

<decisions>
## Implementation Decisions

### TYPE-01: Branded types design
- **D-01:** Use intersection type brand pattern: `type Brand<T, B> = T & { readonly _brand: B }`
- **D-02:** Create `src/types/queue.ts` with `QueueItemId`, `WorkflowId`, `SessionKey` branded types
- **D-03:** Create type constructor functions for each brand (`toQueueItemId()`, `toWorkflowId()`, `toSessionKey()`)

### TYPE-02: Event payload discriminated union
- **D-04:** Replace `EventLogEntry` (flat with `data: Record<string, unknown>`) with a discriminated union
- **D-05:** Each union member has a specific `type` field that acts as the discriminator
- **D-06:** Keep existing event data interfaces (`PainSignalEventData`, `HookExecutionEventData`, etc.) in `event-types.ts` — refactor them into the union

### TYPE-03 to TYPE-05: as any replacement strategy
- **D-07:** Fix `as any` casts in place per file — find the correct type or use type predicates
- **D-08:** Do NOT create a central safe-cast utility that suppresses type errors
- **D-09:** For `prompt.ts`: fix `EmpathyObserverWorkflowManager` subagent cast by using proper type from the workflow manager's expected shape
- **D-10:** For `subagent.ts`: fix `PluginLogger` cast by properly typing the logger adapter
- **D-11:** For `promote-impl.ts`: fix `lifecycleState` access by defining a proper `CandidatePrinciple` interface with `lifecycleState` field
- **D-12:** For `rollback.ts`: fix `ctx.sessionId` access by defining a proper context interface
- **D-13:** For `pain.ts`: fix command context type by defining a proper `PainCommandContext` interface
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Type definitions
- `packages/openclaw-plugin/src/types/event-types.ts` — existing event types (TYPE-02 base)
- `packages/openclaw-plugin/src/hooks/prompt.ts` lines 594, 630 — `as any` subagent casts (TYPE-03)
- `packages/openclaw-plugin/src/hooks/subagent.ts` line 30 — `as unknown as PluginLogger` (TYPE-04)
- `packages/openclaw-plugin/src/commands/promote-impl.ts` lines 48, 145 — `as any` lifecycleState access
- `packages/openclaw-plugin/src/commands/rollback.ts` line 19 — `as any` ctx cast
- `packages/openclaw-plugin/src/commands/pain.ts` line 93 — `as any` ctx cast

### No external specs — requirements fully captured in decisions above
</canonical_refs>

<codebase_context>
## Existing Code Insights

### Reusable Assets
- `packages/openclaw-plugin/src/types/event-types.ts` — existing event type interfaces (source for TYPE-02)
- `packages/openclaw-plugin/src/types/runtime-summary.ts` — existing runtime type definitions

### Established Patterns
- Branded types not yet used in codebase — TYPE-01 creates a new pattern
- Discriminated unions used in existing code for similar type narrowing scenarios
- PluginLogger type exists in plugin framework types

### Integration Points
- New `queue.ts` types will be used by queue operations in `evolution-worker.ts`, `evolution-migration.ts`
- New event union will be used by `event-log.ts` and all consumers of `EventLogEntry`
- Fixed casts in `prompt.ts` affect `EmpathyObserverWorkflowManager` initialization
</codebase_context>

<specifics>
## Specific Ideas

- Brand pattern: `export type QueueItemId = string & { readonly _brand: unique symbol }` using `unique symbol` for stronger branding
- For `EmpathyObserverWorkflowManager` subagent: check the actual subagent type expected by the workflow manager constructor
- Type predicates: `function isPainSignalEventData(data: unknown): data is PainSignalEventData`
</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope
</deferred>
