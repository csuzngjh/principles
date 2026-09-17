<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-088",
  "displayId": "ERR-088",
  "title": "Test assertion uses non-unique signal that cannot distinguish intended behavior from no-op/fail-soft path",
  "status": "active",
  "category": "Missing Tests & Verification",
  "ep": "EP-09",
  "createdAt": "2026-06-29",
  "source": "PRI-486 / PR #1109 (CodeRabbit review)"
}
-->

**Recurrence**: (older inline recurrences → ERROR_ARCHIVE.md) 2026-08-13 PRI-523 C1.1: production-BDD seeded only a Runtime V2 activation then asserted its unique text — seed both paths, assert per-path unique signals. 2026-07-22 PRI-520: fail-loud tests assert the surfaced error AND the preserved outcome. 2026-07-04 PR #1182: non-unique UPDATE-by-painId + pagination false-empty — latest-row subquery + total-based emptiness.
