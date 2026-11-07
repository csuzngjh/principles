---
"principles-disciple": patch
"create-principles-disciple": patch
---

feat(openclaw-plugin,host-runtime): PD-self assembly presence observation via official llm_input (PRI-1150, Path A)

- host-runtime: `buildActivePrinciplePromptContext` freezes per-principle
  presence expectations same-source with `additionalContext` (bounded at 64,
  overflow fact, bodyComplete containment); PD-internal contract.
- openclaw-plugin: bounded in-memory assembly snapshot registry keyed by
  runId+sessionId (global key/snapshot/body-byte caps + TTL, sticky history
  loss), minimal single-string containment checker (three-value outcomes),
  official llm_input registration, and a PD-owned forensic event
  `runtime_v2_prompt_presence_observed` (boundary
  post_assembly_system_prompt_via_llm_input; containment facts only, no body
  text; unique binding requires complete candidate history, everything else
  degrades to unknown:ambiguous_binding / history_incomplete / expired).
- Not dependent on hook-result fields the official host drops. Fact-only: no
  D/confirmed/timely, no delivery/adherence claims. Existing llm_output
  behavior unchanged.
