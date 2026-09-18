<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-067",
  "displayId": "ERR-067",
  "title": "Orchestrator treats `retried` status as failure — retry chain breaks at SplitDiagnosticianRunner and diagnose CLI",
  "status": "active",
  "category": "Schema & Type Mistakes",
  "ep": "EP-02",
  "createdAt": "2026-06-16",
  "source": "PRI-405",
  "trailerLines": [
    "[ERR-067]: docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md#ERR-067"
  ]
}
-->

**Recurrence**: First occurrence (EP-05 Loop State Freshness + EP-02 Production Path Wiring). 2026-08-29 PRI-621, retry-asymmetry form: `artificer_output_retry` flag-off put `output_invalid` in ArtificerRunner.permanentErrorCategories, making artificer the only peer runner whose output_invalid never retried — 5/6 live internalization chains dead-ended while dreamer self-healed the SAME error category via the base retry policy. Graduated the flag to default-on (quiet rollback retained).
