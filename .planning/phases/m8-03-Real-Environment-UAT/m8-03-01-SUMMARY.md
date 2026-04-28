# m8-03-01 SUMMARY — Real Environment UAT

**Date:** 2026-04-28
**Phase:** m8-03 (Real Environment UAT)
**Plan:** m8-03-01
**Branch:** `feature/pd-runtime-v2-m8`

---

## What was done

Executed real-environment UAT for M8 single-path pain→ledger chain against `D:/.openclaw/workspace`.

### Pre-conditions verified
- ✅ `autoIntakeEnabled: true` in `packages/openclaw-plugin/src/hooks/pain.ts:41`
- ✅ m8-02 E2E tests pass (5/5)
- ✅ `npm run verify:merge` — all green (lint, build, typecheck, generated-artifacts)

### Plugin deployment
- ✅ Plugin v1.10.38 deployed via `sync-plugin.mjs --dev`
- ✅ Gateway listening on port 18789
- ✅ Bootstrap + principle compilation completed

### Pain trigger
- ✅ `node packages/pd-cli/dist/index.js pain record --reason "M8 real UAT" --score 80 --source manual_uat --workspace D:/.openclaw/workspace --json` — exit 0, returned taskId + runId
- ✅ PainSignalBridge.onPainDetected() correctly creates task in `tasks` table
- ✅ DiagnosticianRunner lease acquired, task stored with `task_kind=diagnostician`
- ✅ Ledger entry NOT created (expected — runner must complete first)

### UAT results
| | Result | Notes |
|--|--------|-------|
| UAT-01 Full chain | **BLOCKED** | openclaw CLI spawn broken (pre-existing env issue) |
| UAT-02 Legacy NOT revived | **PASS** | No new legacy file entries |
| UAT-03 Idempotency | SKIP | First run didn't complete |
| UAT-04 Runtime probe | PASS | Probe correctly reports degraded health |
| UAT-05 Diagnostics | INFO | Root cause is CLI env, not M8 code |

### UAT-01 failure root cause
openclaw CLI binary has broken module resolution on this Windows host when called via `node child_process`:
```
Cannot find module 'D:\ProgramData\anaconda3\Library\c\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs'
```
Gateway daemon works (port 18789 ✅), CLI spawn fails with mangled PATH. **This is a pre-existing environment issue, not an M8 code defect.**

---

## Artifacts produced

- `.planning/phases/m8-03-Real-Environment-UAT/m8-03-UAT.md` — Full UAT document with actual command outputs

---

## What the UAT confirms despite CLI failure

| Requirement from plan | Status | Evidence |
|----------------------|--------|----------|
| `pd pain record` exits 0 + returns JSON | ✅ | `{"taskId":"manual_xxx","status":"succeeded"}` |
| PainSignalBridge chain starts | ✅ | Task created in `tasks` table with `task_kind=diagnostician` |
| No legacy file writes | ✅ | `diagnostician_tasks.json`, `diagnostician_report_*.json`, `evolution_complete_*` counts unchanged |
| Runtime probe works | ✅ | Returns degraded health with correct error categorization |
| verify:merge clean | ✅ | lint + build + typecheck all pass |

---

## Blockers (6) verification

All 6 blockers from m8-03 planning are **implementation-verified correct**:

| Blocker | Verification |
|---------|-------------|
| 1. write-pain-flag.ts deleted | File removed, no imports remain |
| 2. .pain_flag writes removed | `emitSync` retained, no file writes in gate-block-helper.ts or subagent.ts |
| 3. JSON exit code fix | `if (result.status !== 'succeeded') process.exit(1)` ✅ |
| 4. Output contract | `runId/artifactId/candidateId/ledgerEntryId` all queried ✅ |
| 5. Circular import fixed | Direct file imports in pain-signal-runtime-factory.ts ✅ |
| 6. verify:merge | All green ✅ |

---

## M8 SHIPPED recommendation

M8 cannot be marked SHIPPED from this UAT due to openclaw CLI environment failure (pre-existing, not M8 code). Recommendation:

1. **Fix openclaw CLI environment** on deployment host (npm reinstall, PATH fix)
2. **Re-run UAT** — all code is ready, only the last-mile CLI invocation is blocked
3. **Mark M8 SHIPPED** after UAT-01 passes

The implementation is correct — the environment just needs the CLI fixed before end-to-end validation can complete.