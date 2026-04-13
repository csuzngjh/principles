# Phase 35: Dreamer Enhancement - Research

**Researched:** 2026-04-13
**Domain:** Nocturnal Trinity pipeline — Dreamer stage enhancement for strategic diversity
**Confidence:** HIGH

## Summary

Phase 35 enhances the Dreamer stage of the Nocturnal Trinity pipeline to generate strategically diverse candidates using reasoning context derived from Phase 34. The phase touches four files: `nocturnal-trinity.ts` (prompt extension, interface extension, prompt builder injection, stub updates), `nocturnal-candidate-scoring.ts` (new `validateCandidateDiversity()` function), and indirectly consumes `nocturnal-reasoning-deriver.ts` (built in Phase 34). All changes are backward-compatible -- new DreamerCandidate fields are optional, diversity validation is soft (logs warnings, never gates the pipeline), and existing candidates without new fields continue to work.

The implementation is well-scoped with clear design doc specifications. The Jaccard-like keyword overlap algorithm is straightforward to implement. The primary complexity lies in prompt engineering (adding strategic perspective requirements to `NOCTURNAL_DREAMER_PROMPT`) and the integration point where `buildDreamerPrompt()` calls deriver functions and injects their output.

**Primary recommendation:** Follow the design doc (`docs/plans/2026-04-12-trinity-quality-enhancement-design.md`) precisely for prompt text and algorithm specs. All locked decisions from CONTEXT.md align with the design doc. No external dependencies needed -- this is pure TypeScript with no new libraries.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Force distinct strategic perspectives per candidate -- 2 candidates = 2 different perspectives, 3 = all three covered (conservative_fix, structural_improvement, paradigm_shift)
- **D-02:** Risk level (low/medium/high) is LLM-judged per candidate, not bound to perspective type. Prompt requires inclusion but does not constrain the value
- **D-03:** Derived reasoning signals inject as a new independent `## Reasoning Context` section in buildDreamerPrompt(), placed after existing Session Context sections
- **D-04:** Only inject reasoningChain + contextualFactors into Dreamer. DecisionPoints are reserved for Phase 37 (Scribe contrastive analysis). Follows design doc allocation
- **D-05:** Keyword overlap uses Jaccard-like algorithm: `intersection / max(|A|, |B|)` for words > 3 chars, threshold 0.8. No external dependencies
- **D-06:** `validateCandidateDiversity()` lives in `nocturnal-candidate-scoring.ts` alongside existing scoring/validation functions
- **D-07:** Fixed mapping for stub candidates: gateBlocks -> conservative_fix/low, pain -> structural_improvement/medium, failures -> paradigm_shift/high. Deterministic, testable

### Claude's Discretion
- Exact formatting of Reasoning Context section (how to serialize reasoning chain + contextual factors into prompt text)
- Anti-pattern warning wording in NOCTURNAL_DREAMER_PROMPT
- validateCandidateDiversity() helper function decomposition
- Telemetry field names and structure for diversityCheckPassed

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DIVER-01 | Dreamer prompt includes strategic perspective requirements with anti-pattern warnings | Extend `NOCTURNAL_DREAMER_PROMPT` (lines 64-149 of `nocturnal-trinity.ts`). Design doc provides exact prompt text in Section A1 |
| DIVER-02 | DreamerCandidate interface gains optional `riskLevel` and `strategicPerspective` fields | Add two optional fields to existing interface at line 1247 of `nocturnal-trinity.ts`. Backward compatible since all existing code accesses only required fields |
| DIVER-03 | `validateCandidateDiversity()` checks risk diversity (Set.size >= 2) and keyword overlap (> 0.8) | New function in `nocturnal-candidate-scoring.ts`. Algorithm: `intersection / max(|A|, |B|)` for words > 3 chars per D-05 |
| DIVER-04 | Diversity failures log telemetry warnings with `diversityCheckPassed: false`, do not hard-gate | Soft enforcement pattern already established in codebase. Add field to `TrinityTelemetry` interface |
| DERIV-04 | Derived reasoning signals injected into Dreamer prompt builder | `buildDreamerPrompt()` (lines 724-811) calls `deriveReasoningChain()` + `deriveContextualFactors()` from Phase 34 module. New `## Reasoning Context` section per D-03 |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | (existing) | Test framework | Already configured in `packages/openclaw-plugin/vitest.config.ts`, all existing tests use it [VERIFIED: codebase] |
| TypeScript | (existing) | Language | Project-wide standard [VERIFIED: codebase] |

### Supporting
No new dependencies required. This phase uses only existing codebase modules.

### Alternatives Considered
Not applicable -- no new dependencies for this phase.

**Installation:**
```bash
# No new packages required
```

**Version verification:** No new packages to verify.

## Architecture Patterns

### Recommended Project Structure
```
packages/openclaw-plugin/src/core/
  nocturnal-trinity.ts              # MODIFY: prompt, interface, builder, stub
  nocturnal-candidate-scoring.ts    # MODIFY: add validateCandidateDiversity()
  nocturnal-reasoning-deriver.ts    # CONSUME: import deriveReasoningChain + deriveContextualFactors

packages/openclaw-plugin/tests/core/
  nocturnal-trinity.test.ts         # MODIFY: add tests for new prompt, interface, stub
  nocturnal-candidate-scoring.test.ts  # MODIFY: add diversity validation tests
```

### Pattern 1: Prompt Extension Pattern
**What:** Add a new section to embedded prompt constant, then update the builder to inject derived data into that section.
**When to use:** When enhancing a Trinity stage prompt with new context.
**Example:**
```typescript
// In NOCTURNAL_DREAMER_PROMPT constant (top of file):
// Append new section after existing ## Candidates should DIFFER section:
`## Strategic Perspective Requirements

Generate candidates from DISTINCT strategic perspectives:
- **conservative_fix**: Minimal deviation from original approach.
- **structural_improvement**: Change HOW the goal is achieved.
- **paradigm_shift**: Challenge whether the original goal was correct.

Each candidate MUST specify \`riskLevel\` ("low"|"medium"|"high") and
\`strategicPerspective\` matching one of the above.

ANTI-PATTERN: Candidates that differ only in wording, not in substance,
will be rejected.`
```

### Pattern 2: Soft Validation Function
**What:** A validation function that returns a result object with pass/fail status, never throws, and is consumed for telemetry logging.
**When to use:** Post-generation checks that should not block the pipeline.
**Example:**
```typescript
// In nocturnal-candidate-scoring.ts:
export interface DiversityValidationResult {
  diversityCheckPassed: boolean;
  riskLevelDiversity: boolean;       // Set.size >= 2
  keywordOverlapPassed: boolean;     // no pair > 0.8
  maxOverlapScore: number;           // for telemetry
  details: string;                   // human-readable summary
}

export function validateCandidateDiversity(
  candidates: DreamerCandidate[]
): DiversityValidationResult {
  // Check risk level diversity
  // Check keyword overlap
  // Return result (never throw)
}
```

### Pattern 3: Reasoning Context Injection
**What:** Call deriver functions and serialize output into a new `## Reasoning Context` section.
**When to use:** When injecting derived signals into a prompt builder.
**Example:**
```typescript
// In buildDreamerPrompt():
import { deriveReasoningChain, deriveContextualFactors } from './nocturnal-reasoning-deriver.js';

// After existing context sections, before ## Task section:
const reasoningChain = deriveReasoningChain(snapshot.assistantTurns);
const contextualFactors = deriveContextualFactors(snapshot);

if (reasoningChain.length > 0 || contextualFactors) {
  sections.push(`## Reasoning Context`);
  // Serialize reasoning signals...
}
```

### Anti-Patterns to Avoid
- **Hard gating on diversity validation:** Never discard candidates or fail the pipeline when diversity check fails. Log warning + set telemetry flag only. [CITED: CONTEXT.md D-05, design doc Section A1]
- **Binding risk level to perspective type:** Risk level is LLM-judged independently per D-02. Do NOT enforce conservative_fix=low, paradigm_shift=high in the real Dreamer path (only in stubs per D-07).
- **Modifying NocturnalSessionSnapshot schema:** All reasoning signals are derived at runtime from existing data. No schema changes. [CITED: REQUIREMENTS.md "Out of Scope"]
- **Modifying service layer orchestration:** Deriver functions are called from Trinity stage builders, not from `nocturnal-service.ts`. [CITED: REQUIREMENTS.md "Out of Scope"]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Reasoning signal derivation | Custom extraction logic in buildDreamerPrompt | `deriveReasoningChain()` + `deriveContextualFactors()` from `nocturnal-reasoning-deriver.ts` | Phase 34 already implemented these with 30 passing tests [VERIFIED: test run] |
| Jaccard-like similarity | External NLP library or complex string similarity | Simple `intersection / max(|A|, |B|)` for words > 3 chars | Design spec defines the algorithm; it's ~10 lines of pure TypeScript. No need for `string-similarity` or `natural` npm packages [CITED: CONTEXT.md D-05] |

**Key insight:** This phase is almost entirely about wiring existing components together and extending existing patterns. The only "new" logic is the keyword overlap algorithm (~10 lines) and prompt text additions.

## Common Pitfalls

### Pitfall 1: parseDreamerOutput Pass-Through Assumption
**What goes wrong:** The existing `parseDreamerOutput()` (line 967) does `candidates: parsed.candidates` -- a direct pass-through of the parsed JSON array. This means new fields (`riskLevel`, `strategicPerspective`) from the LLM will flow through automatically WITHOUT any parsing changes needed.
**Why it happens:** Developers might try to add explicit field extraction in parseDreamerOutput, adding unnecessary code and potentially filtering out the new fields.
**How to avoid:** Do NOT modify parseDreamerOutput. The pass-through already handles optional new fields correctly. [VERIFIED: Read parseDreamerOutput at lines 967-1011]
**Warning signs:** If you find yourself adding `riskLevel: c.riskLevel` mappings in parseDreamerOutput, stop.

### Pitfall 2: Keyword Overlap Denominator
**What goes wrong:** Using `min(|A|, |B|)` instead of `max(|A|, |B|)` as the denominator.
**Why it happens:** Standard Jaccard uses `intersection / union`, but this spec uses `intersection / max(|A|, |B|)` which is slightly different (more lenient than Jaccard but stricter than overlap coefficient which uses `min`).
**How to avoid:** Follow D-05 exactly: `intersection / max(|A|, |B|)`. Test with a case where one candidate is much longer than another to verify the denominator is `max`. [CITED: CONTEXT.md D-05]

### Pitfall 3: buildDreamerPrompt Signature Change
**What goes wrong:** Changing `buildDreamerPrompt`'s signature to accept deriver outputs as parameters, which would require changes at all call sites.
**Why it happens:** Trying to pass pre-computed deriver results into the function.
**How to avoid:** Import and call deriver functions INSIDE `buildDreamerPrompt`. The function already has access to the full `snapshot` parameter. No signature change needed. [VERIFIED: buildDreamerPrompt takes `snapshot: NocturnalSessionSnapshot` at line 724]

### Pitfall 4: Stub Dreamer Perspective Overlap
**What goes wrong:** Stub candidates for the same signal type (e.g., all 3 gateBlocks candidates) getting the same strategicPerspective instead of diverse perspectives.
**Why it happens:** The stub function generates multiple candidates per signal type but D-01 requires distinct perspectives.
**How to avoid:** Per D-07, the fixed mapping is by signal type (gateBlocks=conservative_fix, pain=structural_improvement, failures=paradigm_shift). For stub candidates within the SAME signal type, they should ALL share that signal type's perspective (e.g., all gateBlocks candidates get conservative_fix). This is acceptable because stubs are deterministic test fixtures, not meant for real diversity testing. [CITED: CONTEXT.md D-07]

### Pitfall 5: TrinityTelemetry Interface Extension
**What goes wrong:** Forgetting to add `diversityCheckPassed` and `candidateRiskLevels` fields to the `TrinityTelemetry` interface, causing TypeScript errors at telemetry emission sites.
**Why it happens:** The telemetry interface is defined separately from the validation function.
**How to avoid:** Add optional fields to `TrinityTelemetry` first: `diversityCheckPassed?: boolean` and `candidateRiskLevels?: string[]`. Then emit them in the runTrinity functions after Dreamer output parsing. [VERIFIED: TrinityTelemetry at lines 1330-1353]

## Code Examples

Verified patterns from existing codebase:

### Existing buildDreamerPrompt section structure
```typescript
// Source: nocturnal-trinity.ts lines 760-808
const sections = [
  `## Target Principle`,
  `**Principle ID**: ${principleId}`,
  ``,
  `## Session Context`,
  `**Session ID**: ${snapshot.sessionId}`,
  ``,
];

// Conditional sections (failures, pains, blocks, turns, userCues)
// ...

// ## Task section at the end
sections.push(`## Task`, ...);
return sections.join('\n');
```

The new `## Reasoning Context` section should be inserted between the conditional sections and the `## Task` section, per D-03.

### Existing pure function pattern in nocturnal-candidate-scoring.ts
```typescript
// Source: nocturnal-candidate-scoring.ts lines 131-198
export function scoreCandidate(
  candidate: DreamerCandidate,
  judgment: PhilosopherJudgment,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): CandidateScores {
  // Pure function: no side effects, deterministic output
  // Returns structured result object
}
```

`validateCandidateDiversity` should follow this exact pattern: pure function, structured return type, no side effects.

### Existing stub candidate generation
```typescript
// Source: nocturnal-trinity.ts lines 1417-1424
if (hasGateBlocks) {
  candidates.push({
    candidateIndex: 0,
    badDecision: '...',
    betterDecision: '...',
    rationale: '...',
    confidence: 0.95,
  });
  // ...
}
```

For Phase 35, add `riskLevel` and `strategicPerspective` to each stub candidate per D-07 mapping.

### Deriver function import and usage
```typescript
// Source: nocturnal-reasoning-deriver.ts (Phase 34, verified)
import { deriveReasoningChain, deriveContextualFactors } from './nocturnal-reasoning-deriver.js';

// Usage pattern:
const reasoningChain = deriveReasoningChain(snapshot.assistantTurns);
const contextualFactors = deriveContextualFactors(snapshot);
// Both return structured objects, never throw, handle empty inputs gracefully
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Dreamer generates candidates without perspective constraints | Dreamer requires distinct strategic perspectives per candidate | Phase 35 (this phase) | Forces LLM to think from different angles |
| No diversity post-validation | validateCandidateDiversity() checks risk + keyword overlap | Phase 35 (this phase) | Soft enforcement catches homogeneous candidates |
| No reasoning context in Dreamer prompt | Derived reasoning chain + contextual factors injected | Phase 35 (this phase) | LLM has richer context for generating quality candidates |

**Deprecated/outdated:**
- None for this phase. All changes are additive.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `parseDreamerOutput` does not need modification because it passes through `parsed.candidates` directly, and new optional fields will flow through from LLM JSON output | Architecture Patterns | If parseDreamerOutput is changed to do field-level extraction, new fields would be silently dropped. LOW risk -- verified by code reading. |
| A2 | `buildDreamerPrompt` can import and call deriver functions directly without signature changes since it already receives the full `snapshot` parameter | Architecture Patterns | If signature needs changing, all call sites need updating. LOW risk -- verified by code reading. |
| A3 | The `TrinityTelemetry` interface needs new optional fields (`diversityCheckPassed`, `candidateRiskLevels`) but existing telemetry initializers (4 locations) do not need updates since the fields are optional | Common Pitfalls | TypeScript compilation would fail if required fields are added. LOW risk -- optional fields are backward compatible. |

**Note:** Claims A1-A3 are marked [ASSUMED] but have been verified by direct code reading. They carry LOW risk.

## Open Questions

1. **Reasoning Context serialization format**
   - What we know: Must be a `## Reasoning Context` section after existing context, before `## Task`. D-03 locks the placement.
   - What's unclear: How to format `DerivedReasoningSignal[]` and `DerivedContextualFactors` as human-readable prompt text.
   - Recommendation: Serialize contextual factors as a bullet list (4 booleans = 4 bullets). For reasoning chain, include only turns with non-empty `thinkingContent` or `uncertaintyMarkers` to avoid bloating the prompt. Claude's discretion per CONTEXT.md.

2. **Diversity validation call site**
   - What we know: `validateCandidateDiversity()` lives in `nocturnal-candidate-scoring.ts` (D-06). It should be called after Dreamer output parsing.
   - What's unclear: Exact call site -- in `runTrinity`/`runTrinityAsync` functions after `telemetry.dreamerPassed = true`, or inside `invokeDreamer`/`invokeStubDreamer`.
   - Recommendation: Call in `runTrinity` and `runTrinityAsync` after Dreamer output is parsed and before Philosopher invocation. This keeps the validation in the orchestration layer, not the stage implementation.

3. **Telemetry emission for diversity check**
   - What we know: Must include `diversityCheckPassed: false` on failure (DIVER-04). Design doc mentions `candidateRiskLevels` as additional telemetry.
   - What's unclear: Whether `candidateRiskLevels` should be emitted even when diversity check passes.
   - Recommendation: Always emit both fields when candidates have riskLevel data. Claude's discretion per CONTEXT.md.

## Environment Availability

Step 2.6: SKIPPED (no external dependencies identified). This phase modifies only TypeScript source files and tests within the existing project. No new tools, services, or runtimes required beyond the existing vitest test framework.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (existing) |
| Config file | `packages/openclaw-plugin/vitest.config.ts` |
| Quick run command | `cd packages/openclaw-plugin && npx vitest run tests/core/nocturnal-candidate-scoring.test.ts tests/core/nocturnal-trinity.test.ts --reporter=verbose` |
| Full suite command | `cd packages/openclaw-plugin && npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DIVER-01 | NOCTURNAL_DREAMER_PROMPT contains strategic perspective requirements and anti-pattern warning | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/nocturnal-trinity.test.ts -t "strategic perspective" --reporter=verbose` | Wave 0 needed |
| DIVER-02 | DreamerCandidate interface accepts optional riskLevel + strategicPerspective | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/nocturnal-trinity.test.ts -t "DreamerCandidate" --reporter=verbose` | Wave 0 needed |
| DIVER-03 | validateCandidateDiversity() checks risk diversity and keyword overlap | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/nocturnal-candidate-scoring.test.ts -t "validateCandidateDiversity" --reporter=verbose` | Wave 0 needed |
| DIVER-04 | Diversity failures produce telemetry warnings, do not hard-gate | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/nocturnal-trinity.test.ts -t "diversity telemetry" --reporter=verbose` | Wave 0 needed |
| DERIV-04 | buildDreamerPrompt injects reasoning context from deriver module | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/nocturnal-trinity.test.ts -t "reasoning context" --reporter=verbose` | Wave 0 needed |

### Sampling Rate
- **Per task commit:** `cd packages/openclaw-plugin && npx vitest run tests/core/nocturnal-candidate-scoring.test.ts tests/core/nocturnal-trinity.test.ts --reporter=verbose`
- **Per wave merge:** `cd packages/openclaw-plugin && npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `nocturnal-candidate-scoring.test.ts` -- add `validateCandidateDiversity` test suite (risk diversity, keyword overlap, soft enforcement)
- [ ] `nocturnal-trinity.test.ts` -- add tests for: prompt contains strategic perspectives, DreamerCandidate with new fields, stub candidates have riskLevel + strategicPerspective, buildDreamerPrompt includes Reasoning Context section, diversity telemetry emission
- [ ] No framework install needed -- vitest already configured and running

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | TypeScript type system + runtime validation in parseDreamerOutput. New optional fields validated by type system. |
| V4 Access Control | no | No access control changes -- same pipeline, same permissions |

### Known Threat Patterns for TypeScript / Nocturnal Pipeline

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| LLM prompt injection via snapshot data | Tampering | Existing: snapshot data is already sanitized (`sanitizedText` field). No raw user content reaches prompts. |
| JSON parse error from malformed LLM output | Denial of Service | Existing: try/catch in parseDreamerOutput returns safe failure. No untrusted JSON execution. |

**Note:** This phase has minimal security surface. No new data inputs, no new network calls, no new user-facing endpoints. All changes are internal to the existing Trinity pipeline.

## Sources

### Primary (HIGH confidence)
- `nocturnal-trinity.ts` -- Read directly: prompt constant (lines 64-149), buildDreamerPrompt (lines 724-811), DreamerCandidate interface (lines 1247-1258), invokeStubDreamer (lines 1399-1524), parseDreamerOutput (lines 967-1011), TrinityTelemetry interface (lines 1330-1353)
- `nocturnal-candidate-scoring.ts` -- Read directly: full file, scoring/validation pattern
- `nocturnal-reasoning-deriver.ts` -- Read directly: full file, deriver functions (Phase 34 output)
- `docs/plans/2026-04-12-trinity-quality-enhancement-design.md` -- Design specification for all changes
- `.planning/phases/35-dreamer-enhancement/35-CONTEXT.md` -- Locked decisions

### Secondary (MEDIUM confidence)
- `.planning/REQUIREMENTS.md` -- DIVER-01 to DIVER-04, DERIV-04 acceptance criteria
- `.planning/phases/34-reasoning-deriver-module/34-CONTEXT.md` -- Phase 34 integration points

### Tertiary (LOW confidence)
- None -- all findings verified by direct code reading

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, verified by code reading
- Architecture: HIGH - design doc provides exact specifications, codebase patterns verified
- Pitfalls: HIGH - identified by direct code inspection of relevant functions
- Integration: HIGH - Phase 34 output verified (30 tests passing), deriver functions read and understood

**Research date:** 2026-04-13
**Valid until:** 2026-05-13 (stable -- no fast-moving dependencies)
