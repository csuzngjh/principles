<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-009",
  "displayId": "ERR-009",
  "title": "Validator derived from the shape the writer controls instead of the authoritative contract — required fields (array, scalar, lineage identity) skipped/treated nullable instead of failing loud",
  "status": "active",
  "category": "Schema & Type Mistakes",
  "ep": "EP-01",
  "createdAt": "2026-05-19",
  "source": "PRI-192 / PR #638 (reviewer feedback)",
  "undatedRecurrences": [
    "Earlier recurrences (PR#680-#966): same silent-skip pattern across `parseInt` w/o NaN check, `?.trim()||undefined`, `?? 'fallback'` defaulting, `if(output){assert}` (full text → ERROR_ARCHIVE.md)."
  ]
}
-->

**Recurrence**: Yes — validator/test silently passes when data is absent/malformed instead of failing loud.
