---
'@principles/host-runtime': patch
'@principles/codex-adapter': patch
---

Adaptive activation now skips selection deterministically before the candidate read: missing host-bound turn identity, a blank prompt, an exhausted hook budget, and pure social acknowledgements return the Native body with zero model requests. Substantive prompts and task continuations keep the existing single-send fast path; the default-off switch and Native fallback are unchanged.
