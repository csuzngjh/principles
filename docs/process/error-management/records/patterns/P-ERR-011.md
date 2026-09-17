<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-011",
  "displayId": "ERR-011",
  "title": "CLI commands directly import RuntimeStateManager instead of Tier 2 boundary facades",
  "status": "active",
  "category": "Architecture Boundary Violations",
  "ep": "EP-02",
  "createdAt": "2026-05-21",
  "source": "PRI-131 (Tier 2)"
}
-->

**Recurrence**: Yes — same boundary violation pattern as PRI-129 (trace.ts) and PRI-131 Tier 1 (health.ts, runtime-pruning.ts, runtime-internalization-queue.ts). 2026-08-13 PRI-523 C1.1 review: the shared prompt reader opened the Runtime V2 database through the normal bootstrapping connection path, so a logically read-only prompt build could create/migrate the database and checkpoint WAL state. Fixed by using the existing validated store APIs over a file-must-exist read-only connection with bootstrap and close-time checkpoint disabled; a production test proves a missing database yields a structured warning without changing the workspace filesystem.
