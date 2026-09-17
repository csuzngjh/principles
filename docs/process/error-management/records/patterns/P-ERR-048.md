<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-048",
  "displayId": "ERR-048",
  "title": "Runtime V2 activation write path disconnected from live prompt read path — activation succeeds but principle never injected",
  "status": "active",
  "category": "Architecture Boundary Violations",
  "ep": "EP-02",
  "createdAt": "2026-05-27",
  "source": "PRI-261",
  "undatedRecurrences": [
    "PRI-261 PR review: initial implementation missed validation_status guard, action filter, budget limit, used `as` bypass + hand-rolled YAML parser",
    "See git history for full incident detail."
  ]
}
-->

**Recurrence**: Same class as ERR-024, ERR-025 — component exists and passes isolated tests, but production code never calls it.
