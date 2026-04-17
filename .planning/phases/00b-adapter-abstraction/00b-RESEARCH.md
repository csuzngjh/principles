# Phase 0b: Adapter Abstraction - Research

**Researched:** 2026-04-17
**Domain:** Adapter pattern design, framework abstraction, telemetry schema
**Confidence:** HIGH

## Summary

Phase 0b creates the adapter layer that decouples the Principles SDK from OpenClaw-specific code. The core interfaces (`PainSignalAdapter`, `EvolutionHook`, `PrincipleInjector`) will be thin abstractions over already-proven implementations in Phase 0a and existing code. The existing codebase provides strong precedents: `StorageAdapter` interface + `FileStorageAdapter` implementation is the exact pattern to replicate. The telemetry schema is a documentation-only output describing events the existing `EvolutionLogger` already emits.

The primary risk is over-engineering: the adapter interfaces must remain thin translation layers, not new abstraction hierarchies. CONTEXT.md decisions D-01 through D-08 already constrain the design tightly, which reduces ambiguity and makes this a straightforward extraction phase.

**Primary recommendation:** Follow the `StorageAdapter` / `FileStorageAdapter` precedent exactly: one interface file per adapter, generic type parameter for framework events, existing code delegates to the new interfaces without behavioral changes.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** PainSignalAdapter uses generic `PainSignalAdapter<RawEvent>` pattern, each framework implements its own type parameter (e.g., `OpenClawPainSignalAdapter implements PainSignalAdapter<PluginHookAfterToolCallEvent>`). Compile-time type safety.
- **D-02:** PainSignalAdapter responsibility is pure translation -- `capture(rawEvent)` only translates framework event to `PainSignal | null`, returns null when the event does not produce a signal. Trigger decision logic (e.g., GFI threshold) stays in framework-side hook logic.
- **D-03:** EvolutionHook interface contains only 3 core event methods: `onPainDetected`, `onPrincipleCreated`, `onPrinciplePromoted`. Extra events deferred to later phases.
- **D-04:** EvolutionHook uses interface callback pattern -- users implement an interface with 3 methods. No EventEmitter pattern. Optional methods (hooks not needed can provide empty implementation).
- **D-05:** PrincipleInjector wraps existing implementation -- `getRelevantPrinciples()` delegates to `selectPrinciplesForInjection`, `formatForInjection()` delegates to `formatPrinciple`. Zero rewrite risk, existing tests preserved.
- **D-06:** PrincipleInjector receives generic `InjectionContext` (domain, sessionId, character budget fields), no framework-specific fields. Framework adapter converts framework context to InjectionContext.
- **D-07:** Telemetry schema output as TypeBox `TelemetryEvent` type definition + documentation. Existing EvolutionLogger output should conform to this schema. No new TelemetryService interface, no changes to existing code.
- **D-08:** Telemetry schema covers core 3 events: `pain_detected`, `principle_candidate_created`, `principle_promoted`. Aligned with EvolutionHook's 3 events. Injection/storage events out of scope.

### Claude's Discretion
- Exact field naming and type details for each interface
- PainSignalAdapter error handling strategy (return null vs throw on translation failure)
- EvolutionHook optional method implementation (base class with no-op vs individual method optional)
- InjectionContext full field list (core fields decided by planner)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SDK-ADP-01 | Design generic PainSignal structure to be framework-agnostic | Phase 0a PainSignal schema + generic adapter pattern (D-01) |
| SDK-ADP-02 | Implement `PainSignalAdapter.capture()` for framework signal translation | hooks/pain.ts extraction points identified; generic `<RawEvent>` pattern |
| SDK-ADP-03 | Implement `PrincipleInjector.getRelevantPrinciples()` contract | principle-injection.ts selectPrinciplesForInjection is delegate target (D-05) |
| SDK-ADP-04 | Implement `PrincipleInjector.formatForInjection()` contract | principle-injection.ts formatPrinciple is delegate target (D-05) |
| SDK-ADP-05 | Define `EvolutionHook` interface (onPainDetected, onPrincipleCreated, onPrinciplePromoted) | evolution-reducer.ts applyEvent/onPainDetected/onCandidateCreated/onPrinciplePromoted are extraction sources (D-03) |
| SDK-ADP-06 | Define generic `StorageAdapter` save/load methods | Already completed in Phase 0a (storage-adapter.ts). Verified in 00a-VERIFICATION.md. |
| SDK-OBS-05 | Define telemetry schema for in-process events | EvolutionLogger existing stages map directly to 3-event schema (D-07, D-08) |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| PainSignal translation | API / SDK Core | -- | Adapter pattern lives at the integration boundary; framework events are translated to domain types |
| Principle injection | API / SDK Core | -- | Budget-aware selection is domain logic, not browser/CDN concern |
| EvolutionHook callbacks | API / SDK Core | -- | Lifecycle event observation belongs in the core event loop |
| Telemetry schema definition | API / SDK Core | -- | Schema is a type definition, consumed by existing logger |
| StorageAdapter interface | API / SDK Core | -- | Already defined in Phase 0a, persistence abstraction |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @sinclair/typebox | ^0.34.48 (latest: 0.34.49) | Runtime type validation, schema definitions | Project-wide standard (PainSignalSchema, observability) [VERIFIED: npm registry] |
| vitest | ^4.1.0 | Test framework | Project standard, all 23+ existing test files use it [VERIFIED: package.json] |
| typescript | ^6.0.2 | Type system | Project standard [VERIFIED: package.json] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @sinclair/typebox/value | (same) | Value.Check, Value.Cast, Value.Errors for validation | Used in validatePainSignal pattern |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Interface-only EvolutionHook | Abstract base class with no-ops | Abstract base class reduces boilerplate but prevents structural typing; interface allows cross-package implementation without inheritance chain. Per D-04, interface is locked. |

**Installation:**
No new packages needed. All dependencies already in package.json.

**Version verification:**
```
@sinclair/typebox: ^0.34.48 (installed), 0.34.49 (latest on npm)
vitest: ^4.1.0
typescript: ^6.0.2
```

## Architecture Patterns

### System Architecture Diagram

```
Framework Hook (e.g., OpenClaw after_tool_call)
       |
       v
PainSignalAdapter<RawEvent>     <--- NEW: framework-agnostic interface
  .capture(rawEvent) -> PainSignal | null
       |
       v
  [Existing PainSignal validation pipeline]
       |
       v
EvolutionHook.onPainDetected()  <--- NEW: lifecycle observation interface
       |
       v
  [EvolutionReducer processes event]
       |
       v
EvolutionHook.onPrincipleCreated() / onPrinciplePromoted()
       |
       v
PrincipleInjector                <--- NEW: injection abstraction interface
  .getRelevantPrinciples(ctx) -> InjectablePrinciple[]
  .formatForInjection(principle) -> string
       |
       v
  [Prompt hook injects into LLM context]

--- Telemetry (parallel, side-channel) ---
EvolutionLogger.log() --> TelemetryEvent TypeBox schema (documentation artifact)
```

### Recommended Project Structure
```
packages/openclaw-plugin/src/core/
├── pain-signal-adapter.ts       # PainSignalAdapter<RawEvent> interface
├── evolution-hook.ts            # EvolutionHook interface (3 methods)
├── principle-injector.ts        # PrincipleInjector interface + InjectionContext
├── telemetry-event.ts           # TelemetryEvent TypeBox schema (documentation)
├── pain-signal.ts               # (Phase 0a) PainSignal schema -- unchanged
├── storage-adapter.ts           # (Phase 0a) StorageAdapter -- unchanged
├── principle-injection.ts       # (Phase 0a) selection logic -- unchanged, delegate target
└── observability.ts             # (Phase 0a) baselines -- unchanged

packages/openclaw-plugin/tests/core/
├── pain-signal-adapter.test.ts  # Interface contract tests
├── evolution-hook.test.ts       # Interface contract tests
├── principle-injector.test.ts   # Interface contract tests
└── telemetry-event.test.ts      # Schema validation tests
```

### Pattern 1: Generic Adapter Interface
**What:** Framework-agnostic interface with generic type parameter for framework-specific events.
**When to use:** Any boundary where framework events enter the SDK.
**Example:**
```typescript
// Source: Established by StorageAdapter pattern in storage-adapter.ts
export interface PainSignalAdapter<TRawEvent> {
  /**
   * Translate a framework-specific event into a universal PainSignal.
   * Returns null when the event does not produce a signal.
   */
  capture(rawEvent: TRawEvent): PainSignal | null;
}
```

### Pattern 2: Thin Wrapper with Delegation
**What:** Interface method delegates to existing function with identical semantics.
**When to use:** When abstracting already-proven logic into a contract.
**Example:**
```typescript
// PrincipleInjector wraps selectPrinciplesForInjection and formatPrinciple
export interface PrincipleInjector {
  getRelevantPrinciples(
    principles: InjectablePrinciple[],
    context: InjectionContext,
  ): InjectablePrinciple[];
  formatForInjection(principle: InjectablePrinciple): string;
}
```

### Pattern 3: Interface Callback (EvolutionHook)
**What:** Pure interface with methods for lifecycle events. No base class, no EventEmitter.
**When to use:** When consumers need to observe lifecycle events without coupling to implementation.
**Example:**
```typescript
// 3 methods aligned with D-03
export interface EvolutionHook {
  onPainDetected(signal: PainSignal): void;
  onPrincipleCreated(principle: { id: string; text: string; trigger: string }): void;
  onPrinciplePromoted(principle: { id: string; from: string; to: string }): void;
}
```

### Anti-Patterns to Avoid
- **Fat adapters:** PainSignalAdapter must NOT contain GFI tracking, session management, or risk assessment. Per D-02, it only translates. The existing hooks/pain.ts logic for GFI/friction/probation stays in the framework hook.
- **Telemetry service creation:** Per D-07, no new TelemetryService. The output is a TypeBox type definition + documentation, not a new class.
- **Breaking existing consumers:** PrincipleInjector wraps existing functions; it must not change their behavior. Existing tests in principle-injection.test.ts must pass unchanged.
- **Over-engineered InjectionContext:** Per D-06, only domain, sessionId, and character budget. Do not add framework-specific fields like OpenClaw session keys or agent IDs.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PainSignal validation | Custom validation in adapter | validatePainSignal() from pain-signal.ts | Phase 0a already provides validated output; adapter feeds into it |
| Principle selection algorithm | New selection logic in PrincipleInjector | selectPrinciplesForInjection() from principle-injection.ts | Budget-aware, priority-sorted, P0 force-include -- complex algorithm already tested |
| Principle formatting | New formatter in PrincipleInjector | formatPrinciple() from principle-injection.ts | Consistent format (`- [ID] text`) used across all injection sites |
| Telemetry event typing | New logging infrastructure | TypeBox TelemetryEvent schema | Documentation artifact only; EvolutionLogger already writes events |

**Key insight:** This phase is extraction, not creation. Every new interface wraps an existing, tested function. The interfaces are contractual boundaries, not new implementations.

## Common Pitfalls

### Pitfall 1: Mixing Framework Logic into Adapter
**What goes wrong:** PainSignalAdapter.capture() tries to decide whether to capture (GFI check, tool name filter).
**Why it happens:** The existing pain.ts hook does both translation and decision in one function.
**How to avoid:** Strict separation -- adapter only translates. Decision logic stays in the framework hook. Per D-02, `capture()` returns `PainSignal | null` where null means "this event type doesn't produce signals" (not "GFI too low").
**Warning signs:** PainSignalAdapter importing session-tracker, pain-context-extractor, or config.

### Pitfall 2: EvolutionHook Coupled to EvolutionReducer Internals
**What goes wrong:** EvolutionHook methods receive EvolutionReducer-internal data types (like full `Principle` with validation scores, feedbackScore, etc).
**Why it happens:** EvolutionReducer.applyEvent() has rich internal data.
**How to avoid:** EvolutionHook methods receive minimal, serializable payloads. Per CONTEXT.md, onPrincipleCreated gets `{id, text, trigger}`, not the full Principle object. This keeps the interface framework-agnostic.
**Warning signs:** EvolutionHook importing evolution-types.ts types.

### Pitfall 3: Telemetry Schema Mismatch with EvolutionLogger
**What goes wrong:** TelemetryEvent schema defines fields that EvolutionLogger doesn't emit, or uses different field names.
**Why it happens:** Schema is designed independently without checking actual logger output.
**How to avoid:** Schema must be a superset of what EvolutionLogger already produces. The existing stages (`pain_detected`, `principle_generated` which maps to `principle_candidate_created`, `completed` which maps to `principle_promoted`) are the source of truth.
**Warning signs:** TelemetryEvent fields that have no corresponding EvolutionLogger.log() call.

### Pitfall 4: Making EvolutionHook Methods Async
**What goes wrong:** EvolutionHook methods return Promise, forcing all callers to await even though the existing evolution-reducer emitSync() path is synchronous.
**Why it happens:** "Making everything async is more flexible."
**How to avoid:** Per D-04 interface callback pattern, methods return void (synchronous). If async is needed later, it's a breaking change that warrants its own phase.
**Warning signs:** EvolutionHook methods returning `Promise<void>`.

## Code Examples

### PainSignalAdapter Interface
```typescript
// Pattern: Generic interface + framework-specific implementation
// Source: StorageAdapter pattern from storage-adapter.ts
import type { PainSignal } from './pain-signal.js';

/**
 * Framework-agnostic adapter for capturing pain signals.
 *
 * @typeParam TRawEvent - The framework-specific event type
 * (e.g., PluginHookAfterToolCallEvent for OpenClaw)
 */
export interface PainSignalAdapter<TRawEvent> {
  /**
   * Translate a framework event into a universal PainSignal.
   * Returns null when the event does not produce a signal.
   */
  capture(rawEvent: TRawEvent): PainSignal | null;
}
```

### EvolutionHook Interface
```typescript
// Pattern: Pure interface, no base class, no EventEmitter
// Source: D-03, D-04 decisions
import type { PainSignal } from './pain-signal.js';

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

### PrincipleInjector Interface
```typescript
// Pattern: Thin wrapper delegating to existing functions
// Source: D-05, D-06 decisions
import type { InjectablePrinciple } from './principle-injection.js';

export interface InjectionContext {
  domain: string;
  sessionId: string;
  budgetChars: number;
}

export interface PrincipleInjector {
  getRelevantPrinciples(
    principles: InjectablePrinciple[],
    context: InjectionContext,
  ): InjectablePrinciple[];
  formatForInjection(principle: InjectablePrinciple): string;
}
```

### TelemetryEvent Schema (TypeBox)
```typescript
// Pattern: TypeBox schema as documentation artifact
// Source: D-07, D-08 decisions. Aligns with EvolutionLogger stages.
import { Type, type Static } from '@sinclair/typebox';

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

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hardcoded pain capture in hooks/pain.ts | Generic PainSignalAdapter<RawEvent> interface | Phase 0b (this phase) | Framework events can be captured without modifying core logic |
| Direct selectPrinciplesForInjection() calls | PrincipleInjector interface wrapping | Phase 0b (this phase) | Injection logic contractually decoupled from implementation |
| EvolutionReducer internal event dispatch | EvolutionHook callback interface | Phase 0b (this phase) | External consumers can observe lifecycle without extending EvolutionReducer |

**Deprecated/outdated:**
- SDK-ADP-06 (StorageAdapter): Already completed in Phase 0a. This requirement is pre-satisfied.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | SDK-ADP-06 is already satisfied by Phase 0a StorageAdapter interface and needs no new work | Phase Requirements | Would need to add StorageAdapter methods, but CONTEXT.md confirms "Phase 0b 的 SDK-ADP-06 已被 Phase 0a 覆盖" |
| A2 | EvolutionLogger's `principle_generated` stage semantically maps to `principle_candidate_created` telemetry event | Telemetry Schema | Minor naming mismatch, easily reconciled in schema documentation |
| A3 | No new npm packages needed for this phase | Standard Stack | Would need to add dependencies if a new utility library is desired |

**If this table is empty:** All claims in this research were verified or cited -- no user confirmation needed.

## Open Questions

1. **EvolutionHook optional method strategy**
   - What we know: D-04 says "hooks not needed can provide empty implementation" and "interface callback pattern"
   - What's unclear: Whether to provide a `NoOpEvolutionHook` base class alongside the interface, or rely on consumers implementing all 3 methods
   - Recommendation: Provide a `NoOpEvolutionHook` object literal export (not a class) that implements all 3 methods as no-ops. Consumers can spread and override: `{ ...noOpEvolutionHook, onPainDetected: (s) => ... }`. This is Claude's discretion.

2. **PainSignalAdapter error handling strategy**
   - What we know: D-02 says capture() returns `PainSignal | null`
   - What's unclear: Whether translation failure (malformed event, missing fields) should return null or throw
   - Recommendation: Return null for translation failures. This is Claude's discretion. Returning null keeps the adapter resilient and matches the "returns null when event doesn't produce signal" contract. Log translation errors for observability.

## Environment Availability

Step 2.6: SKIPPED (no external dependencies -- all code/config changes using existing packages)

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.1.0 |
| Config file | vitest.config.ts (project root) |
| Quick run command | `npx vitest run tests/core/pain-signal-adapter.test.ts -x` |
| Full suite command | `npx vitest run tests/core/ -x` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SDK-ADP-01 | PainSignalAdapter interface is framework-agnostic via generic type | unit | `npx vitest run tests/core/pain-signal-adapter.test.ts -x` | Wave 0 |
| SDK-ADP-02 | PainSignalAdapter.capture() translates framework event to PainSignal or null | unit | `npx vitest run tests/core/pain-signal-adapter.test.ts -x` | Wave 0 |
| SDK-ADP-03 | PrincipleInjector.getRelevantPrinciples() delegates to selectPrinciplesForInjection | unit | `npx vitest run tests/core/principle-injector.test.ts -x` | Wave 0 |
| SDK-ADP-04 | PrincipleInjector.formatForInjection() delegates to formatPrinciple | unit | `npx vitest run tests/core/principle-injector.test.ts -x` | Wave 0 |
| SDK-ADP-05 | EvolutionHook interface has 3 methods with correct signatures | unit | `npx vitest run tests/core/evolution-hook.test.ts -x` | Wave 0 |
| SDK-ADP-06 | StorageAdapter already defined (Phase 0a) | conformance | `npx vitest run tests/core/storage-conformance.test.ts -x` | Existing |
| SDK-OBS-05 | TelemetryEvent TypeBox schema validates known event shapes | unit | `npx vitest run tests/core/telemetry-event.test.ts -x` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/core/pain-signal-adapter.test.ts tests/core/evolution-hook.test.ts tests/core/principle-injector.test.ts tests/core/telemetry-event.test.ts -x`
- **Per wave merge:** `npx vitest run tests/core/ -x`
- **Phase gate:** `npx vitest run -x` (full suite)

### Wave 0 Gaps
- [ ] `tests/core/pain-signal-adapter.test.ts` -- covers SDK-ADP-01, SDK-ADP-02
- [ ] `tests/core/evolution-hook.test.ts` -- covers SDK-ADP-05
- [ ] `tests/core/principle-injector.test.ts` -- covers SDK-ADP-03, SDK-ADP-04
- [ ] `tests/core/telemetry-event.test.ts` -- covers SDK-OBS-05

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | N/A -- interfaces only, no auth flows |
| V3 Session Management | no | N/A -- no session creation |
| V4 Access Control | no | N/A -- no privileged operations |
| V5 Input Validation | yes | PainSignalAdapter.capture() output validated via validatePainSignal() |
| V6 Cryptography | no | N/A -- no crypto operations |

### Known Threat Patterns for Adapter Interfaces

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Malformed framework event injection | Tampering | validatePainSignal() on adapter output (Phase 0a) |
| Telemetry event data leakage | Information Disclosure | Schema does not include PII; context field is Record<string, unknown> -- framework adapter responsible for sanitization |

## Project Constraints (from CLAUDE.md)

- **Max cyclomatic complexity: 10** -- Adapter interfaces are inherently simple (single method per concern), but any OpenClaw-specific implementation must stay under 10.
- **No `any` type usage** (warn) -- PainSignalAdapter<TRawEvent> uses generics, not any.
- **Unused variables prefixed with `_`** -- Standard TypeScript convention.
- **Conventional Commits:** `feat(core): add PainSignalAdapter interface` format.
- **TypeBox for runtime validation** -- TelemetryEvent must use TypeBox, not Zod or custom.
- **Test framework: Vitest** -- All new tests use vitest, not jest.

## Sources

### Primary (HIGH confidence)
- Codebase: `src/core/storage-adapter.ts` -- adapter interface pattern precedent
- Codebase: `src/core/pain-signal.ts` -- Phase 0a PainSignal schema (verified 136 lines)
- Codebase: `src/core/principle-injection.ts` -- delegate target for PrincipleInjector (verified 208 lines)
- Codebase: `src/core/evolution-reducer.ts` -- extraction source for EvolutionHook events
- Codebase: `src/core/evolution-logger.ts` -- existing telemetry output (verified 356 lines)
- Codebase: `src/hooks/pain.ts` -- extraction source for PainSignalAdapter (verified 416 lines)
- Codebase: `src/openclaw-sdk.d.ts` -- OpenClaw event types (PluginHookAfterToolCallEvent, etc.)
- Codebase: `.planning/phases/00a-interface-core/00a-VERIFICATION.md` -- Phase 0a verification (passed 4/4)
- npm registry: @sinclair/typebox 0.34.49 (verified current)
- package.json: vitest ^4.1.0, typescript ^6.0.2 (verified)

### Secondary (MEDIUM confidence)
- CONTEXT.md decisions D-01 through D-08 -- user-locked design constraints

### Tertiary (LOW confidence)
None -- all findings verified against codebase or npm registry.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new packages, all existing dependencies verified
- Architecture: HIGH - direct precedent from StorageAdapter pattern, user decisions lock the design
- Pitfalls: HIGH - identified from reading actual codebase (pain.ts mixing concerns, evolution-reducer rich types)

**Research date:** 2026-04-17
**Valid until:** 2026-05-17 (stable -- interface extraction, no external dependencies)
