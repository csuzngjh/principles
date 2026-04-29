---
phase: m9-01
slug: PiAiRuntimeAdapter-Core
status: ready
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-29
---

# Phase m9-01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.0 |
| **Config file** | vitest.config.ts (or inline in package.json) |
| **Quick run command** | `cd packages/principles-core && npm test` |
| **Full suite command** | `cd packages/principles-core && npm run test:coverage` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd packages/principles-core && npm test`
- **After every plan wave:** Run `cd packages/principles-core && npm run test:coverage`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| m9-01-01-01 | 01 | 1 | RS-01 | — | N/A | existing | Already verified in runtime-protocol.ts | ✅ | ⬜ pending |
| m9-01-01-02 | 01 | 1 | RS-02 | — | N/A | unit | `vitest run src/runtime-v2/adapter/__tests__/pi-ai-runtime-adapter.test.ts` | ❌ W0 | ⬜ pending |
| m9-01-01-03 | 01 | 1 | AD-01 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |
| m9-01-01-04 | 01 | 1 | AD-02 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |
| m9-01-01-05 | 01 | 1 | AD-03 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |
| m9-01-01-06 | 01 | 1 | AD-04 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |
| m9-01-01-07 | 01 | 1 | AD-05 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |
| m9-01-01-08 | 01 | 1 | AD-06 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |
| m9-01-01-09 | 01 | 1 | AD-07 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |
| m9-01-01-10 | 01 | 1 | AD-08 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |
| m9-01-01-11 | 01 | 1 | AD-09 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |
| m9-01-01-12 | 01 | 1 | AD-10 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |
| m9-01-01-13 | 01 | 1 | AD-11 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |
| m9-01-01-14 | 01 | 1 | AD-12 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |
| m9-01-01-15 | 01 | 1 | AD-13 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |
| m9-01-01-16 | 01 | 1 | AD-14 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |
| m9-01-01-17 | 01 | 1 | AD-15 | — | N/A | unit | Same as above | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts` — main implementation
- [ ] `packages/principles-core/src/runtime-v2/adapter/__tests__/pi-ai-runtime-adapter.test.ts` — unit tests
- [ ] Mock setup for `@mariozechner/pi-ai` (getModel, complete) in test file

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|

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
