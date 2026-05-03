# Runtime V2 Production Runbook

> Status: Active
> Date: 2026-05-03
> Related: PRI-27, PRI-28, PRI-29, PRI-30, PRI-40

## 1. Purpose & Scope

**This is an operator runbook**, not a developer design document.

**Purpose:** Validate that the Runtime V2 pain→principle chain is healthy in a live workspace. Use this runbook to:
- Confirm a successful end-to-end run after configuration changes
- Diagnose why a pain signal failed to propagate
- Establish a UAT baseline before risky changes
- Verify health after plugin upgrades

**Non-goals (out of scope):**
- Store schema refactoring
- Automatic principle pruning/deletion
- OpenClaw gateway CLI修复 (separate issue)
- Designing new Runtime V2 features

---

## 2. Prerequisites

### 2.1 Plugin Installed & Synced

```bash
# From packages/openclaw-plugin/
npm run sync-plugin
```

This builds the plugin, installs PD CLI globally, and restarts the gateway.

### 2.2 Workspace

Example workspace used in this runbook:
```
D:\.openclaw\workspace
```

Adjust the `--workspace` argument to match your actual workspace path.

### 2.3 Environment Variable

**The Diagnostician uses `MINIMAX_CN_API_KEY`**, not `MINIMAX_API_KEY`.

```powershell
# Windows — set permanently via System Properties or:
setx MINIMAX_CN_API_KEY "your-key-here"
```

**SECURITY REMINDER:**
- ❌ Never commit API keys to git
- ❌ Never paste API keys in Linear comments
- ❌ Never include keys in runbook documentation
- ✅ Use environment variables, never hardcode

### 2.4 Verify PD CLI Works

```bash
pd --version
```

If `pd` is not found, run `npm run sync-plugin` again.

---

## 3. Golden Path: Manual Pain UAT

Run this sequence to verify the full pain→principle chain end-to-end.

### 3.1 Record a Pain Signal

```bash
pd pain record --reason "PRI-30 runbook validation" --score 100 --source manual --workspace "D:\.openclaw\workspace"
```

**Expected output:** JSON with a `painId` such as `manual_<timestamp>_<random>`.

### 3.2 Trace the Chain

```bash
pd runtime trace show --pain-id <painId> --workspace "D:\.openclaw\workspace" --json
```

Replace `<painId>` with the ID from step 3.1.

### 3.3 Audit Candidates

```bash
pd candidate audit --workspace "D:\.openclaw\workspace" --json
```

### 3.4 Check Health Snapshot

```bash
pd runtime health snapshot --workspace "D:\.openclaw\workspace" --json
```

### 3.5 Success Criteria

| Check | Expected |
|-------|----------|
| `status` | `succeeded` |
| `taskId` | Non-empty string |
| `runId` | Non-empty string |
| `artifactId` | Non-empty string |
| `candidateIds` | Non-empty array |
| `ledgerEntryIds` | Non-empty array |
| Candidate audit `status` | `ok` |
| Candidate audit `missingLedgerEntryIds` | `[]` |
| Health snapshot `lastSuccessfulChain` | Updated timestamp |

If all checks pass, the chain is healthy.

---

## 4. Repeated UAT Baseline

Run multiple iterations to establish a reliability baseline.

### 4.1 CLI Command (Recommended)

```bash
pd runtime uat --workspace "D:\.openclaw\workspace" --count 3 --min-success-rate 1 --json
```

### 4.2 Standalone Script

```bash
node packages/pd-cli/dist/index.js runtime uat --workspace "D:\.openclaw\workspace" --count 3
```

### 4.3 Understanding Results

| Field | Meaning |
|-------|---------|
| `successCount` / `totalCount` | Iterations that reached `status=succeeded` |
| `successRate` | successCount / totalCount |
| `latencyMs` p50 / p95 | Chain completion latency distribution |
| `failuresByCategory` | Breakdown of failure types |

**Pass threshold:** `successRate >= min-success-rate` (default 1.0 = 100%)

### 4.4 Without API Key

If `MINIMAX_CN_API_KEY` is not set, the UAT will fail with:

```
Error: MINIMAX_CN_API_KEY environment variable not set
```

This is expected behavior. Configure the key and re-run.

### 4.5 Windows-Specific Notes

The UAT runner was fixed for Windows compatibility:

- ✅ Uses `process.execPath + packages/pd-cli/dist/index.js` (no `npx pd`)
- ✅ `--workspace` must come **after** subcommand args, not before
- ✅ Correct: `pd runtime uat ... --workspace "D:\.openclaw\workspace"`
- ❌ Wrong: `pd --workspace "D:\.openclaw\workspace" runtime uat ...`

---

## 5. Operator Health Snapshot

Get a consolidated health view without running a full UAT.

```bash
pd runtime health snapshot --workspace "D:\.openclaw\workspace" --json
```

### 5.1 Field Reference

| Field | Description |
|-------|-------------|
| `overallStatus` | `healthy` \| `degraded` \| `error` |
| `painChain.lastSuccessfulChain` | Timestamp of last succeeded chain |
| `painChain.consecutiveFailures` | Failed iterations since last success |
| `candidateLedger.auditStatus` | `ok` \| `degraded` \| `error` |
| `candidateLedger.missingLedgerEntryIds` | Candidates without ledger entries |
| `pruning.watchCount` | Principles flagged for review |
| `pruning.reviewCount` | Principles with operator decisions recorded |
| `recommendedActions` | Array of suggested operator actions |

### 5.2 Interpreting Status

| Status | Meaning | Action |
|--------|---------|--------|
| `healthy` | All checks passed | None |
| `degraded` | Some checks failed but chain still functions | Review recommendedActions |
| `error` | Chain is broken | Investigate immediately |

---

## 6. Trace & Audit Troubleshooting

Use these commands to diagnose specific failures.

### 6.1 Trace a Pain ID

```bash
pd runtime trace show --pain-id <painId> --workspace "D:\.openclaw\workspace" --json
```

### 6.2 Audit Candidate-Ledger Consistency

```bash
pd candidate audit --workspace "D:\.openclaw\workspace" --json
```

### 6.3 Common Failure Categories

| Category | Meaning | First Debug Step |
|----------|---------|------------------|
| `runtime_unavailable` | Diagnostician or provider not accessible | Check `MINIMAX_CN_API_KEY`, provider config |
| `config_missing` | Required config not found | Verify workspace state.db exists |
| `output_invalid` | Runtime returned malformed response | Check OpenClaw logs for error details |
| `candidate_missing` | Pain reached Diagnostician but no candidate created | Run `pd candidate audit` |
| `ledger_write_failed` | Candidate created but ledger entry missing | Run `pd candidate audit` — check missingLedgerEntryIds |
| `pain_gate_rejected` | GFI below threshold — normal gate behavior | Not an error, expected for low-severity failures |

### 6.4 Decision Path

```
health snapshot error
  → Check workspace/state.db/config exists

UAT reports runtime_unavailable
  → Verify MINIMAX_CN_API_KEY is set
  → Verify provider config is correct

trace show returns candidate_missing
  → Run pd candidate audit

candidate audit shows degraded
  → Do NOT continue auto-trigger
  → Repair consistency first (see candidate audit output for specific IDs)

OpenClaw log shows PAIN_GATE_REJECTED
  → This is normal gate behavior, not a bug
  → Low GFI score means the failure was not severe enough to trigger pain detection
```

---

## 7. Auto-Trigger Track B Status

**PRI-40 Track A (Manual Pain Trigger):** ✅ PASS

Manual pain record fully validated:
- Pain ID generated
- Diagnostician triggered
- Task/Run/Artifact/Candidate/Ledger all created
- Chain latency: ~35s

**PRI-40 Track B (Gateway Tool Failure Auto-Trigger):** ⏸️ BLOCKED

**Blocker:** OpenClaw gateway CLI (`openclaw gateway start/status`) is currently unavailable. Cannot programmatically trigger controlled tool failures to test the GFI gate.

**What Track B would validate:**
- Real OpenClaw `after_tool_call` hook fires on tool failure
- GFI accumulates across consecutive failures
- If GFI ≥ 40: `pain_detected` → PainToPrincipleService → full chain
- If GFI < 40: `PAIN_GATE_REJECTED` with `reason/detail/gfi/score` in structured log

**How to unblock Track B (when gateway is available):**
1. Open OpenClaw web UI or establish WebSocket connection
2. Conduct a conversation that triggers 2+ consecutive tool failures
3. Check structured logs for `PAIN_GATE_REJECTED` or `pain_detected` events
4. Verify via `pd runtime health snapshot` and `pd runtime trace show`

**Important clarification:** Running `pd pain record` manually does **not** validate Track B. Track B specifically tests the OpenClaw `after_tool_call → emitPainDetectedEvent` automatic path.

---

## 8. Pruning Review Workflow

The pruning review system is **non-destructive** — it only appends audit records, never modifies the principle ledger or `state.db`.

Reference: [`docs/runtime-v2-principle-lifecycle-review.md`](../runtime-v2-principle-lifecycle-review.md)

### 8.1 View All Flagged Principles

```bash
pd runtime pruning report --workspace "D:\.openclaw\workspace" --json
```

Shows all principles with `watch` or `review` signals.

### 8.2 Explain a Specific Flag

```bash
pd runtime pruning explain --principle-id <principleId> --workspace "D:\.openclaw\workspace" --json
```

Shows why a specific principle was flagged: stale, orphan, or at-risk evidence.

### 8.3 Record a Review Decision

```bash
pd runtime pruning review --principle-id <principleId> --decision keep --reviewer operator --workspace "D:\.openclaw\workspace"
```

Or to archive:

```bash
pd runtime pruning review --principle-id <principleId> --decision archive-candidate --note "Duplicate of P_003" --reviewer operator --workspace "D:\.openclaw\workspace"
```

**Decisions:**
- `keep` — Principle is valid, remove from watch list
- `defer` — Needs review later, stays on watch list
- `archive-candidate` — Mark for future deletion (note required)

**Audit log location:** `.state/pruning_reviews.jsonl` (append-only, never modified by this workflow)

---

## 9. Known Issues & Guardrails

### 9.1 API Key Name

❌ **Wrong:** `MINIMAX_API_KEY`
✅ **Correct:** `MINIMAX_CN_API_KEY`

The Diagnostician reads `MINIMAX_CN_API_KEY`. Using the wrong name silently fails with `runtime_unavailable`.

### 9.2 Never Commit Keys

❌ Do not commit `.env` files, `settings.json`, or any config containing API keys
❌ Do not paste keys in Linear comments or GitHub issues
❌ Do not include keys in runbook documentation

### 9.3 UAT Internal Invocation

❌ Do not use `npx pd` inside scripts that run on Windows
✅ Use `node packages/pd-cli/dist/index.js` or the global `pd` shim

### 9.4 Legacy Path

❌ Do not use `.pain_flag` file as a success standard — this is a legacy mechanism
✅ Use `pd candidate audit` and `pd runtime trace show` for validation

### 9.5 Cleanup PRs

❌ Do not delete core read models or CLI commands in cleanup PRs without an architecture guard
✅ When removing files, update `packages/principles-core/src/runtime-v2/index.ts` exports and `packages/pd-cli/src/index.ts` command registrations

Architecture regression tests (`architecture-regression.test.ts`) guard critical files:
- `pain.ts` (hook)
- `pain-record.ts` (command)
- `runtime-health-snapshot.ts` (command)
- `pruning-read-model.ts` (read model)

Deleting these without updating the guard test will cause the guard to fail, protecting the codebase.

---

## 10. Quick Decision Tree

```
START: Something is wrong with Runtime V2
│
├─ pd runtime health snapshot → error
│   → Check workspace path exists
│   → Check .state/state.db exists
│   → Check .state/config.json exists
│
├─ pd runtime uat fails with runtime_unavailable
│   → Verify MINIMAX_CN_API_KEY is set
│   → Verify MINIMAX_CN_API_KEY is correct (not MINIMAX_API_KEY)
│   → Check provider config in config.json
│
├─ pd runtime trace show shows candidate_missing
│   → Run pd candidate audit
│
├─ pd candidate audit shows degraded / missingLedgerEntryIds
│   → Do NOT continue auto-trigger validation
│   → Investigate missing entries
│   → Repair consistency before proceeding
│
├─ pd runtime health snapshot shows degraded
│   → Review recommendedActions array
│   → Check consecutiveFailures count
│
└─ PRI-40 Track B: no pain_detected events in logs
    → Check OpenClaw logs for PAIN_GATE_REJECTED (may be normal)
    → Verify gateway is running
    → Track B requires OpenClaw UI or WebSocket — not blocked by Runtime V2
```

---

## Appendix: All Verified Commands

### Pain Recording
```bash
pd pain record --reason "..." --score 100 --source manual --workspace "D:\.openclaw\workspace"
```

### Trace & Audit
```bash
pd runtime trace show --pain-id <painId> --workspace "D:\.openclaw\workspace" --json
pd candidate audit --workspace "D:\.openclaw\workspace" --json
```

### Health
```bash
pd runtime health snapshot --workspace "D:\.openclaw\workspace" --json
```

### UAT
```bash
pd runtime uat --workspace "D:\.openclaw\workspace" --count 3 --min-success-rate 1 --json
```

### Pruning
```bash
pd runtime pruning report --workspace "D:\.openclaw\workspace" --json
pd runtime pruning explain --principle-id <id> --workspace "D:\.openclaw\workspace" --json
pd runtime pruning review --principle-id <id> --decision keep --reviewer operator --workspace "D:\.openclaw\workspace"
```
