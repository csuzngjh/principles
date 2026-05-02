# PRI-15: Dynamic Pruning Metrics and Read Model

**Status:** Done
**Completed:** 2026-05-02
**PR:** #437 merged

## Goal

Build non-destructive pruning observability infrastructure — read-only metrics and signals that answer:
- Which principles have no recent derived candidates (stale)?
- Which principles are old without pain-signal lineage?
- What is the overall ledger health?

**Non-goal achieved:** No automatic pruning, no ledger writes, no state changes.

## What Was Built

### 1. Core Read Model — `pruning-read-model.ts`

**File:** `packages/principles-core/src/runtime-v2/pruning-read-model.ts`

`PruningReadModel` — stateless, read-only, no side effects.

**API:**
```typescript
const model = new PruningReadModel({ workspaceDir });
const signals = model.getPrincipleSignals();
const summary = model.getHealthSummary();
```

**`PrinciplePruningSignal` per principle:**
- `principleId`, `status`, `createdAt`, `updatedAt`
- `derivedCandidateIds`, `derivedPainCount`, `matchedCandidateCount`
- `recentCandidateCount` (within 30 days)
- `orphanCandidateCount`
- `ageDays`
- `riskLevel: 'none' | 'watch' | 'review'`
- `reasons: string[]` (with `[source: ...]` citations)

**`PruningHealthSummary` aggregate:**
- `totalPrinciples`, `byStatus`
- `watchCount`, `reviewCount`
- `orphanDerivedCandidateCount`
- `averageAgeDays`, `generatedAt`

**Risk level rules (deterministic, no LLM):**
| Condition | Risk Level |
|-----------|------------|
| age ≥ 90 days AND derivedPainCount = 0 | `review` |
| age ≥ 30 days AND derivedPainCount = 0 | `watch` |
| otherwise | `none` |

### 2. CLI Command — `pd runtime pruning report`

**File:** `packages/pd-cli/src/commands/runtime-pruning.ts`
**Registered:** `packages/pd-cli/src/index.ts`

```
pd runtime pruning report [--workspace <path>] [--json]
```

**Text output:** summary table + watch/review principle lists with reasons
**JSON output:** `{ generatedAt, workspace, summary, signals }`

### 3. Exhaustive Test Suite — 12/12 passing

**File:** `packages/principles-core/src/runtime-v2/__tests__/pruning-read-model.test.ts`

Coverage:
| Test | Scenario |
|------|----------|
| Empty ledger | signals = [], summary counts = 0 |
| Status grouping | byStatus counts correct |
| Watch risk | ~45d old, no derived pain → `watch` |
| Review risk | ~120d old, no derived pain → `review` |
| None risk | recent derived candidate → `none` |
| All present in DB | orphan count = 0 |
| Probation status | reasons include `[source: ledger.status]` |
| Deprecated status | reasons include `[source: ledger.status]` |
| DB absent | graceful degradation |
| Custom thresholds | 90d watch threshold respected |
| Average age | computed correctly |

## Architecture

```
pd runtime pruning report
        │
        ▼
PruningReadModel (core)
        │
        ├── loadLedger(.state/principle_training_state.json)
        │
        └── Database(.pd/state.db) — consumed candidates only
```

## Metrics Definition

| Signal | Source | Trigger |
|--------|--------|---------|
| `derivedPainCount` | `derivedFromPainIds.length` | ledger |
| `matchedCandidateCount` | derived ID found in consumed candidates table | state.db |
| `recentCandidateCount` | candidate.createdAt ≥ 30 days ago | state.db |
| `orphanCandidateCount` | derived ID not in consumed candidates table | state.db |
| `ageDays` | `createdAt` vs now | ledger |
| `riskLevel` | deterministic rules above | computed |

## Non-Destructive Guarantee

- No `saveLedger`, `updatePrinciple`, or any write call
- No background workers
- No automatic demote/harden/prune actions
- All signals include `reasons` with explicit `[source: ...]` so operators can audit the evidence

## Future: Destructive Pruning (Out of Scope)

Any automatic pruning must:
1. Require human confirmation via `pd runtime pruning review --principle-id <id>`
2. Be gated behind a `--dry-run` that shows what would change
3. Include a rollback mechanism
4. Be tracked in a separate issue (PRI-N+1)

## Test Results

```
npx vitest run packages/principles-core/src/runtime-v2/__tests__/pruning-read-model.test.ts
→ 12 passed (12)

npm run build --workspace=@principles/core   → tsc OK
npm run build --workspace=@principles/pd-cli  → tsc OK
```

## Next Steps

- PRI-16 is the parent issue (now Done)
- PRI-15 (this issue) is now Done
- Future: PRI-N for actual destructive pruning with human-in-the-loop guardrails

## Files Changed

| Action | File |
|--------|------|
| NEW | `packages/principles-core/src/runtime-v2/pruning-read-model.ts` |
| NEW | `packages/principles-core/src/runtime-v2/__tests__/pruning-read-model.test.ts` |
| NEW | `packages/pd-cli/src/commands/runtime-pruning.ts` |
| EDIT | `packages/principles-core/src/runtime-v2/index.ts` (export) |
| EDIT | `packages/pd-cli/src/index.ts` (register command) |
| NEW | `docs/reports/pri-15-dynamic-pruning-read-model.md` |
