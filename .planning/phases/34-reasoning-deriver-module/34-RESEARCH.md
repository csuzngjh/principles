# Phase 34: Reasoning Deriver Module - Research

**Researched:** 2026-04-12
**Domain:** Pure TypeScript reasoning signal derivation from Nocturnal session snapshot data
**Confidence:** HIGH

## Summary

Phase 34 builds a leaf module (`nocturnal-reasoning-deriver.ts`) containing three pure functions that derive structured reasoning signals from existing snapshot data. The module has zero external dependencies and zero snapshot schema changes. It operates entirely on types already exported from `nocturnal-trajectory-extractor.ts`.

The design document at `docs/plans/2026-04-12-trinity-quality-enhancement-design.md` specifies exact interfaces and algorithms. Research verified these specs against the actual codebase and found them accurate with minor clarifications needed around timestamp-based matching (tool calls lack `turnIndex`, so `deriveDecisionPoints` must correlate by `createdAt` timestamps).

**Primary recommendation:** Follow the design document interfaces verbatim. Use `createdAt` ISO string comparison for correlating tool calls with assistant turns. Follow the inline-interface pattern from `nocturnal-candidate-scoring.ts`. Test with the `vitest` + `makeFixture()` pattern established in existing nocturnal test files.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Confidence signal thresholds: high > 0.6, medium 0.3-0.6, low < 0.3 -- consistent with `computeThinkingModelActivation` existing thresholds
- Empty input handling: return empty arrays / default values (DerivedContextualFactors all false/zero) -- never throw exceptions
- Module location: `packages/openclaw-plugin/src/core/nocturnal-reasoning-deriver.ts` -- alongside all other nocturnal-*.ts modules
- Type exports: interfaces defined inline in same file -- matches existing pattern (e.g., `nocturnal-candidate-scoring.ts`)

### Claude's Discretion
- Exact regex pattern refinements for uncertainty markers
- Confidence signal computation algorithm details
- Helper function decomposition within the module

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DERIV-01 | `deriveReasoningChain()` extracts thinking content (from `<thinking>` tags), uncertainty markers (3 regex patterns), and confidence signal (high/medium/low) from assistant turns | NocturnalAssistantTurn has `sanitizedText: string` field. `<thinking>` tag extraction via regex. Uncertainty markers use 3 regex patterns from design doc. Confidence thresholds locked at high>0.6, medium 0.3-0.6, low<0.3. |
| DERIV-02 | `deriveDecisionPoints()` extracts before-context (last 500 chars), after-reflection (first 300 chars on failure), and confidence delta per tool call | NocturnalToolCall has `createdAt: string` (ISO), `outcome: 'success'|'failure'|'blocked'`. Must correlate tool calls to assistant turns by timestamp (no turnIndex on tool calls). |
| DERIV-03 | `deriveContextualFactors()` computes fileStructureKnown, errorHistoryPresent, userGuidanceAvailable, and timePressure from existing snapshot data | NocturnalSessionSnapshot has all needed data: `toolCalls` (with `toolName`, `outcome`, `createdAt`), `userTurns` (with `correctionDetected`). timePressure uses `createdAt` gap between consecutive tool calls. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | ^4.1.0 | Test framework | Already used across all 20+ nocturnal test files [VERIFIED: package.json] |
| TypeScript (strict) | ES2022 target | Language | Project standard [VERIFIED: tsconfig.json] |

### No External Dependencies Required
This module is purely TypeScript with zero new dependencies. It only imports types from the existing `nocturnal-trajectory-extractor.ts` module:
- `NocturnalAssistantTurn` [VERIFIED: nocturnal-trajectory-extractor.ts line 44]
- `NocturnalToolCall` [VERIFIED: nocturnal-trajectory-extractor.ts line 66]
- `NocturnalUserTurn` [VERIFIED: nocturnal-trajectory-extractor.ts line 55]
- `NocturnalSessionSnapshot` [VERIFIED: nocturnal-trajectory-extractor.ts line 108]

## Architecture Patterns

### Recommended Project Structure
```
packages/openclaw-plugin/
  src/core/
    nocturnal-reasoning-deriver.ts     # NEW - three derive functions
  tests/core/
    nocturnal-reasoning-deriver.test.ts # NEW - test file
```

### Pattern 1: Inline Interface Definitions with Pure Functions
**What:** Interfaces defined in the same file as the functions that produce them. No separate types file.
**When to use:** For self-contained modules with no circular dependency risk.
**Precedent:** `nocturnal-candidate-scoring.ts` defines `CandidateScores`, `ScoredCandidate`, `TournamentResult`, `TournamentTraceEntry`, `ScoringWeights` all inline. [VERIFIED: code inspection]

```typescript
// Pattern from nocturnal-candidate-scoring.ts
export interface CandidateScores {
  schemaCompleteness: number;
  principleAlignment: number;
  // ...
}

export function scoreCandidate(...): CandidateScores {
  // Pure function, no side effects
}
```

### Pattern 2: Empty Input Handling (Return Defaults, Never Throw)
**What:** When input arrays are empty or data is missing, return sensible defaults rather than throwing.
**When to use:** All nocturnal analysis functions.
**Precedent:** `computeThinkingModelActivation()` returns `0` for empty/whitespace text. `runTournament()` returns structured failure result for empty inputs. [VERIFIED: nocturnal-trajectory-extractor.ts line 420, nocturnal-candidate-scoring.ts line 340-348]

```typescript
// Pattern from nocturnal-trajectory-extractor.ts
export function computeThinkingModelActivation(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  // ...
}
```

### Pattern 3: Test Fixture Factory Functions
**What:** Use `makeXxx()` factory functions to create test fixtures with sensible defaults, overridden per-test.
**When to use:** All nocturnal test files.
**Precedent:** `nocturnal-candidate-scoring.test.ts` uses `makeCandidate()` and `makeJudgment()`. [VERIFIED: test file lines 16-45]

```typescript
// Pattern from nocturnal-candidate-scoring.test.ts
function makeAssistantTurn(overrides: Partial<NocturnalAssistantTurn> = {}): NocturnalAssistantTurn {
  return {
    turnIndex: 0,
    sanitizedText: 'Some text content',
    model: 'gpt-4',
    createdAt: '2026-04-12T10:00:00.000Z',
    ...overrides,
  };
}
```

### Anti-Patterns to Avoid
- **Throwing on empty input:** All nocturnal modules return defaults. Never throw on empty arrays or missing data.
- **Separate types file:** This module's types are only consumed by Trinity stage builders. Define inline like other nocturnal modules.
- **Importing runtime dependencies:** This module is pure computation. No database access, no filesystem, no external calls.
- **Using numeric timestamps:** All timestamps in the nocturnal pipeline are ISO strings (`createdAt: string`). Use `Date.parse()` for comparisons.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Timestamp comparison | Custom date math | `Date.parse(isoString)` | All `createdAt` fields are ISO strings. `Date.parse()` is native, reliable, handles ISO 8601. |
| Thinking model detection | New thinking content regex | Existing `detectThinkingModelMatches()` from `thinking-models.ts` | 10 well-tuned patterns already exist for planning language detection. Reuse for confidence signal computation. |
| Text truncation | Custom substring logic | Simple `String.slice()` with bounds check | `text.slice(-500)` for last 500 chars, `text.slice(0, 300)` for first 300 chars. Native, handles strings shorter than limit gracefully. |

**Key insight:** The module needs no new libraries. Every computation is achievable with native TypeScript/JavaScript.

## Common Pitfalls

### Pitfall 1: Tool Calls Have No turnIndex -- Must Match by Timestamp
**What goes wrong:** `deriveDecisionPoints()` needs to find "the assistant turn immediately before the tool call." But `NocturnalToolCall` has no `turnIndex` field -- only `NocturnalAssistantTurn` has `turnIndex`.
**Why it happens:** The snapshot schema treats tool calls as a separate list from assistant turns. They are correlated only by temporal ordering.
**How to avoid:** Match by `createdAt` timestamp. For each tool call, find the assistant turn with the highest `createdAt` that is still less than the tool call's `createdAt`. Sort both arrays by `createdAt` first, then walk them in order.
**Warning signs:** If you try to use `turnIndex` on `NocturnalToolCall`, it won't compile -- the type doesn't have that field. [VERIFIED: nocturnal-trajectory-extractor.ts line 66-74]

### Pitfall 2: `<thinking>` Tags May Not Exist
**What goes wrong:** Most assistant turns in production data do NOT contain `<thinking>` tags. These are only present when using Claude's extended thinking mode.
**Why it happens:** Extended thinking is optional and model-dependent. Other models (GPT-4, MiniMax) never produce these tags.
**How to avoid:** Handle the case where `thinkingContent` is an empty string. The regex `/<thinking>([\s\S]*?)<\/thinking>/` will simply not match, and the result should be `''`. Do not throw or return null.
**Warning signs:** If tests only cover turns WITH thinking tags, edge cases on empty matches are missed. [ASSUMED -- based on understanding of model behavior]

### Pitfall 3: durationMs Can Be Null on Tool Calls
**What goes wrong:** `timePressure` computation checks consecutive tool call timing. But `durationMs` is `number | null`, not always present.
**Why it happens:** `durationMs` is only populated when the tool execution was timed. Some tool calls (especially older ones or certain tool types) may not have duration data.
**How to avoid:** Use `createdAt` timestamps for time gap computation between consecutive tool calls, NOT `durationMs`. `createdAt` is always present on tool calls (guaranteed by the trajectory extractor). The design doc says ">50% of consecutive toolCalls < 2s apart" -- compute this from `Date.parse(tc[i+1].createdAt) - Date.parse(tc[i].createdAt)`, which gives the wall-clock gap between calls. [VERIFIED: trajectory.ts line 804 -- createdAt always populated]

### Pitfall 4: Confidence Signal Thresholds Must Match Existing Conventions
**What goes wrong:** Using different thresholds than the rest of the codebase creates inconsistency.
**Why it happens:** `computeThinkingModelActivation` returns a 0-1 ratio. The locked decision says high > 0.6, medium 0.3-0.6, low < 0.3.
**How to avoid:** Use exactly the thresholds from CONTEXT.md. Map the computed confidence ratio (0-1) to these three buckets. Follow the same `Math.round(x * 100) / 100` rounding pattern used in `computeThinkingModelActivation`. [VERIFIED: nocturnal-trajectory-extractor.ts line 423]

### Pitfall 5: Regex Case Sensitivity and Global Flag
**What goes wrong:** The design doc specifies uncertainty marker patterns like `/let me (check|verify|confirm|understand)/gi`. The `g` flag on `RegExp.test()` can cause alternating true/false results on repeated calls due to `lastIndex` state.
**Why it happens:** JavaScript RegExp with `g` flag maintains `lastIndex` state between `.test()` calls.
**How to avoid:** Either (a) use `String.match()` instead of `RegExp.test()` to collect all matches, or (b) reset `lastIndex` to 0 before each use, or (c) create fresh RegExp instances per call. The `detectThinkingModelMatches()` in `thinking-models.ts` uses `pattern.test(text)` but creates patterns in a constant array that gets iterated once. Follow the same pattern: define patterns as constants, iterate once, collect matches.

## Code Examples

### NocturnalAssistantTurn Type (Verified from Codebase)
```typescript
// Source: packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts:44-49
export interface NocturnalAssistantTurn {
  turnIndex: number;
  sanitizedText: string;
  model: string;
  createdAt: string;
}
```

### NocturnalToolCall Type (Verified from Codebase)
```typescript
// Source: packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts:66-74
export interface NocturnalToolCall {
  toolName: string;
  outcome: 'success' | 'failure' | 'blocked';
  filePath: string | null;
  durationMs: number | null;
  exitCode: number | null;
  errorType: string | null;
  errorMessage: string | null;
  createdAt: string;
}
```

### NocturnalUserTurn Type (Verified from Codebase)
```typescript
// Source: packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts:55-60
export interface NocturnalUserTurn {
  turnIndex: number;
  correctionDetected: boolean;
  correctionCue: string | null;
  createdAt: string;
}
```

### NocturnalSessionSnapshot Type (Verified from Codebase)
```typescript
// Source: packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts:108-137
export interface NocturnalSessionSnapshot {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  assistantTurns: NocturnalAssistantTurn[];
  userTurns: NocturnalUserTurn[];
  toolCalls: NocturnalToolCall[];
  painEvents: NocturnalPainEvent[];
  gateBlocks: NocturnalGateBlock[];
  stats: {
    totalAssistantTurns: number;
    totalToolCalls: number;
    totalPainEvents: number;
    totalGateBlocks: number;
    failureCount: number;
  };
  _dataSource?: 'pain_context_fallback';
}
```

### computeThinkingModelActivation Precedent (Verified)
```typescript
// Source: packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts:419-424
export function computeThinkingModelActivation(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  const matches = detectThinkingModelMatches(text);
  const totalModels = listThinkingModels().length;
  return Math.round((matches.length / totalModels) * 100) / 100;
}
```

### Existing Tool Name Regex Patterns for Read/Write Detection
```typescript
// Source: packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts:448-449,453-454
// Write tool detection:
const isWriteTool = /^(edit|write|create|delete|remove|move|rename)/i.test(tc.toolName);
// Read tool detection:
const isReadTool = /^(read|grep|search|find|inspect|look)/i.test(prevTc.toolName);
```
Note: These patterns are directly relevant for `deriveContextualFactors().fileStructureKnown` -- "any Read before any Write?"

### Test Fixture Pattern (Verified)
```typescript
// Source: packages/openclaw-plugin/tests/core/nocturnal-candidate-scoring.test.ts:16-45
function makeCandidate(overrides: Partial<DreamerCandidate> = {}): DreamerCandidate {
  return {
    candidateIndex: 0,
    badDecision: 'Did something wrong without verifying preconditions',
    betterDecision: 'Read the relevant file to understand its structure before making changes',
    rationale: 'Verifying preconditions prevents errors',
    confidence: 0.85,
    ...overrides,
  };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single-reflector nocturnal samples | Trinity Dreamer->Philosopher->Scribe chain | v1.9.0 | Multi-candidate generation with tournament selection |
| Static analysis only | Thinking model activation + planning ratio metrics | v1.9.0 | Quantified quality metrics for trajectory analysis |

**Deprecated/outdated:**
- None relevant to this phase

## Design Document Verification

The design document at `docs/plans/2026-04-12-trinity-quality-enhancement-design.md` was verified against the actual codebase. Findings:

| Design Spec | Codebase Reality | Status |
|-------------|------------------|--------|
| `deriveReasoningChain(assistantTurns)` takes `NocturnalAssistantTurn[]` | Type exists at trajectory-extractor.ts:44. Has `sanitizedText` and `createdAt`. | MATCH |
| `deriveDecisionPoints(assistantTurns, toolCalls)` takes both arrays | Both types exist. But tool calls lack `turnIndex` -- must match by `createdAt`. | MINOR CLARIFICATION |
| `deriveContextualFactors(snapshot)` takes full snapshot | `NocturnalSessionSnapshot` exists at trajectory-extractor.ts:108. Has all needed fields. | MATCH |
| `toolCall.outcome === 'failure'` | Type is `'success' | 'failure' | 'blocked'` at trajectory-extractor.ts:67 | MATCH |
| `<thinking>` tag extraction from `sanitizedText` | `sanitizedText` is a string field on assistant turns. | MATCH |
| `fileStructureKnown`: "any Read before any Write?" | Tool names match `read|grep|search|find|inspect|look` and `edit|write|create|delete|remove|move|rename` patterns from existing code. | MATCH |
| `timePressure`: ">50% of consecutive toolCalls < 2s apart" | Tool calls have `createdAt: string` (ISO). Compute gaps via `Date.parse()`. | MATCH (use createdAt, not durationMs) |
| `userGuidanceAvailable`: "any userTurn with correctionDetected: true" | `NocturnalUserTurn.correctionDetected: boolean` exists at trajectory-extractor.ts:57 | MATCH |
| Confidence thresholds: high > 0.6, medium 0.3-0.6, low < 0.3 | Matches `computeThinkingModelActivation` rounding pattern | MATCH |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Most production assistant turns do NOT contain `<thinking>` tags (only Claude extended thinking produces them) | Common Pitfalls | Low -- function handles empty matches gracefully regardless |
| A2 | Tool calls and assistant turns within a session share the same temporal ordering (tool calls are interleaved chronologically with assistant turns) | Architecture | Medium -- if they are not interleaved by time, the "assistant turn before tool call" matching would need a different approach. Verified: both are stored with `createdAt` in the same session context. |
| A3 | The `<thinking>` tag format is exactly `<thinking>...</thinking>` with no attributes or namespaces | Architecture | Low -- this matches Claude's documented thinking tag format |

## Open Questions

1. **Confidence signal computation algorithm**
   - What we know: Design doc says "ratio of planning language to execution language." Thresholds locked at high > 0.6, medium 0.3-0.6, low < 0.3.
   - What's unclear: Exact definition of "planning language" vs "execution language" ratios. The existing `detectThinkingModelMatches()` detects 10 thinking model patterns. A reasonable approach: count thinking model matches / total sentences (or similar).
   - Recommendation: Under Claude's discretion. Use `computeThinkingModelActivation()`-style approach: ratio of thinking-model-matched language to a baseline. Map the 0-1 ratio to the three buckets.

2. **How to handle multiple assistant turns with same timestamp as a tool call**
   - What we know: Both have `createdAt` as ISO strings with millisecond precision. Collision is unlikely but possible.
   - What's unclear: Whether ties should favor the earlier or later turn.
   - Recommendation: Use strictly less-than (`<`) comparison. If two assistant turns have the same `createdAt`, both are considered "before" the tool call, and the one with the higher `turnIndex` wins (most recent).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | TypeScript compilation | Yes | v22+ | -- |
| vitest | Test runner | Yes | ^4.1.0 | -- |
| TypeScript | Compilation | Yes | strict mode | -- |

**Missing dependencies with no fallback:** None -- this module has zero external dependencies.

**Missing dependencies with fallback:** Not applicable.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.1.0 |
| Config file | `packages/openclaw-plugin/vitest.config.ts` |
| Quick run command | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DERIV-01 | `deriveReasoningChain()` extracts thinking content, uncertainty markers, confidence signal | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "deriveReasoningChain"` | Wave 0 |
| DERIV-01 | Handles turns without `<thinking>` tags | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "no thinking tags"` | Wave 0 |
| DERIV-01 | Handles empty assistant turns array | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "empty input"` | Wave 0 |
| DERIV-02 | `deriveDecisionPoints()` extracts before/after context per tool call | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "deriveDecisionPoints"` | Wave 0 |
| DERIV-02 | Only extracts afterReflection on failure outcome | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "afterReflection"` | Wave 0 |
| DERIV-03 | `deriveContextualFactors()` computes all four factors correctly | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "deriveContextualFactors"` | Wave 0 |
| DERIV-03 | Detects Read-before-Write for fileStructureKnown | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "fileStructureKnown"` | Wave 0 |
| DERIV-03 | Detects timePressure from consecutive tool call timing | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "timePressure"` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `packages/openclaw-plugin/tests/core/nocturnal-reasoning-deriver.test.ts` -- covers DERIV-01, DERIV-02, DERIV-03
- [ ] No framework install needed -- vitest already configured

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts` -- types `NocturnalAssistantTurn`, `NocturnalToolCall`, `NocturnalUserTurn`, `NocturnalSessionSnapshot`, function `computeThinkingModelActivation`
- `packages/openclaw-plugin/src/core/nocturnal-candidate-scoring.ts` -- inline interface pattern, pure function pattern
- `packages/openclaw-plugin/src/core/thinking-models.ts` -- `detectThinkingModelMatches()`, regex patterns for thinking model detection
- `packages/openclaw-plugin/src/core/trajectory.ts` -- timestamp handling (`nowIso()`, `createdAt` as ISO string), `listToolCallsForSession` ordering
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` -- `buildDreamerPrompt`, `buildScribePrompt`, `DreamerCandidate`, `PhilosopherJudgment` interfaces
- `docs/plans/2026-04-12-trinity-quality-enhancement-design.md` -- approved design spec with exact interfaces and algorithms
- `packages/openclaw-plugin/package.json` -- vitest ^4.1.0, @vitest/coverage-v8 ^4.1.0

### Secondary (MEDIUM confidence)
- `packages/openclaw-plugin/tests/core/nocturnal-candidate-scoring.test.ts` -- test fixture pattern (`makeCandidate`, `makeJudgment`)
- `packages/openclaw-plugin/tests/core/nocturnal-trajectory-extractor.test.ts` -- test setup pattern with `beforeEach`/`afterEach`, `TrajectoryDatabase` seeding

### Tertiary (LOW confidence)
- None -- all findings verified against codebase

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- zero new dependencies, all types verified in codebase
- Architecture: HIGH -- patterns verified from 3+ existing nocturnal modules
- Pitfalls: HIGH -- discovered from direct code inspection (tool call lacks turnIndex, durationMs nullable, createdAt is ISO string)
- Design doc accuracy: HIGH -- all 9 spec items verified against actual types and code

**Research date:** 2026-04-12
**Valid until:** 2026-05-12 (stable codebase, no fast-moving dependencies)
