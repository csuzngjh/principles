<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-017",
  "displayId": "ERR-017",
  "title": "JSON.stringify on unknown values can throw (BigInt, circular) — preview paths crash",
  "status": "active",
  "category": "Schema & Type Mistakes",
  "ep": "EP-03",
  "createdAt": "2026-05-21",
  "source": "PRI-200 / PR #665 (final review)"
}
-->

**Recurrence**: Yes — 2026-06-23 PR #1020 (PRI-443): `validatePainSignal()` used `JSON.stringify(hydrated.context).length` without try-catch — throws on circular/BigInt, crashing validator. Fixed with try-catch returning structured error + 2 regression tests.
