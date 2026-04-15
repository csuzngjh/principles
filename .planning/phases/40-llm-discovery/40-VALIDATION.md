---
phase: 40
slug: llm-discovery
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
| **Framework** | vitest |
| **Config file** | packages/openclaw-plugin/vitest.config.ts |
| **Quick run command** | `cd packages/openclaw-plugin && npx vitest run tests/core/correction-cue-learner.test.ts` |
| **Full suite command** | `cd packages/openclaw-plugin && npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd packages/openclaw-plugin && npx vitest run tests/core/correction-cue-learner.test.ts`
- **After every plan wave:** Run `cd packages/openclaw-plugin && npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 40-01-01 | 01 | 1 | CORR-12 | — | trajectoryHistory only contains correctionDetected turns | build | `cd packages/openclaw-plugin && npx tsc --noEmit -p tsconfig.json` | ❌ W0 | ⬜ pending |
| 40-01-02 | 01 | 1 | CORR-09 | T-40-01 | Only add/update/remove actions accepted; invalid actions skipped | unit | `cd packages/openclaw-plugin && npx vitest run tests/service/keyword-optimization-service.test.ts` | ❌ W0 | ⬜ pending |
| 40-01-03 | 01 | 1 | CORR-09 | — | updateWeight() and remove() mutate store and flush to disk | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/correction-cue-learner.test.ts` | ✅ | ⬜ pending |
| 40-01-04 | 01 | 1 | CORR-09 | T-40-02 | keyword_optimization task type present in evolution-worker.ts | build | `cd packages/openclaw-plugin && npx tsc --noEmit -p tsconfig.json && grep -q "keyword_optimization" packages/openclaw-plugin/src/service/evolution-worker.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/openclaw-plugin/tests/service/keyword-optimization-service.test.ts` — unit tests for applyResult() (ADD/UPDATE/REMOVE), updateWeight() clamp, remove() not-found throw
- [ ] `packages/openclaw-plugin/tests/core/correction-cue-learner.test.ts` — extend existing tests with updateWeight() and remove() coverage

*Existing vitest infrastructure covers the framework requirement.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| evolution-worker heartbeat triggers keyword_optimization every 6h | CORR-07 | Requires real-time clock or mock; heartbeat loop not unit-testable | Start worker, wait for `keyword_optimization` log line after period_heartbeats cycles |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
