---
phase: 7
slug: trinity-integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-05
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `packages/openclaw-plugin/vitest.config.ts` |
| **Quick run command** | `cd packages/openclaw-plugin && npx vitest run tests/service/nocturnal-workflow-manager.test.ts` |
| **Full suite command** | `cd packages/openclaw-plugin && npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `vitest run tests/service/nocturnal-workflow-manager.test.ts`
- **After every plan wave:** Run `npx vitest run` (full suite)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 7-01-01 | 01 | 1 | NOC-06 | — | N/A | unit | `vitest run -t "NOC-06"` | ✅ | ⬜ pending |
| 7-01-02 | 01 | 1 | NOC-07 | — | N/A | unit | `vitest run -t "NOC-07"` | ⚠️ partial | ⬜ pending |
| 7-01-03 | 01 | 1 | NOC-08 | — | N/A | unit | `vitest run -t "NOC-08"` | ❌ | ⬜ pending |
| 7-01-04 | 01 | 1 | NOC-09 | — | N/A | unit | `vitest run -t "NOC-09"` | ❌ | ⬜ pending |
| 7-01-05 | 01 | 1 | NOC-10 | — | N/A | unit | `vitest run -t "NOC-10"` | ❌ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/service/nocturnal-workflow-manager.test.ts` — Add tests for NOC-07 (mock `runTrinityAsync`), NOC-08 (stage event recording), NOC-09 (failure handling), NOC-10 (state transitions)
- [ ] `tests/core/nocturnal-trinity.test.ts` — Already exists, covers `runTrinityAsync` behavior

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Async fire-and-forget behavior (state='active' returned immediately) | NOC-07 | Requires real async timing verification | Run workflow, verify handle returned before Trinity chain completes |
| Full Trinity chain end-to-end | NOC-07, NOC-08 | Requires live subagent execution | Manual integration test with real OpenClaw |

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
