<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-021",
  "displayId": "ERR-021",
  "title": "Handler-only tests miss Commander flag→opts mapping bugs",
  "status": "active",
  "category": "Documentation & Spec Drift",
  "ep": "EP-04",
  "createdAt": "2026-05-22",
  "source": "PRI-217 / PR #677",
  "undatedRecurrences": [
    "Same PR also surfaced a sibling CLI gate violation (Finding 2): `resolveWorkspaceDir()` was called outside the `try` block in `handleRuntimeActivationPromote`, violating `cli-2-exit-stops` — if workspace resolution threw, the exception escaped the catch and broke the `--json` single-object contract. Fix: moved workspace resolution + `RuntimeStateManager` construction inside `try`, used `stateManager?.close()` in `finally`."
  ]
}
-->

**Recurrence**: Yes — handler-only tests miss Commander wiring for new CLI commands.
