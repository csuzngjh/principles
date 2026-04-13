# Phase 35: Dreamer Enhancement - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Enhance Dreamer stage to generate strategically diverse candidates with derived reasoning context (from Phase 34), validated by soft post-validation diversity checks. Covers DIVER-01 through DIVER-04 and DERIV-04.

</domain>

<decisions>
## Implementation Decisions

### Dreamer Prompt Diversity Strategy
- **D-01:** Force distinct strategic perspectives per candidate — 2 candidates = 2 different perspectives, 3 = all three covered (conservative_fix, structural_improvement, paradigm_shift)
- **D-02:** Risk level (low/medium/high) is LLM-judged per candidate, not bound to perspective type. Prompt requires inclusion but does not constrain the value

### Reasoning Signal Injection
- **D-03:** Derived reasoning signals inject as a new independent `## Reasoning Context` section in buildDreamerPrompt(), placed after existing Session Context sections
- **D-04:** Only inject reasoningChain + contextualFactors into Dreamer. DecisionPoints are reserved for Phase 37 (Scribe contrastive analysis). Follows design doc allocation

### Diversity Validation Logic
- **D-05:** Keyword overlap uses Jaccard-like algorithm: `intersection / max(|A|, |B|)` for words > 3 chars, threshold 0.8. No external dependencies
- **D-06:** `validateCandidateDiversity()` lives in `nocturnal-candidate-scoring.ts` alongside existing scoring/validation functions

### Stub Dreamer Updates
- **D-07:** Fixed mapping for stub candidates: gateBlocks → conservative_fix/low, pain → structural_improvement/medium, failures → paradigm_shift/high. Deterministic, testable

### Claude's Discretion
- Exact formatting of Reasoning Context section (how to serialize reasoning chain + contextual factors into prompt text)
- Anti-pattern warning wording in NOCTURNAL_DREAMER_PROMPT
- validateCandidateDiversity() helper function decomposition
- Telemetry field names and structure for diversityCheckPassed

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design Specification
- `docs/plans/2026-04-12-trinity-quality-enhancement-design.md` — Full technical spec for Phase A (Dreamer diversity), Phase B (Philosopher/Scribe), interface definitions, integration points
- `docs/plans/2026-04-12-trinity-quality-enhancement-design.md` §A1 — Dreamer Candidate Diversity: prompt additions, DreamerCandidate interface extension, validateCandidateDiversity spec
- `docs/plans/2026-04-12-trinity-quality-enhancement-design.md` §A2 — Runtime Reasoning Derivation: integration points for buildDreamerPrompt

### Requirements Traceability
- `.planning/REQUIREMENTS.md` — DIVER-01 to DIVER-04, DERIV-04 acceptance criteria

### Prior Phase Context
- `.planning/phases/34-reasoning-deriver-module/34-CONTEXT.md` — Phase 34 decisions: module location, edge case handling, integration points

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `nocturnal-trinity.ts` → `NOCTURNAL_DREAMER_PROMPT` (lines 64-149): Current 86-line system prompt to extend with strategic perspective section
- `nocturnal-trinity.ts` → `DreamerCandidate` interface (lines 1247-1258): Add optional riskLevel + strategicPerspective fields
- `nocturnal-trinity.ts` → `buildDreamerPrompt()` (lines 724-811): Inject reasoning signals as new section after existing context sections
- `nocturnal-trinity.ts` → `invokeStubDreamer()` (lines 1399-1524): Add riskLevel + strategicPerspective to stub candidates with fixed mapping
- `nocturnal-reasoning-deriver.ts`: `deriveReasoningChain()`, `deriveContextualFactors()` — consume these in buildDreamerPrompt
- `nocturnal-candidate-scoring.ts`: Home for new `validateCandidateDiversity()` function (~30 lines)

### Established Patterns
- All nocturnal modules in `packages/openclaw-plugin/src/core/` follow `nocturnal-*.ts` naming
- Pure functions with no side effects, no external dependencies
- Graceful edge case handling (return defaults, never throw on empty input)
- Optional fields for backward compatibility (all new DreamerCandidate fields are `?`)
- Embedded prompt constants at file top, builder methods in adapter class
- Soft enforcement: log warning + set telemetry flag, don't discard

### Integration Points
- `buildDreamerPrompt()` calls deriver functions and injects into new `## Reasoning Context` section
- `validateCandidateDiversity()` called after Dreamer output parsing in invokeDreamer()
- Dreamer output parsed by existing JSON parsing in `OpenClawTrinityRuntimeAdapter.invokeDreamer()`
- Telemetry for `diversityCheckPassed` added to Dreamer telemetry emission

</code_context>

<specifics>
## Specific Ideas

- Design doc has exact prompt text for "Strategic Perspective Requirements" section — follow it precisely
- Design doc specifies keyword overlap formula: intersection / max(|A|, |B|) for words > 3 chars
- Anti-pattern warning in prompt: "Candidates that differ only in wording, not in substance, will be rejected"

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 35-dreamer-enhancement*
*Context gathered: 2026-04-13*
