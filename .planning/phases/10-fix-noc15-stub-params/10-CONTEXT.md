# Phase 10: fix-noc15-stub-params - Context

**Gathered:** 2026-04-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix TypeScript interface compliance bug in `StubFallbackRuntimeAdapter` where method signatures don't match `TrinityRuntimeAdapter` interface. The stub methods accept fewer parameters than the interface requires, causing a type mismatch.

</domain>

<decisions>
## Implementation Decisions

### Method Signatures
- **D-01:** `StubFallbackRuntimeAdapter.invokeDreamer(snapshot, principleId, maxCandidates)` — use the passed-in parameters directly (not stored constructor values)
- **D-02:** `StubFallbackRuntimeAdapter.invokePhilosopher(dreamerOutput, principleId)` — use both passed-in parameters directly
- **D-03:** Remove unused `private realAdapter: TrinityRuntimeAdapter` from constructor — it was stored but never used

### Testing
- **D-04:** Update `vi.fn<>` type signatures in `nocturnal-workflow-manager.test.ts` to match interface:
  - `invokeDreamer: vi.fn<(snapshot: any, principleId: any, maxCandidates: any) => Promise<DreamerOutput>>()`
  - `invokePhilosopher: vi.fn<(dreamerOutput: any, principleId: any) => Promise<PhilosopherOutput>>()`

### Constraints
- **D-05:** The stub implementation logic remains the same — it calls the `invokeStub*` functions from `nocturnal-trinity.js` with the correct arguments
- **D-06:** Only fix the method signatures and remove dead code — no other changes to the stub behavior

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Nocturnal Trinity
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — `TrinityRuntimeAdapter` interface defines the required signatures for `invokeDreamer`, `invokePhilosopher`, `invokeScribe`
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — `invokeStubDreamer`, `invokeStubPhilosopher`, `invokeStubScribe` implementations

### Nocturnal Workflow Manager
- `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` — `StubFallbackRuntimeAdapter` class (lines 166-202) and its usage in fallback paths (lines 348-354, 382-388)

### Tests
- `packages/openclaw-plugin/tests/service/nocturnal-workflow-manager.test.ts` — test file requiring mock signature updates

</canonical_refs>

<codebase>
## Existing Code Insights

### Bug Summary
The `StubFallbackRuntimeAdapter` class claims to implement `TrinityRuntimeAdapter` but its method signatures don't match:
- `invokeDreamer()` has 0 params — interface requires 3
- `invokePhilosopher(dreamerOutput)` has 1 param — interface requires 2

The stub correctly passes stored values (`this.snapshot`, `this.principleId`, `this.maxCandidates`) to the underlying `invokeStub*` functions — but the method signatures themselves are wrong.

### Integration Points
- Stub adapter is instantiated in fallback paths within `NocturnalWorkflowManager` at lines 348 and 382
- The stub is created with correct values in constructor — parameters would be identical to what interface requires

### Established Patterns
- The `NocturnalWorkflowManager` uses composition via `TrinityRuntimeAdapter` interface (not inheritance)
- Fallback stub is created fresh per stage failure with correct captured values

</codebase>

<specifics>
## Specific Ideas

- The fix should be surgical: only update method signatures and remove unused field
- No changes to the actual stub logic (how it calls `invokeStub*` functions)
- TypeScript compilation should pass cleanly after the fix

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 10-fix-noc15-stub-params*
*Context gathered: 2026-04-06*
