<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-001",
  "displayId": "ERR-001",
  "title": "`as string | undefined` type cast on untrusted JSON bypasses runtime validation",
  "status": "active",
  "category": "Schema & Type Mistakes",
  "ep": "EP-01",
  "createdAt": "2026-05-19",
  "source": "PRI-189"
}
-->

**Recurrence**: Yes — `as`-bypass at trust boundaries (JSON parsing, SQLite rows, CLI inputs, LLM/runtime outputs, DOM values, test fixtures).
