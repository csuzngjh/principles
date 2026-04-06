# Phase 10: fix-noc15-stub-params - Research

**Researched:** 2026-04-06
**Domain:** TypeScript interface compliance / method signature mismatch
**Confidence:** HIGH

## Summary

NOC-15 gap closure: `StubFallbackRuntimeAdapter` class declares `implements TrinityRuntimeAdapter` but its method signatures don't match the interface. This is a purely TypeScript-typing bug with no runtime behavioral change — the stub methods internally already pass the correct values to `invokeStub*` functions, they just accept fewer parameters than the interface requires.

**Primary recommendation:** Update `invokeDreamer` and `invokePhilosopher` signatures in `StubFallbackRuntimeAdapter` to match `TrinityRuntimeAdapter` interface. Remove unused `private realAdapter` field. Update test mock signatures.

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** `StubFallbackRuntimeAdapter.invokeDreamer(snapshot, principleId, maxCandidates)` — use the passed-in parameters directly (not stored constructor values)
- **D-02:** `StubFallbackRuntimeAdapter.invokePhilosopher(dreamerOutput, principleId)` — use both passed-in parameters directly
- **D-03:** Remove unused `private realAdapter: TrinityRuntimeAdapter` from constructor — it was stored but never used
- **D-05:** The stub implementation logic remains the same — it calls the `invokeStub*` functions with the correct arguments
- **D-06:** Only fix the method signatures and remove dead code — no other changes to the stub behavior

### Testing
- **D-04:** Update `vi.fn<>` type signatures in `nocturnal-workflow-manager.test.ts`:
  - `invokeDreamer: vi.fn<(snapshot: any, principleId: any, maxCandidates: any) => Promise<DreamerOutput>>()`
  - `invokePhilosopher: vi.fn<(dreamerOutput: any, principleId: any) => Promise<PhilosopherOutput>>()`

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| NOC-15 | Trinity 失败时降级到 stub 实现（而非委托 EmpathyObserver/DeepReflect） | `StubFallbackRuntimeAdapter` class exists at lines 166-202, correctly degrades to stub functions; only signatures need fixing |

## Standard Stack

No new dependencies. All changes are within existing TypeScript files.

| File | Change |
|------|--------|
| `nocturnal-workflow-manager.ts` | Fix `StubFallbackRuntimeAdapter` method signatures, remove dead field |
| `nocturnal-workflow-manager.test.ts` | Update test mock signatures to match interface |

## Bug Anatomy

### TrinityRuntimeAdapter Interface (nocturnal-trinity.ts:72-121)

```typescript
export interface TrinityRuntimeAdapter {
  invokeDreamer(
    snapshot: NocturnalSessionSnapshot,
    principleId: string,
    maxCandidates: number
  ): Promise<DreamerOutput>;

  invokePhilosopher(
    dreamerOutput: DreamerOutput,
    principleId: string
  ): Promise<PhilosopherOutput>;

  invokeScribe(
    dreamerOutput: DreamerOutput,
    philosopherOutput: PhilosopherOutput,
    snapshot: NocturnalSessionSnapshot,
    principleId: string,
    telemetry: TrinityTelemetry,
    config: TrinityConfig
  ): Promise<TrinityDraftArtifact | null>;
}
```

### StubFallbackRuntimeAdapter Current State (nocturnal-workflow-manager.ts:166-202)

```typescript
class StubFallbackRuntimeAdapter implements TrinityRuntimeAdapter {
    constructor(
        private realAdapter: TrinityRuntimeAdapter,  // D-03: REMOVE — never used
        private snapshot: NocturnalSessionSnapshot,
        private principleId: string,
        private maxCandidates: number
    ) {}

    async invokeDreamer(): Promise<DreamerOutput> {  // BUG: 0 params, needs 3
        const { invokeStubDreamer } = await import('../../core/nocturnal-trinity.js');
        return invokeStubDreamer(this.snapshot, this.principleId, this.maxCandidates);
    }

    async invokePhilosopher(dreamerOutput: DreamerOutput): Promise<PhilosopherOutput> {  // BUG: 1 param, needs 2
        const { invokeStubPhilosopher } = await import('../../core/nocturnal-trinity.js');
        return invokeStubPhilosopher(dreamerOutput, this.principleId);
    }

    async invokeScribe(  // CORRECT: 6 params matches interface
        dreamerOutput: DreamerOutput,
        philosopherOutput: PhilosopherOutput,
        snapshot: NocturnalSessionSnapshot,
        principleId: string,
        telemetry: TrinityTelemetry,
        config: TrinityConfig
    ): Promise<TrinityDraftArtifact | null> {
        const { invokeStubScribe } = await import('../../core/nocturnal-trinity.js');
        return invokeStubScribe(dreamerOutput, philosopherOutput, snapshot, principleId, telemetry, config);
    }
}
```

### Summary of Mismatches

| Method | Interface Params | Stub Params | Status |
|--------|-----------------|-------------|--------|
| `invokeDreamer` | `(snapshot, principleId, maxCandidates)` | `()` | MISMATCH |
| `invokePhilosopher` | `(dreamerOutput, principleId)` | `(dreamerOutput)` | MISMATCH |
| `invokeScribe` | `(dreamerOutput, philosopherOutput, snapshot, principleId, telemetry, config)` | Same 6 | OK |
| `realAdapter` | — | Stored in constructor | D-03: Remove |

## Fixed Implementation

After applying D-01, D-02, D-03:

```typescript
class StubFallbackRuntimeAdapter implements TrinityRuntimeAdapter {
    constructor(
        private snapshot: NocturnalSessionSnapshot,   // D-03: removed realAdapter
        private principleId: string,
        private maxCandidates: number
    ) {}

    async invokeDreamer(                              // D-01: 3 params now
        snapshot: NocturnalSessionSnapshot,
        principleId: string,
        maxCandidates: number
    ): Promise<DreamerOutput> {
        const { invokeStubDreamer } = await import('../../core/nocturnal-trinity.js');
        return invokeStubDreamer(snapshot, principleId, maxCandidates);  // D-01: use passed params
    }

    async invokePhilosopher(                          // D-02: 2 params now
        dreamerOutput: DreamerOutput,
        principleId: string
    ): Promise<PhilosopherOutput> {
        const { invokeStubPhilosopher } = await import('../../core/nocturnal-trinity.js');
        return invokeStubPhilosopher(dreamerOutput, principleId);  // D-02: use passed params
    }

    async invokeScribe(
        dreamerOutput: DreamerOutput,
        philosopherOutput: PhilosopherOutput,
        snapshot: NocturnalSessionSnapshot,
        principleId: string,
        telemetry: TrinityTelemetry,
        config: TrinityConfig
    ): Promise<TrinityDraftArtifact | null> {
        const { invokeStubScribe } = await import('../../core/nocturnal-trinity.js');
        return invokeStubScribe(dreamerOutput, philosopherOutput, snapshot, principleId, telemetry, config);
    }
}
```

Note: After the signature fix, the callers at lines 354 and 388 must also be updated to pass arguments:
- Line 354: `stubAdapter.invokeDreamer()` → `stubAdapter.invokeDreamer(snapshot, principleId, trinityConfig.maxCandidates)`
- Line 388: `stubAdapter.invokePhilosopher(dreamerOutput)` → `stubAdapter.invokePhilosopher(dreamerOutput, principleId)`

The CONTEXT.md doesn't explicitly mention updating the callers, but this follows logically from D-01 and D-02. The planner should include these caller updates.

## Test Mock Fix (D-04)

Current (broken) mock signatures in `nocturnal-workflow-manager.test.ts:32-34`:

```typescript
function createMockRuntimeAdapter() {
    return {
        invokeDreamer: vi.fn<() => Promise<DreamerOutput>>(),              // WRONG: 0 params
        invokePhilosopher: vi.fn<() => Promise<PhilosopherOutput>>(),     // WRONG: 0 params
        invokeScribe: vi.fn<() => Promise<TrinityDraftArtifact | null>>(), // WRONG: 0 params
    } as unknown as TrinityRuntimeAdapter;
}
```

Fixed mock signatures per D-04:

```typescript
function createMockRuntimeAdapter() {
    return {
        invokeDreamer: vi.fn<(snapshot: any, principleId: any, maxCandidates: any) => Promise<DreamerOutput>>(),
        invokePhilosopher: vi.fn<(dreamerOutput: any, principleId: any) => Promise<PhilosopherOutput>>(),
        invokeScribe: vi.fn<(dreamerOutput: any, philosopherOutput: any, snapshot: any, principleId: any, telemetry: any, config: any) => Promise<TrinityDraftArtifact | null>>(),
    } as unknown as TrinityRuntimeAdapter;
}
```

## Don't Hand-Roll

Not applicable — this is a TypeScript signature fix, not a feature implementation.

## Common Pitfalls

### Pitfall 1: Forgetting to update callers after signature fix
**What goes wrong:** After fixing `invokeDreamer(snapshot, principleId, maxCandidates)`, calls at lines 354 and 388 still pass 0 and 1 arguments respectively.
**How to avoid:** The plan must include caller updates alongside signature fixes.

### Pitfall 2: Test mock types not updated
**What goes wrong:** `createMockRuntimeAdapter()` returns `vi.fn<() => ...>` which won't type-check against the updated interface signatures.
**How to avoid:** Update mock types per D-04 before TypeScript compilation.

## Architecture Patterns

This phase follows the **adapter pattern**: `StubFallbackRuntimeAdapter` wraps synchronous stub functions (`invokeStubDreamer`, `invokeStubPhilosopher`, `invokeStubScribe`) to implement the async `TrinityRuntimeAdapter` interface. The fix is purely contractual (TypeScript interface compliance), not behavioral.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.2 |
| Config file | `vitest.config.ts` (detected in project root) |
| Quick run command | `cd packages/openclaw-plugin && npx vitest run tests/service/nocturnal-workflow-manager.test.ts` |
| Full suite command | `cd packages/openclaw-plugin && npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command |
|--------|----------|-----------|--------------------|
| NOC-15 | `StubFallbackRuntimeAdapter` implements `TrinityRuntimeAdapter` correctly | type check | `npx tsc --noEmit` (TypeScript compilation) |

### Sampling Rate
- **Per task commit:** TypeScript compile check — `cd packages/openclaw-plugin && npx tsc --noEmit`
- **Per wave merge:** Full vitest suite
- **Phase gate:** TypeScript compiles cleanly + vitest passes

### Wave 0 Gaps
None — existing test infrastructure and TypeScript tooling cover this phase.

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — `TrinityRuntimeAdapter` interface (lines 72-121), stub implementations (lines 775-1022)
- `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` — `StubFallbackRuntimeAdapter` class (lines 166-202), caller sites (lines 348-354, 382-388)
- `packages/openclaw-plugin/tests/service/nocturnal-workflow-manager.test.ts` — mock adapter factory (lines 30-36)

### Secondary (MEDIUM confidence)
- NOC-15 from `.planning/REQUIREMENTS.md` — defines fallback behavior requirement
- CONTEXT.md decisions D-01 through D-06 — locked implementation constraints

## Open Questions

None — all decisions are locked in CONTEXT.md.

## Metadata

**Confidence breakdown:**
- Bug diagnosis: HIGH — confirmed by reading interface vs. implementation
- Fix specification: HIGH — D-01 through D-06 fully specify the change
- Test mock fix: HIGH — directly derivable from D-04 and interface
- Caller updates: MEDIUM — logically required by D-01/D-02 but not explicitly stated in CONTEXT.md (planner should include)

**Research date:** 2026-04-06
**Valid until:** 2026-05-06 (TypeScript signature bugs are stable — no ecosystem changes affect this)
