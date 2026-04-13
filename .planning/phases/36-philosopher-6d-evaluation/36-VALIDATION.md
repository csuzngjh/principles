---
phase: 36
slug: philosopher-6d-evaluation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-13
---

# Phase 36 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `packages/openclaw-plugin/vitest.config.ts` |
| **Quick run command** | `npx vitest run packages/openclaw-plugin/tests/core/nocturnal-trinity.test.ts` |
| **Full suite command** | `npx vitest run packages/openclaw-plugin/tests/` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run packages/openclaw-plugin/tests/core/nocturnal-trinity.test.ts`
- **After every plan wave:** Run `npx vitest run packages/openclaw-plugin/tests/`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 36-01-01 | 01 | 1 | PHILO-01 | — | N/A | unit | `vitest run nocturnal-trinity.test.ts` | ❌ W0 | ⬜ pending |
| 36-01-02 | 01 | 1 | PHILO-01 | — | N/A | unit | `vitest run nocturnal-trinity.test.ts` | ❌ W0 | ⬜ pending |
| 36-01-03 | 01 | 1 | PHILO-03 | — | N/A | unit | `vitest run nocturnal-trinity.test.ts` | ❌ W0 | ⬜ pending |
| 36-02-01 | 02 | 1 | PHILO-02 | — | N/A | unit | `vitest run nocturnal-trinity.test.ts` | ❌ W0 | ⬜ pending |
| 36-02-02 | 02 | 1 | PHILO-02 | — | N/A | unit | `vitest run nocturnal-trinity.test.ts` | ❌ W0 | ⬜ pending |
| 36-02-03 | 02 | 1 | PHILO-03 | — | N/A | unit | `vitest run nocturnal-trinity.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/openclaw-plugin/tests/core/nocturnal-trinity.test.ts` — stubs for PHILO-01, PHILO-02, PHILO-03

*Existing infrastructure covers all phase requirements — just need new test cases in existing test file.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| LLM prompt quality (6D evaluation produces meaningful scores) | PHILO-01 | Requires real LLM call | Run nocturnal pipeline with real adapter, inspect Philosopher output for 6D scores |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
