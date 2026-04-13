---
phase: 35
slug: dreamer-enhancement
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-13
---

# Phase 35 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) |
| **Config file** | `packages/openclaw-plugin/vitest.config.ts` |
| **Quick run command** | `cd packages/openclaw-plugin && npx vitest run tests/core/nocturnal-candidate-scoring.test.ts tests/core/nocturnal-trinity.test.ts --reporter=verbose` |
| **Full suite command** | `cd packages/openclaw-plugin && npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd packages/openclaw-plugin && npx vitest run tests/core/nocturnal-candidate-scoring.test.ts tests/core/nocturnal-trinity.test.ts --reporter=verbose`
- **After every plan wave:** Run `cd packages/openclaw-plugin && npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 35-01-01 | 01 | 1 | DIVER-01, DIVER-02 | — | N/A | unit | `npx vitest run tests/core/nocturnal-trinity.test.ts -t "strategic perspective"` | ❌ W0 | ⬜ pending |
| 35-01-02 | 01 | 1 | DERIV-04 | — | N/A | unit | `npx vitest run tests/core/nocturnal-trinity.test.ts -t "reasoning context"` | ❌ W0 | ⬜ pending |
| 35-02-01 | 02 | 2 | DIVER-03 | — | N/A | unit | `npx vitest run tests/core/nocturnal-candidate-scoring.test.ts -t "validateCandidateDiversity"` | ❌ W0 | ⬜ pending |
| 35-02-02 | 02 | 2 | DIVER-04, DIVER-01 | — | N/A | unit | `npx vitest run tests/core/nocturnal-trinity.test.ts -t "diversity telemetry"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/core/nocturnal-candidate-scoring.test.ts` — add `validateCandidateDiversity` test suite (risk diversity, keyword overlap, soft enforcement)
- [ ] `tests/core/nocturnal-trinity.test.ts` — add tests for: prompt contains strategic perspectives, DreamerCandidate with new fields, stub candidates have riskLevel + strategicPerspective, buildDreamerPrompt includes Reasoning Context section, diversity telemetry emission

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| LLM Dreamer prompt response quality | DIVER-01 | Requires live LLM to verify strategic perspective compliance | Run nocturnal pipeline with live Dreamer, inspect candidate perspectives |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
