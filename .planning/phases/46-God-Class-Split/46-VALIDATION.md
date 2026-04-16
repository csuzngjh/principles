---
phase: 46
slug: god-class-split
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-15
---

# Phase 46 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (from Phase 45 existing tests) |
| **Config file** | `packages/openclaw-plugin/vitest.config.ts` |
| **Quick run command** | `npm test -- --filter "queue-migration|workflow-watchdog|queue-io|sleep-cycle" --run` |
| **Full suite command** | `npm test -- --filter "evolution-worker" --run` |
| **Estimated runtime** | ~60 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- --filter "evolution-worker" --run`
- **After every plan wave:** Full suite
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 46-01-01 | 46-01 | 1 | SPLIT-01 | — | N/A (code extraction) | unit | `npm test -- --filter queue-migration --run` | ✅ W0 | ⬜ pending |
| 46-02-01 | 46-02 | 2 | SPLIT-02, BUG-01, BUG-02, BUG-03 | — | N/A (code extraction + bug fix) | unit | `npm test -- --filter workflow-watchdog --run` | ✅ W0 | ⬜ pending |
| 46-03-01 | 46-03 | 3 | SPLIT-03, SPLIT-04 | — | N/A (code extraction) | unit | `npm test -- --filter queue-io --run` | ✅ W0 | ⬜ pending |
| 46-04-01 | 46-04 | 4 | SPLIT-05 | — | N/A (code extraction) | unit | `npm test -- --filter sleep-cycle --run` | ✅ W0 | ⬜ pending |
| 46-05-01 | 46-05 | 5 | SPLIT-06 | — | N/A (facade/re-export) | verify | `npm run build -- --filter openclaw-plugin` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/openclaw-plugin/tests/service/queue-migration.test.ts` — stubs for SPLIT-01 verification
- [ ] `packages/openclaw-plugin/tests/service/workflow-watchdog.test.ts` — stubs for SPLIT-02 + BUG-01/02/03 verification
- [ ] `packages/openclaw-plugin/tests/service/queue-io.test.ts` — stubs for SPLIT-03/04 verification
- [ ] `packages/openclaw-plugin/tests/service/sleep-cycle.test.ts` — stubs for SPLIT-05 verification

*Phase 45 tests serve as validation baseline: `evolution-worker.queue.test.ts`, `queue-purge.test.ts`, `async-lock.test.ts`.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Verify all imports from `evolution-worker.ts` still resolve post-facade | SPLIT-06 | Requires compilation of all downstream consumers | `npm run build` must succeed with no import errors |
| Verify nocturnal-runtime.js does not transitively import evolution-worker.ts | SPLIT-05 | Circular dependency check | `node -e "require('./nocturnal-runtime')"` in openclaw-plugin context |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
