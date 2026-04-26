---
phase: m6-05
slug: Telemetry-Events
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-24
---

# Phase m6-05 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | packages/pd-cli/package.json (vitest section) |
| **Quick run command** | `cd packages/pd-cli && npx vitest run --reporter=verbose` |
| **Full suite command** | `cd packages/principles-core && npx vitest run --reporter=verbose` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run quick suite
- **After every plan wave:** Run full suite
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| m6-05-01-01 | 01 | 1 | TELE-01~04 event types added to TelemetryEventType | grep | `grep "runtime_adapter_selected" telemetry-event.ts` | ✅ | ⬜ pending |
| m6-05-01-02 | 01 | 1 | OCRA eventEmitter DI | grep | `grep "eventEmitter" openclaw-cli-runtime-adapter.ts` | ✅ | ⬜ pending |
| m6-05-02-01 | 02 | 2 | TELE-01 in handleDiagnoseRun | grep | `grep "runtime_adapter_selected" diagnose.ts` | ✅ | ⬜ pending |
| m6-05-02-02 | 02 | 2 | TELE-04 in DiagnosticianRunner | grep | `grep "output_validation_succeeded\|output_validation_failed" diagnostician-runner.ts` | ✅ | ⬜ pending |
| m6-05-03-01 | 03 | 2 | TELE-02/03 in OCRA.startRun | grep | `grep "runtime_invocation_started\|runtime_invocation_succeeded" openclaw-cli-runtime-adapter.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/principles-core/src/runtime-v2/runner/__tests__/diagnostician-telemetry.test.ts` — existing telemetry test patterns
- [ ] `packages/pd-cli/tests/commands/diagnose.test.ts` — existing CLI routing tests

*Existing infrastructure covers all phase requirements (Vitest already configured).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| TELE-02 fires before diagnostician_run_started | TELE-02, CONTEXT.D-01 | Requires integration test with mock emitter to verify event order | Run full suite, grep output for both event types |
| Event payload fields correct | TELE-01~04 | Payload structure verified via grep + type-check | `npx tsc --noEmit` passes |

*All phase behaviors have automated or type-check verification.*

---

## Validation Sign-Off

- [x] All tasks have automated verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** {pending / approved YYYY-MM-DD}
