---
"principles-disciple": patch
---

feat(openclaw-plugin): freeze prompt presence expectations in before_prompt_build (PRI-1119)

The hook now returns `injectedExpectations` — the per-activation frozen body
texts (post size guard) injected into `prependSystemContext`, with
`bodyComplete` marking truncated fragments. Memory-only; consumed by the host
wire checkpoint (prompt presence check). Requires the host-side carrier support
(openclaw ai/prompt-presence-check branch) to take effect; older hosts ignore
the field.
