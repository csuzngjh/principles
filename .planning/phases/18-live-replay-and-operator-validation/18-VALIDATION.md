---
phase: 18
slug: live-replay-and-operator-validation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-10
---

# Phase 18 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js child_process (TypeScript) |
| **Config file** | scripts/validate-live-path.ts |
| **Quick run command** | `npx tsx scripts/validate-live-path.ts` |
| **Full suite command** | `npx tsx scripts/validate-live-path.ts --verbose` |
| **Estimated runtime** | ~60 seconds (5-min poll timeout with 10s interval) |

---

## Sampling Rate

- **After every task commit:** Run `npx tsx scripts/validate-live-path.ts`
- **After every plan wave:** Full script run with verbose output
- **Before `/gsd-verify-work`:** Script must exit code 0
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 18-01-01 | 01 | 1 | LIVE-01 | — | N/A | e2e script | `npx tsx scripts/validate-live-path.ts` | ✅ | ⬜ pending |
| 18-02-01 | 02 | 1 | LIVE-03 | — | N/A | e2e script | `npx tsx scripts/validate-live-path.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `scripts/validate-live-path.ts` — validation script (Task 2 of Plan 2)
- [ ] `scripts/` directory — tsx runner dependency in package.json

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live workflow completion (state='completed') | LIVE-01 | Requires actual workflow store + queue processing | Run `npx tsx scripts/validate-live-path.ts` and inspect output |
| Stub rule evaluation succeeds | LIVE-01 | Stub rules return 'allow (stub)' — expected behavior, path-only verification | Same script covers this |

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
