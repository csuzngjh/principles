# m10-01 Artificer Core & LLM Integration — PLAN

## Overview

Replace hardcoded Artificer stub with LLM-backed `runArtificerAsync`. This plan covers ONLY the Artificer core — pipeline integration (replacing the stub call in NocturnalService) is m10-02.

## Plans

### Plan 1: Extend TrinityRuntimeAdapter with invokeArtificer

**File:** `packages/openclaw-plugin/src/core/nocturnal-trinity.ts`

**Changes:**
1. Add `invokeArtificer` method to `TrinityRuntimeAdapter` interface (after `invokeScribe`):
   ```typescript
   invokeArtificer(
     _input: ArtificerInput,
     _ruleContext: ArtificerRuleContext,
     _telemetry: TrinityTelemetry,
     _config: TrinityConfig
   ): Promise<string | null>;  // Returns raw JSON string or null
   ```

2. Add `ArtificerRuleContext` type:
   ```typescript
   export interface ArtificerRuleContext {
     ruleName: string;
     ruleDescription: string;
     triggerCondition: string;
     action: string;
     forbiddenApis: string[];  // From validator's known list
   }
   ```

3. Implement in `OpenClawTrinityRuntimeAdapter`:
   - Reuse existing `runEmbeddedPiAgent` pattern from `invokeScribe`
   - Build Artificer-specific system prompt
   - Parse response as JSON string
   - Return null on failure (timeout, parse error, empty response)

**Verification:**
- `lsp_diagnostics` clean on `nocturnal-trinity.ts`
- Interface change compiles without breaking existing implementations
- `OpenClawTrinityRuntimeAdapter.invokeArtificer` follows same pattern as `invokeScribe`

### Plan 2: Implement runArtificerAsync + Artificer Prompt

**File:** `packages/openclaw-plugin/src/core/nocturnal-artificer.ts`

**Changes:**

1. Add `buildArtificerPrompt` function:
   - System prompt defining sandbox constraints:
     - Must export `meta` object with `name`, `version`, `ruleId`, `coversCondition`
     - Must export `evaluate(input, helpers)` function
     - 13 forbidden APIs (fs, child_process, eval, Function, fetch, require, import, process, Buffer, setTimeout/setInterval with string arg, WebSocket, XMLHttpRequest, URL)
     - `evaluate` must return `{ decision: 'allow'|'block'|'requireApproval', matched: boolean, reason: string }`
   - Context section with:
     - Target rule info (name, description, triggerCondition, action)
     - Scribe artifact (badDecision, betterDecision, rationale)
     - Pain event summaries
     - Gate block summaries
   - Output format instruction: JSON matching `ArtificerOutput` interface

2. Add `runArtificerAsync` function:
   ```typescript
   export async function runArtificerAsync(
     input: ArtificerInput,
     ruleContext: ArtificerRuleContext,
     adapter: TrinityRuntimeAdapter,
     telemetry: TrinityTelemetry,
     config: TrinityConfig
   ): Promise<ArtificerOutput | null>
   ```
   - Calls `adapter.invokeArtificer(input, ruleContext, telemetry, config)`
   - Parses raw JSON with `parseArtificerOutput`
   - Returns `ArtificerOutput` or null
   - Does NOT call `validateRuleImplementationCandidate` (that's the caller's responsibility)

3. Export `ArtificerRuleContext` from nocturnal-trinity.ts re-export

**Verification:**
- `lsp_diagnostics` clean on `nocturnal-artificer.ts`
- `runArtificerAsync` returns null on adapter failure (not throws)
- `buildArtificerPrompt` produces complete prompt with all required sections

### Plan 3: Unit Tests for Artificer Core

**File:** `packages/openclaw-plugin/src/__tests__/m10-artificer-core.test.ts`

**Test Cases:**

1. **buildArtificerPrompt structure:**
   - Contains meta/evaluate structure instruction
   - Contains forbidden API list
   - Contains scribe artifact context
   - Contains target rule context

2. **runArtificerAsync happy path:**
   - Mock adapter returns valid JSON → parsed ArtificerOutput returned

3. **runArtificerAsync adapter failure:**
   - Mock adapter returns null → runArtificerAsync returns null

4. **runArtificerAsync invalid JSON:**
   - Mock adapter returns malformed JSON → runArtificerAsync returns null

5. **runArtificerAsync parseArtificerOutput rejection:**
   - Mock adapter returns valid JSON but missing required fields → returns null

6. **invokeArtificer in OpenClawTrinityRuntimeAdapter:**
   - Verify prompt construction
   - Verify timeout handling
   - Verify runEmbeddedPiAgent called with correct params

**Verification:**
- All tests pass
- Coverage > 80% for modified code

## Dependencies

- Plan 1 → Plan 2 (runArtificerAsync needs invokeArtificer on adapter)
- Plan 2 → Plan 3 (tests need runArtificerAsync)

## Out of Scope (m10-02)

- Replacing `buildDefaultArtificerOutput` call in `nocturnal-service.ts`
- Adding `runArtificerAsync` to the service pipeline
- E2E validation of full reflection → artificer → persistence flow

## Success Criteria

1. `TrinityRuntimeAdapter` interface extended with `invokeArtificer`
2. `OpenClawTrinityRuntimeAdapter.invokeArtificer` implemented
3. `runArtificerAsync` exported from `nocturnal-artificer.ts`
4. `buildArtificerPrompt` produces sandbox-aware prompts
5. All unit tests pass
6. `lsp_diagnostics` clean on all modified files
7. No changes to `nocturnal-service.ts` (m10-02 scope)
