---
'@principles/core': patch
---

PRI-981 (SPEC-PD-IAER-001 FR-01/FR-05): add the shared, side-effect-free evidence readiness gate (`assessEvidenceReadiness` + `EvidenceReadiness` contract, runtime-v2 internalization) and harden ArtificerRunner so a missing or invalid BehaviorExamplePack fails as a structured permanent `input_invalid` (PDRuntimeError with reasonCode/nextAction) instead of a plain retryable execution failure. A missing pack no longer burns retry attempts or reaches the model.
