<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-033",
  "displayId": "ERR-033",
  "title": "Operator failure path returns success exit code and breaks JSON contract",
  "status": "archived",
  "category": null,
  "ep": null,
  "createdAt": "2026-05-24",
  "source": "PRI-162 / PR #701"
}
-->

**Recurrence**: Same class as ERR-022, ERR-009. 2026-05-24 PR #701: `runtime-internalization-run-once.ts` catch block classified all errors as `config_error` (including runner/orchestrator failures). Fixed by introducing `ConfigResolutionError` class for `instanceof` distinction without message substring guessing.
