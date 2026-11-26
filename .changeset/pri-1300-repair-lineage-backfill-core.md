---
"@principles/core": patch
"@principles/host-runtime": patch
"@principles/pd-cli": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

Repair task lineage validation + CAS backfill uplifted into `@principles/core` (PRI-1300). The new `validateAndBackfillRepairLineage` (@principles/core `./runtime` export, admitted) is the ONE write-side implementation of repair-lineage verification + missing parent/correlation backfill: it composes the existing `verifyRepairTaskIdentity` read-only authority with the six-precondition snapshot CAS (diagnosticJson + status/attemptCount/maxAttempts/leaseOwner/leaseExpiresAt/leaseGeneration) and returns a structured discriminated union instead of throwing host-shaped errors. The two evaluator repair seeders (host-runtime consumer governance + pd-cli rulehost pipeline runner) and the orchestrator `REOPEN_SOURCE_EVALUATOR` completion branch now share this single implementation — the per-host copies of hydrate + mergePITaskMetadata + full-snapshot CAS that drifted in parallel are deleted. External behavior is unchanged: host error string literals, throw/return shapes, terminal-status reuse refusal, telemetry/log lines, the CAS precondition set, and the zero-partial-write guarantee on concurrent modification are all preserved and pinned by the existing host/orchestrator suites plus new real-sqlite core tests.
