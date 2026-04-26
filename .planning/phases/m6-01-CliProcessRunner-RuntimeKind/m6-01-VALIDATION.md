---
phase: m6-01
slug: CliProcessRunner-RuntimeKind
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-24
---

# Phase m6-01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (existing test infrastructure in `packages/principles-core`) |
| **Config file** | `packages/principles-core/vitest.config.ts` (existing) |
| **Quick run command** | `cd packages/principles-core && npx vitest run src/runtime-v2/utils/cli-process-runner.test.ts src/runtime-v2/runtime-protocol.test.ts --reporter=basic` |
| **Full suite command** | `cd packages/principles-core && npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** `vitest run src/runtime-v2/utils/cli-process-runner.test.ts --reporter=basic`
- **After every plan wave:** `npx vitest run` (full suite)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------------|-----------|-------------------|-------------|--------|
| m6-01-01-01 | 01 | 1 | RUNR-01 | No shell injection (array args) | unit | `vitest run cli-process-runner.test.ts` | CREATED | ⬜ pending |
| m6-01-01-02 | 01 | 1 | RUNR-02, RUNR-03, RUNR-04 | Graceful tree kill (SIGTERM→SIGKILL) | unit | `vitest run cli-process-runner.test.ts` | CREATED | ⬜ pending |
| m6-01-02-01 | 02 | 1 | RUK-01, RUK-02 | N/A (schema) | unit | `vitest run runtime-protocol.test.ts` | CREATED | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/principles-core/src/runtime-v2/utils/cli-process-runner.ts` — main implementation (RUNR-01~04)
- [ ] `packages/principles-core/src/runtime-v2/utils/cli-process-runner.test.ts` — unit tests (RUNR-01~04)
- [ ] `packages/principles-core/src/runtime-v2/runtime-protocol.test.ts` — RuntimeKindSchema tests (RUK-01, RUK-02)

*If none: "Existing test infrastructure (Vitest + existing test patterns) covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Windows process group kill behavior | RUNR-02 (SIGTERM→SIGKILL) | Requires Windows CI environment | Run `taskkill /PID <pid> /T` vs `kill(-pid, 'SIGTERM')` on Windows |
| Cross-platform detached process exit | RUNR-02 | Platform-specific | Verify graceful termination on Windows vs Unix |

*If none: "All phase behaviors have automated verification via unit tests."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending