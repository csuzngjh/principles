# PRI-438 Acceptance Gate Report — acceptance-20260704-1f1ea076

**Date**: 2026-07-04T15:18:10.724Z
**Provider**: sensenova
**Workspace**: D:/.openclaw/workspace
**Overall**: `FAIL` (2 PASS, 4 FAIL, 4 SKIP)

---

## Matrix Results

| Item | Status | Evidence |
|------|--------|----------|
| 1-capture | ⏭️ SKIP | Agent drives skipped |
| 2-principle | ❌ FAIL | Production pipeline did not produce an evaluator-approved candidate |
| 3-approve | ⏭️ SKIP | Agent drives skipped |
| 4-activation | ⏭️ SKIP | Agent drives skipped |
| 5-lineage | ❌ FAIL | Correlated lineage incomplete |
| 6-enforce | ❌ FAIL | Runtime evidence: danger 0/5 blocked, safe 0/5 allowed |
| 7-restart | ⏭️ SKIP | No activations to verify persistence |
| 8-deactivate | ❌ FAIL | Deactivation behavior not verified |
| 9-unhealthy | ✅ PASS | Runtime-invalid rules emit persistent unhealthy evidence and never execute |
| 10-secrets | ✅ PASS | All invoked JSON contracts were runtime-validated; report contains no secret values |

---

## Phase 0: Setup

- **Status**: PASS
- **Test Workspace**: D:\.openclaw\workspace\acceptance-gate\run-acceptance-20260704-1f1ea076


## Phase 1: Environment Probe

- **Status**: PASS

- **Details**: `{"pdCliVersion":"1.74.1","consoleStatus":{"success":true,"data":{"overall":"error","checks":[{"id":"sqlite","name":"数据库连接","status":"healthy","message":"连接正常","lastCheck":"2026-07-04T15:17:55.290Z"},{"id":"pain_chain_flow","name":"Pain Chain 流动","status":"error","message":"超过 26769 分钟无活动","lastCheck":"2026-07-04T15:17:55.295Z"},{"id":"task_queue","name":"任务队列","status":"error","message":"失败任务过多: 37 个","lastCheck":"2026-07-04T15:17:55.295Z"},{"id":"principle_tree","name":"原则树","status":"healthy",`

## Phase 2: Baseline Capture

- **Canary**: {"overallStatus":"degraded","checks":[{"name":"schema_conformance","status":"healthy","summary":"All tables and columns conform to expected schema.","details":{"overallStatus":"ok","checkedDatabasePath":"D:\\.openclaw\\workspace\\.pd\\state.db","tables":{"tasks":{"exists":true,"missingColumns":[]},"runs":{"exists":true,"missingColumns":[]},"artifacts":{"exists":true,"missingColumns":[]},"commits":{"exists":true,"missingColumns":[]},"principle_candidates":{"exists":true,"missingColumns":[]},"pi_a
- **Integrity**: {"overallStatus":"error","brokenLinks":[{"type":"missing_dreamer_task","severity":"warning","candidateId":"b1779c82-65ef-4fa3-8979-0ca430377aa6","reason":"Consumed candidate b1779c82-65ef-4fa3-8979-0ca430377aa6 has no corresponding dreamer task","recommendedAction":"Seed a dreamer task via `pd candidate internalize --candidate-id <id>`."},{"type":"missing_dreamer_task","severity":"warning","candidateId":"8d4a423e-9357-4001-9372-d3094c0475c4","reason":"Consumed candidate 8d4a423e-9357-4001-9372-d
- **MVP Smoke**: {"ok":false,"verdict":{"overall":"violation","painId":"manual_1783074843352_giuprq3l","stages":[{"stage":"config_source_alignment","status":"ok","reason":"doctor and probe agree on \"pi-ai.sensenova\" from .pd/config.yaml."},{"stage":"diagnostician_readiness","status":"ok","reason":"Diagnostician passed readiness probe."},{"stage":"pain_record","status":"ok","reason":"Canonical painId \"manual_1783074843352_giuprq3l\" present."},{"stage":"diagnosis_task","status":"ok","reason":"Diagnosis task di
- **Activations**: {"activations":[{"activationId":"act_prompt_demo-principle-story-a-1783130516336-oozwsd","idempotencyKey":"story-a-story-a-1783130516336-oozwsd::prompt","artifactId":"art-demo-principle-story-a-1783130516336-oozwsd","channel":"prompt","action":"prompt_activate","targetRef":"ledger://demo-principle-story-a-1783130516336-oozwsd","activatedAt":"2026-07-04T02:01:56.347Z","promotedAt":null,"deactivatedAt":null,"principleId":"demo-principle-story-a-1783130516336-oozwsd","status":"active","contextVersi

## Phase 3: Full Production Loop

- **Agent Drives Skipped**: true
- **Danger Scenarios Run**: 0
- **Safe Scenarios Run**: 0



## Phase 4: Restart Persistence

- **Activations persist**: false

## Phase 5: Deactivate Rollback

- **Deactivated**: false
- **Other rules still enforce**: true

## Phase 6: Unhealthy Rule Visibility

- **Unhealthy visible**: true

## Phase 7: Evidence Report

- **Report path**: D:\Code\principles\docs\plans\acceptance-gate-output\acceptance-20260704-1f1ea076\REPORT.md
- **JSON path**: D:\Code\principles\docs\plans\acceptance-gate-output\acceptance-20260704-1f1ea076\REPORT.json

---

## Log

[15:17:54.643] [INFO] Phase 0: Setting up test workspace...
[15:17:54.660] [INFO] Phase 0: Copied .pd config from main workspace
[15:17:54.660] [PASS] Phase 0: Test workspace: D:\.openclaw\workspace\acceptance-gate\run-acceptance-20260704-1f1ea076
[15:17:54.660] [INFO] Phase 1: Probing environment...
[15:17:54.660] [INFO] Phase 1: Checking pd CLI availability...
[15:17:55.272] [PASS] Phase 1: pd CLI: 1.74.1
[15:17:55.272] [INFO] Phase 1: Checking Console at http://127.0.0.1:3100...
[15:17:55.347] [PASS] Phase 1: Console API reachable
[15:17:55.347] [INFO] Phase 1: Checking OpenClaw status...
[15:18:04.256] [PASS] Phase 1: OpenClaw reachable
[15:18:04.256] [INFO] Phase 1: Provider: sensenova (skipping direct check — relies on OpenClaw config)
[15:18:04.257] [INFO] Phase 2: Capturing baseline...
[15:18:04.257] [INFO] Phase 2: Running pd runtime canary...
[15:18:04.906] [FAIL] Phase 2: Canary: {"overallStatus":"degraded","checks":[{"name":"schema_conformance","status":"healthy","summary":"All tables and columns conform to expected schema.","details":{"overallStatus":"ok","checkedDatabasePath":"D:\\.openclaw\\workspace\\.pd\\state.db","tables":{"tasks":{"exists":true,"missingColumns":[]},"runs":{"exists":true,"missingColumns":[]},"artifacts":{"exists":true,"missingColumns":[]},"commits":{"exists":true,"missingColumns":[]},"principle_candidates":{"exists":true,"missingColumns":[]},"pi_a
[15:18:04.906] [INFO] Phase 2: Running pd runtime internalization integrity...
[15:18:05.480] [FAIL] Phase 2: Integrity: {"overallStatus":"error","brokenLinks":[{"type":"missing_dreamer_task","severity":"warning","candidateId":"b1779c82-65ef-4fa3-8979-0ca430377aa6","reason":"Consumed candidate b1779c82-65ef-4fa3-8979-0ca430377aa6 has no corresponding dreamer task","recommendedAction":"Seed a dreamer task via `pd candidate internalize --candidate-id <id>`."},{"type":"missing_dreamer_task","severity":"warning","candidateId":"8d4a423e-9357-4001-9372-d3094c0475c4","reason":"Consumed candidate 8d4a423e-9357-4001-9372-d
[15:18:05.480] [INFO] Phase 2: Running pd mvp smoke...
[15:18:06.055] [FAIL] Phase 2: MVP smoke: violation
[15:18:06.056] [INFO] Phase 2: Running pd runtime internalization queue...
[15:18:06.616] [INFO] Phase 2: Queue: 0 items
[15:18:06.616] [INFO] Phase 2: Running pd runtime activation list...
[15:18:07.177] [INFO] Phase 3: Running full production loop...
[15:18:07.177] [SKIP] Phase 3: Agent drives skipped (--skip-agent)
[15:18:07.177] [INFO] Phase 4: Verifying restart persistence...
[15:18:07.177] [INFO] Phase 4: Verifying restart persistence...
[15:18:07.177] [FAIL] Phase 4: No correlated activation from Phase 3
[15:18:07.177] [INFO] Phase 5: Testing deactivate rollback...
[15:18:07.178] [INFO] Phase 5: Testing deactivate rollback...
[15:18:07.766] [SKIP] Phase 5: No active activations to deactivate
[15:18:08.324] [FAIL] Phase 5: Post-deactivation behavior was not restored: {"toolAttempted":false,"blocked":false,"allowed":false,"reason":"not run"}
[15:18:08.324] [INFO] Phase 6: Testing unhealthy rule visibility...
[15:18:08.324] [INFO] Phase 6: Testing unhealthy rule visibility...
[15:18:10.723] [PASS] Phase 6: Production RuleHost unhealthy-event regression test passed
[15:18:10.723] [INFO] Phase 7: Generating evidence report...
[15:18:10.723] [INFO] Phase 7: Generating evidence report...

---

## ERR Checklist

| ERR | Considered | How Avoided |
|-----|-----------|-------------|
| ERR-001 | Yes | All JSON CLI output validated as unknown via isRecord/isNonEmptyString/requireString before use |
| ERR-002 | Yes | Every catch/degradation path emits structured reason; sh() helper returns empty string with stderr capture |
| ERR-009 | Yes | Required fields checked with fail-loud requireString/requireArray helpers |
| ERR-014 | Yes | All previews bounded via safePreview() with max 500 chars; never raw JSON.stringify on unknown |
| ERR-020 | Yes | No Commander flags constructed in this script; all CLI calls use established command signatures |
| ERR-024 | Yes | Only pd CLI / openclaw CLI / Console HTTP API used; zero internal imports |
