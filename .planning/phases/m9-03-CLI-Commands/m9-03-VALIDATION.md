---
phase: m9-03
slug: CLI-Commands
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-29
---

# Phase m9-03 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing in project) |
| **Config file** | `packages/pd-cli/vitest.config.ts` |
| **Quick run command** | `cd packages/pd-cli && npx vitest run` |
| **Full suite command** | `npm run test` (root) |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd packages/pd-cli && npx vitest run`
- **After every plan wave:** Run `npm run test` (full suite)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| m9-03-01-01 | 01 | 1 | CLI-01 | — | N/A | manual | `pd runtime probe --runtime pi-ai` | ❌ W0 | ⬜ pending |
| m9-03-01-02 | 01 | 1 | CLI-02 | — | N/A | manual | `pd diagnose run --runtime pi-ai` | ❌ W0 | ⬜ pending |
| m9-03-01-03 | 01 | 1 | CLI-03 | — | N/A | manual | `pd pain record` | ❌ W0 | ⬜ pending |
| m9-03-01-04 | 01 | 1 | CLI-04 | — | N/A | unit | `npx vitest run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/pd-cli/__tests__/runtime-probe-pi-ai.test.ts` — stubs for CLI-01
- [ ] `packages/pd-cli/__tests__/diagnose-pi-ai.test.ts` — stubs for CLI-02

*Note: Full unit tests (TEST-01~06) are in m9-04. m9-03 focuses on manual CLI verification.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `pd runtime probe --runtime pi-ai` returns healthy | CLI-01 | Requires real LLM API key | Set OPENROUTER_API_KEY, run probe command |
| `pd diagnose run --runtime pi-ai` creates adapter | CLI-02 | Requires real LLM API key | Set OPENROUTER_API_KEY, run diagnose command |
| `pd pain record` uses policy runtime | CLI-03 | Requires workflows.yaml policy | Run pain record, verify runtime selection in telemetry |

*Note: Automated tests for mock success/failure/timeout/invalid-json are in m9-04 (TEST-01~06).*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

---

*Phase: m9-03-CLI-Commands*
*Validation strategy created: 2026-04-29*
