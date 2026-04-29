---
phase: m9-04
slug: Tests
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-29
---

# Phase m9-04 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.0 |
| **Config file** | packages/principles-core/vitest.config.ts |
| **Quick run command** | `cd packages/principles-core && pnpm vitest run --dir src/runtime-v2/runner/__tests__ --testNamePattern "m9-"` |
| **Full suite command** | `cd packages/principles-core && pnpm vitest run src/runtime-v2/runner/__tests__/m9-*.test.ts` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run quick run command for affected test file
- **After every plan wave:** Run full suite command
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| m9-04-01-01 | m9-04-01 | 1 | TEST-06 | — | N/A (test infrastructure) | e2e | `pnpm vitest run src/runtime-v2/runner/__tests__/m9-adapter-integration.test.ts` | ✅ W0 | ⬜ pending |
| m9-04-02-01 | m9-04-02 | 2 | TEST-06 | — | N/A (test infrastructure) | e2e | `pnpm vitest run src/runtime-v2/runner/__tests__/m9-e2e.test.ts` | ✅ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/principles-core/src/runtime-v2/runner/__tests__/m9-adapter-integration.test.ts` — stub for m9-04-01
- [ ] `packages/principles-core/src/runtime-v2/runner/__tests__/m9-e2e.test.ts` — stub for m9-04-02

*Wave 0 stubs are created by the executor before real implementation per plan tasks.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| None | TEST-01~05 | Already covered by existing unit tests (pi-ai-runtime-adapter.test.ts, 727 lines) | Run: `pnpm vitest run src/runtime-v2/adapter/__tests__/pi-ai-runtime-adapter.test.ts` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
