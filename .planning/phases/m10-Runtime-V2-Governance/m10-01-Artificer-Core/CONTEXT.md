# m10-01 Artificer Core & LLM Integration — CONTEXT

## Phase Goal

Replace the hardcoded `buildDefaultArtificerOutput` stub with a real LLM-backed `runArtificerAsync` that dynamically generates JavaScript interception rules from Trinity reflection results.

## Current State (Verified Against Codebase)

### Stub Location
- **File:** `packages/openclaw-plugin/src/service/nocturnal-service.ts`
- **Function:** `buildDefaultArtificerOutput` (lines 419-465)
- **Called at:** line 633 inside `maybePersistArtificerCandidate`
- **Behavior:** Always generates identical JS — checks `riskPath && toolName === 'write' && planStatus !== 'READY'` regardless of input

### Integration Point
```typescript
// nocturnal-service.ts:630-639
const parsedArtificer =
  options.artificerOutputOverride !== undefined
    ? parseArtificerOutput(options.artificerOutputOverride)  // test override path
    : buildDefaultArtificerOutput(                           // PRODUCTION STUB — to be replaced
        ruleResolution.ruleId,
        artifact,
        artifact.sourceSnapshotRef,
        sourcePainIds,
        sourceGateBlockIds
      );
```

### Existing Infrastructure (Ready to Use)

1. **`ArtificerInput` interface** (nocturnal-artificer.ts:18-30):
   - `principleId`, `ruleId`, `snapshot`, `scribeArtifact`, `lineage`
   - Fully defined, no changes needed

2. **`ArtificerOutput` interface** (nocturnal-artificer.ts:32-40):
   - `ruleId`, `implementationType: 'code'`, `candidateSource`, `helperUsage[]`, `expectedDecision`, `rationale`, `lineage`
   - Fully defined, no changes needed

3. **`resolveArtificerTargetRule`** (nocturnal-artificer.ts:138-210):
   - Scores rules against snapshot signals (gate/pain/tool/impl)
   - Returns `selected` or `skip` with deterministic winner
   - **Works correctly — no changes needed**

4. **`shouldRunArtificer`** (nocturnal-artificer.ts:212-227):
   - Checks signal density (default minimum 2)
   - **Works correctly — no changes needed**

5. **`parseArtificerOutput`** (nocturnal-artificer.ts:229-257):
   - Validates JSON structure of ArtificerOutput
   - **Works correctly — no changes needed**

6. **`validateRuleImplementationCandidate`** (nocturnal-rule-implementation-validator.ts):
   - 13 forbidden API patterns (fs, child_process, eval, fetch, etc.)
   - Compilation check
   - `meta` + `evaluate` structure validation
   - **Non-negotiable gate (LOCKED-05) — no changes needed**

7. **`TrinityRuntimeAdapter` interface** (nocturnal-trinity.ts:374-436):
   - `isRuntimeAvailable()`, `getLastFailureReason()`, `invokeDreamer()`, `invokePhilosopher()`, `invokeScribe()`, `close()`
   - **Needs `invokeArtificer` method added**

8. **`OpenClawTrinityRuntimeAdapter`** (nocturnal-trinity.ts:536+):
   - Uses `api.runtime.agent.runEmbeddedPiAgent()` for LLM calls
   - **Needs `invokeArtificer` implementation**

9. **`NocturnalServiceOptions.runtimeAdapter`** (nocturnal-service.ts:233):
   - Already passes `TrinityRuntimeAdapter` into the service
   - **Available for Artificer to use — same adapter (LOCKED-04)**

### Key Data Flow

```
Trinity Reflection (Dreamer → Philosopher → Scribe)
  → ScribeArtifact: { badDecision, betterDecision, rationale }
  → resolveArtificerTargetRule: selects target rule
  → shouldRunArtificer: signal density check
  → [MISSING] runArtificerAsync: LLM generates candidateSource JS
  → parseArtificerOutput: validate JSON
  → validateRuleImplementationCandidate: sandbox validation
  → persistCodeCandidate: write to ledger
```

## Design Decisions (Pre-Discuss)

### DD-01: Where to add `runArtificerAsync`
**Location:** `nocturnal-artificer.ts` — new exported function
**Rationale:** File already has all Artificer types and utilities. Follows single-responsibility.

### DD-02: Extend TrinityRuntimeAdapter or separate interface
**Decision:** Extend `TrinityRuntimeAdapter` with `invokeArtificer()`
**Rationale:** LOCKED-04 mandates same adapter config. OpenClawTrinityRuntimeAdapter already has the `runEmbeddedPiAgent` infrastructure. Adding a method is cleaner than a parallel adapter.

### DD-03: Prompt design approach
**Decision:** Structured system prompt + scribe artifact context → generate `candidateSource` JS
**Format:** The LLM receives:
- System prompt defining the rule sandbox constraints (13 forbidden APIs, meta/evaluate structure)
- Scribe artifact (badDecision, betterDecision, rationale)
- Target rule info (ruleId, name, description, triggerCondition, action)
- Expected output format (JSON matching ArtificerOutput)

### DD-04: Fallback behavior
**Decision:** If LLM fails or output fails validation → return null (skip artificer, no candidate)
**Rationale:** No candidate is better than a bad candidate. The stub's "always generate" was the bug.

## Open Questions

1. **Prompt language:** Should the Artificer prompt be in English (matching codebase) or configurable?
2. **Token budget:** What's the max tokens for Artificer response? (Trinity stages use configurable timeoutMs)
3. **Retry logic:** Should Artificer retry on validation failure? (Diagnostician doesn't retry)

## Constraints (LOCKED)

- LOCKED-04: Same `runtimeAdapter` as Diagnostician
- LOCKED-05: `validateRuleImplementationCandidate` is non-negotiable gate
- Artificer only generates sandbox `.js`, never modifies production code
- Must pass `RuleHost` sandbox validation before persistence

## Files to Modify

| File | Change |
|------|--------|
| `nocturnal-artificer.ts` | Add `runArtificerAsync` + Artificer prompt builder |
| `nocturnal-trinity.ts` | Add `invokeArtificer` to `TrinityRuntimeAdapter` interface |
| `nocturnal-trinity.ts` | Implement `invokeArtificer` in `OpenClawTrinityRuntimeAdapter` |

## Files NOT to Modify (Confirmed Working)

- `nocturnal-service.ts` — m10-02 scope (pipeline integration)
- `nocturnal-artificer.ts` existing functions — all work correctly
- `nocturnal-rule-implementation-validator.ts` — locked gate
- `principle-tree-ledger.ts` — read-only dependency
