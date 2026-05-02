# Plan: PRI-25 — Pruning Review CLI Workflow

**Date:** 2026-05-02
**Status:** READY

## Context

PRI-23 (explain) and PRI-24 (audit log) are merged. Now implement the review CLI that connects them.

---

## PRI-25: `pd runtime pruning review` CLI

### Command Shape

```
pd runtime pruning review \
  --principle-id <id> \
  --decision keep|defer|archive-candidate \
  --note "..." \
  [--workspace <path>] \
  [--json]
```

### Behavior

1. Instantiate `PruningReadModel`, call `getPrincipleSignals()`
2. Find matching signal for `principleId`
3. **Missing principle**: exit 1, no log written
4. **Invalid decision**: exit 1, no log written
5. **archive-candidate + no note**: exit 1, no log written
6. Call `appendPruningReview(workspaceDir, { principleId, decision, note, reviewer, signalSnapshot })`
7. **JSON mode**: `{ reviewId, principleId, decision, reviewer, reviewedAt }`
8. **Text mode**: print all fields + audit-only note

---

## TDD Tests (in `runtime-pruning.test.ts`)

```typescript
it('review --json writes review record and outputs reviewId', ...)
it('review text output includes audit-only / no mutation note', ...)
it('review missing principle exits 1 and does not append', ...)
it('review invalid decision exits 1 and does not append', ...)
it('archive-candidate without note exits 1', ...)
it('review passes workspace to PruningReadModel and appendPruningReview', ...)
it('review captures signalSnapshot from matching signal', ...)
```

---

## Verification

```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npx vitest run packages/pd-cli/tests/commands/runtime-pruning.test.ts --exclude "**/.worktrees/**"
npx vitest run packages/principles-core/src/runtime-v2/__tests__/pruning-review-log.test.ts --exclude "**/.worktrees/**"
npx vitest run packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts --exclude "**/.worktrees/**"
```

---

## Branch

```bash
git checkout main && git pull origin main
git checkout -b codex/pri-25-pruning-review-cli
```

## Commit

```
feat(pd-cli): add pruning review workflow

- pd runtime pruning review --principle-id --decision --note
- archives audit record to pruning_reviews.jsonl
- validates decision and note requirements before writing
- does not modify principle ledger or state.db
```

## Linear Update

- PRI-25 → In Progress (start)
- PRI-25 → Done (after merge, comment with PR + tests)
- PRI-26: comment → PRI-25 done, can start docs