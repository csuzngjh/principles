<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-212",
  "displayId": "ERR-212",
  "title": "Split-read candidate-set race drops rows that change predicate between queries",
  "status": "active",
  "category": "Security & Safety",
  "ep": "EP-03",
  "createdAt": "2026-11-26",
  "source": "PRI-1299 / PR #2805 review"
}
-->

A candidate set was split across two non-transactional reads: the first read matched only rows whose persisted parent edge already existed, while the second broader read was used only for rows still missing that edge. A legitimate backfill writer could persist the edge between the reads; the row then failed the first read's exact predicate as originally evaluated and was skipped by the second read because it was no longer an inference candidate. The lookup concluded that no successor existed even though a real historical successor was now durable.

The defect class is a split-read candidate-set race. When a second broader snapshot can contain rows that became exact after the first read, exact identity must be re-judged on that second snapshot before falling back to inference. Exact-match priority and conflict completeness must be preserved.

Must check: for any multi-read lookup where concurrent writers can move rows between predicates, enumerate the row's classification in each read and prove no interleaving can make it belong to neither branch. Prefer a single snapshot when available; otherwise re-apply the exact predicate to the freshest broader snapshot. Regression tests must use the real cross-connection writer, not only a mocked row order.
