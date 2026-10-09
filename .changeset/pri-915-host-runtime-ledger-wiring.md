---
"@principles/host-runtime": patch
---

PRI-915: wire `ledgerIdentity.isAvailable` in the internalization consumer
cycle's evaluator construction so an unreadable principle ledger surfaces as
`identity_source_unavailable` instead of `invalid_identity` drift.
