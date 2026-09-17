<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-023",
  "displayId": "ERR-023",
  "title": "CLI dry-run command opens writable database connection instead of readonly",
  "status": "active",
  "category": "Documentation & Spec Drift",
  "ep": "EP-04",
  "createdAt": "2026-05-23",
  "source": "PRI-218 / PR #681"
}
-->

**Recurrence**: 2026-06-27 PR #1079 — `migrate-illegal-expected-decision.ts` docstring claimed "默认 dry-run" but `parseArgs()` defaulted to write mode (no `--write` flag required). Operator running the script with no flags would mutate the DB. Fixed by flipping to `--write` opt-in.
