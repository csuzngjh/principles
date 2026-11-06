---
"@principles/core": minor
"principles-disciple": minor
"create-principles-disciple": patch
---

Add a default-off controlled-admission path for adaptive principle prompts.

When no operator admission is configured the runtime behaves exactly as before. When an admission document is supplied through `PD_AA_ADMISSION_FILE`, a single request may be admitted: the shared `adaptivePriorityProvider` entry claims the admission and hands it to `before_prompt_build` for the same request, replay attempts are rejected, and `consumedAt`/`consumedBy` are written atomically under an exclusive lock. `@principles/core` additionally exports `validateControlledAdmissionBinding` and `canonicalAdaptiveMappingSha256` for the host adapters that bind an admission to a request.
