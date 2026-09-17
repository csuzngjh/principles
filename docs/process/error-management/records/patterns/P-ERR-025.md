<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-025",
  "displayId": "ERR-025",
  "title": "Test coverage proves isolated helper behavior, not real production defense",
  "status": "active",
  "category": "Missing Tests & Verification",
  "ep": "EP-02",
  "createdAt": "2026-05-23",
  "source": "PRI-209 / PR #689"
}
-->

**Recurrence**: Yes — tests assert shapes/strings/isolated helper behavior instead of the real production contract, or vacuously pass when data is absent.
