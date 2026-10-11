---
"@principles/core": patch
---

State the runtime kind semantics in the Evaluator judge prompt (contract v6 → v7). Live p1-closeout chain evidence: a rule whose write gate branched on `input.action.canonicalKind === 'write'` passed the FULL deterministic replay — edit and apply_patch dispatch as the single canonical kind 'write' per the host mapping — yet the LLM judge returned needs_revision claiming the rule "returns allow for edit/apply_patch", because the prompt's tool catalog carried tool NAMES without the kind mapping. The judge now receives a RUNTIME KIND SEMANTICS clause (writeTools all dispatch as canonicalKind 'write'; only literal-toolName matching can miss a same-kind sibling), same genre as the existing TOOL CATALOG AUTHORITY clause. Replay gate, validator, and decision thresholds unchanged.
