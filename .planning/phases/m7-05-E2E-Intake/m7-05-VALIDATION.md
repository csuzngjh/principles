---
phase: m7-05-E2E-Intake
slug: m7-05-E2E-Intake
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-27
---

# Phase m7-05 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `packages/pd-cli/vitest.config.ts` |
| **Quick run command** | `cd packages/pd-cli && npm run test -- --run tests/e2e/candidate-intake-e2e.test.ts` |
| **Full suite command** | `cd packages/pd-cli && npm run test -- --run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run quick run command
- **After every plan wave:** Run full suite command
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Validation Architecture

### Dimension 1: Requirements Coverage (E2E-INTAKE-01~04)
Every requirement maps to a test:

| Requirement | Test | File |
|-------------|------|------|
| E2E-INTAKE-01 (Happy path) | Test 1: pending → intake → consumed + ledgerEntryId | candidate-intake-e2e.test.ts |
| E2E-INTAKE-02 (CLI list) | Test 4: `pd candidate list --task-id` shows consumed | candidate-intake-e2e.test.ts |
| E2E-INTAKE-03 (Idempotency) | Test 3: intake twice → one ledger entry | candidate-intake-e2e.test.ts |
| E2E-INTAKE-04 (Traceability) | Test 5: `pd candidate show` shows ledgerEntryId | candidate-intake-e2e.test.ts |

### Dimension 2: Traceability Chain
```
pending candidate (DB) → pd candidate intake (CLI) → consumed status (DB) → ledger entry (file) → ledgerEntryId (CLI show/list)
```

### Dimension 3: Idempotency Verification
- Second intake with same candidateId returns `status: "already_consumed"`
- Only ONE ledger entry exists for a given candidateId
- `PrincipleTreeLedgerAdapter.existsForCandidate()` returns existing entry

### Dimension 4: CLI Output Contracts
| Command | Expected Output Fields |
|----------|------------------------|
| `pd candidate intake --json` | `candidateId, status, ledgerEntryId` |
| `pd candidate list --json` | `taskId, candidates[].candidateId, candidates[].status` |
| `pd candidate show --json` | `candidateId, status, ledgerEntryId` |

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 1 | 01 | 1 | E2E-INTAKE-04 | T-m7-05-01~06 | ledgerEntryId added to CandidateShowResult | unit + build | `cd packages/principles-core && npm run build` | ✅ packages/principles-core/src/runtime-v2/cli/diagnose.ts | ⬜ pending |
| 2 | 01 | 1 | E2E-INTAKE-01~04 | T-m7-05-01~06 | 6 E2E tests pass with real CLI | E2E | `cd packages/pd-cli && npm run test -- --run tests/e2e/candidate-intake-e2e.test.ts` | ✅ packages/pd-cli/tests/e2e/candidate-intake-e2e.test.ts | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/pd-cli/tests/e2e/candidate-intake-e2e.test.ts` — E2E tests for intake flow
- [ ] `better-sqlite3` — already in dependencies (DB access)
- [ ] `vitest` — already configured in pd-cli

*Existing infrastructure covers all phase requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Ledger file write correctness | E2E-INTAKE-01 | Requires file system verification | Read `.pd/principle-tree-ledger.json` after intake |
| DB state verification | E2E-INTAKE-01 | Requires direct SQL query | `SELECT status FROM principle_candidates WHERE candidate_id = ?` |

*Both are automated in the E2E tests via inline DB queries and ledger file reads.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
