# M8-03 Real Environment UAT

**Date:** 2026-04-28
**Phase:** m8-03 (Real Environment UAT)
**Branch:** `feature/pd-runtime-v2-m8`
**Status:** PARTIAL — UAT blocked by pre-existing openclaw CLI environment issue

---

## 语义约定（Semantic Conventions）

以下为 M8 单路径链路的 ID 语义：

| 术语 | 含义 | 示例 |
|------|------|------|
| `painId` | 触发事件的外部 ID（用户在 CLI 指定，或 hook 自动生成） | `manual_1777357370328_4tl8qb77` |
| `taskId` | 诊断任务在 tasks 表中的主键。由 `createDiagnosticianTaskId(painId)` = `diagnosis_<painId>` 生成 | `diagnosis_manual_1777357370328_4tl8qb77` |
| `runId` | 单次执行的运行时句柄（由 DiagnosticianRunner 生成） | `run_diagnosis_manual_1777357370328_4tl8qb77_1` |
| `artifactId` | 诊断输出 artifact 的 ID（diagnostician_output 类型） | `be29144e-50c6-400b-9ef7-2e38367814af` |
| `candidateId` | principle_candidates 表中的候选人 ID（从 painId 派生） | `manual_1777357370328_4tl8qb77` |
| `ledgerEntryId` | PrincipleTreeLedger 中 probation 条目的 principle id | `P_<hash>` |

**重要：** `pd pain record` 的 JSON 输出中，`taskId` 格式为 `diagnosis_<painId>`（由 PainSignalBridge 的 `createDiagnosticianTaskId(painId)` 生成）。CLI 本地计算的 `taskId` 变量现已通过 `painData.taskId` 正确传递给 bridge。

---

## 1. Environment Info

| Item | Value |
|------|-------|
| Workspace | `D:/.openclaw/workspace` |
| Plugin version (deployed) | v1.10.38 |
| Gateway status | ✅ Running on port 18789 |
| `autoIntakeEnabled` | ✅ `true` (confirmed at `packages/openclaw-plugin/src/hooks/pain.ts:41`) |
| m8-02-01 pre-condition | ✅ Complete |
| m8-02-02 pre-condition (E2E tests) | ✅ 5/5 passed |
| verify:merge | ✅ All checks green (lint + build + typecheck) |

---

## 2. Legacy Files Baseline

Recorded before pain trigger.

| Item | Count |
|------|-------|
| `diagnostician_tasks.json` entries | 1 (`test-e2e-001`) |
| `diagnostician_report_*.json` files | 14 |
| `evolution_complete_*` files | 14 |
| `.pd/state.db` | ✅ Exists |
| `principle_training_state.json` (ledger) | ✅ Exists |
| Ledger probation entries (before) | 4 |
| Ledger total principles (before) | 14 |

---

## 3. Pain Trigger

**Command:**
```bash
node packages/pd-cli/dist/index.js pain record \
  --reason "M8 real UAT pain signal" \
  --score 80 \
  --source manual_uat \
  --workspace D:/.openclaw/workspace \
  --json
```

**JSON Output:**
```json
{
  "painId": "manual_1777357370328_4tl8qb77",
  "taskId": "diagnosis_manual_1777357370328_4tl8qb77",
  "runId": "run_diagnosis_manual_1777357370328_4tl8qb77_1",
  "status": "succeeded"
}
```

**Exit code:** 0

> **Note on semantics:** `taskId` 由 `createDiagnosticianTaskId(painId)` 生成，格式为 `diagnosis_<painId>`。CLI 本地计算的 `taskId` 通过 `painData.taskId` 正确传递给 PainSignalBridge。`status: succeeded` 表示 pain signal 已成功入队，不代表 DiagnosticianRunner 已完成。

---

## UAT-01: Full Chain Verification

**Status: BLOCKED — DiagnosticianRunner fails at CLI invocation**

### What worked:
- ✅ `pd pain record` command exits 0 with JSON containing painId + taskId + runId
- ✅ `PainSignalBridge.onPainDetected()` creates task in `tasks` table
- ✅ `DiagnosticianRunner.run()` lease acquired

### What failed:
- ❌ `OpenClawCliRuntimeAdapter.startRun()` — openclaw CLI spawn fails (module resolution error)
- ❌ `openclaw agent` probe times out
- ❌ Task stuck in `retry_wait` after 1 attempt

**Root cause (pre-existing environment issue, NOT M8 code):**
```
Error: Cannot find module 'D:\ProgramData\anaconda3\Library\c\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs'
```
The npm wrapper script's `basedir` computation is corrupted when node resolves the symlink. Gateway daemon works (port 18789 ✅), CLI spawn fails.

**DB state after trigger:**
```
tasks:          { task_id: "diagnosis_manual_1777357370328_4tl8qb77", status: "retry_wait", task_kind: "diagnostician", attempt_count: 1 }
runs:           { run_id: "run_diagnosis_manual_1777357370328_4tl8qb77_1", execution_status: "failed", error_category: "execution_failed" }
principle_candidates: (empty — runner must succeed first)
artifacts:      (no new diagnostician_output created)
```

**Pass criteria (not achievable until CLI env is fixed):**
- task with `status=succeeded` in tasks table (`task_id = diagnosis_<painId>`)
- artifact with `artifact_kind=diagnostician_output` in artifacts table
- row in principle_candidates with `task_id = diagnosis_<painId>`
- probation entry in `.state/principle_training_state.json`

---

## UAT-02: Legacy NOT Revived

**Status: PASS**

| Item | Baseline | Post-trigger | Change |
|------|----------|--------------|--------|
| `diagnostician_tasks.json` entries | 1 | 1 | 0 |
| `diagnostician_report_*.json` count | 14 | 14 | 0 |
| `evolution_complete_*` count | 14 | 14 | 0 |

✅ No new legacy file entries created by `pd pain record` / PainSignalBridge.

---

## UAT-03: Idempotency

**Status: NOT TESTED** — first run did not complete due to CLI env block.

---

## UAT-04: Runtime Probe

**Command:**
```bash
node packages/pd-cli/dist/index.js runtime probe \
  --runtime openclaw-cli --openclaw-local --agent main --json
```

**JSON Output:**
```json
{
  "status": "failed",
  "runtimeKind": "openclaw-cli",
  "health": {
    "healthy": false,
    "degraded": false,
    "warnings": [
      "openclaw agent 'main' probe failed with exit code 143"
    ],
    "lastCheckedAt": "2026-04-28T06:28:32.740Z"
  }
}
```

Exit code 143 = SIGTERM (60s timeout exceeded).

**Status: FAIL**

> ❌ Probe returns `healthy: false` → runtime is not usable. This correctly reflects that the openclaw CLI environment is broken. UAT-04 is a **health check** — it cannot pass when the runtime is degraded.

---

## UAT-05: Diagnostics

**Key finding:** The failure is **NOT in the Runtime v2 code** — it's in the openclaw CLI environment:

```
Error: Cannot find module 'D:\ProgramData\anaconda3\Library\c\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs'
```

This is a **pre-existing Windows environment issue** where the npm wrapper script path resolution is broken when called from non-npm contexts (node child_process, PowerShell, etc.). The gateway daemon (`openclaw gateway`) works fine (port 18789 ✅).

The PainSignalBridge code path itself is correct — the failure happens at the **last mile** where the adapter spawns `openclaw agent`.

---

## Summary

| UAT | Result | Notes |
|-----|--------|-------|
| UAT-01 Full chain | ❌ BLOCKED | openclaw CLI spawn broken (pre-existing env issue), not M8 code |
| UAT-02 Legacy NOT revived | ✅ PASS | No legacy file writes from new chain |
| UAT-03 Idempotency | ⏭ SKIP | First run didn't complete |
| UAT-04 Runtime probe | ❌ FAIL | `healthy: false` — runtime not usable |
| UAT-05 Diagnostics | ℹ️ INFO | Root cause is CLI environment, not Runtime v2 code |

**M8 SHIPPED criteria NOT met** — UAT-01 remains BLOCKED and UAT-04 fails. UAT-02 passes, confirming no legacy regression.

**Next step:** Fix openclaw CLI environment (npm reinstall / PATH repair), then re-run UAT-01 to verify full chain. All 6 blockers (write-pain-flag deletion, .pain_flag cleanup, JSON exit code, output contract, circular import, verify:merge) remain verified correct.

---

## Evidence: openclaw CLI Issue

The error manifests when `OpenClawCliRuntimeAdapter.healthCheck()` Probe 3 calls `openclaw agent --agent diagnostician`:
- Gateway daemon: ✅ `localhost:18789` TCP test succeeds
- openclaw binary: ✅ Found at `C:\Users\Administrator\AppData\Roaming\npm\openclaw.cmd`
- openclaw agent via CLI: ❌ Module resolution fails with mangled path `D:\ProgramData\anaconda3\Library\c\...`

This is a Windows PATH / npm symlink resolution issue unrelated to M8 code.