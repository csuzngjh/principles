---
phase: 24
slug: queue-store-extraction
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-11
---

# Phase 24 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.x |
| **Config file** | packages/openclaw-plugin/vitest.config.ts |
| **Quick run command** | `npx vitest run --reporter=verbose packages/openclaw-plugin/src/service/__tests__/evolution-queue-store.test.ts` |
| **Full suite command** | `npx vitest run --reporter=verbose packages/openclaw-plugin/src/service/__tests__/` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run quick command (queue store tests only)
- **After every plan wave:** Run full suite command (all service tests)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 24-01-01 | 01 | 1 | DECOMP-01 | — | N/A | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 24-02-01 | 02 | 1 | CONTRACT-01 | T-24-01 | Reject malformed items | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 24-02-02 | 02 | 1 | CONTRACT-02 | T-24-02 | Flag corrupted reads | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 24-03-01 | 03 | 2 | CONTRACT-06 | — | Lock encapsulation | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 24-04-01 | 04 | 2 | DECOMP-01 | — | N/A | integration | `npx vitest run` | ❌ W0 | ⬜ pending |
| 24-05-01 | 05 | 3 | DECOMP-01 | — | N/A | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 24-06-01 | 06 | 3 | DECOMP-01 | — | N/A | unit+existing | `npx vitest run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/openclaw-plugin/src/service/__tests__/evolution-queue-store.test.ts` — test stubs for queue store
- [ ] Existing test file `evolution-worker.test.ts` covers integration (462 lines, 6 import targets)

*Existing infrastructure covers most requirements. Wave 0 adds new test file for extracted module.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| None | — | — | — |

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
