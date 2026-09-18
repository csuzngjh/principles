<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-012",
  "displayId": "ERR-012",
  "title": "PR branch based on stale main reverts already-merged telemetry fields",
  "status": "active",
  "category": "Missing Tests & Verification",
  "ep": "EP-10",
  "createdAt": "2026-05-21",
  "source": "PR #659",
  "undatedRecurrences": [
    "Earlier recurrence (PRI-444 PR#1027): `subagent.ts` deleted but stale route in `hooks/AGENTS.md`. See git history."
  ]
}
-->

**Recurrence**: Yes — feature branch base drifts from `origin/main` so PR diff surfaces unrelated/deleted files.
