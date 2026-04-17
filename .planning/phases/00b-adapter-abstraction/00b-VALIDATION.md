---
phase: 00b
slug: adapter-abstraction
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-17
---

# Phase 00b — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.1.0 |
| **Config file** | vitest.config.ts (project root) |
| **Quick run command** | `npx vitest run tests/core/pain-signal-adapter.test.ts tests/core/evolution-hook.test.ts tests/core/principle-injector.test.ts tests/core/telemetry-event.test.ts -x` |
| **Full suite command** | `npx vitest run tests/core/ -x` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run quick command
- **After every plan wave:** Run `npx vitest run tests/core/ -x`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 00b-01-01 | 01 | 1 | SDK-ADP-01 | T-00b-01 | validatePainSignal() on adapter output | unit | `npx vitest run tests/core/pain-signal-adapter.test.ts -x` | ❌ W0 | ⬜ pending |
| 00b-01-02 | 01 | 1 | SDK-ADP-02 | T-00b-01 | Returns PainSignal or null, never throws | unit | `npx vitest run tests/core/pain-signal-adapter.test.ts -x` | ❌ W0 | ⬜ pending |
| 00b-02-01 | 02 | 1 | SDK-ADP-05 | — | N/A | unit | `npx vitest run tests/core/evolution-hook.test.ts -x` | ❌ W0 | ⬜ pending |
| 00b-03-01 | 03 | 1 | SDK-ADP-03 | — | N/A | unit | `npx vitest run tests/core/principle-injector.test.ts -x` | ❌ W0 | ⬜ pending |
| 00b-03-02 | 03 | 1 | SDK-ADP-04 | — | N/A | unit | `npx vitest run tests/core/principle-injector.test.ts -x` | ❌ W0 | ⬜ pending |
| 00b-04-01 | 04 | 1 | SDK-OBS-05 | T-00b-02 | Schema does not include PII | unit | `npx vitest run tests/core/telemetry-event.test.ts -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/core/pain-signal-adapter.test.ts` — stubs for SDK-ADP-01, SDK-ADP-02
- [ ] `tests/core/evolution-hook.test.ts` — stubs for SDK-ADP-05
- [ ] `tests/core/principle-injector.test.ts` — stubs for SDK-ADP-03, SDK-ADP-04
- [ ] `tests/core/telemetry-event.test.ts` — stubs for SDK-OBS-05

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| None | — | — | All phase behaviors have automated verification. |

---

## Validation Sign-Off

- [x] All tasks have automated verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
