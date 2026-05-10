# PD Control Plane Triage Runbook

This runbook maps canary and diagnostic findings to structured triage categories with repair recommendations.

## Quick Start

```bash
# Run canary to detect issues
pd runtime canary --workspace "D:\.openclaw\workspace" --json

# Export full diagnostic bundle
pd runtime diagnostics export --workspace "D:\.openclaw\workspace" --json

# Check internalization chain integrity
pd runtime internalization integrity --workspace "D:\.openclaw\workspace" --json
```

## Triage Categories

### schema_mismatch (Critical)

**Symptom:** Schema conformance check reports missing columns or tables.

**Likely Root Cause:** Workspace created with older PD runtime version; schema migrations not applied.

**Verify:**
```bash
pd runtime canary --workspace <path> --json
# Check schema_conformance details for missingColumns and migrationsNeeded
```

**Safe First Repair:** Open the workspace with a writable SqliteConnection to trigger automatic schema migration. Do NOT manually ALTER TABLE.

**Escalation:** If migration fails or data loss suspected, escalate to PD maintainer with full canary JSON.

---

### sqlite_io_error (Critical)

**Symptom:** Database read error or cannot open state.db.

**Likely Root Cause:** File system permissions, disk corruption, or concurrent write lock.

**Verify:**
```bash
ls -la <workspace>/.pd/state.db
sqlite3 <workspace>/.pd/state.db "PRAGMA integrity_check;"
```

**Safe First Repair:** Verify file permissions and disk space. If corruption detected, restore from backup.

**Escalation:** If integrity_check fails, do NOT attempt repair in-place. Escalate with full diagnostic bundle.

---

### broken_pd_shim (High)

**Symptom:** PD CLI entrypoint not found or not executable.

**Likely Root Cause:** PD CLI not installed globally, or sync-plugin not configured in OpenClaw.

**Verify:**
```bash
which pd || where pd
pd --version
# Check OpenClaw sync-plugin configuration in workflows.yaml
```

**Safe First Repair:** Reinstall PD CLI globally. Verify sync-plugin entry in OpenClaw config points to correct binary.

---

### candidate_audit_failed (High)

**Symptom:** Candidate/ledger consistency audit reports orphans or missing entries.

**Likely Root Cause:** Race condition during candidate consumption, or ledger write failure.

**Verify:**
```bash
pd candidate audit --workspace <path> --json
```

**Safe First Repair:** Review audit output. Orphan candidates can be cleaned via pruning. Missing ledger entries require manual investigation.

---

### gfi_unavailable_or_stale (Medium)

**Symptom:** GFI snapshot shows all sessions stale or no active sessions.

**Likely Root Cause:** No recent PD activity, or session lifecycle not advancing.

**Verify:**
```bash
pd runtime canary --workspace <path> --json
# Check gfi_snapshot details
```

**Safe First Repair:** Trigger a new session by running a PD command. If sessions remain stale, investigate session persistence.

---

### pruning_orphans_present (Medium)

**Symptom:** Orphan derived candidates found in database.

**Likely Root Cause:** Candidates created from derived principles that were later pruned or whose source references were lost.

**Verify:**
```bash
pd runtime pruning orphans --workspace <path> --dry-run
```

**Safe First Repair:** Run `--dry-run` first to inspect. Only use `--confirm` after review.

**Escalation:** If orphan count is large (>100), investigate the pruning pipeline for systematic failures.

---

### internalization_queue_blocked (High)

**Symptom:** Internalization queue has blocked or dependency-failed tasks.

**Likely Root Cause:** Upstream task failure causing downstream tasks to be permanently blocked.

**Verify:**
```bash
pd runtime internalization queue --workspace <path> --json
```

**Safe First Repair:** Review blocked task details. If root cause is fixed, consider resetting task status to pending.

---

### internalization_chain_broken (High)

**Symptom:** Broken links in internalization chain (missing dreamer tasks, missing artifacts, missing successors).

**Likely Root Cause:** Orchestrator failed to create successor tasks, or artifact commit failed after task completion.

**Verify:**
```bash
pd runtime internalization integrity --workspace <path> --json
```

**Safe First Repair:** Review broken links. For missing successors, manually enqueue the next task. For missing artifacts, re-run the failed task.

---

### artifact_missing (High)

**Symptom:** Task result_ref points to non-existent artifact.

**Likely Root Cause:** Artifact commit failed silently, or database corruption.

**Verify:**
```bash
pd runtime internalization integrity --workspace <path> --json
```

**Safe First Repair:** Re-run the task that should have produced the artifact. If the task is idempotent, this is safe.

---

### lease_stuck (Medium)

**Symptom:** Task is leased but lease has expired.

**Likely Root Cause:** Worker crashed or lost connection without releasing the lease.

**Verify:**
```bash
pd runtime internalization integrity --workspace <path> --json
```

**Safe First Repair:** Run a recovery sweep to release expired leases, or manually reset the task status to pending.

---

### runner_unsupported (Low)

**Symptom:** Task references a runner kind that is not available.

**Likely Root Cause:** Configuration change removed a runner, or task was created with a runner not in current config.

**Verify:** Check workflows.yaml for available runners.

**Safe First Repair:** Update task metadata to use a supported runner, or add the runner to configuration.

---

### unknown (Low)

**Symptom:** Unrecognized issue detected by canary.

**Likely Root Cause:** New or unexpected condition not yet classified.

**Safe First Repair:** Review the full canary output and investigate manually.

**Escalation:** If this recurs, create a new triage category and update `classifyCanaryFindings`.

## Severity Priority

1. **Critical** — Data loss risk or complete system unavailability
2. **High** — Feature degradation or growing failure count
3. **Medium** — Non-urgent quality issue
4. **Low** — Cosmetic or future improvement

## Programmatic Triage

Use `classifyCanaryFindings()` from `@principles/core/runtime-v2` to programmatically classify canary output:

```typescript
import { classifyCanaryFindings } from '@principles/core/runtime-v2';

const plan = classifyCanaryFindings(canaryOutput);
for (const finding of plan.sortedBySeverity) {
  console.log(`[${finding.severity}] ${finding.category}: ${finding.symptom}`);
  console.log(`  Repair: ${finding.safeFirstRepair}`);
}
```
