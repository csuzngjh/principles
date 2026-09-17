<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-098",
  "displayId": "ERR-098",
  "title": "Destructive cleanup with junction-following recursive delete wiped a shared repo's working tree — cleanup must use `git worktree remove`, never recursive deletes on junction-bearing directories, and must not silence errors on critical cleanup steps",
  "status": "active",
  "category": "Process & Workflow",
  "ep": null,
  "createdAt": "2026-08-16",
  "source": "PRI-538 (pr-review session 2026-08-16, PRs #1332-1335 verification cleanup)"
}
-->

**Recurrence**: Yes — shared-repo reparse-point hazard re-encountered (caught before damage this time).
