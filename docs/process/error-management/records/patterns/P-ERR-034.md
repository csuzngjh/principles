<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-034",
  "displayId": "ERR-034",
  "title": "Canonical runtime config not consumed by caller or cache key",
  "status": "active",
  "category": "Documentation & Spec Drift",
  "ep": "EP-07",
  "createdAt": "2026-05-24",
  "source": "PRI-162 / PR #701",
  "trailerLines": [
    "> PRI-523 C2 recurrence for ERR-034 (2026-08-13): The Codex hook initially preferred inherited `PD_WORKSPACE_DIR` over codex-cli 0.147.0's validated `cwd`, so stale process-global compatibility state could route one Workspace's hook into another Workspace's business state. The fix treats hook `cwd` as authoritative and resolves its nearest ancestor `.pd/config.yaml`; executable regressions cover nested-cwd selection and flag-off/no-mutation behavior."
  ]
}
-->

**Recurrence**: Same class as ERR-031/ERR-004 — canonical resolver output not consumed, or `??`/compatibility fallback silently overrides user intent.
