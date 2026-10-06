---
"@principles/core": patch
"@principles/pd-cli": patch
---

R7: the two candidate→ledger read/audit surfaces are now reuse-aware. `pd trace`
(`PainChainReadModel`) resolves a consumed candidate into the ledger through BOTH
expressions — `derivedFromPainIds` (created) and `Principle.reuseEvidence[]`
(resolved into an existing principle by a reuse decision, zero ledger growth by
design) — so a successful reuse chain traces as `succeeded` with the reuse target
in `ledgerEntryIds` instead of the false `degraded/ledger_write_failed`.
`auditCandidateLedgerConsistency` (pd health / pd candidate audit, now one shared
judgment) no longer flags by-design-absent candidates as missing: reuse-resolved
candidates are counted in the new additive `reusedResolvedCount`, and consumed
candidates whose `recommendation_kind` never targets the Principle Ledger (rule /
implementation / prompt / defer; fail-closed unknown kinds) are counted in
`nonLedgerKindCount`. Only a consumed principle-kind candidate with no resolution
anywhere remains true drift (`missingLedgerEntryIds` lists them). On the R7
production workspace this drops the audit from 63 missing (52+ kind/reuse false
positives masking real drift) to 5 true-drift entries. No write path changes.
