---
"create-principles-disciple": minor
---

Console now surfaces the rule compatibility scan (5B-F), including the active rules the scan could not read.

- New read-only endpoint `GET /api/runtime/compatibility-scan` exposes the same scan the installer preflight and `pd runtime compatibility-scan` use, reduced to a reason-granular view: `status`, `scannedActivations`, `unscannable[{reason, count, sampleActivationIds}]` and `findingsTotal`. It never returns per-row findings or the workspace path.
- The activation page renders that view as a companion block: the scan status, one line per unscannable reason (`reason=count (sample: …)`), an explicit "no unscannable rows" empty state, and a visible degraded reason when the endpoint fails.
- Additive only: no existing payload changes, and the block is supplementary — a scan failure never blocks the activation list.
