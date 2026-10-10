---
"@principles/core": minor
---

PRI-915: make principle-ledger availability decidable so identity refusals no
longer misreport a transient outage as data drift.

- `readLedgerFileState(stateDir)` (new): returns the ledger store plus a
  `LedgerFileAvailability` tri-state — `ok` / `empty` (no file or zero-byte
  file: a true empty ledger) / `unreadable` (exists but read/parse failed,
  with the underlying problem). `loadLedger` behavior is unchanged.
- `PrincipleTreeLedgerAdapter.isAvailable()` (new): false only when the ledger
  file exists but cannot be read.
- `LedgerIdentityChecker` gains the required `isAvailable()`; production and
  test implementations are updated.
- `resolveLedgerActivationId` reports `ledger_unavailable: …` instead of
  `principle_not_in_ledger` while the ledger is unreadable (direct and lineage
  paths).
- `EvaluatorRunner` identity stamp gains the fifth failure reason
  `identity_source_unavailable` (checked before membership) and
  `ScribeRunner` reports `ledger_unavailable` in its skip event reason.
