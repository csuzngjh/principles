---
phase: m9-02
slug: Policy-Factory-Integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-29
---

# Phase m9-02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.0 |
| **Config file** | vitest.config.ts (packages/principles-core) |
| **Quick run command** | `cd packages/principles-core && npm test` |
| **Full suite command** | `cd packages/principles-core && npm run test:coverage` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd packages/principles-core && npm test`
- **After every plan wave:** Run `cd packages/principles-core && npm run test:coverage`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| m9-02-01-01 | 01 | 1 | PL-01, PL-02, PL-03 | unit | `vitest run src/workflow-funnel-loader.test.ts` | ❌ W0 | ⬜ pending |
| m9-02-01-02 | 01 | 1 | FC-01, FC-02, FC-03, FC-04 | unit | `vitest run src/runtime-v2/__tests__/pain-signal-runtime-factory.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/principles-core/src/workflow-funnel-loader.test.ts` — FunnelPolicy extension tests (new fields parsed correctly)
- [ ] `packages/principles-core/src/runtime-v2/__tests__/pain-signal-runtime-factory.test.ts` — Factory runtime selection tests

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| workflows.yaml policy with all runtime fields | PL-01 | Requires real YAML file on disk | Update .state/workflows.yaml with runtime config, verify factory reads correctly |
| D-05 breaking change error message | FC-01 | Error message quality is subjective | Run with only timeoutMs configured, verify error message lists missing fields and migration guidance |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
