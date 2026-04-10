---
phase: 17
slug: minimal-rule-bootstrap
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-10
updated: 2026-04-10
---

# Phase 17 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.0 |
| **Config file** | packages/openclaw-plugin/vitest.config.ts |
| **Quick run command** | `cd packages/openclaw-plugin && npx vitest run tests/core/bootstrap-rules.test.ts` |
| **Full suite command** | `cd packages/openclaw-plugin && npm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd packages/openclaw-plugin && npx vitest run tests/core/bootstrap-rules.test.ts`
- **After every plan wave:** Run `cd packages/openclaw-plugin && npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 17-01-01 | 01 | 1 | BOOT-01 | T-17-01 | selectPrinciplesForBootstrap returns deterministic principles with violations | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/bootstrap-rules.test.ts -t "selectPrinciples"` | ✅ W0 | ⬜ pending |
| 17-01-01 | 01 | 1 | BOOT-02 | T-17-02 | createRule() called with valid stub rule data | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/bootstrap-rules.test.ts -t "createRule"` | ✅ W0 | ⬜ pending |
| 17-01-01 | 01 | 1 | BOOT-03 | T-17-03 | bootstrap limited to 1-3 principles only | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/bootstrap-rules.test.ts -t "bootstrap limit"` | ✅ W0 | ⬜ pending |
| 17-01-02 | 01 | 1 | BOOT-01, BOOT-02 | — | CLI script creates rules and updates ledger | integration | `cd packages/openclaw-plugin && npx vitest run tests/core/bootstrap-rules.test.ts -t "CLI"` | ✅ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `tests/core/bootstrap-rules.test.ts` — test file created with TDD workflow
- [x] `packages/openclaw-plugin/src/core/bootstrap-rules.ts` — bootstrap implementation (created during TDD cycle)
- [x] Framework install: Already available (vitest 4.1.0 in package.json)

**Note:** This plan uses TDD methodology (type: tdd), which means tests are created first in the RED phase, then implementation follows in GREEN phase. Wave 0 is satisfied by the TDD workflow itself.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Bootstrap script idempotency | BOOT-03 | Requires state file inspection | Run `npm run bootstrap-rules` twice, verify principle_training_state.json shows duplicate rule IDs not created |
| Rule-principle linkage | BOOT-02 | Requires state file inspection | Run bootstrap, verify `principle.suggestedRules` array contains `ruleId` references |

---

## Threat Model References

| Ref | Threat | Mitigation |
|-----|--------|------------|
| T-17-01 | Principle selection bypass | selectPrinciplesForBootstrap filters by evaluability + violation count |
| T-17-02 | Invalid rule creation | createRule() validates rule structure before persistence |
| T-17-03 | Unbounded bootstrap | Bootstrap limited to 1-3 principles per CONTEXT.md decision |
| T-17-04 | Ledger corruption | mutateLedger() uses file-locking for transactional safety |
| T-17-05 | Principle overwrite | updatePrinciple() merges with existing data, doesn't replace |
| T-17-06 | Stub rule bypass | Stub rules explicitly marked with diagnostic "stub: bootstrap placeholder" |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 10s
- [x] `nyquist_compliant: true` set in frontmatter
- [x] `wave_0_complete: true` set in frontmatter (TDD workflow satisfies this)

**Approval:** pending
