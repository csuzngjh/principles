---
"@principles/codex-adapter": patch
"@principles/host-runtime": patch
---

Advance the Marketplace runtime pin to the npm versions that carry the Phase 1 closeout replay fix (#1992 / P2-2): codex-adapter 0.5.3 (evidence-recorder producers keep unresolved content refs unresolved across replays), host-runtime 0.8.2, core 1.291.4 — all published by the 2026-10-12 release train. The pin still referenced 0.5.1 / 0.8.1 / 1.291.2, so a fresh `$pd-setup` install would receive the pre-fix recorder that rejects same-event evidence replays with `observation_contentRef_resolved_requires_payloadDigest` instead of deduplicating them (pd-v2-phase1-final-acceptance 2026-10-11 §14.4: installed-artifact verification was blocked on exactly this gap). Verified by `npm run check:runtime-pin` (packaged capability probe S1–S5 against npm-installed bytes of the new pins).
