<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-008",
  "displayId": "ERR-008",
  "title": "Missing lineage field validation allows agent to return trace with wrong attribution",
  "status": "active",
  "category": "Schema & Type Mistakes",
  "ep": "EP-07",
  "createdAt": "2026-05-19",
  "source": "PRI-192 / PR #638 (Codex review)",
  "undatedRecurrences": [
    "Pattern: lineage fields must be verified against source, not trusted from agent output. Fix: strip lineage from LLM schema; verify per-dependency; emit malformed separately."
  ]
}
-->

**Recurrence**: Yes — agent-output lineage fields can be fabricated/misattributed by the LLM.
