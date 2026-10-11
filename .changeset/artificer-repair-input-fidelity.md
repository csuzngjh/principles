---
"@principles/core": patch
---

Carry the failed adversarial case's defining input into the repair round and document the context.facts field semantics in the Artificer prompt (contract v10 → v11). Live p1-closeout chain evidence: with the #1982 pairing fix active, artificer r2 converged (2 template failures → 1) but the remaining `v2-path-boundary` failure was unactionable — the repair evidence named only `Expected block but got allow`, dropping the case's tool/params/context facts and authored rationale, and the prompt never defined what `priorReadOfTarget`/`readCount` mean. Failed-case entries now carry a bounded `caseInput` summary (rc-8) rendered as an `Input:` line in the repair prompt, and CONTEXT MODE states the facts semantics plus the per-call write-discipline mapping. Validator, templates, and oracle unchanged.
