---
"@principles/pd-cli": patch
---

PRI-915: wire `ledgerIdentity.isAvailable` in the evaluator factory and both
scribe wirings (rulehost pipeline + run-once) so an unreadable principle ledger
surfaces as `identity_source_unavailable` instead of `invalid_identity` drift.
