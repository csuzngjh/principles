# Phase 10: fix-noc15-stub-params - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md — this log preserves the analysis.

**Date:** 2026-04-06
**Phase:** 10-fix-noc15-stub-params
**Mode:** discuss
**Areas discussed:** Method signatures, Cleanup, Testing

## Assumptions Presented

### Method Signatures
| Assumption | Confidence | Evidence |
|-----------|-----------|----------|
| Stub methods accept fewer params than interface requires | Confident | `nocturnal-workflow-manager.ts:174-184` — `invokeDreamer()` 0 params, `invokePhilosopher(dreamerOutput)` 1 param |
| Stub correctly uses stored values internally | Confident | Lines 177, 183 — `invokeStubDreamer(this.snapshot, this.principleId, this.maxCandidates)` |

## Corrections Made

No corrections — assumptions confirmed.

## Decisions Made

### Method Signatures
- **Use passed parameters** — Change `invokeDreamer(snapshot, principleId, maxCandidates)` to use the actual passed params directly, not stored constructor values. More pure to interface semantics.

### Cleanup
- **Remove unused `realAdapter`** — The constructor parameter `private realAdapter: TrinityRuntimeAdapter` is stored but never used. Remove it.

### Testing
- **Update existing test mocks** — Fix `vi.fn<>` type signatures in `nocturnal-workflow-manager.test.ts` to match interface:
  - `invokeDreamer: vi.fn<(snapshot: any, principleId: any, maxCandidates: any) => Promise<DreamerOutput>>()`
  - `invokePhilosopher: vi.fn<(dreamerOutput: any, principleId: any) => Promise<PhilosopherOutput>>()`

## Gray Areas Skipped

The user selected "All gray areas" but the bug fix is straightforward. No additional gray areas were identified beyond the three discussed (signatures, cleanup, testing).

---
