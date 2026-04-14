---
phase: 40
slug: failure-classification-cooldown-recovery
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-14
---

# Phase 40 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.4 |
| **Config file** | packages/openclaw-plugin/vitest.config.ts |
| **Quick run command** | `npx vitest run tests/service/failure-classifier.test.ts tests/service/cooldown-strategy.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/service/failure-classifier.test.ts tests/service/cooldown-strategy.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 40-01-01 | 01 | 1 | SC-1, SC-3 | T-40-01 | TaskKind validated against known string values | unit | `npx vitest run tests/service/failure-classifier.test.ts` | W0 | pending |
| 40-01-02 | 01 | 1 | SC-4 | — | Counter resets on success | unit | `npx vitest run tests/service/failure-classifier.test.ts` | W0 | pending |
| 40-02-01 | 02 | 1 | SC-2 | T-40-02 | Escalation tier clamped to [0,3] | unit | `npx vitest run tests/service/cooldown-strategy.test.ts` | W0 | pending |
| 40-02-02 | 02 | 1 | SC-5, SC-6 | T-40-03 | State file in workspace-controlled directory | unit | `npx vitest run tests/service/cooldown-strategy.test.ts` | W0 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `packages/openclaw-plugin/tests/service/failure-classifier.test.ts` — stubs for SC-1, SC-3, SC-4
- [ ] `packages/openclaw-plugin/tests/service/cooldown-strategy.test.ts` — stubs for SC-2, SC-5, SC-6
- [ ] `packages/openclaw-plugin/src/service/failure-classifier.ts` — NEW: failure classification module
- [ ] `packages/openclaw-plugin/src/service/cooldown-strategy.ts` — NEW: cooldown escalation module

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| None | — | — | — |

All phase behaviors have automated verification.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
