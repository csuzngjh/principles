# Phase 35: Dreamer Enhancement - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-13
**Phase:** 35-dreamer-enhancement
**Areas discussed:** Dreamer Prompt Diversity Strategy, Reasoning Signal Injection, Diversity Validation Logic, Stub Dreamer Updates

---

## Dreamer Prompt Diversity Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Force distinct perspectives | Each candidate must use different perspective. 2=2 different, 3=all three. Maximizes diversity. | ✓ |
| Suggest but don't force | Prompt suggests different perspectives, LLM flexible. Post-validation as safety net. | |
| Claude's discretion | Let Claude decide based on design doc and code patterns. | |

**User's choice:** Force distinct perspectives (recommended)
**Notes:** User chose maximum diversity enforcement at prompt level. Risk level is LLM-judged separately.

### Risk Level Determination

| Option | Description | Selected |
|--------|-------------|----------|
| Perspective-determined | conservative_fix=low, structural_improvement=medium, paradigm_shift=high. Fully deterministic. | |
| LLM-judged | Prompt requires riskLevel but LLM judges based on specific situation. More flexible. | ✓ |
| Claude's discretion | Let Claude decide. | |

**User's choice:** LLM-judged (recommended)
**Notes:** Risk level not bound to perspective type — allows conservative_fix with high risk when appropriate.

---

## Reasoning Signal Injection

### Injection Format

| Option | Description | Selected |
|--------|-------------|----------|
| Independent section | New "## Reasoning Context" section after Session Context. Clear separation. | ✓ |
| Merge into existing | Fold into "## Assistant Decision Context". Fewer sections but mixed data. | |
| Claude's discretion | Let Claude decide. | |

**User's choice:** Independent section (recommended)
**Notes:** New `## Reasoning Context` section placed after existing context sections. Clean separation between raw data and derived signals.

### Signal Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Only 2 signals (chain + factors) | Follow design doc: reasoningChain + contextualFactors for Dreamer. decisionPoints for Scribe (Phase 37). | ✓ |
| All 3 signals | Inject all derived signals for maximum context. decisionPoints may not benefit Dreamer. | |
| Claude's discretion | Let Claude decide. | |

**User's choice:** Only 2 signals (recommended)
**Notes:** Strictly follows design doc allocation. decisionPoints are the natural input for Phase 37 Scribe contrastive analysis.

---

## Diversity Validation Logic

### Algorithm Choice

| Option | Description | Selected |
|--------|-------------|----------|
| Jaccard-like | intersection / max(|A|, |B|) for words > 3 chars. Simple, deterministic, no dependencies. | ✓ |
| Cosine similarity | Considers word frequency weights. More precise but over-engineered for this use case. | |
| Claude's discretion | Let Claude decide. | |

**User's choice:** Jaccard-like (recommended)
**Notes:** Follows design doc specification exactly. Threshold 0.8 for rejection.

### Function Location

| Option | Description | Selected |
|--------|-------------|----------|
| nocturnal-candidate-scoring.ts | Alongside existing scoring/validation. Design doc specifies this. | ✓ |
| nocturnal-trinity.ts internal | Close to Dreamer candidate parsing. More localized but scattered concerns. | |

**User's choice:** nocturnal-candidate-scoring.ts (recommended)
**Notes:** Consistent with existing code organization — all candidate validation lives here.

---

## Stub Dreamer Updates

### Assignment Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Fixed mapping | gateBlocks→conservative_fix/low, pain→structural_improvement/medium, failures→paradigm_shift/high. Deterministic, testable. | ✓ |
| Force diversity | Assign different perspectives across candidates regardless of signal type. May not match semantics. | |
| Claude's discretion | Let Claude decide. | |

**User's choice:** Fixed mapping (recommended)
**Notes:** Each signal type maps to its natural perspective + risk level. Gate blocks are naturally conservative fixes, pain signals suggest structural issues, failures may need paradigm shifts.

---

## Claude's Discretion

- Exact formatting of Reasoning Context section (how to serialize reasoning chain + contextual factors into prompt text)
- Anti-pattern warning wording in NOCTURNAL_DREAMER_PROMPT
- validateCandidateDiversity() helper function decomposition
- Telemetry field names and structure for diversityCheckPassed

## Deferred Ideas

None — discussion stayed within phase scope
