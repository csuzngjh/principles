<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-060",
  "displayId": "ERR-060",
  "title": "Emitted telemetry event not registered in schema — event silently dropped or degraded",
  "status": "archived",
  "category": null,
  "ep": "EP-02",
  "createdAt": "2026-06-03",
  "source": "PR #808/#809/#810",
  "trailerLines": [
    "- **Archived**: 2026-09-10 (last activity 2026-06-11, > 90 days; archived to bring the active handbook back under the 300KB limit)"
  ]
}
-->

**Recurrence**: Yes - 2026-06-11 PR #902 (PRI-371): `diagnostician_core_grounding_result` telemetry event emitted by DiagnosticianRunner.succeedTask() but not registered in TelemetryEventType union in telemetry-event.ts. Event would be silently dropped and replaced with `degradation_triggered` fallback by StoreEventEmitter. Same class as original: new event literal added to runner but telemetry schema not updated.
