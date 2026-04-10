---
phase: 9
slug: basic-monitoring-backend
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-10
---

# Phase 9 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.0 |
| **Config file** | packages/openclaw-plugin/vitest.config.ts |
| **Quick run command** | `npm test -- tests/service/monitoring-query-service.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- tests/service/monitoring-query-service.test.ts`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 09-01-01 | 01 | 1 | WF-01 | T-09-01 | getWorkflows() returns filtered workflow list | unit | `npm test -- tests/service/monitoring-query-service.test.ts -t "getWorkflows"` | ❌ W0 | ⬜ pending |
| 09-01-02 | 01 | 1 | WF-03 | T-09-02 | Stuck workflows detected and marked | unit | `npm test -- tests/service/monitoring-query-service.test.ts -t "stuck detection"` | ❌ W0 | ⬜ pending |
| 09-01-03 | 01 | 1 | TRIN-01 | T-09-03 | getTrinityStatus() returns 3-stage states | unit | `npm test -- tests/service/monitoring-query-service.test.ts -t "getTrinityStatus"` | ❌ W0 | ⬜ pending |
| 09-01-04 | 01 | 1 | TRIN-02 | T-09-04 | getTrinityHealth() returns aggregate metrics | unit | `npm test -- tests/service/monitoring-query-service.test.ts -t "getTrinityHealth"` | ❌ W0 | ⬜ pending |
| 09-02-01 | 02 | 2 | WF-01, WF-03, TRIN-01, TRIN-02 | T-09-01 | API endpoints protected by validateGatewayAuth() | integration | `grep -q "validateGatewayAuth" packages/openclaw-plugin/src/http/principles-console-route.ts` | ✅ | ⬜ pending |
| 09-02-02 | 02 | 2 | WF-01 | T-09-05 | /api/monitoring/workflows returns 200 on success | integration | `npm test -- tests/integration/monitoring-api.test.ts -t "GET /api/monitoring/workflows"` | ❌ W0 | ⬜ pending |
| 09-02-03 | 02 | 2 | TRIN-01 | T-09-06 | /api/monitoring/trinity returns Trinity status | integration | `npm test -- tests/integration/monitoring-api.test.ts -t "GET /api/monitoring/trinity"` | ❌ W0 | ⬜ pending |
| 09-02-04 | 02 | 2 | TRIN-02 | T-09-07 | /api/monitoring/trinity/health returns health metrics | integration | `npm test -- tests/integration/monitoring-api.test.ts -t "GET /api/monitoring/trinity/health"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/service/monitoring-query-service.test.ts` — stubs for WF-01, WF-03, TRIN-01, TRIN-02
- [ ] `tests/integration/monitoring-api.test.ts` — API endpoint integration tests
- [ ] `tests/fixtures/workflow-store.ts` — WorkflowStore mock/stub fixtures
- [ ] Framework install: Already available (vitest 4.1.0 in package.json)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| API response time under load | WF-01, TRIN-01 | Requires load testing environment | Run `npm run load-test` with 100 concurrent requests, verify P95 < 500ms |
| Database connection cleanup | WF-03 | Requires observing file descriptors | Run 100 workflow queries, check `lsof -p $$ | grep sqlite3` count doesn't increase |

*If none: "All phase behaviors have automated verification."*

---

## Threat Model References

| Ref | Threat | Mitigation |
|-----|--------|------------|
| T-09-01 | Unauthenticated workflow listing | validateGatewayAuth() required on all endpoints |
| T-09-02 | SQL injection via filters | Parameterized queries via WorkflowStore |
| T-09-03 | Information disclosure via errors | Sanitized error responses via json() helper |
| T-09-04 | Missing auth on Trinity endpoints | validateGatewayAuth() called before all monitoring routes |
| T-09-05 | Stuck detection bypass | Use Date.now() - created_at > timeoutMs (not last_observed_at) |
| T-09-06 | Trinity state manipulation | Read-only queries, no state modification |
| T-09-07 | Health metrics exposure | Workspace-scoped data, gateway auth required |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
