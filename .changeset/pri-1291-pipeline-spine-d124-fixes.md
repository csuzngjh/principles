---
"@principles/core": patch
"@principles/pd-cli": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

Pipeline Spine Phase 1 (PRI-1291): fix the three verified pipeline breaks. D1 — `PainToPrincipleServiceOptions` is now a discriminated union on `asyncMode` (sync mode requires `sourceMaterialAuthorization` + `trajectoryTurnReader`), the sync bridge call forwards the authorization, and the three sync entry points (pd pain record --wait, OpenClaw hook, OpenClaw /pd-pain command) wire the workspace consent-ledger authorization and trajectory reader. D2 — `deviationAnchorToPainAnchor` single-tracks the anchor: the ingress/bridge write side derives the canonical `anchor`, the assembler recovers historical `deviationAnchor` rows and surfaces malformed ones in ambiguityNotes. D4 — `pd candidate internalize` gains the authority gate (dedup-first ordering, raw-kind validation, admission-document fail-closed, seed suppression, rule seeding window preserved) and both automatic seed entries (`diagnose`, PainSignalBridge) refuse invalid RAW kinds with zero seeding; `validateRecommendationKind` is exported from the runtime barrel with admission records.
