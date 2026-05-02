# m7-05 Context: E2E — candidate → ledger entry

## Phase Goal

Full traceability from pending candidate to ledger entry with idempotency verified.

## Depends On

- m7-04 (CLI: `pd candidate intake` — SHIPPED)

## Requirements

- E2E-INTAKE-01: Happy path E2E — pending candidate → intake → consumed → ledger entry visible
- E2E-INTAKE-02: `pd candidate list --task-id <taskId>` shows candidate with correct status after intake
- E2E-INTAKE-03: Idempotency — intake same candidate twice → one ledger entry, no duplicate
- E2E-INTAKE-04: Traceability — `pd candidate show <id>` shows ledger entry link

## Success Criteria (what must be TRUE)

1. Happy path: pending candidate → intake → consumed → ledger entry visible
2. `pd candidate list --task-id <taskId>` shows candidate with correct status after intake
3. Idempotency: intake same candidate twice → one ledger entry, no duplicate
4. Traceability: `pd candidate show <id>` shows ledger entry link (E2E-INTAKE-04)
5. Tests + build green

## Plan Breakdown

| Plan | Scope | Status |
|------|-------|--------|
| m7-05-01-PLAN.md | E2E tests: happy path, idempotency, traceability, CLI show | Pending |

## Key Files (canonical source: `packages/principles-core/src/runtime-v2/`)

| File | Role |
|------|------|
| `candidate-intake/service.ts` | CandidateIntakeService — intake logic |
| `candidate-intake/ledger-adapter.ts` | PrincipleTreeLedgerAdapter — ledger write |
| `candidate-intake/types.ts` | CandidateIntakeInput/Output, CandidateIntakeError |
| `cli/commands/candidate-intake.ts` | CLI handler for `pd candidate intake` |

## Non-Goals

- No pain signal bridge in m7-05
- No legacy path deletion
- No new CLI commands (only test existing ones)
