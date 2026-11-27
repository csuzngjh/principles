---
"@principles/core": patch
"@principles/host-runtime": patch
"@principles/pd-cli": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

PRI-1299 Phase 1: unify evaluator repair task creation behind the core `createRepairTask` authority. host-runtime and pd-cli repair seeders now share the same RepairSuccessorIdentity adjudication, exact payload/channel checks, lineage proof, CAS backfill, atomic insert, and UNIQUE-race re-arbitration instead of maintaining parallel creation implementations. R1/R2 identities remain distinct, same-identity repairs are adopted only when their complete persisted identity matches, malformed or conflicting repairs fail closed, and `repairTaskRole: repair_artificer` records the OD-8 dual-role transition durably rather than relying on implicit `taskKind` inference.
