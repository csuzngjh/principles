---
phase: m7-01
slug: candidate-intake-contract
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-26
---

# Phase m7-01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.0 |
| **Config file** | `packages/principles-core/vitest.config.ts` |
| **Quick run command** | `npx vitest run tests/candidate-intake.test.ts` |
| **Full suite command** | `npx vitest run` (from packages/principles-core) |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run tests/candidate-intake.test.ts`
- **After every plan wave:** Run `npx vitest run` (full suite in principles-core)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| m7-01-01-01 | 01 | 1 | INTAKE-01~04 | — | N/A (contract layer) | unit | `npx vitest run tests/candidate-intake.test.ts` | ❌ W0 | ⬜ pending |
| m7-01-01-02 | 01 | 1 | INTAKE-01~04 | — | N/A (contract layer) | unit | `npx vitest run tests/candidate-intake.test.ts` | ❌ W0 | ⬜ pending |
| m7-01-02-01 | 02 | 2 | LEDGER-01 | — | N/A (contract layer) | unit | `npx vitest run tests/candidate-intake.test.ts` | ❌ W0 | ⬜ pending |
| m7-01-02-02 | 02 | 2 | LEDGER-01 | — | N/A (contract layer) | unit | `npx vitest run tests/candidate-intake.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/candidate-intake.test.ts` — stubs for all 5 requirements (INTAKE-01 through LEDGER-01)
- [ ] Framework already installed: vitest 4.1.0 present in devDependencies
- [ ] Vitest config already includes `src/runtime-v2/**/*.test.ts` in `include` array

---

## Manual-Only Verifications

None — all phase behaviors have automated verification.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
