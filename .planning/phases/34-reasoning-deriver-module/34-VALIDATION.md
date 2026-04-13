---
phase: 34
slug: reasoning-deriver-module
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-12
---

# Phase 34 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^4.1.0 |
| **Config file** | `packages/openclaw-plugin/vitest.config.ts` |
| **Quick run command** | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 34-01-01 | 01 | 1 | DERIV-01 | — | N/A | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "deriveReasoningChain"` | W0 | pending |
| 34-01-02 | 01 | 1 | DERIV-01 | — | N/A | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "no thinking tags"` | W0 | pending |
| 34-01-03 | 01 | 1 | DERIV-01 | — | N/A | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "empty input"` | W0 | pending |
| 34-02-01 | 02 | 1 | DERIV-02 | — | N/A | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "deriveDecisionPoints"` | W0 | pending |
| 34-02-02 | 02 | 1 | DERIV-02 | — | N/A | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "afterReflection"` | W0 | pending |
| 34-02-03 | 02 | 1 | DERIV-03 | — | N/A | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "deriveContextualFactors"` | W0 | pending |
| 34-02-04 | 02 | 1 | DERIV-03 | — | N/A | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "fileStructureKnown"` | W0 | pending |
| 34-02-05 | 02 | 1 | DERIV-03 | — | N/A | unit | `npx vitest run tests/core/nocturnal-reasoning-deriver.test.ts -t "timePressure"` | W0 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `packages/openclaw-plugin/tests/core/nocturnal-reasoning-deriver.test.ts` — stubs for DERIV-01, DERIV-02, DERIV-03
- [ ] No framework install needed — vitest already configured

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
