# Story A' Smoke Test Evidence — 2026-05-29

## Pre-flight Results

| Step | Status | Notes |
|------|--------|-------|
| 1. Sync main | ✅ PASS | `896404c1` (newer than required `682d2862`), #735 + #732 in history |
| 2. Rebuild | ✅ PASS | All 4 packages built (tsc + esbuild) |
| 3. Redeploy plugin | ✅ PASS | sync-plugin v1.10.41, fingerprint git=896404c1ed8c |
| 4. Restart gateway | ✅ PASS | Gateway listening on port 18789 via schtasks |
| 5. Snapshot baseline | ✅ PASS | See `baseline.json` |

### Baseline Summary
- **features**: 3/8 enabled (prompt, code_tool_hook, defer_archive)
- **canary**: degraded (GFI stale sessions only — known stale-noise)
- **integrity**: degraded (13× missing_dreamer_task — PRI-257 pre-existing)
- **queue**: 1 ready scribe, 0 pending, 1 retry_wait, 3 suppressed non-MVP

## Smoke Step A — Submit Pain

**Command:**
```powershell
pd pain record --reason "Agent attempted to modify package.json without confirming scope of dependency changes first - added 3 deps without version pinning or lockfile sync" --score 75 --source "manual_smoke_2026-05-29" --json
```

**Result: ❌ FAILED**

```json
{
  "status": "retried",
  "painId": "manual_1780021864411_cw80inw9",
  "taskId": "diagnosis_manual_1780021864411_cw80inw9",
  "failureCategory": "output_invalid",
  "message": "[output_invalid] LLM output does not match diagnostician-output-v1 schema",
  "latencyMs": 39196
}
```

**Database state:**
- `task_id`: `diagnosis_manual_1780021864411_cw80inw9`
- `task_kind`: `diagnostician`
- `status`: `retry_wait`
- `attempt_count`: 1
- `last_error`: `output_invalid`

**Failure fingerprint:**
- Pain was recorded in state.db
- Diagnostician ran but LLM output failed schema validation
- No candidate was produced
- Queue unchanged (still 1 ready scribe from pre-existing data)

## Stop Decision

Per PRI-269 instructions: *"任何一步失败立刻停下"* — Smoke halted at Step A.

Root cause class: `output_invalid` — Diagnostician LLM response does not conform to `diagnostician-output-v1` schema.
This may be related to LLM model configuration or prompt template issues in the deployed plugin.
