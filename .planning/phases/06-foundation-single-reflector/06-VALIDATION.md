---
phase: 06
slug: foundation-single-reflector
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-05
---

# Phase 06 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | packages/openclaw-plugin/vitest.config.ts |
| **Quick run command** | `vitest run packages/openclaw-plugin/src/service/subagent-workflow --testNamePattern "nocturnal"` |
| **Full suite command** | `vitest run packages/openclaw-plugin` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run quick command for nocturnal tests
- **After every plan wave:** Run full suite
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | NOC-01 | — | N/A | unit | `vitest run --testNamePattern "NOC-01"` | ✅ W0 | ⬜ pending |
| 06-01-02 | 01 | 1 | NOC-02 | — | N/A | unit | `vitest run --testNamePattern "NOC-02"` | ✅ W0 | ⬜ pending |
| 06-01-03 | 01 | 1 | NOC-03 | — | N/A | unit | `vitest run --testNamePattern "NOC-03"` | ✅ W0 | ⬜ pending |
| 06-01-04 | 01 | 1 | NOC-04 | — | N/A | unit | `vitest run --testNamePattern "NOC-04"` | ✅ W0 | ⬜ pending |
| 06-01-05 | 01 | 1 | NOC-05 | — | N/A | unit | `vitest run --testNamePattern "NOC-05"` | ✅ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.test.ts` — covers NOC-01 through NOC-05
- [ ] `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` — implementation file created
- [ ] Framework install: Existing vitest infrastructure covers all phase requirements

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| WorkflowStore event persistence end-to-end | NOC-03 | Requires full WorkflowStore + runtime integration | Run full vitest suite after all tasks complete |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** {pending / approved YYYY-MM-DD}
