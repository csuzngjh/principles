---
status: testing
phase: m8-02
---

## Mocked Runtime E2E Results (m8-02-02)

| Test | Scenario | Result |
|------|----------|--------|
| E2E-01 | Full chain: pain→task→artifact→candidates→ledger probation | PASS |
| E2E-02 | Legacy .state/diagnostician_tasks.json NOT created | PASS |
| E2E-03 | Same painId twice: NO duplicate candidates/ledger | PASS |
| E2E-04 | autoIntakeEnabled=false: NO ledger write | PASS |
| E2E-05 | Second trigger returns immediately while first in-flight | PASS |

total: 5 | passed: 5 | pending: 0

## Real OpenClaw UAT (manual — NOT covered by m8-02-02)

These require a real OpenClaw workspace with openclaw-cli runtime.

| Test | Scenario | How to Verify |
|------|----------|---------------|
| UAT-1 | Cold Start Smoke | `npm run verify:merge` — PASS |
| UAT-3 | PainSignalBridge Init in real plugin | Trigger a real pain signal, observe DiagnosticianRunner executes |
| UAT-4 | Runtime Summary shows diagnostician tasks | Run `/pd-status`, verify runtimeDiagnosis count from task-store.db |

UAT-2 (Legacy path removed) and UAT-5 (Full chain pain→ledger) are covered by E2E-01 and E2E-02 in the mocked test.

To run real UAT:
```bash
# Deploy latest plugin
node sync-plugin.mjs

# In real workspace D:\\.openclaw\\workspace
openclaw agent --agent main

# Trigger pain signal (e.g., cause a tool failure)
# Then verify:
sqlite3 .principles/db/task-store.db "SELECT * FROM tasks WHERE task_kind='diagnostician';"
sqlite3 .principles/db/run-store.db "SELECT * FROM principle_candidates;"
cat .principles/ledger/principles.jsonl | grep probation
```
