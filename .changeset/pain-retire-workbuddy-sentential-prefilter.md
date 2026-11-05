---
'@principles/host-runtime': patch
'@principles/core': patch
---

PRI-1093 / SPEC P-5: WorkBuddy keyword detection no longer applies a sentence-initial `startsWith` pre-filter before the shared keyword-stage guards. Mid-sentence corrections now reach the same quote / third-person / negation guards Codex uses, so they are no longer silently discarded at the detection layer and land in the same `ambiguity` disposition. This does not add Pain: WorkBuddy still has no persisted behavior-trace evidence, so admitted candidates stop at the evidence gate (`abandoned` / `evidence_invalid`). Cost impact: at most one extra Stage-1 evaluation per prompt; Stage-2 pending candidates stay zero-LLM in the hook.

`@principles/core` also gains one deterministic guard in the shared keyword stage: a clause that opens with a hypothetical/conditional marker (`如果` / `假如` / `要是` / `假设` / `万一`) downgrades a high-precision correction hit from STRONG to `ambiguity`, because such a clause states a hypothesis rather than an Owner assertion. The guard is clause-scoped, so a real correction in a later clause still reaches STRONG.

