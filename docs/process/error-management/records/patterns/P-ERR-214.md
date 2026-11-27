<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-214",
  "displayId": "ERR-214",
  "title": "Durable lifecycle recovery reconstructed from positional or single-row evidence instead of authoritative revision evidence",
  "status": "active",
  "category": "Architecture Boundary Violations",
  "ep": "EP-07",
  "createdAt": "2026-11-27",
  "source": "PRI-1299 / PR #2805 Devin Review"
}
-->

A durable task lifecycle was reconstructed from invocation-local position or an over-simplified row shape instead of the authoritative persisted lifecycle evidence. In PRI-1299 / PR #2805 this one root class appeared in three forms: a terminal evaluator verdict was reused after its upstream artifact had been revised without first materializing the formal cascade; evaluator output recovery treated the output-producing run itself as the only possible terminal-completion witness even though completion-intent recovery deliberately separates output persistence from the later terminal write; and a reopened repair evaluator kept its original identity/parent, so positional loop lookup treated logical round 2 as round 1 and bypassed the configured round budget.

The common defect is evidence-source confusion across restart/re-entry. A durable lifecycle fact must be derived from the state machine's authoritative evidence chain, not from loop position, task-id shape, or a single convenient run row.

Must check: separate output-production evidence from completion evidence; bind both to the same task and revision epoch; run upstream-revision cascades through the formal transition authority before reusing terminal successor results; derive logical retry/repair rounds from durable lineage before execution; and prove crash/re-entry behavior in real SQLite rather than only the fresh single-invocation path.
