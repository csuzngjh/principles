---
phase: 02
slug: workflow-watchdog
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-19
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (existing in project) |
| **Config file** | `vitest.config.ts` in package root |
| **Quick run command** | `npx vitest run tests/core/event-log.test.ts --reporter=dot` |
| **Full suite command** | `npm run test` |
| **Estimated runtime** | ~30 seconds (full suite) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/core/event-log.test.ts --reporter=dot`
- **After every plan wave:** Run `npm run test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 02-01 | 0 | PD-FUNNEL-2.1 | T-02-01 | YAML loaded via js-yaml schema (safe load) | unit | `npx vitest run tests/core/workflow-funnel-loader.test.ts` | ❌ W0 | ⬜ pending |
| 02-01-02 | 02-01 | 0 | PD-FUNNEL-2.2 | T-02-02 | fs.watch() handles hot reload without crashing | unit | `npx vitest run tests/core/workflow-funnel-loader.test.ts` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02-02 | 0 | PD-FUNNEL-2.1 | — | N/A | type | `npx tsc --noEmit --pretty false` | ✅ | ⬜ pending |
| 02-03-01 | 02-03 | 1 | PD-FUNNEL-2.3 | — | N/A | unit | `grep -c "recordNocturnalDreamerCompleted" src/core/event-log.ts` | ✅ | ⬜ pending |
| 02-03-02 | 02-03 | 1 | PD-FUNNEL-2.3 | — | N/A | unit | `grep -c "recordRuleHostBlocked" src/core/event-log.ts` | ✅ | ⬜ pending |
| 02-04-01 | 02-04 | 1 | PD-FUNNEL-2.3 | — | N/A | unit | `grep -c "recordNocturnalDreamerCompleted" src/service/subagent-workflow/nocturnal-workflow-manager.ts` | ✅ | ⬜ pending |
| 02-04-02 | 02-04 | 1 | PD-FUNNEL-2.3 | — | N/A | unit | `grep -c "recordNocturnalArtifactPersisted" src/service/nocturnal-service.ts` | ✅ | ⬜ pending |
| 02-04-03 | 02-04 | 1 | PD-FUNNEL-2.3 | — | N/A | unit | `grep -c "recordNocturnalCodeCandidateCreated" src/service/nocturnal-service.ts` | ✅ | ⬜ pending |
| 02-05-01 | 02-05 | 1 | PD-FUNNEL-2.4 | — | N/A | unit | `grep -c "recordRuleHostEvaluated" src/hooks/gate.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/core/workflow-funnel-loader.test.ts` — unit tests for YAML loading and hot reload (PD-FUNNEL-2.1, PD-FUNNEL-2.2)
- [ ] `tests/hooks/gate.test.ts` — rulehost event emission tests (PD-FUNNEL-2.4)
- [ ] `npm install js-yaml@4.1.1` — if not already present in package.json

*Existing test infrastructure covers event-log.ts modifications (02-03).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Nocturnal `nocturnal_dreamer_completed` event fires after Trinity chain completes | PD-FUNNEL-2.3 | Requires full NocturnalWorkflowManager execution with Trinity chain | Trigger `/pd-nocturnal` and observe JSONL output for `type: "nocturnal_dreamer_completed"` |
| Hot reload picks up YAML changes without process restart | PD-FUNNEL-2.2 | fs.watch() behavior on Windows | Edit `.state/workflows.yaml` and observe EventLog output within 1s |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
