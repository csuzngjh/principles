---
'@principles/core': patch
---

Activation identity boundary (Phase 3 / I3, Principle Identity Reconciliation): activation dispatch is now fail-closed about principle identity. `PromptWriter` / `DeferArchiveWriter` canActivate and the dispatcher's record path resolve the identity solely from `source_principle_id` when it is a ledger-shaped principle UUID (`resolveActivationPrincipleId`); content-level ids and `principleDraft.title` are no longer accepted as identity — artifacts without a valid identity are refused with `no_principle_id_in_artifact` instead of activating under a philosopher title. Display-only lenient resolution (`extractPrincipleId`) is unchanged and documented as never-an-identity-source.
